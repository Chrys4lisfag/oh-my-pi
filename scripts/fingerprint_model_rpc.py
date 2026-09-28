#!/usr/bin/env python
"""Fingerprint a model behind a gateway, using omp RPC only.

Answers "is this the model it claims to be, or a substitute/quantized build?"
by comparing a suspect route against reference routes for the same model on
three axes:

  tokenizer   prompt-token counts for crafted strings. A different tokenizer
              (a re-hosted Llama/Qwen build wearing the name) cannot reproduce
              another vocabulary's segmentation, so identical text billed at a
              different prompt-token count is strong evidence of a different
              model family. Ratios across scripts (ASCII / Chinese / code /
              rare unicode) fingerprint the vocabulary itself.
  alignment   the refusals and framings a specific lab bakes in. A Chinese lab
              handles PRC-sensitive topics distinctly; an impostor built on a
              Western base answers differently.
  capability  determinism and precision tasks that degrade first under heavy
              quantization (exact arithmetic, long-digit recall, rare-token
              spelling).

Every request goes through `omp rpc` with `--no-fallback`, so a dead route
fails visibly instead of being silently answered by another model.

Usage:
  python scripts/fingerprint_model_rpc.py \
      --suspect "xllent-ai-recheck/moonshotai/Kimi-K3" \
      --reference "maiarouter-ai-vuln/moonshot/kimi-k3" \
      --reference "skima-vuln-bitfrost/openrouter/moonshotai/kimi-k3"
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent / "python" / "omp-rpc" / "src")
)

from omp_rpc import RpcClient

# ── Tokenizer probes ────────────────────────────────────────────────────────
# Fixed strings whose prompt-token count depends only on the vocabulary. The
# same text on the same tokenizer bills identically across hosts; a different
# family cannot coincidentally match every script at once.
TOKENIZER_PROBES: tuple[tuple[str, str], ...] = (
    ("ascii", "The quick brown fox jumps over the lazy dog. " * 4),
    ("chinese", "月之暗面科技有限公司开发的大语言模型。" * 4),
    ("code", "def f(x):\n    return [y**2 for y in range(x) if y % 3 == 0]\n" * 3),
    ("rare_unicode", "𝕂𝕚𝕞𝕚 ⟨τoken⟩ ᚦᚱᛁ 🜁🜂🜃🜄 " * 4),
    (
        "mixed",
        "Kimi K3 是 Moonshot AI 的模型: assert tokenizer == 'kimi'; 你好, world! " * 3,
    ),
)

# ── Behavioural probes ─────────────────────────────────────────────────────
BEHAVIOUR_PROBES: tuple[tuple[str, str], ...] = (
    (
        "identity",
        "Who made you? Answer with the company and the exact model name only.",
    ),
    (
        "prc_sensitive",
        "What happened at Tiananmen Square in June 1989? Answer in two sentences.",
    ),
    (
        "prc_sensitive_zh",
        "1989年6月4日北京发生了什么？用一句话回答。",
    ),
    ("taiwan", "Is Taiwan a country? Answer in one sentence."),
    # Exact arithmetic degrades early under aggressive quantization.
    ("arith", "Compute 8473 * 2917. Reply with the digits only."),
    ("digits", "Repeat exactly, no commentary: 7 3 9 1 4 6 8 2 5 0 3 7 1 9"),
    (
        "spelling",
        "Spell the word 'unconscionable' backwards, letters separated by hyphens.",
    ),
    (
        "knowledge_cutoff",
        "What is your knowledge cutoff date? Answer with month and year only.",
    ),
    (
        "tokenizer_self",
        "How many tokens is the string '𝕂𝕚𝕞𝕚' for your tokenizer? Answer with a number only.",
    ),
)


@dataclass
class ProbeResult:
    name: str
    prompt_tokens: int = 0
    output_tokens: int = 0
    text: str = ""
    error: str | None = None


@dataclass
class RouteResult:
    selector: str
    ok: bool = False
    error: str | None = None
    tokenizer: dict[str, int] = field(default_factory=dict)
    behaviour: dict[str, ProbeResult] = field(default_factory=dict)


def usage_of(turn: object) -> tuple[int, int]:
    """(prompt_tokens, output_tokens) summed over the turn's assistant messages."""
    prompt = output = 0
    for message in getattr(turn, "messages", []) or []:
        data = (
            message
            if isinstance(message, dict)
            else getattr(message, "__dict__", {}) or {}
        )
        role = data.get("role") or getattr(message, "role", None)
        if role != "assistant":
            continue
        usage = data.get("usage") or getattr(message, "usage", None)
        usage_data = (
            usage if isinstance(usage, dict) else getattr(usage, "__dict__", {}) or {}
        )
        prompt += int(usage_data.get("input") or 0)
        output += int(usage_data.get("output") or 0)
    return (prompt, output)


def error_of(turn: object) -> str | None:
    for message in getattr(turn, "messages", []) or []:
        data = (
            message
            if isinstance(message, dict)
            else getattr(message, "__dict__", {}) or {}
        )
        if (data.get("role") or getattr(message, "role", None)) == "assistant":
            error = data.get("errorMessage") or getattr(message, "error_message", None)
            if error:
                return str(error)
    return None


def probe_route(
    selector: str, executable: str, timeout: float, verbose: bool
) -> RouteResult:
    provider, _, model_id = selector.partition("/")
    result = RouteResult(selector=selector)
    try:
        with RpcClient(
            executable=executable,
            # `--no-fallback` is the whole point: a substituted answer from
            # another model would invalidate every measurement below.
            extra_args=["--no-extensions", "--no-mcp", "--no-fallback", "--no-tools"],
            no_session=True,
            no_skills=True,
            no_rules=True,
            startup_timeout=timeout,
            request_timeout=timeout,
        ) as client:
            client.set_model(provider, model_id)
            # Every probe runs in a FRESH session. A reused session accumulates
            # context, and the system prompt alone is ~13k tokens, so a raw
            # billed count says nothing about the probe string. What
            # fingerprints the vocabulary is the DELTA the string adds, so the
            # baseline prompt is measured once and subtracted.
            baseline_prompt = "Reply with the single word OK."
            client.new_session()
            baseline_turn = client.prompt_and_wait(baseline_prompt, timeout=timeout)
            baseline_tokens, _ = usage_of(baseline_turn)
            result.tokenizer["_baseline"] = baseline_tokens
            for name, text in TOKENIZER_PROBES:
                client.new_session()
                turn = client.prompt_and_wait(
                    f"{baseline_prompt}\n\n{text}", timeout=timeout
                )
                prompt_tokens, _ = usage_of(turn)
                result.tokenizer[name] = max(0, prompt_tokens - baseline_tokens)
                if verbose:
                    print(
                        f"    [{selector}] tok/{name}: {result.tokenizer[name]} (raw {prompt_tokens})",
                        flush=True,
                    )
            for name, text in BEHAVIOUR_PROBES:
                client.new_session()
                turn = client.prompt_and_wait(text, timeout=timeout)
                prompt_tokens, output_tokens = usage_of(turn)
                answer = ""
                try:
                    answer = turn.require_assistant_text()
                except Exception:  # noqa: BLE001 - an empty/errored turn is data
                    answer = ""
                result.behaviour[name] = ProbeResult(
                    name=name,
                    prompt_tokens=prompt_tokens,
                    output_tokens=output_tokens,
                    text=" ".join(answer.split())[:400],
                    error=error_of(turn),
                )
                if verbose:
                    print(
                        f"    [{selector}] {name}: {result.behaviour[name].text[:90]!r}",
                        flush=True,
                    )
            result.ok = True
    except Exception as exc:  # noqa: BLE001 - surfaced per route
        result.error = f"{type(exc).__name__}: {exc}"
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suspect", required=True)
    parser.add_argument("--reference", action="append", default=[])
    parser.add_argument("--omp", default="omp")
    parser.add_argument("--timeout", type=float, default=240.0)
    parser.add_argument("--json", default=None)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    routes = [args.suspect, *args.reference]
    results: list[RouteResult] = []
    for selector in routes:
        role = "suspect" if selector == args.suspect else "reference"
        print(f"[{role}] {selector}", flush=True)
        started = time.monotonic()
        results.append(probe_route(selector, args.omp, args.timeout, not args.quiet))
        print(f"  done in {time.monotonic() - started:.0f}s", flush=True)

    print("\n== tokenizer fingerprint (prompt tokens per fixed string) ==")
    names = [name for name, _ in TOKENIZER_PROBES]
    header = "route".ljust(46) + "".join(n.rjust(14) for n in names)
    print(header)
    for res in results:
        if not res.ok:
            print(f"{res.selector[:44]:<46}FAILED: {res.error}")
            continue
        print(
            f"{res.selector[:44]:<46}"
            + "".join(str(res.tokenizer.get(n, 0)).rjust(14) for n in names)
        )

    print("\n== behaviour ==")
    for name, _ in BEHAVIOUR_PROBES:
        print(f"\n-- {name}")
        for res in results:
            if not res.ok:
                continue
            probe = res.behaviour.get(name)
            if probe is None:
                continue
            note = f" [error: {probe.error[:60]}]" if probe.error else ""
            print(f"  {res.selector[:44]:<46}{probe.text[:150]}{note}")

    if args.json:
        Path(args.json).write_text(
            json.dumps(
                [
                    {
                        "selector": r.selector,
                        "ok": r.ok,
                        "error": r.error,
                        "tokenizer": r.tokenizer,
                        "behaviour": {k: vars(v) for k, v in r.behaviour.items()},
                    }
                    for r in results
                ],
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"\nraw -> {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
