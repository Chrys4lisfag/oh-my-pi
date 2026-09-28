"""Render a bench-tps run into one self-contained HTML reading view.

    python scripts/bench_report_html.py runs/bench-tps/bench-tps-20260909-230058

Successful models only (a failed row has no answer to read), grouped by model
family, sorted fastest-first inside each family. The output is a single
`report.html` next to `report.json` — no network, no assets, so it opens from
disk and can be zipped or mailed as is.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import webbrowser
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]

# Vendor namespaces a gateway prepends to its ids (`azure/gpt-6-astra`); they
# say who resells the model, not which family it belongs to.
_NAMESPACE_TOKENS = ("meta",)
# Families whose first token is a series word: the second token carries the
# actual family (`claude-opus-5` → claude-opus, `mistral-large-3` → mistral-large).
_TWO_TOKEN_FAMILIES = ("claude", "mistral", "cohere", "stable", "mai", "text", "code")


@dataclass(frozen=True)
class Answer:
    """One successful model row plus the answer body it produced."""

    provider: str
    model: str
    family: str
    body: str
    output_tokens: int
    total_seconds: float
    ttft_seconds: float | None
    output_tps: float | None
    stop_reason: str | None


def model_family(model_id: str) -> str:
    """Coarse family key of a model id, ignoring the reseller namespace.

    `azure/gpt-5.1-codex` → `gpt`, `azure/claude-opus-5` → `claude-opus`,
    `Meta-Llama-3.1-8B-Instruct` → `llama`. Version numbers never start a new
    family, so every GPT variant lands in one group instead of dozens.
    """
    tail = model_id.rsplit("/", 1)[-1].lower()
    tokens = [token for token in re.split(r"[-_.\s]+", tail) if token]
    if tokens and tokens[0] in _NAMESPACE_TOKENS and len(tokens) > 1:
        tokens.pop(0)
    if not tokens:
        return "other"
    head = tokens[0]
    if head in _TWO_TOKEN_FAMILIES and len(tokens) > 1 and tokens[1].isalpha():
        return f"{head}-{tokens[1]}"
    return head


def load_answers(root: Path) -> list[Answer]:
    """Successful rows of `report.json` whose answer body is on disk."""
    report = json.loads((root / "report.json").read_text(encoding="utf-8"))
    answers: list[Answer] = []
    for entry in report.get("results", []):
        if not isinstance(entry, dict) or not entry.get("ok"):
            continue
        body = _read_body(root, entry)
        if not body.strip():
            continue
        model = str(entry.get("model", ""))
        answers.append(
            Answer(
                provider=str(entry.get("provider", "")),
                model=model,
                family=model_family(model),
                body=body,
                output_tokens=int(entry.get("output_tokens") or 0),
                total_seconds=float(entry.get("total_seconds") or 0.0),
                ttft_seconds=_optional_float(entry.get("ttft_seconds")),
                output_tps=_optional_float(entry.get("output_tps")),
                stop_reason=entry.get("stop_reason"),
            )
        )
    return answers


def _optional_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def _read_body(root: Path, entry: dict[str, Any]) -> str:
    """The saved answer, preferring the recorded path but tolerating a moved run."""
    candidates: list[Path] = []
    recorded = entry.get("response_path")
    if isinstance(recorded, str) and recorded:
        candidates.append(Path(recorded))
    workdir = entry.get("workdir")
    if isinstance(workdir, str) and workdir:
        candidates.append(Path(workdir) / "response.md")
        candidates.append(root / Path(workdir).name / "response.md")
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate.read_text(encoding="utf-8")
        except OSError:
            continue
    return ""


def group_by_family(answers: Iterable[Answer]) -> list[tuple[str, list[Answer]]]:
    """Families ordered by size then name; fastest answer first inside each."""
    groups: dict[str, list[Answer]] = {}
    for answer in answers:
        groups.setdefault(answer.family, []).append(answer)
    for members in groups.values():
        members.sort(key=lambda a: (-(a.output_tps or 0.0), a.model.lower()))
    return sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))


def _fmt(value: float | None, suffix: str = "") -> str:
    return "—" if value is None else f"{value:.1f}{suffix}"


_STYLE = """
:root { color-scheme: dark; --bg:#12141a; --panel:#181b23; --line:#262b36;
        --fg:#dfe3ec; --dim:#8b93a7; --accent:#7cc4ff; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); display:flex;
       font:15px/1.6 "Segoe UI",system-ui,sans-serif; }
aside { width:300px; flex:none; height:100vh; overflow:auto; padding:16px;
        border-right:1px solid var(--line); background:var(--panel); }
main { flex:1; height:100vh; overflow:auto; padding:28px 36px 96px; }
h1 { font-size:18px; margin:0 0 4px; }
h2 { font-size:15px; margin:26px 0 8px; color:var(--accent); letter-spacing:.04em;
     text-transform:uppercase; }
.sub { color:var(--dim); font-size:13px; margin-bottom:14px; }
input { width:100%; padding:8px 10px; margin-bottom:14px; border-radius:6px;
        border:1px solid var(--line); background:#0e1015; color:var(--fg); }
aside a { display:block; padding:3px 6px; color:var(--fg); text-decoration:none;
          border-radius:4px; font-size:13px; }
aside a:hover { background:#222735; }
aside .tps { float:right; color:var(--dim); }
article { border:1px solid var(--line); border-radius:10px; margin:0 0 20px;
          background:var(--panel); }
article > header { padding:12px 16px; border-bottom:1px solid var(--line);
                   display:flex; gap:14px; align-items:baseline; flex-wrap:wrap;
                   cursor:pointer; }
article h3 { margin:0; font-size:15px; }
.meta { color:var(--dim); font-size:12.5px; }
.body { padding:14px 18px; white-space:pre-wrap; word-wrap:break-word;
        font:14px/1.65 "Cascadia Mono",Consolas,monospace; }
article.collapsed .body { display:none; }
.hidden { display:none; }
.prompt { border:1px solid var(--line); border-radius:10px; padding:14px 18px;
          background:var(--panel); white-space:pre-wrap; margin-bottom:26px;
          color:var(--dim); font:13.5px/1.6 "Cascadia Mono",Consolas,monospace; }
"""

_SCRIPT = """
const search = document.getElementById('q');
search.addEventListener('input', () => {
  const needle = search.value.trim().toLowerCase();
  for (const card of document.querySelectorAll('article')) {
    const hit = !needle || card.dataset.key.includes(needle);
    card.classList.toggle('hidden', !hit);
  }
  for (const group of document.querySelectorAll('section')) {
    const any = group.querySelector('article:not(.hidden)');
    group.classList.toggle('hidden', !any);
  }
});
for (const header of document.querySelectorAll('article > header')) {
  header.addEventListener('click', () => header.parentElement.classList.toggle('collapsed'));
}
"""


def render_html(root: Path, answers: Sequence[Answer], prompt: str) -> str:
    """One self-contained page: sidebar index, prompt, answers grouped by family."""
    groups = group_by_family(answers)
    nav: list[str] = []
    body: list[str] = []
    for family, members in groups:
        anchor = re.sub(r"[^a-z0-9]+", "-", family)
        nav.append(
            f'<h2>{html.escape(family)} <span class="tps">{len(members)}</span></h2>'
        )
        body.append(f'<section id="{anchor}"><h2>{html.escape(family)}</h2>')
        for index, answer in enumerate(members):
            slug = re.sub(r"[^a-z0-9]+", "-", f"{answer.provider}-{answer.model}".lower())
            label = html.escape(answer.model)
            nav.append(
                f'<a href="#{slug}">{label}'
                f'<span class="tps">{_fmt(answer.output_tps)}</span></a>'
            )
            meta = " · ".join(
                [
                    html.escape(answer.provider),
                    f"{answer.output_tokens} tok",
                    f"{_fmt(answer.output_tps)} tok/s",
                    f"{_fmt(answer.total_seconds, 's')} total",
                    f"ttft {_fmt(answer.ttft_seconds, 's')}",
                    html.escape(answer.stop_reason or "—"),
                ]
            )
            key = html.escape(f"{answer.provider} {answer.model} {answer.family}".lower())
            body.append(
                f'<article id="{slug}" data-key="{key}"'
                f'{"" if index < 3 else " class=collapsed"}>'
                f"<header><h3>{label}</h3><span class='meta'>{meta}</span></header>"
                f'<div class="body">{html.escape(answer.body)}</div></article>'
            )
        body.append("</section>")

    title = html.escape(root.name)
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        f"<title>{title} — answers</title><style>{_STYLE}</style></head><body>"
        f"<aside><h1>{title}</h1>"
        f'<div class="sub">{len(answers)} answers · {len(groups)} families</div>'
        "<input id='q' placeholder='filter models…' autocomplete='off'>"
        f"{''.join(nav)}</aside>"
        f"<main><h2>prompt</h2><div class='prompt'>{html.escape(prompt)}</div>"
        f"{''.join(body)}</main>"
        f"<script>{_SCRIPT}</script></body></html>"
    )


def build_report(root: Path, output: Path | None = None) -> Path:
    """Write `report.html` for a finished run directory and return its path."""
    answers = load_answers(root)
    if not answers:
        raise SystemExit(f"No successful answers with bodies under {root}")
    prompt_file = root / "prompt.txt"
    prompt = prompt_file.read_text(encoding="utf-8") if prompt_file.is_file() else ""
    target = output or root / "report.html"
    target.write_text(render_html(root, answers, prompt), encoding="utf-8")
    return target

def latest_run(parent: Path) -> Path:
    """Newest run directory holding a report.json, so the .bat needs no path."""
    runs = sorted(
        (child for child in parent.glob("bench-tps-*") if (child / "report.json").is_file()),
        key=lambda child: child.name,
    )
    if not runs:
        raise SystemExit(f"No finished bench-tps run under {parent}")
    return runs[-1]



def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "run",
        type=Path,
        nargs="?",
        help="bench-tps run directory (default: the newest run under runs/bench-tps)",
    )
    parser.add_argument("--out", type=Path, help="output file (default: <run>/report.html)")
    parser.add_argument("--open", action="store_true", help="open the page in the default browser")
    args = parser.parse_args(argv)

    root = (
        args.run.expanduser().resolve()
        if args.run is not None
        else latest_run(_REPO_ROOT / "runs" / "bench-tps")
    )
    if not (root / "report.json").is_file():
        parser.error(f"{root} has no report.json")
    answers = load_answers(root)
    target = build_report(root, args.out)
    print(f"{len(answers)} answers · {len(group_by_family(answers))} families")
    print(target)
    if args.open:
        webbrowser.open(target.as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
