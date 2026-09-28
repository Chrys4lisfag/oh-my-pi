#!/usr/bin/env python
"""CPU-profile the omp TUI while keystrokes are typed into it.

Runs the interactive entrypoint under `bun --cpu-prof` inside a ConPTY, types
into the prompt, exits cleanly so the profile is flushed, then aggregates the
.cpuprofile by self-time so the per-keystroke hot path is named.

Usage:
  python scripts/typing_cpu_prof.py --keys 80
  python scripts/typing_cpu_prof.py --keys 80 --arm yml-only
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from winpty import PtyProcess

AGENT_DIR = Path(os.path.expanduser("~/.omp/agent"))
REPO = Path(__file__).resolve().parent.parent
ENTRY = REPO / "packages" / "coding-agent" / "src" / "cli.ts"

SAMPLE_TEXT = "the quick brown fox jumps over the lazy dog while typing steadily "

# arm -> (extra omp args, models mode)
ARMS = {
    "real": ((), "full"),
    "no-ext": (("--no-mcp", "--no-extensions"), "full"),
    "yml-only": (("--no-mcp", "--no-extensions"), "yml"),
    "minimal": (("--no-mcp", "--no-extensions"), "minimal"),
}

MINIMAL_MODELS_YML = """providers:
  probe-local:
    baseUrl: "http://127.0.0.1:9/v1"
    api: openai-completions
    auth: none
"""


def build_agent_dir(models_mode: str) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="omp-prof-"))
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
    return tmp


def summarize(profile_path: Path, top: int) -> None:
    data = json.loads(profile_path.read_text(encoding="utf-8"))
    nodes = {n["id"]: n for n in data["nodes"]}
    self_ticks: collections.Counter[int] = collections.Counter(data.get("samples", []))
    deltas = data.get("timeDeltas") or []
    samples = data.get("samples") or []
    self_us: collections.Counter[int] = collections.Counter()
    for i, node_id in enumerate(samples):
        self_us[node_id] += deltas[i] if i < len(deltas) else 0
    total_us = sum(self_us.values()) or 1

    def label(node: dict) -> str:
        cf = node.get("callFrame", {})
        url = cf.get("url", "") or ""
        short = url.split("/")[-1].split("\\")[-1]
        name = cf.get("functionName") or "(anonymous)"
        line = cf.get("lineNumber", -1)
        return f"{name} @ {short}:{line + 1}"

    print(f"\ntotal profiled cpu: {total_us / 1e6:.2f}s over {len(samples)} samples")
    print(f"\n{'self %':>7}{'self s':>9}  function")
    for node_id, us in self_us.most_common(top):
        node = nodes.get(node_id)
        if not node:
            continue
        print(f"{100 * us / total_us:>7.1f}{us / 1e6:>9.3f}  {label(node)}")

    # Aggregate by file: which subsystem owns the time.
    per_file: collections.Counter[str] = collections.Counter()
    for node_id, us in self_us.items():
        node = nodes.get(node_id)
        if not node:
            continue
        url = node.get("callFrame", {}).get("url", "") or "(native)"
        per_file[url.split("/")[-1].split("\\")[-1] or "(native)"] += us
    print(f"\n{'self %':>7}{'self s':>9}  file")
    for name, us in per_file.most_common(top):
        print(f"{100 * us / total_us:>7.1f}{us / 1e6:>9.3f}  {name}")
    _ = self_ticks


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keys", type=int, default=80)
    ap.add_argument("--arm", default="no-ext", choices=sorted(ARMS))
    ap.add_argument("--boot-wait", type=float, default=16.0)
    ap.add_argument("--key-delay", type=float, default=0.12)
    ap.add_argument("--top", type=int, default=18)
    args = ap.parse_args()

    extra, models_mode = ARMS[args.arm]
    agent_dir = build_agent_dir(models_mode)
    out_dir = Path(tempfile.mkdtemp(prefix="omp-prof-out-"))
    env = dict(os.environ)
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    home = agent_dir / "home"
    home.mkdir(exist_ok=True)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    env["TERM"] = "xterm-256color"

    argv = [
        "bun",
        "--cpu-prof",
        f"--cpu-prof-name={out_dir / 'typing.cpuprofile'}",
        str(ENTRY),
        *extra,
    ]
    print(f"[{args.arm}] {' '.join(argv[:3])} ... (models={models_mode})", flush=True)
    proc = PtyProcess.spawn(argv, cwd=str(REPO), env=env, dimensions=(40, 140))
    try:
        time.sleep(args.boot_wait)
        for i in range(args.keys):
            proc.write(SAMPLE_TEXT[i % len(SAMPLE_TEXT)])
            time.sleep(args.key_delay)
        # Clear the line, then exit so bun flushes the profile.
        proc.write("\x15")
        time.sleep(0.3)
        # `/exit` is the clean shutdown path; ctrl+d does not flush the profile.
        proc.write("/exit\r")
        deadline = time.monotonic() + 25
        while proc.isalive() and time.monotonic() < deadline:
            time.sleep(0.25)
        if proc.isalive():
            proc.write("\x03")
            time.sleep(1.0)
    finally:
        if proc.isalive():
            try:
                proc.terminate(force=True)
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass

    patterns = [out_dir / "*.cpuprofile", REPO / "*.cpuprofile", REPO / "CPU.*.cpuprofile"]
    profiles = [p for pat in patterns for p in sorted(glob.glob(str(pat)), key=os.path.getmtime, reverse=True)]
    if not profiles:
        print("no .cpuprofile produced (did the process exit cleanly?)")
        print(f"agent dir kept for inspection: {agent_dir}")
        return 1
    print(f"profile: {profiles[0]}")
    summarize(Path(profiles[0]), args.top)
    shutil.rmtree(agent_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
