#!/usr/bin/env python
"""Measure interactive typing latency of the omp TUI through a real ConPTY.

Typing lag is keystroke -> repaint latency, which no RPC probe can see: RPC has
no TUI, no renderer and no input controller. This drives the real interactive
binary through a pseudo-terminal, writes one character at a time, and records
how long the terminal takes to emit the repaint for it.

Reported per arm: latency percentiles, the repaint byte volume per keystroke
(a renderer that redraws the whole transcript per key shows up here), and the
worst stalls.

Usage:
  python scripts/typing_latency_pty.py --keys 120
  python scripts/typing_latency_pty.py --keys 120 --arms real,no-mcp,minimal
  python scripts/typing_latency_pty.py --exe "C:/path/to/older/omp.exe" --arms real
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    from winpty import PtyProcess
except ImportError:  # pragma: no cover
    sys.exit("pywinpty required: pip install pywinpty")

AGENT_DIR = Path(os.path.expanduser("~/.omp/agent"))
REPO = Path(__file__).resolve().parent.parent

MINIMAL_MODELS_YML = """providers:
  probe-local:
    baseUrl: "http://127.0.0.1:9/v1"
    api: openai-completions
    auth: none
"""

# arm -> (extra args, keep real models.yml + db, keep extensions)
ARMS: dict[str, tuple[tuple[str, ...], str, bool]] = {
    "real": ((), "full", True),
    "no-mcp": (("--no-mcp",), "full", True),
    "no-ext": (("--no-mcp", "--no-extensions"), "full", True),
    "minimal": (("--no-mcp", "--no-extensions"), "minimal", False),
    # Minimal catalog but MCP + extensions ON: isolates fan-out cost from the
    # configured provider count.
    "mcp-only": ((), "minimal", True),
    # Real catalog, MCP off, extensions ON: isolates extension cost.
    "ext-only": (("--no-mcp",), "full", True),
    # Real 90-provider models.yml but NO discovery cache: separates the cost of
    # the configured provider set from the 15k discovered models it produces.
    "yml-only": (("--no-mcp", "--no-extensions"), "yml", False),
}

# Typed characters avoid `/` and `@` so no completion popup skews the sample.
SAMPLE_TEXT = "the quick brown fox jumps over the lazy dog while typing steadily "


@dataclass
class ArmResult:
    arm: str
    boot_s: float = 0.0
    latencies_ms: list[float] = field(default_factory=list)
    bytes_per_key: list[int] = field(default_factory=list)
    dropped: int = 0
    error: str | None = None

    def pct(self, q: float) -> float:
        if not self.latencies_ms:
            return 0.0
        vals = sorted(self.latencies_ms)
        return vals[min(len(vals) - 1, int(len(vals) * q))]


def build_agent_dir(arm: str, models_mode: str, keep_ext: bool) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix=f"omp-typing-{arm}-"))
    for name in ("config.yml", "auth.db", "auth.json"):
        src = AGENT_DIR / name
        if src.exists():
            shutil.copy2(src, tmp / name)
    if models_mode in ("full", "yml"):
        names = ("models.yml", "models.db") if models_mode == "full" else ("models.yml",)
        for name in names:
            src = AGENT_DIR / name
            if src.exists():
                shutil.copy2(src, tmp / name)
    else:
        (tmp / "models.yml").write_text(MINIMAL_MODELS_YML, encoding="utf-8")
    if keep_ext and (AGENT_DIR / "extensions").exists():
        shutil.copytree(AGENT_DIR / "extensions", tmp / "extensions", dirs_exist_ok=True)
    return tmp


class Reader:
    """Background pty reader: timestamps every chunk as it arrives.

    `PtyProcess.read` blocks, so latency has to be measured by a thread that is
    always parked in `read` — polling would fold the poll interval into every
    sample.
    """

    def __init__(self, proc: PtyProcess) -> None:
        self.proc = proc
        self.chunks: list[tuple[float, int]] = []
        self.lock = threading.Lock()
        self.alive = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self) -> None:
        while self.alive:
            try:
                data = self.proc.read(65536)
            except (EOFError, OSError):
                break
            if not data:
                continue
            with self.lock:
                self.chunks.append((time.monotonic(), len(data)))

    def mark(self) -> int:
        with self.lock:
            return len(self.chunks)

    def wait_after(self, index: int, sent: float, budget_s: float) -> tuple[float, int]:
        """First chunk timestamp/byte total produced after `index`."""
        end = time.monotonic() + budget_s
        while time.monotonic() < end:
            with self.lock:
                if len(self.chunks) > index:
                    first_at = self.chunks[index][0]
                    total = sum(n for _, n in self.chunks[index:])
                    if time.monotonic() - first_at > 0.05:
                        return (first_at - sent) * 1000.0, total
            time.sleep(0.002)
        with self.lock:
            if len(self.chunks) > index:
                first_at = self.chunks[index][0]
                return (first_at - sent) * 1000.0, sum(n for _, n in self.chunks[index:])
        return (-1.0, 0)

    def stop(self) -> None:
        self.alive = False


def run_arm(arm: str, keys: int, boot_wait: float, per_key_budget: float, key_delay: float = 0.0) -> ArmResult:
    extra, models_mode, keep_ext = ARMS[arm]
    result = ArmResult(arm=arm)
    agent_dir = build_agent_dir(arm, models_mode, keep_ext)
    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    home = agent_dir / "home"
    home.mkdir(exist_ok=True)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    env["TERM"] = "xterm-256color"

    exe = env.get("OMP_TYPING_EXE") or "omp"
    argv = [exe, *extra]
    started = time.monotonic()
    try:
        proc = PtyProcess.spawn(argv, cwd=str(REPO), env=env, dimensions=(40, 140))
    except Exception as exc:  # noqa: BLE001 - surfaced as arm error
        result.error = f"spawn failed: {exc}"
        shutil.rmtree(agent_dir, ignore_errors=True)
        return result

    reader = Reader(proc)
    try:
        # Boot: let the prompt paint and background discovery settle.
        time.sleep(boot_wait)
        result.boot_s = time.monotonic() - started

        for i in range(keys):
            ch = SAMPLE_TEXT[i % len(SAMPLE_TEXT)]
            index = reader.mark()
            sent = time.monotonic()
            try:
                proc.write(ch)
            except (EOFError, OSError) as exc:
                result.error = f"write failed after {i} keys: {exc}"
                break
            latency_ms, total_bytes = reader.wait_after(index, sent, per_key_budget)
            if latency_ms < 0:
                result.dropped += 1
                continue
            result.latencies_ms.append(latency_ms)
            result.bytes_per_key.append(total_bytes)
            if key_delay:
                time.sleep(key_delay)
        try:
            proc.write("\x15")  # ctrl+u clears the line before teardown
        except (EOFError, OSError):
            pass
    finally:
        reader.stop()
        try:
            proc.terminate(force=True)
        except Exception:  # noqa: BLE001 - best-effort teardown
            pass
        shutil.rmtree(agent_dir, ignore_errors=True)
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", type=int, default=120)
    ap.add_argument("--arms", default="real,no-mcp,minimal")
    ap.add_argument("--boot-wait", type=float, default=12.0)
    ap.add_argument("--per-key-budget", type=float, default=2.0)
    ap.add_argument("--key-delay", type=float, default=0.0, help="pause between keys; 1.0 = slow cadence")
    ap.add_argument("--exe", default=None, help="omp executable to test")
    ap.add_argument("--json", default=None, help="write raw samples here")
    args = ap.parse_args()

    if args.exe:
        os.environ["OMP_TYPING_EXE"] = args.exe

    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    unknown = [a for a in arms if a not in ARMS]
    if unknown:
        print(f"unknown arms: {unknown}; known: {list(ARMS)}")
        return 2

    results: list[ArmResult] = []
    for arm in arms:
        print(f"[{arm}] typing {args.keys} keys ...", flush=True)
        res = run_arm(arm, args.keys, args.boot_wait, args.per_key_budget, args.key_delay)
        results.append(res)
        if res.error:
            print(f"  error: {res.error}")
        if res.latencies_ms:
            print(
                f"  boot={res.boot_s:5.1f}s p50={res.pct(0.5):7.1f}ms p95={res.pct(0.95):8.1f}ms"
                f" max={max(res.latencies_ms):8.1f}ms dropped={res.dropped}"
                f" bytes/key p50={int(statistics.median(res.bytes_per_key))}"
            )

    print(
        f"\n{'arm':<10}{'boot s':>8}{'p50 ms':>9}{'p95 ms':>9}{'max ms':>9}"
        f"{'fps@p50':>9}{'bytes/key':>11}{'dropped':>9}"
    )
    for r in results:
        if not r.latencies_ms:
            print(f"{r.arm:<10}  {r.error or 'no samples'}")
            continue
        p50 = r.pct(0.5)
        print(
            f"{r.arm:<10}{r.boot_s:>8.1f}{p50:>9.1f}{r.pct(0.95):>9.1f}"
            f"{max(r.latencies_ms):>9.1f}{(1000.0 / p50 if p50 else 0):>9.1f}"
            f"{int(statistics.median(r.bytes_per_key)):>11}{r.dropped:>9}"
        )

    if args.json:
        Path(args.json).write_text(
            json.dumps(
                [
                    {
                        "arm": r.arm,
                        "boot_s": r.boot_s,
                        "latencies_ms": r.latencies_ms,
                        "bytes_per_key": r.bytes_per_key,
                        "dropped": r.dropped,
                        "error": r.error,
                    }
                    for r in results
                ],
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"\nraw samples -> {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
