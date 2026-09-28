#!/usr/bin/env python
"""Measure what an *idle* omp instance costs, per configuration arm.

Typing lag is main-thread starvation: whatever background work runs while you
sit at the prompt competes with input handling and repaint. This probe boots one
omp RPC instance per arm, leaves it idle, and samples the process tree — so the
cost is attributable without a TUI in the loop.

Arms isolate the three suspects: MCP fan-out, the configured provider set
(discovery + usage fetches scale with it), and extensions/plugins.

Usage:
  python scripts/lag_probe_rpc.py --seconds 45
  python scripts/lag_probe_rpc.py --seconds 45 --arms real,no-mcp,minimal
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import psutil
except ImportError:  # pragma: no cover
    sys.exit("psutil required: pip install psutil")

AGENT_DIR = Path(os.path.expanduser("~/.omp/agent"))
REPO = Path(__file__).resolve().parent.parent

# Arm -> (extra omp args, keep real models.yml, keep extensions)
ARMS: dict[str, tuple[tuple[str, ...], bool, bool]] = {
    "real": ((), True, True),
    "no-mcp": (("--no-mcp",), True, True),
    "no-ext": (("--no-mcp", "--no-extensions"), True, True),
    "minimal": (("--no-mcp", "--no-extensions"), False, False),
}

MINIMAL_MODELS_YML = """providers:
  probe-local:
    baseUrl: "http://127.0.0.1:9/v1"
    api: openai-completions
    auth: none
"""


@dataclass
class Sample:
    t: float
    cpu_percent: float
    rss_mb: float
    procs: int
    threads: int


@dataclass
class ArmResult:
    arm: str
    boot_s: float = 0.0
    samples: list[Sample] = field(default_factory=list)
    log_events: dict[str, int] = field(default_factory=dict)
    error: str | None = None

    def cpu_stats(self) -> tuple[float, float, float]:
        vals = [s.cpu_percent for s in self.samples]
        if not vals:
            return (0.0, 0.0, 0.0)
        vals_sorted = sorted(vals)
        return (
            statistics.mean(vals),
            vals_sorted[int(len(vals_sorted) * 0.95)],
            max(vals),
        )


def build_agent_dir(arm: str, keep_models: bool, keep_ext: bool) -> Path:
    """Sandbox agent dir: real credentials/config, optionally trimmed catalog."""
    tmp = Path(tempfile.mkdtemp(prefix=f"omp-lag-{arm}-"))
    for name in ("config.yml", "auth.db", "auth.json"):
        src = AGENT_DIR / name
        if src.exists():
            shutil.copy2(src, tmp / name)
    if keep_models:
        for name in ("models.yml", "models.db"):
            src = AGENT_DIR / name
            if src.exists():
                shutil.copy2(src, tmp / name)
    else:
        (tmp / "models.yml").write_text(MINIMAL_MODELS_YML, encoding="utf-8")
    if keep_ext:
        src = AGENT_DIR / "extensions"
        if src.exists():
            shutil.copytree(src, tmp / "extensions", dirs_exist_ok=True)
    return tmp


def count_log_events(log_dir: Path, pid: int) -> dict[str, int]:
    events: dict[str, int] = {}
    for log in log_dir.glob(f"*.{pid}.log"):
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                msg = json.loads(line).get("message", "?")
            except (ValueError, AttributeError):
                continue
            events[msg] = events.get(msg, 0) + 1
    return dict(sorted(events.items(), key=lambda kv: -kv[1])[:12])


def run_arm(arm: str, seconds: float, interval: float) -> ArmResult:
    extra, keep_models, keep_ext = ARMS[arm]
    result = ArmResult(arm=arm)
    agent_dir = build_agent_dir(arm, keep_models, keep_ext)
    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    home = agent_dir / "home"
    home.mkdir(exist_ok=True)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)

    cmd = ["omp", "rpc", *extra]
    started = time.monotonic()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(REPO),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        result.error = f"launch failed: {exc}"
        return result

    try:
        parent = psutil.Process(proc.pid)
        # Boot: first sample where the tree stops growing counts as settled.
        deadline = started + 30
        last_children = -1
        while time.monotonic() < deadline:
            time.sleep(0.5)
            try:
                kids = len(parent.children(recursive=True))
            except psutil.Error:
                break
            if kids == last_children and kids >= 0:
                break
            last_children = kids
        result.boot_s = time.monotonic() - started

        tree = [parent, *parent.children(recursive=True)]
        for p in tree:
            try:
                p.cpu_percent(None)
            except psutil.Error:
                pass

        end = time.monotonic() + seconds
        while time.monotonic() < end:
            time.sleep(interval)
            cpu = rss = 0.0
            threads = 0
            try:
                tree = [parent, *parent.children(recursive=True)]
            except psutil.Error:
                break
            alive = 0
            for p in tree:
                try:
                    cpu += p.cpu_percent(None)
                    rss += p.memory_info().rss / 1e6
                    threads += p.num_threads()
                    alive += 1
                except psutil.Error:
                    continue
            result.samples.append(Sample(time.monotonic(), cpu, rss, alive, threads))
        result.log_events = count_log_events(home / ".omp" / "logs", proc.pid)
        if not result.log_events:
            result.log_events = count_log_events(
                Path(os.path.expanduser("~/.omp/logs")), proc.pid
            )
    finally:
        try:
            for child in psutil.Process(proc.pid).children(recursive=True):
                child.kill()
        except psutil.Error:
            pass
        proc.kill()
        proc.wait(timeout=10)
        shutil.rmtree(agent_dir, ignore_errors=True)
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=45.0, help="idle sampling window")
    ap.add_argument("--interval", type=float, default=1.0, help="sample interval")
    ap.add_argument("--arms", default="real,no-mcp,no-ext,minimal")
    args = ap.parse_args()

    arms = [a.strip() for a in args.arms.split(",") if a.strip()]
    bad = [a for a in arms if a not in ARMS]
    if bad:
        return print(f"unknown arms: {bad}; known: {list(ARMS)}") or 2

    results: list[ArmResult] = []
    for arm in arms:
        print(f"[{arm}] booting + sampling {args.seconds:.0f}s ...", flush=True)
        res = run_arm(arm, args.seconds, args.interval)
        results.append(res)
        if res.error:
            print(f"  error: {res.error}")
            continue
        mean, p95, mx = res.cpu_stats()
        last = res.samples[-1] if res.samples else None
        print(
            f"  boot={res.boot_s:5.1f}s cpu mean={mean:6.1f}% p95={p95:6.1f}% max={mx:6.1f}%"
            f" rss={last.rss_mb if last else 0:7.0f}MB procs={last.procs if last else 0:3d}"
            f" threads={last.threads if last else 0:4d}"
        )

    print(
        f"\n{'arm':<10}{'boot s':>8}{'cpu mean%':>11}{'cpu p95%':>10}{'rss MB':>9}{'procs':>7}{'threads':>9}"
    )
    for r in results:
        if r.error:
            print(f"{r.arm:<10}  {r.error}")
            continue
        mean, p95, _ = r.cpu_stats()
        last = r.samples[-1] if r.samples else Sample(0, 0, 0, 0, 0)
        print(
            f"{r.arm:<10}{r.boot_s:>8.1f}{mean:>11.1f}{p95:>10.1f}"
            f"{last.rss_mb:>9.0f}{last.procs:>7d}{last.threads:>9d}"
        )

    for r in results:
        if r.log_events:
            print(f"\n[{r.arm}] idle log events:")
            for msg, count in r.log_events.items():
                print(f"  {count:>5}  {msg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
