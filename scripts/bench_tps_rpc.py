"""Benchmark tokens/second across models with one identical task.

Two selection modes:

    bench_tps.bat --provider anoman-vuln            # terminal: ask models; unattended: all
    bench_tps.bat --provider anoman-vuln --models claude,gpt-5
    bench_tps.bat --model deepseek-v4-flash --match partial

Six prompts (omit `--task` and the script asks; the menu is a/b/c/d/e/f):

    --task hi       a one-word reply; the number is dominated by round-trip
                    latency and per-request overhead, NOT decode rate
    --task dialogue  a creative scene of ~1-2 A4 pages (`--words`, default 900)
                    — mid-length decode with a narrative sampling profile
    --task prose     (default) one long technical essay, tools disabled — a
                    clean decode-rate measurement that lands around 1-2
                    minutes per model (`--words`, default 1400)
    --task context   a ~1M-token INPUT for a one-word answer (`--input-tokens`):
                    checks whether an advertised context window is real. Read
                    the `in tok` column (what the provider accepted) and the
                    status, not the throughput
    --task landing   the original landing-page build; writes files and calls
                    tools, so its rate includes tool round-trips
    --task custom    exact prompt from `--prompt`, `--prompt-file`, or input

Reported throughput per model:

    omp tps   omp's own number, read from the live session state after the
              turn (the same value the status line shows)
    tps       output tokens / generation window (excludes the TTFT wait)
    wall tps  output tokens / total turn time

The prose task is genuinely tool-free: `--no-tools` alone only filters
built-in tools (MCP servers are custom tools and mount anyway), so each run
also passes `--no-mcp`. That takes a run from 338 tools and 21 child processes
down to 0 tools and 1 process — which matters twice over, because a parallel
batch of MCP-spawning instances starves every other omp on the machine.
`--sandbox` additionally redirects the agent dir and home to hide skills,
plugins and rules; it is opt-in because it also hides OAuth credentials.

Every invocation gets its own timestamped results directory. It holds exact
`prompt.txt`, `selection.json`, overlay, log, report, and each model's session
JSON/work directory. `--clean` removes only per-model workdirs after a run;
run-level artifacts remain. While the batch runs, a single table is repainted
in place — one row per model with status, elapsed, time-to-first-token, tokens,
tokens/second and an idle counter — so a hung provider is obvious at a glance.
Per-model chatter goes to `bench.log` in the results directory instead of
scrolling over the table. Ctrl+C once stops the batch: running models are
aborted and keep their partial numbers, queued models are skipped, stragglers
are abandoned after a short grace, and the final table always prints.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import signal
import statistics
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_RPC_SRC = _REPO_ROOT / "python" / "omp-rpc" / "src"
if _RPC_SRC.is_dir() and str(_RPC_SRC) not in sys.path:
    sys.path.insert(0, str(_RPC_SRC))

TOPICS = (
    "a solar-powered bike courier service",
    "an indie board game cafe",
    "a rescue shelter for retired sled dogs",
    "a rooftop urban farm subscription",
    "a retro synthesizer repair shop",
    "a deep-sea photography expedition club",
    "a night-shift ramen delivery startup",
)

TASK_TEMPLATE = (
    "create me landing page on the topic {topic}.\n"
    "Write the files into the current working directory. "
    "Finish the whole page in this turn."
)

PROSE_SUBJECTS = (
    "how a write-ahead log turns crash recovery into a replay problem",
    "why CPU cache coherency protocols make false sharing so expensive",
    "how a query planner decides between a hash join and a merge join",
    "what a garbage collector's write barrier actually costs a mutator thread",
    "how TCP congestion control reacts to a lossy wireless last hop",
    "why floating-point summation order changes the answer, and how to fix it",
    "how a JIT decides to deoptimize a speculatively inlined call site",
)

# The throughput task: pure decode, no tools, no files. A tool call would stall
# generation on local work (and on a subagent's model), which is exactly what
# the previous landing-page task measured by accident.
PROSE_TASK_TEMPLATE = (
    "Write a detailed technical essay of at least {words} words explaining {subject}.\n"
    "Requirements: continuous prose only — no bullet lists, no headings, no code "
    "blocks, no tables. Work through the mechanism step by step, name the "
    "trade-offs, and give concrete numbers where they matter. Do not ask "
    "questions, do not summarize the request, do not stop early: produce the "
    "whole essay in this single reply."
)

# Latency-shaped task: a one-word reply. Output is a handful of tokens, so the
# measured `omp tps` is dominated by time-to-first-token and per-request
# overhead rather than decode rate — useful for comparing gateway round-trips,
# useless for comparing decode speed.
HI_TASK = "hi"

DIALOGUE_SUBJECTS = (
    "two lighthouse keepers who disagree about whether the ship on the horizon is real",
    "a night-shift nurse and a patient who claims to remember the future",
    "two translators arguing over one ambiguous line in a dead diplomat's letter",
    "a retired safecracker teaching an apprentice who asks the wrong questions",
    "two astronomers on the last night of an observatory that is being sold",
    "a chef and a food critic trapped in a lift between floors",
)

# Mid-length creative task: ~1-2 A4 pages of dialogue (roughly 700-1100 words).
# Prose-only like the essay task, but the register is narrative, which exercises
# a different sampling profile than technical exposition.
DIALOGUE_TASK_TEMPLATE = (
    "Write a creative dialogue scene of about {words} words between {subject}.\n"
    "Requirements: dialogue and minimal stage directions only — no headings, no "
    "bullet lists, no code blocks, no commentary about the task. Give each "
    "speaker a distinct voice, let the disagreement escalate and then turn, and "
    "end on a line that reframes what came before. Do not ask questions, do not "
    "summarize the request, do not stop early: produce the whole scene in this "
    "single reply."
)

# Context-window probe: a very large INPUT with a trivial output, to find out
# whether an advertised window (a "1M-token" model, say) is real on this route.
# Throughput is irrelevant here — the columns that matter are `in tok` (what the
# provider actually accepted) and status (a gateway that lies about its window
# fails with a context/payload error instead).
#
# The filler is pseudo-random word salad, not repeated text: a repetitive prompt
# can be served from a prefix cache (or squashed by a proxy), which would prove
# nothing about capacity. The seed keeps one run reproducible across models.
# Common short words: each is ONE token in cl100k/o200k, so the prompt size is
# predictable. Rare words (`gossamer`, `whetstone`) cost ~2.25 tokens each,
# which is how a "1M-token" request became 1.38M and was rejected by a gateway
# whose 1M window was genuine.
CONTEXT_FILLER_VOCABULARY: tuple[str, ...] = (
    "the",
    "of",
    "and",
    "to",
    "in",
    "a",
    "is",
    "for",
    "on",
    "with",
    "as",
    "by",
    "at",
    "from",
    "or",
    "an",
    "be",
    "this",
    "that",
    "it",
    "not",
    "are",
    "was",
    "but",
    "they",
    "have",
    "has",
    "can",
    "will",
    "one",
    "two",
    "all",
    "any",
    "may",
    "new",
    "now",
    "out",
    "up",
    "so",
    "if",
    "no",
    "we",
    "you",
    "he",
    "she",
    "them",
    "when",
    "then",
    "than",
    "some",
    "each",
    "more",
    "most",
)

# Fallback ratio when no tokenizer is installed. With the single-token
# vocabulary above, one word plus its space is one token.
CONTEXT_WORDS_PER_TOKEN = 1.0


def _token_counter() -> Callable[[str], int] | None:
    """A real tokenizer when one is available; otherwise None.

    The probe exists to compare a request against an advertised window, so the
    size has to be measured, not estimated: an over-long prompt is rejected by a
    provider whose window is genuinely large, which looks like a provider fault
    and is not one.
    """
    try:
        import tiktoken
    except ImportError:
        return None
    try:
        encoding = tiktoken.get_encoding("o200k_base")
    except Exception:  # noqa: BLE001 - any tiktoken failure falls back to estimation
        return None
    return lambda text: len(encoding.encode(text))


CONTEXT_TASK_INSTRUCTION = (
    "Above is filler text. Ignore all of it. Do not summarize it, do not quote "
    "it, do not comment on it.\nReply with exactly one word: ok"
)


def build_context_probe_task(input_tokens: int, seed: int = 1234) -> str:
    """A prompt of about `input_tokens` tokens whose answer is one word.

    Sized against a real tokenizer when `tiktoken` is installed, then trimmed
    down to the target: overshooting is what makes a provider reject the request
    and look broken. The count is the whole prompt, instruction included.
    """
    rng = random.Random(seed)
    vocabulary = CONTEXT_FILLER_VOCABULARY
    count = _token_counter()
    overhead = count(CONTEXT_TASK_INSTRUCTION) if count else 32
    target = max(1, input_tokens - overhead)

    words: list[str] = [
        rng.choice(vocabulary) for _ in range(int(target * CONTEXT_WORDS_PER_TOKEN))
    ]
    if count:
        # Converge by measurement: add or drop words until the filler lands
        # within 0.5% of the target, capped so a pathological tokenizer cannot
        # spin here.
        for _ in range(24):
            actual = count(" ".join(words))
            if abs(actual - target) <= max(16, target // 200):
                break
            scale = target / max(1, actual)
            wanted = max(1, int(len(words) * scale))
            if wanted > len(words):
                words.extend(rng.choice(vocabulary) for _ in range(wanted - len(words)))
            else:
                del words[wanted:]
    return f"{' '.join(words)}\n\n{CONTEXT_TASK_INSTRUCTION}"


def resolve_context_input_tokens(
    requested: int, context_window: int | None, max_tokens: int | None
) -> int:
    """Clamp the probe to what the model can actually accept.

    A request is `input + reserved output`, so asking for a full window always
    fails: the reported rejection was "1048576 maximum … you requested about
    1447376 (1383376 of text input, 64000 in the output)". Leave the output
    reservation plus 2% slack (tokenizers disagree by a percent or two) so the
    probe tests the window instead of tripping over arithmetic.
    """
    if not context_window or context_window <= 0:
        return requested
    reserve = max_tokens if max_tokens and max_tokens > 0 else 4096
    reserve = min(reserve, max(1024, context_window // 8))
    budget = int((context_window - reserve) * 0.98)
    return max(1024, min(requested, budget))


# Subagent delegation is excluded from the benchmark: a `task` call would move
# generation onto another model and destroy the tokens/second attribution.
EXCLUDED_TOOLS = ("task",)

# The only task that gets tools. Everything else runs `--no-tools`: a tool call
# interleaves local work with decode and destroys the tokens/second it is
# supposed to measure. Adding a task therefore opts OUT of tools by default.
TASKS_WITH_TOOLS = frozenset({"landing"})

# `--no-tools` only filters BUILT-IN tools; MCP servers are custom tools and
# still mount (336 of them on a typical config), so the request would carry
# their schemas and the model could still call one. A throughput run therefore
# gets its own agent directory seeded with credentials, the model catalog and
# its cache — and deliberately without `mcp.json`, `plugins/` or `extensions/`,
# which is what actually keeps the turn tool-free.
SANDBOX_AGENT_FILES = ("auth.json", "models.yml", "config.yml")
# Copied into the sandbox home. The redirect exists to hide MCP declarations
# (`~/.cursor/mcp.json` and friends), not to blank the machine: anything here
# is host configuration a spawned process may legitimately want.
SANDBOX_HOME_FILES = (".gitconfig", ".gitignore_global")
SANDBOX_AGENT_CACHES = (
    "models.db",
    "models.db-shm",
    "models.db-wal",
)

CONFIG_OVERLAY = """# Generated by scripts/bench_tps_rpc.py — benchmark isolation overlay.
advisor:
  enabled: false
tools:
  approvalMode: yolo
task:
  batch: false
# `learn` and `manage_skill` are custom tools that survive `--no-tools`
# (custom tools are force-included), so their feature switches are the only
# way to keep a throughput turn's tool list empty.
autolearn:
  enabled: false
skills:
  enabled: false
# A benchmark must measure the model it pinned or report nothing. With fallback
# enabled, a dead provider's turn is answered by a DIFFERENT model and its
# tokens/second are attributed to the pinned one — every broken gateway scored
# "ok". Retries are off too: retrying a failing provider until it answers turns
# a broken endpoint into a slow-but-passing row.
# A huge `--task context` prompt would otherwise trip auto-compaction, which
# would summarize the input away and measure compaction instead of the
# provider's real context window. Every task wants the prompt sent verbatim.
compaction:
  enabled: false
retry:
  modelFallback: false
  usageAwareFallback: false
  fallbackChains: {}
  maxRetries: 0
"""

# Streaming events that prove the first token reached us.
FIRST_TOKEN_EVENT_TYPES = frozenset(
    {
        "text_start",
        "text_delta",
        "thinking_start",
        "thinking_delta",
        "toolcall_start",
        "toolcall_delta",
    }
)

STATUS_OK = "ok"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"
STATUS_STALLED = "stalled"
STATUS_TIMEOUT = "timeout"
STATUS_SKIPPED = "skipped"
# Never returned within the cancel grace; its numbers are whatever streamed.
STATUS_ABANDONED = "abandoned"
STATUS_LABELS = {
    STATUS_OK: "ok",
    STATUS_FAILED: "FAIL",
    STATUS_CANCELLED: "CANCEL",
    STATUS_STALLED: "STALL",
    STATUS_TIMEOUT: "TIMEOUT",
    STATUS_SKIPPED: "SKIP",
    STATUS_ABANDONED: "ABANDON",
}
# Statuses whose partial numbers are still worth reporting (the model streamed,
# we just stopped waiting for it).
PARTIAL_STATUSES = frozenset(
    {STATUS_CANCELLED, STATUS_STALLED, STATUS_TIMEOUT, STATUS_ABANDONED}
)
# How long an aborted turn gets to unwind before the model is abandoned.
ABORT_GRACE_SECONDS = 12.0
# How long the batch waits for stragglers after Ctrl+C before printing anyway.
CANCEL_GRACE_SECONDS = 20.0
# Default concurrency for a `--provider` sweep, which can hold hundreds of
# models. Small on purpose: parallel turns share one uplink and depress every
# model's measured tokens/second.
PROVIDER_SWEEP_DEFAULT_JOBS = 4
LIVE_REFRESH_SECONDS = 0.4
# Plain-log heartbeat cadence when stdout is not a TTY (CI, piped output).
LIVE_HEARTBEAT_SECONDS = 15.0
NOTE_WIDTH = 44

MatchMode = str  # "partial" | "full"


# ─────────────────────────────────────────────────────────────────────────────
# Model selection
# ─────────────────────────────────────────────────────────────────────────────


def _base_id(model_id: str) -> str:
    """Model id without its vendor namespace (`deepseek/foo` -> `foo`)."""
    return model_id.rsplit("/", 1)[-1]


def matches_model(model_id: str, query: str, mode: MatchMode) -> bool:
    """Whether `model_id` matches `query`.

    partial — query anywhere in the id (`deepseek-v4-flash` hits
              `deepseek-v4-flash-postfix-allowed` and `x-deepseek-v4-flash`).
    full    — the id, ignoring an optional `vendor/` namespace, equals the query
              or continues it after a separator, so `deepseek-v4-flash` hits
              `deepseek-v4-flash` and `deepseek/deepseek-v4-flash-preview`,
              but never `my-deepseek-v4-flash`.
    """
    identifier = model_id.strip().lower()
    wanted = query.strip().lower()
    if not wanted:
        return False
    if mode == "partial":
        return wanted in identifier
    if mode != "full":
        raise ValueError(f'match mode must be "partial" or "full", got "{mode}"')
    for candidate in (identifier, _base_id(identifier)):
        if candidate == wanted:
            return True
        if candidate.startswith(wanted) and candidate[len(wanted) :][:1] in {
            "-",
            "_",
            ".",
            ":",
        }:
            return True
    return False


def select_models(models: Iterable[Any], query: str, mode: MatchMode) -> list[Any]:
    """Matching models, ordered by provider then id, deduped by provider/id."""
    seen: set[tuple[str, str]] = set()
    selected: list[Any] = []
    for model in models:
        key = (model.provider, model.id)
        if key in seen or not matches_model(model.id, query, mode):
            continue
        seen.add(key)
        selected.append(model)
    selected.sort(key=lambda model: (model.provider.lower(), model.id.lower()))
    return selected


# ─────────────────────────────────────────────────────────────────────────────
# Results
# ─────────────────────────────────────────────────────────────────────────────


def select_provider_models(models: Iterable[Any], provider: str) -> list[Any]:
    """Every available model of one provider, ordered by id.

    Provider ids are matched case-insensitively and exactly: `anoman` must not
    also select `anoman-beta`, or a provider sweep silently benchmarks a
    neighbour's catalog.
    """
    wanted = provider.strip().lower()
    matched = [
        model
        for model in models
        if str(getattr(model, "provider", "")).lower() == wanted
    ]
    return sorted(matched, key=lambda model: str(model.id))


def parse_model_queries(value: str) -> tuple[str, ...]:
    """Comma-separated partial model queries, preserving first occurrence."""
    queries: list[str] = []
    seen: set[str] = set()
    for raw in value.split(","):
        query = raw.strip()
        key = query.lower()
        if not query or key in seen:
            continue
        seen.add(key)
        queries.append(query)
    return tuple(queries)



def resolve_provider_model_queries(
    value: str | None, *, interactive: bool
) -> tuple[str, ...]:
    """Parse --models, or interactively ask; unattended sweeps select all."""
    if value is not None:
        return parse_model_queries(value)
    if not interactive:
        return ()
    return parse_model_queries(
        _ask(
            "Specify model(s) to use, use , for multiple, leave blank for all",
            allow_empty=True,
        )
    )

def filter_provider_models(models: Iterable[Any], queries: Sequence[str]) -> list[Any]:
    """Keep provider models matching any requested partial query."""
    normalized = tuple(query for query in queries if query.strip())
    if not normalized:
        return list(models)
    return [
        model
        for model in models
        if any(matches_model(str(model.id), query, "partial") for query in normalized)
    ]


def available_providers(models: Iterable[Any]) -> list[str]:
    return sorted({str(getattr(model, "provider", "")) for model in models} - {""})


@dataclass
class BenchResult:
    provider: str
    model: str
    status: str = STATUS_SKIPPED
    ok: bool = False
    error: str | None = None
    ttft_seconds: float | None = None
    total_seconds: float = 0.0
    generation_seconds: float | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    assistant_messages: int = 0
    tool_calls: int = 0
    tool_names: list[str] = field(default_factory=list)
    stop_reason: str | None = None
    response_chars: int = 0
    streamed_chars: int = 0
    files_created: int = 0
    workdir: str | None = None
    error_message: str | None = None
    resolved_provider: str | None = None
    resolved_model: str | None = None
    # Where this model's answer body was written (`response.md` in its workdir).
    response_path: str | None = None
    # omp's own throughput number, read from the live session state right after
    # the turn (the same value the status line shows). Kept beside the locally
    # derived rates so a disagreement is visible instead of averaged away.
    omp_tps: float | None = None
    # Every `provider/model` that produced an assistant message this turn. A
    # benchmark row is only meaningful when this is exactly the pinned model.
    answered_by: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        # `as_dict` writes `answered_by` as a sorted list (JSON has no set), so a
        # result rebuilt from a report arrives with a list. Coerce it back rather
        # than letting the identity check run against the wrong shape.
        if not isinstance(self.answered_by, set):
            self.answered_by = set(self.answered_by or ())
        # `status` is the source of truth, but callers (and the report
        # round-trip) may set only one of the pair. Keep them consistent so a
        # result built either way reports the same thing.
        if self.ok and self.status == STATUS_SKIPPED:
            self.status = STATUS_OK
        self.ok = self.status == STATUS_OK

    @property
    def partial(self) -> bool:
        """Whether the numbers describe an interrupted (but measured) turn."""
        return self.status in PARTIAL_STATUSES and self.output_tokens > 0

    @property
    def output_tps(self) -> float | None:
        """Output tokens per second of generation time (excludes TTFT wait).

        Reported for interrupted runs too: a cancelled model that streamed for
        30s still has a meaningful throughput number, and hiding it defeats the
        point of being able to stop a slow batch early.
        """
        window = self.generation_seconds
        if window is None or window <= 0 or self.output_tokens <= 0:
            return None
        if self.status not in PARTIAL_STATUSES and self.status != STATUS_OK:
            return None
        return self.output_tokens / window

    @property
    def wall_tps(self) -> float | None:
        """Output tokens per second of total wall time (includes TTFT)."""
        if self.total_seconds <= 0 or self.output_tokens <= 0:
            return None
        if self.status not in PARTIAL_STATUSES and self.status != STATUS_OK:
            return None
        return self.output_tokens / self.total_seconds

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        # `answered_by` is a set; the report is JSON.
        payload["answered_by"] = sorted(self.answered_by)
        payload["output_tps"] = self.output_tps
        payload["wall_tps"] = self.wall_tps
        payload["partial"] = self.partial
        return payload


def _usage_int(usage: Any, key: str) -> int:
    if not isinstance(usage, dict):
        return 0
    value = usage.get(key)
    return int(value) if isinstance(value, (int, float)) else 0


def _usage_cost(usage: Any) -> float:
    if not isinstance(usage, dict):
        return 0.0
    cost = usage.get("cost")
    if not isinstance(cost, dict):
        return 0.0
    total = cost.get("total")
    return float(total) if isinstance(total, (int, float)) else 0.0


def _message_text(message: Any) -> str:
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return "".join(part for part in parts if isinstance(part, str))


def collect_response_text(messages: Sequence[Any]) -> str:
    """Every assistant answer body of a turn, in order, blank-line separated."""
    bodies = [
        text
        for message in messages
        if isinstance(message, dict) and message.get("role") == "assistant"
        for text in (_message_text(message),)
        if text.strip()
    ]
    return "\n\n".join(bodies)


def one_line(text: str | None, width: int = NOTE_WIDTH) -> str:
    """Collapse a multi-line provider error into one table-safe cell."""
    if not text:
        return ""
    flat = re.sub(r"\s+", " ", str(text)).strip()
    return flat if len(flat) <= width else f"{flat[: width - 1]}…"


def _answered_by_other_model(result: BenchResult) -> str | None:
    """The foreign `provider/model` that answered, or None when identity holds.

    Compared against the model the session actually resolved to (what
    `_pin_exact_model` recorded), falling back to the requested pair. A gateway
    may legitimately report its own id casing, so matching is case-insensitive.
    """
    if not result.answered_by:
        return None
    expected = {
        f"{result.provider}/{result.model}".lower(),
        f"{result.resolved_provider or result.provider}/{result.resolved_model or result.model}".lower(),
    }
    foreign = sorted(
        name for name in result.answered_by if name.lower() not in expected
    )
    return ", ".join(foreign) if foreign else None


def summarize_turn(result: BenchResult, messages: Sequence[Any]) -> BenchResult:
    """Fold assistant usage and tool calls from one finished turn into `result`."""
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            result.assistant_messages += 1
            # Who actually answered. A retry fallback, a credential rotation or a
            # gateway that silently serves a different upstream model all show up
            # here — and without this check their tokens/second were credited to
            # the pinned model, so a dead provider scored "ok".
            answered_provider = message.get("provider")
            answered_model = message.get("model")
            if isinstance(answered_provider, str) and isinstance(answered_model, str):
                result.answered_by.add(f"{answered_provider}/{answered_model}")
            usage = message.get("usage")
            result.input_tokens += _usage_int(usage, "input")
            result.output_tokens += _usage_int(usage, "output")
            result.cache_read_tokens += _usage_int(usage, "cacheRead")
            result.cache_write_tokens += _usage_int(usage, "cacheWrite")
            result.total_tokens += _usage_int(usage, "totalTokens")
            result.cost_usd += _usage_cost(usage)
            result.response_chars += len(_message_text(message))
            stop_reason = message.get("stopReason")
            if isinstance(stop_reason, str):
                result.stop_reason = stop_reason
            if stop_reason == "error":
                error_message = message.get("errorMessage")
                result.error_message = (
                    error_message
                    if isinstance(error_message, str) and error_message
                    else "provider returned an error turn"
                )
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "toolCall":
                        result.tool_calls += 1
                        name = block.get("name")
                        if isinstance(name, str):
                            result.tool_names.append(name)
    if result.total_tokens == 0:
        result.total_tokens = (
            result.input_tokens
            + result.output_tokens
            + result.cache_read_tokens
            + result.cache_write_tokens
        )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Live table
# ─────────────────────────────────────────────────────────────────────────────

LIVE_COLUMNS: tuple[tuple[str, int, str], ...] = (
    ("model", 46, "<"),
    ("status", 9, "<"),
    ("elapsed", 8, ">"),
    ("ttft", 7, ">"),
    ("tokens", 8, ">"),
    ("tok/s", 7, ">"),
    ("tools", 5, ">"),
    ("idle", 6, ">"),
    ("note", NOTE_WIDTH, "<"),
)


def _cell(text: str, width: int, align: str) -> str:
    value = text if len(text) <= width else f"{text[: width - 1]}…"
    return value.ljust(width) if align == "<" else value.rjust(width)


@dataclass
class ModelLive:
    """Mutable per-model progress: written by listeners, read by the table."""

    label: str
    stage: str = "queued"
    started_at: float | None = None
    first_token_at: float | None = None
    last_activity_at: float | None = None
    finished_at: float | None = None
    streamed_chars: int = 0
    tool_calls: int = 0
    last_tool: str | None = None
    output_tokens: int = 0
    status: str | None = None
    note: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def begin(self, stage: str = "starting") -> None:
        with self.lock:
            now = time.monotonic()
            self.stage = stage
            self.started_at = now
            self.last_activity_at = now

    def set_stage(self, stage: str) -> None:
        with self.lock:
            self.stage = stage

    def note_stream(self, chars: int) -> None:
        with self.lock:
            now = time.monotonic()
            if self.first_token_at is None:
                self.first_token_at = now
            self.stage = "streaming"
            self.streamed_chars += max(0, chars)
            self.last_activity_at = now

    def note_tool(self, name: str | None) -> None:
        with self.lock:
            self.tool_calls += 1
            self.last_tool = name
            self.stage = f"tool:{name}" if name else "tool"
            self.last_activity_at = time.monotonic()

    def note_tokens(self, output_tokens: int) -> None:
        with self.lock:
            self.output_tokens += max(0, output_tokens)
            self.last_activity_at = time.monotonic()

    def finish(self, status: str, note: str | None = None) -> None:
        with self.lock:
            self.status = status
            self.stage = STATUS_LABELS.get(status, status)
            self.note = one_line(note)
            self.finished_at = time.monotonic()

    def idle_seconds(self, now: float) -> float:
        with self.lock:
            if self.finished_at is not None or self.last_activity_at is None:
                return 0.0
            return max(0.0, now - self.last_activity_at)

    def is_running(self) -> bool:
        with self.lock:
            return self.started_at is not None and self.finished_at is None

    def row(self, now: float) -> tuple[str, ...]:
        """One table row: (model, status, elapsed, ttft, tokens, tok/s, tools, idle, note)."""
        with self.lock:
            if self.started_at is None:
                return (
                    self.label,
                    "queued",
                    "-",
                    "-",
                    "-",
                    "-",
                    "-",
                    "-",
                    self.note or "",
                )
            end = self.finished_at if self.finished_at is not None else now
            elapsed = end - self.started_at
            ttft = (
                "-"
                if self.first_token_at is None
                else f"{self.first_token_at - self.started_at:.1f}s"
            )
            if self.output_tokens:
                tokens = str(self.output_tokens)
            elif self.streamed_chars:
                tokens = f"~{self.streamed_chars // 4}"
            else:
                tokens = "-"
            speed = "-"
            if self.output_tokens and self.first_token_at is not None:
                window = end - self.first_token_at
                if window > 0:
                    speed = f"{self.output_tokens / window:.1f}"
            idle = "-"
            if self.finished_at is None and self.last_activity_at is not None:
                idle = f"{now - self.last_activity_at:.0f}s"
            status = (
                STATUS_LABELS.get(self.status, self.stage)
                if self.status
                else self.stage
            )
            return (
                self.label,
                status,
                f"{elapsed:.1f}s",
                ttft,
                tokens,
                speed,
                str(self.tool_calls or "-"),
                idle,
                self.note or "",
            )


class LiveTable:
    """One in-place repainted status table for the whole batch.

    A TTY gets a real dashboard (header, divider, one row per model, clamped to
    the window height). Non-TTY output falls back to a periodic plain snapshot so
    piped/CI runs still prove the batch is alive.
    """

    def __init__(
        self,
        entries: Sequence[ModelLive],
        *,
        stream: Any = None,
        enabled: bool = True,
        refresh: float = LIVE_REFRESH_SECONDS,
        heartbeat: float = LIVE_HEARTBEAT_SECONDS,
        height: int | None = None,
        title: str = "",
    ) -> None:
        self.entries = list(entries)
        self.stream = stream if stream is not None else sys.stderr
        self.refresh = refresh
        self.heartbeat = heartbeat
        self.height = height
        self.title = title
        self.enabled = enabled and bool(self.entries)
        self.tty = bool(getattr(self.stream, "isatty", lambda: False)())
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._painted_lines = 0
        self._last_heartbeat = 0.0

    # ── rendering ──
    def _viewport(self) -> int:
        if self.height is not None:
            return max(4, self.height)
        try:
            return max(8, shutil.get_terminal_size(fallback=(120, 30)).lines)
        except Exception:  # noqa: BLE001 — headless terminals report nothing
            return 30

    def render(self, now: float | None = None) -> str:
        moment = time.monotonic() if now is None else now
        header = " ".join(
            _cell(name, width, align) for name, width, align in LIVE_COLUMNS
        )
        divider = " ".join("─" * width for _name, width, _align in LIVE_COLUMNS)
        rows = [entry.row(moment) for entry in self.entries]
        # Rows keep their discovery order so nothing jumps between repaints;
        # running models are pulled to the top only when the window is too small
        # to show everything.
        budget = self._viewport() - 4  # title + header + divider + footer
        omitted = 0
        if len(rows) > budget > 0:
            running = [
                (entry, row)
                for entry, row in zip(self.entries, rows)
                if entry.is_running()
            ]
            finished = [
                (entry, row)
                for entry, row in zip(self.entries, rows)
                if not entry.is_running()
            ]
            keep = running[:budget]
            if len(keep) < budget:
                keep = keep + finished[-(budget - len(keep)) :]
            omitted = len(rows) - len(keep)
            rows = [row for _entry, row in keep]
        body = [
            " ".join(
                _cell(cell, width, align)
                for cell, (_n, width, align) in zip(row, LIVE_COLUMNS)
            )
            for row in rows
        ]
        done = sum(1 for entry in self.entries if entry.status is not None)
        footer = f"{done}/{len(self.entries)} finished"
        if omitted:
            footer += f"  (+{omitted} rows hidden — window too small)"
        footer += "   Ctrl+C: stop and print the table"
        lines = []
        if self.title:
            lines.append(self.title)
        lines.extend([header, divider, *body, footer])
        return "\n".join(lines)

    def paint(self, now: float | None = None) -> None:
        if not self.enabled:
            return
        moment = time.monotonic() if now is None else now
        text = self.render(moment)
        if self.tty:
            self._clear()
            self.stream.write(f"{text}\n")
            self.stream.flush()
            self._painted_lines = len(text.splitlines())
            return
        if moment - self._last_heartbeat < self.heartbeat:
            return
        self._last_heartbeat = moment
        self.stream.write(f"{text}\n\n")
        self.stream.flush()

    def _clear(self) -> None:
        if self._painted_lines <= 0:
            return
        self.stream.write(f"\x1b[{self._painted_lines}F\x1b[0J")
        self.stream.flush()
        self._painted_lines = 0

    # ── lifecycle ──
    def start(self) -> None:
        if not self.enabled or self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._loop, name="bench-live", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=2.0)
        if self.enabled and self.tty:
            self._clear()

    def _loop(self) -> None:
        while not self._stop.wait(self.refresh):
            self.paint()


# ─────────────────────────────────────────────────────────────────────────────
# Benchmark execution
# ─────────────────────────────────────────────────────────────────────────────


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_") or "model"


def _count_files(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    return sum(1 for path in directory.rglob("*") if path.is_file())


def _fire_and_forget(action: Callable[[], Any], name: str) -> None:
    """Run a possibly-blocking client call without stalling the poller.

    `abort()`/`stop()` are RPC round-trips: against a wedged omp process they can
    block for the whole request timeout, which is exactly the situation the
    caller is trying to escape.
    """

    def runner() -> None:
        try:
            action()
        except Exception:  # noqa: BLE001, S110 — teardown must never mask a result
            pass

    threading.Thread(target=runner, name=name, daemon=True).start()


class ModelIdentityError(RuntimeError):
    """The live session is not on the exact provider/model that was requested."""


def _pin_exact_model(client: Any, model: Any, result: BenchResult) -> None:
    """Force the session onto `model` and record what it actually resolved to.

    `set_model` takes an explicit provider + modelId pair, so it cannot drift to
    a sibling variant the way the fuzzy `--model` CLI selector can. The state
    read afterwards is the authority for what gets benchmarked.
    """
    try:
        client.set_model(model.provider, model.id)
    except Exception as exc:
        raise ModelIdentityError(
            f"could not select {model.provider}/{model.id}: {exc}"
        ) from exc

    live = getattr(client.get_state(), "model", None)
    if live is None:
        raise ModelIdentityError(
            f"session reported no active model for {model.provider}/{model.id}"
        )
    result.resolved_provider = live.provider
    result.resolved_model = live.id
    if (live.provider, live.id) != (model.provider, model.id):
        raise ModelIdentityError(
            f"requested {model.provider}/{model.id} but the session runs {live.provider}/{live.id}"
        )


@dataclass
class _StreamTally:
    """Streaming counters, so an aborted turn still reports what it produced."""

    first_token_at: float | None = None
    chars: int = 0
    output_tokens: int = 0
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    assistant_messages: int = 0
    tool_calls: int = 0
    tool_names: list[str] = field(default_factory=list)
    # Streamed answer text, so an aborted or result-less turn still saves a body.
    text_parts: list[str] = field(default_factory=list)


def _install_stream_listeners(
    client: Any, tally: _StreamTally, live: ModelLive | None
) -> None:
    def on_update(event: Any) -> None:
        payload = getattr(event, "assistant_message_event", None)
        event_type = payload.get("type") if isinstance(payload, dict) else None
        if event_type not in FIRST_TOKEN_EVENT_TYPES:
            return
        if tally.first_token_at is None:
            tally.first_token_at = time.monotonic()
        delta = payload.get("delta") if isinstance(payload, dict) else None
        chars = len(delta) if isinstance(delta, str) else 0
        if isinstance(delta, str) and event_type == "text_delta":
            tally.text_parts.append(delta)
        tally.chars += chars
        if live is not None:
            live.note_stream(chars)

    def on_message_end(event: Any) -> None:
        message = getattr(event, "message", None)
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return
        usage = message.get("usage")
        tally.assistant_messages += 1
        output = _usage_int(usage, "output")
        tally.output_tokens += output
        tally.input_tokens += _usage_int(usage, "input")
        tally.cache_read_tokens += _usage_int(usage, "cacheRead")
        tally.cache_write_tokens += _usage_int(usage, "cacheWrite")
        tally.total_tokens += _usage_int(usage, "totalTokens")
        tally.cost_usd += _usage_cost(usage)
        if live is not None and output:
            live.note_tokens(output)

    def on_tool_start(event: Any) -> None:
        name = getattr(event, "tool_name", None) or getattr(event, "toolName", None)
        tally.tool_calls += 1
        if isinstance(name, str):
            tally.tool_names.append(name)
        if live is not None:
            live.note_tool(name if isinstance(name, str) else None)

    client.on_message_update(on_update)
    if hasattr(client, "on_message_end"):
        client.on_message_end(on_message_end)
    if hasattr(client, "on_tool_execution_start"):
        client.on_tool_execution_start(on_tool_start)


def _apply_tally(result: BenchResult, tally: _StreamTally) -> None:
    """Use streamed counters when the turn never produced a final message set."""
    result.assistant_messages = tally.assistant_messages
    result.input_tokens = tally.input_tokens
    result.output_tokens = tally.output_tokens
    result.cache_read_tokens = tally.cache_read_tokens
    result.cache_write_tokens = tally.cache_write_tokens
    result.cost_usd = tally.cost_usd
    result.tool_calls = tally.tool_calls
    result.tool_names = list(tally.tool_names)
    result.total_tokens = tally.total_tokens or (
        tally.input_tokens
        + tally.output_tokens
        + tally.cache_read_tokens
        + tally.cache_write_tokens
    )


def run_model(
    model: Any,
    *,
    task: str,
    root: Path,
    client_factory: Callable[..., Any],
    max_event_history: int | None = None,
    executable: str = "omp",
    tools: Sequence[str] | None = None,
    config_path: Path | None = None,
    startup_timeout: float = 180.0,
    request_timeout: float = 180.0,
    turn_timeout: float | None = None,
    stall_timeout: float | None = None,
    cancel: threading.Event | None = None,
    live: ModelLive | None = None,
    abort_grace: float = ABORT_GRACE_SECONDS,
    on_progress: Callable[[str], None] | None = None,
    env: Mapping[str, str] | None = None,
    context_input_tokens: int | None = None,
) -> BenchResult:
    """Run one model end to end and collect its timing/token statistics.

    Every blocking phase (session start, model pin, the turn itself) runs on a
    worker thread while this function polls for cancellation, a stall, or a turn
    timeout — so Ctrl+C is honored during startup too, not just mid-stream.
    `turn_timeout` of `None` waits for the turn to end.
    """
    result = BenchResult(provider=model.provider, model=model.id, status=STATUS_FAILED)
    workdir = root / _safe_name(f"{model.provider}__{model.id}")
    workdir.mkdir(parents=True, exist_ok=True)
    result.workdir = str(workdir)
    if context_input_tokens is not None:
        # Size the probe to THIS model: a request is input + reserved output, so
        # asking for a whole advertised window always fails ("1048576 maximum …
        # you requested about 1447376 (1383376 of text input, 64000 in the
        # output)") even when the window is genuine.
        allowed = resolve_context_input_tokens(
            context_input_tokens,
            getattr(model, "contextWindow", None)
            or getattr(model, "context_window", None),
            getattr(model, "maxTokens", None) or getattr(model, "max_tokens", None),
        )
        task = build_context_probe_task(allowed)

    if cancel is not None and cancel.is_set():
        result.status = STATUS_SKIPPED
        result.error = "cancelled before start"
        if live is not None:
            live.finish(STATUS_SKIPPED, "not started")
        return result

    if live is not None:
        live.begin("starting")

    # Every benchmark instance runs without MCP and without extensions,
    # regardless of task. MCP servers are custom tools that mount even under an
    # empty tool allowlist, and each instance forks its own fleet (measured: 21
    # child processes per instance vs 1 with this flag, ~11 servers each). For
    # the tool-free tasks that is a tool leak; for `landing` — the only task
    # that legitimately needs tools — the built-in tools do the work and the MCP
    # fleet would just add startup cost and starve every other omp on the
    # machine during a parallel batch.
    #
    # `--no-fallback` pins the run to the model we selected: no role fallback,
    # no usage-aware switch, no chains. Without it a dead provider's turn is
    # answered by another model and credited to this row.
    extra_args: list[str] = ["--no-extensions", "--no-mcp", "--no-fallback"]
    if config_path is not None:
        extra_args.extend(["--config", str(config_path)])

    tally = _StreamTally()
    started = time.monotonic()
    state: dict[str, Any] = {"client": None, "prompt_started": None}

    def work() -> None:
        try:
            client = client_factory(
                executable=executable,
                provider=model.provider,
                model=model.id,
                cwd=str(workdir),
                session_dir=str(workdir / ".sessions"),
                tools=list(tools) if tools is not None else None,
                no_session=True,
                no_skills=True,
                no_rules=True,
                # A long landing-page turn streams far more than the library's
                # 10k-event default; overflowing it aborts the run with
                # "Event history limit was exceeded while waiting for agent_end".
                max_event_history=max_event_history,
                startup_timeout=startup_timeout,
                # Non-prompt commands (get_state, set_model, …) on a cold,
                # heavily parallel run need more than the 30s library default.
                request_timeout=request_timeout,
                extra_args=extra_args,
                env=dict(env) if env else None,
            )
            state["client"] = client
            client.start()
            _install_stream_listeners(client, tally, live)

            # `--model <id>` is fuzzy: a provider that serves several variants of
            # the same family can resolve every one of them to whichever matches
            # first. Re-pin the exact pair and verify what the session ended up
            # on, so each variant is measured as itself.
            if live is not None:
                live.set_stage("selecting")
            _pin_exact_model(client, model, result)

            if live is not None:
                live.set_stage("prompting")
            state["prompt_started"] = time.monotonic()
            state["turn"] = client.prompt_and_wait(task, timeout=turn_timeout)
            # omp's own tokens/second for the finished turn, straight from the
            # session state that feeds the status line. Read immediately: it is
            # derived from the last assistant message, so a later turn (or a
            # compaction) would move it.
            try:
                state["omp_tps"] = getattr(
                    client.get_state(), "tokens_per_second", None
                )
            except Exception as exc:  # noqa: BLE001 — the local rates still stand
                state["omp_tps_error"] = exc
        except BaseException as exc:  # noqa: BLE001 — reported by the poller
            state["error"] = exc

    worker = threading.Thread(target=work, name="bench-turn", daemon=True)
    worker.start()

    interrupt: str | None = None
    aborted_at: float | None = None
    abandoned = False
    while True:
        worker.join(0.2)
        if not worker.is_alive():
            break
        now = time.monotonic()
        prompt_started = state.get("prompt_started")
        if interrupt is None:
            reference = prompt_started if prompt_started is not None else started
            if cancel is not None and cancel.is_set():
                interrupt = STATUS_CANCELLED
            elif (
                turn_timeout
                and prompt_started is not None
                and now - prompt_started >= turn_timeout
            ):
                interrupt = STATUS_TIMEOUT
            elif stall_timeout:
                idle = live.idle_seconds(now) if live is not None else now - reference
                if idle >= stall_timeout:
                    interrupt = STATUS_STALLED
            if interrupt is not None:
                aborted_at = now
                if live is not None:
                    live.set_stage(f"aborting/{interrupt}")
                if on_progress:
                    on_progress(f"{interrupt} after {now - started:.1f}s — aborting")
                client = state.get("client")
                if client is not None:
                    _fire_and_forget(client.abort, "bench-abort")
        elif aborted_at is not None and now - aborted_at >= abort_grace:
            # The turn never unwound. Keep the measured numbers and let the
            # daemon worker die with the process.
            abandoned = True
            break

    finished = time.monotonic()
    prompt_started = state.get("prompt_started")
    reference = prompt_started if prompt_started is not None else started
    result.total_seconds = finished - reference
    if tally.first_token_at is not None:
        result.ttft_seconds = tally.first_token_at - reference
        result.generation_seconds = max(finished - tally.first_token_at, 0.0)
    else:
        result.generation_seconds = result.total_seconds
    result.streamed_chars = tally.chars

    omp_tps = state.get("omp_tps")
    if isinstance(omp_tps, (int, float)) and omp_tps > 0:
        result.omp_tps = float(omp_tps)

    turn = state.get("turn")
    worker_error = state.get("error")
    if turn is not None:
        summarize_turn(result, getattr(turn, "messages", ()) or ())
        if result.error_message:
            # A provider failure comes back as a normal turn whose assistant
            # message carries stopReason "error" — not a benchmarked run.
            result.status = STATUS_FAILED
            result.error = result.error_message
        elif mismatch := _answered_by_other_model(result):
            # The turn succeeded, but not on the model we pinned: a retry
            # fallback, a credential rotation, or a gateway serving a different
            # upstream. Crediting those tokens to the pinned model is how dead
            # providers scored "ok", so the row fails instead.
            result.status = STATUS_FAILED
            result.error = (
                f"answered by {mismatch}, not {result.provider}/{result.model}"
            )
        else:
            result.status = STATUS_OK
    else:
        _apply_tally(result, tally)
        if interrupt is not None:
            result.status = STATUS_ABANDONED if abandoned else interrupt
            suffix = " (abandoned, never unwound)" if abandoned else ""
            result.error = f"{interrupt} after {result.total_seconds:.1f}s{suffix}"
        elif worker_error is not None:
            result.status = STATUS_FAILED
            result.error = f"{type(worker_error).__name__}: {worker_error}"
        else:
            result.status = STATUS_FAILED
            result.error = "turn ended without a result"
    result.files_created = _count_files(workdir)

    # The answer itself. Counting characters and throwing the text away made a
    # whole sweep unreviewable, so every model's body lands next to its numbers.
    answer = collect_response_text(getattr(turn, "messages", ()) or ()) if turn else ""
    if not answer.strip():
        answer = "".join(tally.text_parts)
    if answer.strip():
        response_path = workdir / "response.md"
        try:
            response_path.write_text(answer, encoding="utf-8")
            result.response_path = str(response_path)
        except OSError as exc:  # a missing body must never fail the row
            if on_progress:
                on_progress(f"could not save response.md: {exc}")

    client = state.get("client")
    if client is not None:
        # Never block on teardown: a wedged process would hold the whole batch.
        _fire_and_forget(client.stop, "bench-stop")

    result.ok = result.status == STATUS_OK
    if live is not None:
        live.finish(result.status, None if result.ok else result.error)
    if on_progress:
        on_progress(
            f"done in {result.total_seconds:.1f}s"
            if result.ok
            else f"{result.status}: {result.error}"
        )
    return result


def _agent_dir() -> Path:
    """The agent directory this machine's omp would normally use."""
    override = os.environ.get("PI_CODING_AGENT_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".omp" / "agent"


def build_agent_sandbox(root: Path, *, log: Callable[[str], None] = print) -> Path:
    """Seed a throwaway agent dir that has credentials but no MCP/plugins.

    Copied in: auth, `models.yml` (custom providers) and the discovery cache so
    a sweep does not re-probe every provider. Never copied: `mcp.json`,
    `plugins/`, `extensions/` — their tools would mount despite `--no-tools`.
    """
    source = _agent_dir()
    sandbox = root / "_agent"
    sandbox.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    for name in SANDBOX_AGENT_FILES + SANDBOX_AGENT_CACHES:
        origin = source / name
        if not origin.is_file():
            continue
        try:
            shutil.copy2(origin, sandbox / name)
        except OSError as exc:
            log(f"sandbox: could not copy {name} ({exc})")
            continue
        copied.append(name)
    log(f"Agent sandbox: {sandbox} ({len(copied)} file(s) seeded, no MCP/plugins)")
    return sandbox


def sandbox_env(root: Path, *, log: Callable[[str], None] = print) -> dict[str, str]:
    """Environment that keeps a benchmark turn genuinely tool-free.

    `PI_CODING_AGENT_DIR` drops omp's own `mcp.json`/plugins, but MCP servers
    are also discovered from foreign home-directory configs (verified here:
    `~/.cursor/mcp.json` declares servers), so the home directory is redirected
    as well. Measured on one provider: 338 tools with neither, 91 with only the
    agent dir sandboxed, 0 with both plus the overlay's feature switches.

    The redirect is scoped to the spawned processes and the sandbox home is
    seeded with {@link SANDBOX_HOME_FILES}, so host settings a child may read
    (git identity above all) still resolve. Use `--no-sandbox` to bench against
    the real environment, tools included.
    """
    home = root / "_home"
    home.mkdir(parents=True, exist_ok=True)
    real_home = Path(
        os.environ.get("USERPROFILE") or os.environ.get("HOME") or Path.home()
    )
    for name in SANDBOX_HOME_FILES:
        origin = real_home / name
        if origin.is_file():
            try:
                shutil.copy2(origin, home / name)
            except OSError as exc:
                log(f"sandbox home: could not copy {name} ({exc})")
    # Only the spawned omp processes see this; the benchmark process keeps its
    # own environment, so nothing here can disturb the caller's shell.
    return {
        "PI_CODING_AGENT_DIR": str(build_agent_sandbox(root, log=log)),
        "HOME": str(home),
        "USERPROFILE": str(home),
    }


def discover_models(
    *,
    client_factory: Callable[..., Any],
    executable: str,
    cwd: Path,
    env: Mapping[str, str] | None = None,
) -> tuple[list[Any], list[str]]:
    """Return (available models, tool allowlist) from a short probe session."""
    with client_factory(
        executable=executable,
        cwd=str(cwd),
        no_session=True,
        no_skills=True,
        no_rules=True,
        startup_timeout=120.0,
        env=dict(env) if env else None,
        extra_args=["--no-extensions", "--no-mcp", "--no-fallback"],
    ) as client:
        models = list(client.get_available_models())
        tools: list[str] = []
        try:
            state = client.get_state()
        except Exception:  # noqa: BLE001 — tool discovery is best effort
            state = None
        for descriptor in getattr(state, "dump_tools", ()) or ():
            name = getattr(descriptor, "name", None)
            if isinstance(name, str) and name not in EXCLUDED_TOOLS:
                tools.append(name)
    return models, tools


# ─────────────────────────────────────────────────────────────────────────────
# Reporting
# ─────────────────────────────────────────────────────────────────────────────


def _fmt(value: float | None, spec: str = ".2f", dash: str = "-") -> str:
    return dash if value is None else format(value, spec)


def render_table(results: Sequence[BenchResult]) -> str:
    headers = (
        "provider",
        "model",
        "omp tps",
        "tps",
        "wall tps",
        "ttft s",
        "gen s",
        "total s",
        "out tok",
        "in tok",
        "tot tok",
        "tools",
        "cost $",
        "status",
        "note",
    )
    rows: list[tuple[str, ...]] = []
    for result in results:
        status = STATUS_LABELS.get(result.status, result.status)
        rows.append(
            (
                result.provider,
                result.model,
                _fmt(result.omp_tps),
                _fmt(result.output_tps),
                _fmt(result.wall_tps),
                _fmt(result.ttft_seconds),
                _fmt(result.generation_seconds),
                _fmt(result.total_seconds),
                str(result.output_tokens),
                str(result.input_tokens),
                str(result.total_tokens),
                str(result.tool_calls),
                _fmt(result.cost_usd, ".4f"),
                f"{status}*" if result.partial else status,
                "" if result.ok else one_line(result.error),
            )
        )
    widths = [
        max(len(headers[column]), *(len(row[column]) for row in rows))
        if rows
        else len(headers[column])
        for column in range(len(headers))
    ]
    line = " | ".join(
        header.ljust(widths[index]) for index, header in enumerate(headers)
    )
    separator = "-+-".join("-" * width for width in widths)
    body = [
        " | ".join(cell.ljust(widths[index]) for index, cell in enumerate(row))
        for row in rows
    ]
    footer = [
        "",
        "* partial: interrupted run, numbers cover what streamed before the stop.",
    ]
    return "\n".join(
        [line, separator, *body, *(footer if any(r.partial for r in results) else [])]
    )


def render_details(results: Sequence[BenchResult]) -> str:
    blocks: list[str] = []
    for result in results:
        lines = [f"{result.provider}/{result.model}"]
        resolved = (
            f"{result.resolved_provider}/{result.resolved_model}"
            if result.resolved_provider and result.resolved_model
            else None
        )
        if resolved and resolved != f"{result.provider}/{result.model}":
            lines.append(f"  session ran on        : {resolved}")
        if result.ok or result.partial:
            if not result.ok:
                lines.append(
                    f"  PARTIAL ({result.status}) : {one_line(result.error, 120)}"
                )
            lines.extend(
                [
                    f"  tokens/s (omp)        : {_fmt(result.omp_tps)}",
                    f"  tokens/s (generation) : {_fmt(result.output_tps)}",
                    f"  tokens/s (wall clock) : {_fmt(result.wall_tps)}",
                    f"  time to first token   : {_fmt(result.ttft_seconds)} s",
                    f"  generation time       : {_fmt(result.generation_seconds)} s",
                    f"  total turn time       : {_fmt(result.total_seconds)} s",
                    f"  tokens in/out         : {result.input_tokens} / {result.output_tokens}",
                    f"  cache read/write      : {result.cache_read_tokens} / {result.cache_write_tokens}",
                    f"  total tokens          : {result.total_tokens}",
                    f"  cost                  : ${result.cost_usd:.4f}",
                    f"  assistant messages    : {result.assistant_messages}",
                    f"  tool calls            : {result.tool_calls}"
                    + (
                        f" ({', '.join(result.tool_names)})"
                        if result.tool_names
                        else ""
                    ),
                    f"  streamed characters   : {result.streamed_chars}",
                    f"  response characters   : {result.response_chars}",
                    f"  answer                : {result.response_path or '-'}",
                    f"  files written         : {result.files_created}",
                    f"  stop reason           : {result.stop_reason or '-'}",
                    f"  workdir               : {result.workdir}",
                ]
            )
        else:
            label = STATUS_LABELS.get(result.status, result.status)
            lines.append(f"  {label}: {one_line(result.error, 200)}")
            lines.append(f"  workdir               : {result.workdir}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def render_summary(results: Sequence[BenchResult]) -> str:
    measured = [result for result in results if result.ok or result.partial]
    speeds = [result.output_tps for result in measured if result.output_tps is not None]
    ttfts = [
        result.ttft_seconds for result in measured if result.ttft_seconds is not None
    ]
    counts: dict[str, int] = {}
    for result in results:
        counts[result.status] = counts.get(result.status, 0) + 1
    breakdown = ", ".join(
        f"{count} {STATUS_LABELS.get(status, status)}"
        for status, count in sorted(counts.items())
    )
    lines = [
        f"models benchmarked : {len(results)} ({breakdown})",
        f"total tokens       : {sum(result.total_tokens for result in measured)}",
        f"total output tokens: {sum(result.output_tokens for result in measured)}",
        f"total cost         : ${sum(result.cost_usd for result in measured):.4f}",
        f"total wall time    : {sum(result.total_seconds for result in results):.1f} s",
    ]
    if speeds:
        fastest = max(measured, key=lambda result: result.output_tps or 0.0)
        slowest = min(measured, key=lambda result: result.output_tps or 0.0)
        lines.extend(
            [
                f"fastest            : {fastest.provider}/{fastest.model} at {_fmt(fastest.output_tps)} tok/s",
                f"slowest            : {slowest.provider}/{slowest.model} at {_fmt(slowest.output_tps)} tok/s",
                f"median tokens/s    : {statistics.median(speeds):.2f}",
            ]
        )
    if ttfts:
        lines.append(f"median ttft        : {statistics.median(ttfts):.2f} s")
    return "\n".join(lines)


def build_report(
    *,
    query: str,
    mode: MatchMode,
    topic: str,
    task: str,
    provider: str | None = None,
    tools_enabled: bool = True,
    results: Sequence[BenchResult],
    root: Path,
    cancelled: bool = False,
) -> dict[str, Any]:
    ranked = sorted(
        results,
        key=lambda result: (
            not (result.ok or result.partial),
            -(result.output_tps or 0.0),
        ),
    )
    status_counts: dict[str, int] = {}
    for result in results:
        status_counts[result.status] = status_counts.get(result.status, 0) + 1
    return {
        "query": query,
        "match_mode": mode,
        "provider": provider,
        "topic": topic,
        "task": task,
        "tools_enabled": tools_enabled,
        "workdir_root": str(root),
        "cancelled": cancelled,
        "model_count": len(results),
        "successful_models": sum(1 for result in results if result.ok),
        "partial_models": sum(1 for result in results if result.partial),
        "failed_models": sum(1 for result in results if not result.ok),
        "status_counts": status_counts,
        "results": [result.as_dict() for result in ranked],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ─────────────────────────────────────────────────────────────────────────────


def _ask(prompt: str, default: str | None = None, *, allow_empty: bool = False) -> str:
    """Read one answer. `allow_empty` returns "" instead of re-asking forever."""
    suffix = f" [{default}]" if default else ""
    while True:
        answer = input(f"{prompt}{suffix}: ").strip()
        if answer:
            return answer
        if default is not None:
            return default
        if allow_empty:
            return ""


def resolve_prompt_input(answer: str) -> str:
    """Prompt text from a typed answer, reading a file when one was named.

    Typing `--prompt-file C:\\path\\prompt.txt` (or just the path) at the prompt
    used to benchmark that literal string against every model — a silent, very
    expensive misread. A named file is read instead.
    """
    text = answer.strip()
    for flag in ("--prompt-file", "--prompt_file", "-f"):
        if text.lower().startswith(f"{flag} "):
            text = text[len(flag) :].strip()
            break
    unquoted = text.strip('"').strip("'")
    if not unquoted:
        return answer
    try:
        candidate = Path(unquoted).expanduser()
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8")
    except OSError:
        return answer
    return answer


def _ask_custom_prompt() -> str:
    """Read a one-line custom prompt, or the contents of a named prompt file."""
    return resolve_prompt_input(
        _ask("custom prompt (or a path / --prompt-file <path> for multi-line text)")
    )


def render_prompt_preview(task: str, *, task_name: str | None, lines: int = 12) -> str:
    """Exactly what will be sent: size, then the head of the real prompt text."""
    body = task.splitlines()
    head = body[:lines]
    shown = "\n".join(f"  │ {line}" for line in head) or "  │"
    suffix = f"\n  │ … {len(body) - lines} more line(s)" if len(body) > lines else ""
    return (
        f"Prompt ({task_name or 'prose'}): {len(task)} chars, {len(body)} line(s)\n"
        f"{shown}{suffix}"
    )


def create_run_dir(parent: Path) -> Path:
    """Create one collision-safe timestamped child directory per CLI invocation."""
    parent.mkdir(parents=True, exist_ok=True)
    stem = time.strftime("bench-tps-%Y%m%d-%H%M%S")
    for sequence in range(1, 10_000):
        candidate = parent / (stem if sequence == 1 else f"{stem}-{sequence:02d}")
        try:
            candidate.mkdir()
        except FileExistsError:
            continue
        return candidate
    raise RuntimeError(f"could not create a unique results directory under {parent}")


def _ask_int(prompt: str, default: int, *, minimum: int = 0) -> int:
    """Read a non-negative integer, re-asking until the answer parses."""
    while True:
        answer = _ask(prompt, str(default))
        try:
            value = int(answer)
        except ValueError:
            print(f"  not a number: {answer!r}")
            continue
        if value < minimum:
            print(f"  must be >= {minimum}")
            continue
        return value


# Interactive menu for `--task`, in the order an operator usually wants them:
# smallest/fastest first, the long decode measurement last.
TASK_MENU: tuple[tuple[str, str, str], ...] = (
    ("a", "hi", "one-word reply — round-trip latency, not decode rate"),
    ("b", "dialogue", "creative scene, ~1-2 A4 pages — mid-length decode"),
    ("c", "prose", "long technical essay (~1400 words) — clean decode rate"),
    ("d", "context", "~1M-token INPUT, one-word output — is the window real?"),
    ("e", "landing", "landing page with tools and file writes"),
    ("f", "custom", "your exact prompt, with MCP and tools disabled"),
)


def _ask_task(default: str = "prose") -> str:
    """Pick the benchmark prompt. Accepts the letter or the task name."""
    print("prompt to benchmark:")
    for letter, name, blurb in TASK_MENU:
        marker = " (default)" if name == default else ""
        print(f"  {letter}) {name:<9} {blurb}{marker}")
    by_letter = {letter: name for letter, name, _ in TASK_MENU}
    names = {name for _, name, _ in TASK_MENU}
    while True:
        answer = _ask("task", default).strip().lower()
        if answer in by_letter:
            return by_letter[answer]
        if answer in names:
            return answer
        print(
            f"  pick one of {', '.join(sorted(by_letter))} or {', '.join(sorted(names))}"
        )


def bench(
    *,
    context_input_tokens: int | None = None,
    query: str,
    mode: MatchMode,
    topic: str,
    provider: str | None = None,
    provider_model_queries: Sequence[str] = (),
    limit: int = 0,
    task_text: str | None = None,
    task_name: str | None = None,
    use_tools: bool = True,
    sandbox_agent_dir: bool = False,
    executable: str,
    root: Path,
    client_factory: Callable[..., Any],
    jobs: int = 0,
    turn_timeout: float | None = None,
    stall_timeout: float | None = None,
    max_event_history: int | None = None,
    keep_workdirs: bool = True,
    cancel: threading.Event | None = None,
    cancel_grace: float = CANCEL_GRACE_SECONDS,
    live_stream: Any = None,
    live: bool = True,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Benchmark every matching model.

    `jobs` bounds how many models run at once: 0 (default) runs them all
    concurrently, 1 serializes them.

    Setting `cancel` stops the batch: running models are aborted and keep their
    partial numbers, queued models are recorded as skipped, and anything still
    stuck after `cancel_grace` seconds is abandoned so the report always prints.
    """
    root.mkdir(parents=True, exist_ok=True)
    config_path = root / "bench-overlay.yml"
    config_path.write_text(CONFIG_OVERLAY, encoding="utf-8")
    probe_dir = root / "_probe"
    probe_dir.mkdir(parents=True, exist_ok=True)
    log_path = root / "bench.log"
    log_lock = threading.Lock()

    def record(message: str) -> None:
        """Per-model chatter goes to the log file, never over the live table."""
        with log_lock, log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%H:%M:%S')} {message}\n")

    # `--no-mcp` (passed per run below) is what keeps a tool-free turn actually
    # tool-free. The agent-dir/home sandbox is only needed to ALSO hide
    # foreign config (skills, plugins, project rules) — it is opt-in because
    # redirecting HOME costs the child its git identity and other host state,
    # and because credentials for OAuth providers live in the real agent dir.
    env: dict[str, str] | None = None
    if sandbox_agent_dir and not use_tools:
        env = sandbox_env(root, log=log)

    log("Discovering models…")
    models, tools = discover_models(
        client_factory=client_factory,
        executable=executable,
        cwd=probe_dir,
        env=env,
    )
    if provider:
        selected = filter_provider_models(
            select_provider_models(models, provider), provider_model_queries
        )
        if not selected:
            known = ", ".join(available_providers(models)) or "none"
            requested = ", ".join(provider_model_queries)
            suffix = f' matching "{requested}"' if requested else ""
            raise SystemExit(
                f'No available model for provider "{provider}"{suffix}. Providers with '
                f"models: {known}."
            )
        label = f"provider {provider}"
        if provider_model_queries:
            label += f" ({', '.join(provider_model_queries)})"
    else:
        selected = select_models(models, query, mode)
        if not selected:
            raise SystemExit(
                f'No model matched "{query}" in {mode} mode ({len(models)} models available).'
            )
        label = f"{query} ({mode})"
    if limit > 0 and len(selected) > limit:
        log(f"Limiting to the first {limit} of {len(selected)} model(s).")
        selected = selected[:limit]

    # An empty allowlist becomes `--no-tools`, which is what a throughput run
    # wants: no tool call can interleave local work with decode.
    if not use_tools:
        tools = []

    task = task_text if task_text is not None else TASK_TEMPLATE.format(topic=topic)
    (root / "prompt.txt").write_text(task, encoding="utf-8")
    selection = {
        "task": task_name,
        "query": query,
        "match_mode": mode,
        "provider": provider,
        "provider_model_queries": list(provider_model_queries),
        "selected_models": [
            {"provider": str(model.provider), "model": str(model.id)}
            for model in selected
        ],
        "tools_enabled": bool(tools),
        "mcp_enabled": False,
        "extensions_enabled": False,
    }
    (root / "selection.json").write_text(
        json.dumps(selection, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    if jobs > 0:
        workers = max(1, min(jobs, len(selected)))
    elif provider:
        # A provider sweep can be hundreds of models (316 on one gateway here);
        # "all at once" would both melt the uplink and destroy the very number
        # being measured. Throughput runs want little or no contention.
        workers = min(PROVIDER_SWEEP_DEFAULT_JOBS, len(selected))
    else:
        workers = len(selected)
    if workers > 1:
        log(
            f"Running {workers} at a time — pass --jobs 1 for contention-free "
            "tokens/second."
        )
    log(render_prompt_preview(task, task_name=task_name))
    log(
        f"Tools: {'none (--no-mcp, no builtins)' if not tools else f'{len(tools)} allowed'}"
        + (" · sandboxed agent dir/home" if env else "")
    )
    log(
        f"Matched {len(selected)} model(s), running {workers} at a time. Log: {log_path}"
    )

    lives = [ModelLive(label=f"{model.provider}/{model.id}") for model in selected]
    table = LiveTable(
        lives,
        stream=live_stream,
        enabled=live,
        title=f"bench: {label}",
    )
    table.start()

    results: list[BenchResult | None] = [None] * len(selected)
    slots = threading.Semaphore(workers)
    threads: list[threading.Thread] = []

    def run_one(index: int, model: Any, model_live: ModelLive) -> None:
        with slots:
            record(f"{model_live.label}: started")
            results[index] = run_model(
                model,
                task=task,
                context_input_tokens=context_input_tokens,
                root=root,
                client_factory=client_factory,
                executable=executable,
                # `tools or None` would collapse the tool-free allowlist back to
                # "provider default", silently re-enabling every builtin.
                tools=tools,
                config_path=config_path,
                turn_timeout=turn_timeout,
                stall_timeout=stall_timeout,
                max_event_history=max_event_history,
                cancel=cancel,
                live=model_live,
                on_progress=lambda message, label=model_live.label: record(
                    f"{label}: {message}"
                ),
                env=env,
            )

    for index, (model, model_live) in enumerate(zip(selected, lives)):
        # Daemon threads: an abandoned straggler can never keep the process (or
        # the report) waiting at exit.
        thread = threading.Thread(
            target=run_one,
            args=(index, model, model_live),
            name=f"bench-{index}",
            daemon=True,
        )
        thread.start()
        threads.append(thread)

    try:
        cancel_deadline: float | None = None
        while True:
            alive = [thread for thread in threads if thread.is_alive()]
            if not alive:
                break
            if cancel is not None and cancel.is_set():
                if cancel_deadline is None:
                    cancel_deadline = time.monotonic() + cancel_grace
                elif time.monotonic() >= cancel_deadline:
                    record(
                        f"cancel grace elapsed with {len(alive)} model(s) still running"
                    )
                    break
            time.sleep(0.2)
    finally:
        table.stop()

    for index, (model, model_live) in enumerate(zip(selected, lives)):
        if results[index] is not None:
            continue
        status = (
            STATUS_ABANDONED if model_live.started_at is not None else STATUS_SKIPPED
        )
        abandoned = BenchResult(
            provider=model.provider,
            model=model.id,
            status=status,
            error="abandoned after Ctrl+C"
            if status == STATUS_ABANDONED
            else "not started",
            workdir=str(root / _safe_name(f"{model.provider}__{model.id}")),
        )
        if model_live.started_at is not None:
            now = time.monotonic()
            abandoned.total_seconds = now - model_live.started_at
            abandoned.output_tokens = model_live.output_tokens
            abandoned.streamed_chars = model_live.streamed_chars
            abandoned.tool_calls = model_live.tool_calls
            if model_live.first_token_at is not None:
                abandoned.ttft_seconds = (
                    model_live.first_token_at - model_live.started_at
                )
                abandoned.generation_seconds = max(now - model_live.first_token_at, 0.0)
        model_live.finish(status, abandoned.error)
        results[index] = abandoned

    final = [result for result in results if result is not None]
    was_cancelled = cancel is not None and cancel.is_set()
    report = build_report(
        query=query,
        mode=mode,
        topic=topic,
        task=task,
        provider=provider,
        tools_enabled=bool(tools),
        results=final,
        root=root,
        cancelled=was_cancelled,
    )
    (root / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    if not keep_workdirs:
        for result in final:
            if result.workdir:
                shutil.rmtree(result.workdir, ignore_errors=True)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", help="model name to benchmark (skips the prompt)")
    parser.add_argument(
        "--provider",
        help="benchmark every available model of this provider (instead of --model)",
    )
    parser.add_argument(
        "--models",
        help="comma-separated partial model ids for --provider; terminal omission asks, unattended selects all",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        metavar="N",
        help="benchmark at most the first N selected models (default 0 = all)",
    )
    parser.add_argument(
        "--task",
        choices=("prose", "dialogue", "hi", "context", "landing", "custom"),
        default=None,
        help="prose (default) streams a long technical essay with tools disabled "
        "— a clean decode-rate measurement; dialogue streams a ~1-2 A4 page "
        "creative scene (shorter run, narrative sampling profile); hi sends a "
        "one-word prompt, so the number reflects round-trip latency rather than "
        "decode rate; context sends a ~1M-token input for a one-word answer to "
        "test whether an advertised window is real (`--input-tokens`); landing "
        "writes files and calls tools; custom sends exact prompt text with tools and MCP disabled",
    )
    parser.add_argument(
        "--subject",
        help="prose/dialogue subject (default: a random subject for the task)",
    )
    parser.add_argument(
        "--words",
        type=int,
        default=None,
        metavar="N",
        help="target word count for prose/dialogue (default: 1400 for prose, "
        "900 for dialogue — about 1-2 A4 pages)",
    )
    parser.add_argument(
        "--input-tokens",
        type=int,
        default=1_000_000,
        metavar="N",
        help="context-task input size in tokens (default 1000000). The reported "
        "`in tok` column is what the provider actually accepted",
    )
    parser.add_argument(
        "--prompt", help="exact custom benchmark prompt (implies --task custom)"
    )
    parser.add_argument(
        "--prompt-file",
        type=Path,
        help="read exact custom benchmark prompt from this UTF-8 file (implies --task custom)",
    )
    parser.add_argument(
        "--match",
        choices=("partial", "full"),
        help="partial = substring match; full = exact id (vendor namespace ignored)",
    )
    parser.add_argument("--topic", help="landing-page topic (default: random)")
    parser.add_argument("--omp", default="omp", help="omp executable (default: omp)")
    parser.add_argument(
        "--out",
        help="parent results directory; every invocation creates a timestamped child (default: runs/bench-tps)",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=None,
        metavar="N",
        help="models to run concurrently: 0 = default (all for --model, "
        f"{PROVIDER_SWEEP_DEFAULT_JOBS} for a --provider sweep), 1 = one at a "
        "time for contention-free tokens/second",
    )
    parser.add_argument(
        "--turn-timeout",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="abort a model after this many seconds (default 0 = wait for the turn to end)",
    )
    parser.add_argument(
        "--stall-timeout",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="abort a model that streamed nothing for this long (default 0 = off)",
    )
    parser.add_argument(
        "--cancel-grace",
        type=float,
        default=CANCEL_GRACE_SECONDS,
        metavar="SECONDS",
        help=f"after Ctrl+C, wait at most this long for stragglers (default {CANCEL_GRACE_SECONDS:.0f})",
    )
    parser.add_argument(
        "--max-events",
        type=int,
        default=0,
        metavar="N",
        help="streamed events kept per model (default 0 = unlimited); a long turn "
        "overflows a bounded history and aborts the run",
    )
    parser.add_argument(
        "--sandbox",
        action="store_true",
        help="also seed an isolated agent dir and home for tool-free runs "
        "(hides skills/plugins/rules too); MCP is already disabled via --no-mcp, "
        "and this loses OAuth credentials that live in the real agent dir",
    )
    parser.add_argument("--no-live", action="store_true", help="disable the live table")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="delete per-model workdirs after the run; keep prompt, metadata, log, and report",
    )
    args = parser.parse_args(argv)

    if args.prompt is not None and args.prompt_file is not None:
        parser.error("--prompt and --prompt-file are mutually exclusive")
    if (args.prompt is not None or args.prompt_file is not None) and args.task not in {
        None,
        "custom",
    }:
        parser.error("--prompt/--prompt-file require --task custom")
    if args.prompt is not None or args.prompt_file is not None:
        args.task = "custom"

    provider = args.provider
    if provider and args.model:
        parser.error("--provider and --model are mutually exclusive")
    if args.models and not provider:
        parser.error("--models requires --provider")
    if provider:
        query, mode = "", "partial"
        provider_model_queries = resolve_provider_model_queries(
            args.models, interactive=sys.stdin.isatty()
        )
    else:
        provider_model_queries = ()
        query = args.model or _ask(
            "hi, set model to bench (or leave empty to bench a whole provider)",
            allow_empty=True,
        )
        if query:
            mode = (
                args.match
                or _ask("Partial match or full? (partial/full)", "partial").lower()
            )
            if mode not in {"partial", "full"}:
                parser.error('--match must be "partial" or "full"')
        else:
            provider = _ask("provider to bench (empty aborts)", allow_empty=True)
            if not provider:
                parser.error("no model and no provider given — nothing to benchmark")
            mode = "partial"
            provider_model_queries = parse_model_queries(
                _ask(
                    "Specify model(s) to use, use , for multiple, leave blank for all",
                    allow_empty=True,
                )
            )
            if args.jobs is None:
                args.jobs = _ask_int(
                    "parallel workers (1 = contention-free, 0 = all at once)",
                    PROVIDER_SWEEP_DEFAULT_JOBS,
                )
    topic = args.topic or random.choice(TOPICS)
    # No `--task`: ask, so the operator picks the prompt shape deliberately
    # instead of silently getting the long essay. Non-interactive callers (no
    # tty) keep the documented default.
    if args.task is None:
        args.task = _ask_task() if sys.stdin.isatty() else "prose"
    if args.task == "prose":
        subject = args.subject or random.choice(PROSE_SUBJECTS)
        task_text = PROSE_TASK_TEMPLATE.format(
            words=args.words or 1400, subject=subject
        )
    elif args.task == "dialogue":
        subject = args.subject or random.choice(DIALOGUE_SUBJECTS)
        task_text = DIALOGUE_TASK_TEMPLATE.format(
            words=args.words or 900, subject=subject
        )
    elif args.task == "hi":
        subject = None
        task_text = HI_TASK
    elif args.task == "context":
        subject = None
        task_text = build_context_probe_task(args.input_tokens)
    elif args.task == "custom":
        subject = None
        if args.prompt_file is not None:
            try:
                task_text = args.prompt_file.expanduser().read_text(encoding="utf-8")
            except OSError as exc:
                parser.error(f"could not read --prompt-file {args.prompt_file}: {exc}")
        else:
            task_text = args.prompt if args.prompt is not None else _ask_custom_prompt()
        if not task_text.strip():
            parser.error("custom prompt must not be empty")
        # A wrong prompt costs the whole sweep, so show the real text and get an
        # explicit yes before any model is dialed.
        if sys.stdin.isatty():
            print(render_prompt_preview(task_text, task_name="custom"))
            if _ask("send this prompt? (y/n)", "y").strip().lower() not in {
                "y",
                "yes",
            }:
                parser.error("aborted: custom prompt not confirmed")
    else:
        subject = None
        task_text = None
    # Declarative, so a task added above cannot accidentally inherit tools.
    # Custom prompts intentionally stay tool-free, even if their text requests tools.
    use_tools = args.task in TASKS_WITH_TOOLS
    parent = (
        Path(args.out).expanduser().resolve()
        if args.out
        else _REPO_ROOT / "runs" / "bench-tps"
    )
    root = create_run_dir(parent)

    from omp_rpc import RpcClient  # imported late so --help works without the package

    cancel = threading.Event()
    previous_handler = signal.getsignal(signal.SIGINT)

    def handle_sigint(_signum: int, _frame: Any) -> None:
        if cancel.is_set():
            # Second Ctrl+C: stop right now, no teardown, no waiting.
            print("\nSecond Ctrl+C — exiting now.", file=sys.stderr)
            os._exit(130)
        cancel.set()
        print(
            f"\nCtrl+C — aborting running models (max {args.cancel_grace:.0f}s), "
            "skipping the rest; the table follows.",
            file=sys.stderr,
        )

    signal.signal(signal.SIGINT, handle_sigint)
    try:
        report = bench(
            query=query,
            mode=mode,
            topic=topic,
            provider=provider,
            provider_model_queries=provider_model_queries,
            limit=args.limit,
            jobs=args.jobs if args.jobs is not None else 0,
            task_text=task_text,
            task_name=args.task,
            context_input_tokens=args.input_tokens if args.task == "context" else None,
            use_tools=use_tools,
            sandbox_agent_dir=args.sandbox,
            executable=args.omp,
            root=root,
            client_factory=RpcClient,
            turn_timeout=args.turn_timeout if args.turn_timeout > 0 else None,
            stall_timeout=args.stall_timeout if args.stall_timeout > 0 else None,
            max_event_history=args.max_events if args.max_events > 0 else None,
            keep_workdirs=not args.clean,
            cancel=cancel,
            cancel_grace=args.cancel_grace,
            live=not args.no_live,
        )
    finally:
        signal.signal(signal.SIGINT, previous_handler)  # type: ignore[arg-type]
    results = [
        BenchResult(
            **{
                key: value
                for key, value in entry.items()
                if key not in {"output_tps", "wall_tps", "partial"}
            }
        )
        for entry in report["results"]
    ]

    print()
    print(render_table(results))
    print()
    print(render_details(results))
    print()
    print(render_summary(results))
    print()
    print(f"report: {root / 'report.json'}")
    print(f"log:    {root / 'bench.log'}")
    print(f"answers: {root}\\<provider>__<model>\\response.md")
    if report["cancelled"]:
        return 130
    return 0 if report["successful_models"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
