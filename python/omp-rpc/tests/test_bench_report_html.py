from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[3] / "scripts" / "bench_report_html.py"
_spec = importlib.util.spec_from_file_location("bench_report_html", SCRIPT)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _module
_spec.loader.exec_module(_module)


def _run(tmp_path: Path, rows: list[dict]) -> Path:
    """A minimal run directory: report.json plus each row's saved answer body."""
    root = tmp_path / "bench-tps-20260101-000000"
    root.mkdir()
    (root / "prompt.txt").write_text("write a scene", encoding="utf-8")
    results = []
    for row in rows:
        workdir = root / row["model"].replace("/", "_")
        workdir.mkdir()
        body = row.pop("body", "")
        if body:
            (workdir / "response.md").write_text(body, encoding="utf-8")
        results.append(
            {
                "provider": "gw",
                "workdir": str(workdir),
                "response_path": str(workdir / "response.md") if body else None,
                "output_tokens": 100,
                "total_seconds": 2.0,
                "ttft_seconds": 0.5,
                "output_tps": row.pop("tps", 10.0),
                "stop_reason": "stop",
                **row,
            }
        )
    (root / "report.json").write_text(json.dumps({"results": results}), encoding="utf-8")
    return root


def test_model_family_ignores_reseller_namespace_and_versions() -> None:
    assert _module.model_family("azure/gpt-5.1-codex-max") == "gpt"
    assert _module.model_family("azure/gpt-4o-mini") == "gpt"
    assert _module.model_family("azure/claude-opus-5-2") == "claude-opus"
    assert _module.model_family("azure/claude-sonnet-4-6") == "claude-sonnet"
    # A vendor-named family keeps its own name instead of losing its head token.
    assert _module.model_family("azure/DeepSeek-V4-Flash") == "deepseek"
    assert _module.model_family("azure/Meta-Llama-3.1-8B-Instruct") == "llama"


def test_load_answers_keeps_successful_rows_with_bodies_only(tmp_path) -> None:
    root = _run(
        tmp_path,
        [
            {"model": "azure/gpt-5", "ok": True, "status": "ok", "body": "good"},
            {"model": "azure/gpt-4", "ok": False, "status": "failed", "body": "junk"},
            {"model": "azure/grok-4", "ok": True, "status": "ok", "body": "   "},
        ],
    )

    answers = _module.load_answers(root)
    assert [(a.model, a.body) for a in answers] == [("azure/gpt-5", "good")]


def test_group_by_family_orders_families_by_size_and_members_by_speed(tmp_path) -> None:
    root = _run(
        tmp_path,
        [
            {"model": "azure/gpt-5", "ok": True, "body": "a", "tps": 20.0},
            {"model": "azure/gpt-4", "ok": True, "body": "b", "tps": 90.0},
            {"model": "azure/grok-4", "ok": True, "body": "c", "tps": 50.0},
        ],
    )

    groups = _module.group_by_family(_module.load_answers(root))
    assert [family for family, _ in groups] == ["gpt", "grok"]
    assert [answer.model for answer in groups[0][1]] == ["azure/gpt-4", "azure/gpt-5"]


def test_build_report_writes_a_self_contained_page(tmp_path) -> None:
    root = _run(
        tmp_path,
        [
            {"model": "azure/gpt-5", "ok": True, "body": "<script>alert(1)</script>"},
            {"model": "azure/dead", "ok": False, "body": "never shown"},
        ],
    )

    target = _module.build_report(root)
    page = target.read_text(encoding="utf-8")
    assert target == root / "report.html"
    # No network assets: styles and behavior are inlined.
    assert "http://" not in page and "https://" not in page
    assert "write a scene" in page
    # Answer bodies are escaped, and failed rows never reach the page.
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
    assert "never shown" not in page
