from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

import pytest

SCRIPT = Path(__file__).parents[3] / "scripts" / "bench_tps_rpc.py"
_spec = importlib.util.spec_from_file_location("bench_tps_rpc", SCRIPT)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _module
_spec.loader.exec_module(_module)


@dataclass(frozen=True)
class FakeModel:
    provider: str
    id: str


@dataclass(frozen=True)
class FakeTool:
    name: str


@dataclass(frozen=True)
class FakeState:
    dump_tools: tuple[FakeTool, ...]
    model: FakeModel | None = None


class FakeTurn:
    def __init__(self, messages):
        self.messages = messages


def assistant(output=100, input_tokens=10, text="page", tool_calls=(), stop="stop"):
    content = [{"type": "text", "text": text}]
    for name in tool_calls:
        content.append({"type": "toolCall", "id": name, "name": name, "arguments": {}})
    return {
        "role": "assistant",
        "content": content,
        "stopReason": stop,
        "usage": {
            "input": input_tokens,
            "output": output,
            "cacheRead": 3,
            "cacheWrite": 1,
            "totalTokens": input_tokens + output + 4,
            "cost": {
                "input": 0.001,
                "output": 0.002,
                "cacheRead": 0.0,
                "cacheWrite": 0.0,
                "total": 0.003,
            },
        },
    }


class FakeClient:
    """Records construction kwargs and replays a scripted streaming turn."""

    models = (
        FakeModel("apiclaw-biz-vuln", "deepseek-v4-flash"),
        FakeModel("maiarouter-ai-vuln", "deepseek/deepseek-v4-flash-preview"),
        FakeModel("openai", "gpt-4o-mini"),
        FakeModel("other", "my-deepseek-v4-flash"),
    )
    calls: ClassVar[list[dict]] = []
    set_model_calls: ClassVar[list[tuple[str, str]]] = []
    abort_calls: ClassVar[list[str | None]] = []
    failures: ClassVar[set[str]] = set()

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        type(self).calls.append(kwargs)
        if kwargs.get("provider") in type(self).failures:
            raise RuntimeError("simulated provider failure")
        self._listeners: list = []
        self._message_end_listeners: list = []
        self._tool_listeners: list = []
        self.aborted = threading.Event()
        provider = kwargs.get("provider")
        model_id = kwargs.get("model")
        self._model = FakeModel(provider, model_id) if provider and model_id else None

    def start(self):
        return self

    def stop(self):
        return None

    def abort(self):
        type(self).abort_calls.append(self.kwargs.get("model"))
        self.aborted.set()

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.stop()
        return False

    def on_message_update(self, listener):
        self._listeners.append(listener)
        return lambda: None

    def on_message_end(self, listener):
        self._message_end_listeners.append(listener)
        return lambda: None

    def on_tool_execution_start(self, listener):
        self._tool_listeners.append(listener)
        return lambda: None

    def emit_delta(self, text="hi"):
        for listener in self._listeners:
            listener(
                type(
                    "Event",
                    (),
                    {"assistant_message_event": {"type": "text_delta", "delta": text}},
                )()
            )

    def emit_message_end(self, message):
        for listener in self._message_end_listeners:
            listener(type("Event", (), {"message": message})())

    def get_available_models(self):
        return type(self).models

    def set_model(self, provider, model_id):
        type(self).set_model_calls.append((provider, model_id))
        self._model = FakeModel(provider, model_id)
        return self._model

    def get_state(self):
        return FakeState(
            (FakeTool("read"), FakeTool("write"), FakeTool("task")), model=self._model
        )

    def prompt_and_wait(self, message, *, timeout=None):
        self.emit_delta()
        workdir = Path(self.kwargs["cwd"])
        (workdir / "index.html").write_text("<html></html>", encoding="utf-8")
        return FakeTurn([assistant(tool_calls=("write",))])


def setup_function() -> None:
    FakeClient.calls = []
    FakeClient.set_model_calls = []
    FakeClient.abort_calls = []
    FakeClient.failures = set()


# ── matching ────────────────────────────────────────────────────────────────


def test_partial_match_allows_any_substring():
    assert _module.matches_model(
        "deepseek-v4-flash-postfix", "deepseek-v4-flash", "partial"
    )
    assert _module.matches_model("my-deepseek-v4-flash", "deepseek-v4-flash", "partial")
    assert _module.matches_model(
        "deepseek/deepseek-v4-flash-preview", "deepseek-v4-flash", "partial"
    )
    assert not _module.matches_model("gpt-4o-mini", "deepseek-v4-flash", "partial")


def test_full_match_ignores_vendor_namespace_but_not_prefixes():
    assert _module.matches_model("deepseek-v4-flash", "deepseek-v4-flash", "full")
    assert _module.matches_model(
        "deepseek/deepseek-v4-flash-preview", "deepseek-v4-flash", "full"
    )
    assert _module.matches_model("deepseek-v4-flash:high", "deepseek-v4-flash", "full")
    assert not _module.matches_model(
        "my-deepseek-v4-flash", "deepseek-v4-flash", "full"
    )
    assert not _module.matches_model("deepseek-v4-flashy", "deepseek-v4-flash", "full")


def test_select_models_dedupes_and_sorts():
    models = [
        FakeModel("zeta", "deepseek-v4-flash"),
        FakeModel("alpha", "deepseek-v4-flash"),
        FakeModel("alpha", "deepseek-v4-flash"),
        FakeModel("alpha", "gpt-4o"),
    ]
    selected = _module.select_models(models, "deepseek-v4-flash", "full")
    assert [(model.provider, model.id) for model in selected] == [
        ("alpha", "deepseek-v4-flash"),
        ("zeta", "deepseek-v4-flash"),
    ]


def test_parse_model_queries_trims_and_deduplicates() -> None:
    assert _module.parse_model_queries(" claude, gpt-astra,claude, ,deepseek ") == (
        "claude",
        "gpt-astra",
        "deepseek",
    )


def test_resolve_provider_model_queries_skips_prompt_when_unattended() -> None:
    with patch.object(_module, "_ask", side_effect=AssertionError("must not prompt")):
        assert _module.resolve_provider_model_queries(None, interactive=False) == ()


def test_resolve_provider_model_queries_prompts_when_interactive() -> None:
    with patch.object(_module, "_ask", return_value=" claude, gpt-6,claude ") as ask:
        assert _module.resolve_provider_model_queries(None, interactive=True) == (
            "claude",
            "gpt-6",
        )
    ask.assert_called_once_with(
        "Specify model(s) to use, use , for multiple, leave blank for all",
        allow_empty=True,
    )


def test_resolve_provider_model_queries_honors_explicit_flag_without_prompt() -> None:
    with patch.object(_module, "_ask", side_effect=AssertionError("must not prompt")):
        assert _module.resolve_provider_model_queries("claude, gpt", interactive=True) == (
            "claude",
            "gpt",
        )

def test_filter_provider_models_matches_any_requested_partial_id() -> None:
    models = [
        FakeModel("provider", "claude-opus-5"),
        FakeModel("provider", "gpt-6-astra"),
        FakeModel("provider", "deepseek-v4"),
    ]
    selected = _module.filter_provider_models(models, ("claude", "gpt-6"))
    assert [model.id for model in selected] == ["claude-opus-5", "gpt-6-astra"]
    assert _module.filter_provider_models(models, ()) == models


def test_invalid_match_mode_is_rejected():
    try:
        _module.matches_model("a", "a", "fuzzy")
    except ValueError as exc:
        assert "partial" in str(exc)
    else:  # pragma: no cover - guard
        raise AssertionError("expected ValueError")


# ── statistics ──────────────────────────────────────────────────────────────


def test_summarize_turn_accumulates_usage_and_tools():
    result = _module.BenchResult(provider="p", model="m")
    _module.summarize_turn(result, [assistant(output=40, tool_calls=("write", "read"))])
    assert result.output_tokens == 40
    assert result.input_tokens == 10
    assert result.cache_read_tokens == 3
    assert result.cache_write_tokens == 1
    assert result.total_tokens == 54
    assert result.tool_calls == 2
    assert result.tool_names == ["write", "read"]
    assert result.assistant_messages == 1
    assert result.stop_reason == "stop"
    assert result.cost_usd == 0.003


def test_summarize_turn_derives_total_tokens_when_missing():
    result = _module.BenchResult(provider="p", model="m")
    _module.summarize_turn(
        result,
        [{"role": "assistant", "content": [], "usage": {"input": 5, "output": 7}}],
    )
    assert result.total_tokens == 12


def test_tps_uses_generation_window_and_wall_clock():
    result = _module.BenchResult(
        provider="p",
        model="m",
        ok=True,
        output_tokens=100,
        ttft_seconds=1.0,
        generation_seconds=4.0,
        total_seconds=5.0,
    )
    assert result.output_tps == 25.0
    assert result.wall_tps == 20.0


def test_tps_is_none_for_failed_or_empty_runs():
    failed = _module.BenchResult(provider="p", model="m", ok=False, output_tokens=10)
    assert failed.output_tps is None and failed.wall_tps is None
    empty = _module.BenchResult(
        provider="p", model="m", ok=True, generation_seconds=2.0, total_seconds=2.0
    )
    assert empty.output_tps is None


# ── end-to-end (fake client) ────────────────────────────────────────────────


def test_bench_runs_every_matching_model_and_writes_report(tmp_path):
    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        log=lambda _message: None,
    )

    assert report["model_count"] == 3
    assert report["successful_models"] == 3
    assert report["failed_models"] == 0
    assert report["topic"] == "a tea shop"
    assert "landing page on the topic a tea shop" in report["task"]

    saved = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert saved["results"][0]["output_tps"] is not None
    assert all(entry["files_created"] == 1 for entry in saved["results"])
    assert all(entry["ttft_seconds"] is not None for entry in saved["results"])


def test_bench_saves_exact_custom_prompt_and_tool_free_selection(tmp_path):
    prompt = "Write exactly three words.\nDo not use tools."
    report = _module.bench(
        query="gpt-4o-mini",
        mode="full",
        topic="unused",
        task_name="custom",
        task_text=prompt,
        use_tools=False,
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        log=lambda _message: None,
    )

    assert report["model_count"] == 1
    assert (tmp_path / "prompt.txt").read_text(encoding="utf-8") == prompt
    selection = json.loads((tmp_path / "selection.json").read_text(encoding="utf-8"))
    assert selection["task"] == "custom"
    assert selection["selected_models"] == [{"provider": "openai", "model": "gpt-4o-mini"}]
    assert selection["tools_enabled"] is False
    assert selection["mcp_enabled"] is False
    model_call = next(call for call in FakeClient.calls if call.get("model"))
    assert model_call["tools"] == []
    assert {"--no-mcp", "--no-extensions", "--no-fallback"} <= set(model_call["extra_args"])


def test_bench_saves_each_model_answer_body(tmp_path):
    report = _module.bench(
        query="gpt-4o-mini",
        mode="full",
        topic="unused",
        task_name="custom",
        task_text="Write exactly three words.",
        use_tools=False,
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        log=lambda _message: None,
    )

    entry = report["results"][0]
    saved = Path(entry["response_path"])
    assert saved.name == "response.md"
    assert saved.parent == Path(entry["workdir"])
    # The body itself, not just its character count.
    assert saved.read_text(encoding="utf-8") == "page"


def test_bench_saves_streamed_body_when_the_turn_returns_no_messages(tmp_path):
    class StreamOnlyClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            self.emit_delta("half an answer")

    report = _module.bench(
        query="gpt-4o-mini",
        mode="full",
        topic="unused",
        task_name="custom",
        task_text="anything",
        use_tools=False,
        executable="omp",
        root=tmp_path,
        client_factory=StreamOnlyClient,
        log=lambda _message: None,
    )

    entry = report["results"][0]
    assert Path(entry["response_path"]).read_text(encoding="utf-8") == "half an answer"


def test_resolve_prompt_input_reads_a_named_prompt_file(tmp_path):
    prompt_file = tmp_path / "prompt.txt"
    prompt_file.write_text("line one\nline two", encoding="utf-8")

    # The exact mistake that benchmarked a flag string against every model.
    assert _module.resolve_prompt_input(f"--prompt-file {prompt_file}") == "line one\nline two"
    assert _module.resolve_prompt_input(f'--prompt-file "{prompt_file}"') == "line one\nline two"
    assert _module.resolve_prompt_input(str(prompt_file)) == "line one\nline two"
    # Ordinary prompt text is never mistaken for a path.
    assert _module.resolve_prompt_input("Write three words.") == "Write three words."
    assert _module.resolve_prompt_input(f"--prompt-file {tmp_path / 'missing.txt'}").startswith(
        "--prompt-file"
    )


def test_render_prompt_preview_shows_size_and_head_of_the_real_text():
    preview = _module.render_prompt_preview("\n".join(f"line {i}" for i in range(20)), task_name="custom")
    assert "custom" in preview
    assert "20 line(s)" in preview
    assert "line 0" in preview
    assert "line 11" in preview
    assert "line 12" not in preview
    assert "8 more line(s)" in preview

def test_bench_isolates_each_model_and_disables_task_tool(tmp_path):
    _module.bench(
        query="deepseek-v4-flash",
        mode="full",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        log=lambda _message: None,
    )

    runs = [call for call in FakeClient.calls if call.get("model")]
    assert len(runs) == 2  # full mode excludes "my-deepseek-v4-flash"
    workdirs = {call["cwd"] for call in runs}
    assert len(workdirs) == len(runs)
    for call in runs:
        assert Path(call["cwd"]).is_relative_to(tmp_path)
        assert call["no_session"] is True
        assert call["tools"] == ["read", "write"]
        assert "task" not in call["tools"]
    assert (tmp_path / "bench-overlay.yml").read_text(encoding="utf-8").count(
        "advisor"
    ) == 1


def test_bench_reports_failures_without_stopping_other_models(tmp_path):
    FakeClient.failures = {"apiclaw-biz-vuln"}

    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        log=lambda _message: None,
    )

    assert report["successful_models"] == 2
    assert report["failed_models"] == 1
    failed = next(entry for entry in report["results"] if not entry["ok"])
    assert "simulated provider failure" in failed["error"]
    assert failed["output_tps"] is None
    # Failures rank last.
    assert report["results"][-1]["ok"] is False


def test_provider_error_turn_is_reported_as_failure(tmp_path):
    class ErrorTurnClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            return FakeTurn(
                [
                    {
                        "role": "assistant",
                        "content": [],
                        "stopReason": "error",
                        "errorMessage": "upstream 502 bad gateway",
                        "usage": {"input": 0, "output": 0},
                    }
                ]
            )

    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=ErrorTurnClient,
        log=lambda _message: None,
    )

    assert report["successful_models"] == 0
    assert report["failed_models"] == 3
    assert all(
        entry["error"] == "upstream 502 bad gateway" for entry in report["results"]
    )
    assert all(entry["stop_reason"] == "error" for entry in report["results"])


def test_error_turn_without_message_still_fails(tmp_path):
    class BlankErrorClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            return FakeTurn(
                [{"role": "assistant", "content": [], "stopReason": "error"}]
            )

    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=BlankErrorClient,
        log=lambda _message: None,
    )

    assert report["failed_models"] == 3
    assert all(
        "provider returned an error turn" in entry["error"]
        for entry in report["results"]
    )


def test_run_model_waits_without_timeout_by_default(tmp_path):
    seen: list[object] = []

    class TimeoutProbeClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            seen.append(timeout)
            return super().prompt_and_wait(message, timeout=timeout)

    _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=TimeoutProbeClient,
    )

    assert seen == [None]


def test_run_model_honours_explicit_turn_timeout(tmp_path):
    seen: list[object] = []

    class TimeoutProbeClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            seen.append(timeout)
            return super().prompt_and_wait(message, timeout=timeout)

    _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=TimeoutProbeClient,
        turn_timeout=90.0,
    )

    assert seen == [90.0]


def test_run_model_forwards_config_overlay_and_generous_timeouts(tmp_path):
    overlay = tmp_path / "bench-overlay.yml"
    overlay.write_text("advisor:\n  enabled: false\n", encoding="utf-8")

    _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=FakeClient,
        config_path=overlay,
    )

    call = FakeClient.calls[-1]
    # MCP is off for EVERY task now, including tool-using ones: it mounts even
    # under an empty allowlist and forks ~11 servers per instance.
    # `--no-fallback` pins the run to the selected model: a fallback would credit
    # another model's tokens/second to this row (dead providers scored "ok").
    assert call["extra_args"] == [
        "--no-extensions",
        "--no-mcp",
        "--no-fallback",
        "--config",
        str(overlay),
    ]
    assert call["startup_timeout"] >= 120
    assert call["request_timeout"] >= 120


def test_run_model_disables_mcp_for_tool_free_runs(tmp_path):
    # A throughput run must be genuinely tool-free. `tools=[]` becomes
    # `--no-tools`, which filters built-ins only: MCP servers are custom tools
    # and mount anyway (measured 338 tools, 21 child processes per instance).
    # `--no-mcp` is what makes it 0 tools / 1 child.
    _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="write an essay",
        root=tmp_path,
        client_factory=FakeClient,
        tools=[],
    )

    call = FakeClient.calls[-1]
    assert "--no-mcp" in call["extra_args"]
    assert call["tools"] == []


def test_run_model_disables_mcp_even_for_tool_enabled_runs(tmp_path):
    # Contract change: MCP used to stay enabled whenever tools were requested.
    # It mounts even under an empty allowlist and forks its own fleet per
    # instance, so no benchmark task starts it — `landing` does its work with
    # the built-in tools, which are still forwarded.
    _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=FakeClient,
        tools=["read", "write"],
    )

    call = FakeClient.calls[-1]
    assert "--no-mcp" in call["extra_args"]
    assert call["tools"] == ["read", "write"]


def test_run_model_keeps_unlimited_event_history_by_default(tmp_path):
    _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=FakeClient,
    )

    assert FakeClient.calls[-1]["max_event_history"] is None


def test_bench_forwards_explicit_event_history_cap(tmp_path):
    _module.bench(
        query="deepseek-v4-flash",
        mode="full",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        max_event_history=50_000,
        log=lambda _message: None,
    )

    runs = [call for call in FakeClient.calls if call.get("model")]
    assert runs and all(call["max_event_history"] == 50_000 for call in runs)


def test_run_model_pins_the_exact_provider_and_model(tmp_path):
    result = _module.run_model(
        FakeModel("maiarouter-ai-vuln", "deepseek/deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=FakeClient,
    )

    assert FakeClient.set_model_calls[-1] == (
        "maiarouter-ai-vuln",
        "deepseek/deepseek-v4-flash",
    )
    assert result.resolved_provider == "maiarouter-ai-vuln"
    assert result.resolved_model == "deepseek/deepseek-v4-flash"
    assert result.ok


def test_same_provider_variants_are_each_pinned_separately(tmp_path):
    # maiarouter serves a self-deployed `deepseek-v4-flash` next to the hosted
    # `deepseek/deepseek-v4-flash`; fuzzy `--model` used to collapse them.
    _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        log=lambda _message: None,
    )

    assert sorted(FakeClient.set_model_calls) == sorted(
        (model.provider, model.id)
        for model in FakeClient.models
        if "deepseek-v4-flash" in model.id
    )


def test_run_model_fails_when_the_session_lands_on_another_variant(tmp_path):
    class DriftingClient(FakeClient):
        def get_state(self):
            return FakeState(
                (FakeTool("read"),),
                model=FakeModel("maiarouter-ai-vuln", "deepseek-v4-flash-other"),
            )

    result = _module.run_model(
        FakeModel("maiarouter-ai-vuln", "deepseek/deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=DriftingClient,
    )

    assert not result.ok
    assert "deepseek-v4-flash-other" in result.error
    assert result.resolved_model == "deepseek-v4-flash-other"


def test_run_model_fails_when_set_model_is_rejected(tmp_path):
    class RejectingClient(FakeClient):
        def set_model(self, provider, model_id):
            raise RuntimeError("model not available")

    result = _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=RejectingClient,
    )

    assert not result.ok
    assert "could not select p/deepseek-v4-flash" in result.error


def test_details_report_a_model_swap(tmp_path):
    result = _module.BenchResult(
        provider="maiarouter-ai-vuln",
        model="deepseek/deepseek-v4-flash",
        ok=False,
        error="requested … but the session runs …",
        resolved_provider="maiarouter-ai-vuln",
        resolved_model="deepseek-v4-flash",
    )

    details = _module.render_details([result])
    assert "session ran on        : maiarouter-ai-vuln/deepseek-v4-flash" in details


def test_bench_runs_models_concurrently_by_default(tmp_path):
    import threading

    started = threading.Barrier(3, timeout=5)
    overlapped = []

    class ConcurrentClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            try:
                started.wait()  # only clears when all three run at once
                overlapped.append(self.kwargs["model"])
            except threading.BrokenBarrierError:  # pragma: no cover - failure path
                pass
            return super().prompt_and_wait(message, timeout=timeout)

    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=ConcurrentClient,
        log=lambda _message: None,
    )

    assert report["successful_models"] == 3
    assert len(overlapped) == 3


def test_bench_jobs_one_runs_models_sequentially(tmp_path):
    import threading

    live = 0
    peak = 0
    lock = threading.Lock()

    class SerialProbeClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            nonlocal live, peak
            with lock:
                live += 1
                peak = max(peak, live)
            try:
                time.sleep(0.01)
                return super().prompt_and_wait(message, timeout=timeout)
            finally:
                with lock:
                    live -= 1

    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=SerialProbeClient,
        jobs=1,
        log=lambda _message: None,
    )

    assert report["successful_models"] == 3
    assert peak == 1


def test_bench_jobs_caps_concurrency(tmp_path):
    import threading

    live = 0
    peak = 0
    lock = threading.Lock()

    class CappedClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            nonlocal live, peak
            with lock:
                live += 1
                peak = max(peak, live)
            try:
                time.sleep(0.02)
                return super().prompt_and_wait(message, timeout=timeout)
            finally:
                with lock:
                    live -= 1

    _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=CappedClient,
        jobs=2,
        log=lambda _message: None,
    )

    assert peak <= 2


def test_parallel_logging_is_serialized(tmp_path):
    import threading

    lines = []
    logging_lock = threading.Lock()
    concurrent_log_calls = []

    def log(message):
        acquired = logging_lock.acquire(blocking=False)
        if not acquired:
            concurrent_log_calls.append(message)
            return
        try:
            time.sleep(0.001)
            lines.append(message)
        finally:
            logging_lock.release()

    _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        log=log,
    )

    assert not concurrent_log_calls
    assert any("running 3 at a time" in line for line in lines)


def test_bench_raises_when_nothing_matches(tmp_path):
    try:
        _module.bench(
            query="no-such-model",
            mode="full",
            topic="a tea shop",
            executable="omp",
            root=tmp_path,
            client_factory=FakeClient,
            log=lambda _message: None,
        )
    except SystemExit as exc:
        assert "no-such-model" in str(exc)
    else:  # pragma: no cover - guard
        raise AssertionError("expected SystemExit")


def test_bench_can_clean_workdirs(tmp_path):
    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        keep_workdirs=False,
        log=lambda _message: None,
    )
    assert all(not Path(entry["workdir"]).exists() for entry in report["results"])
    for filename in (
        "prompt.txt",
        "selection.json",
        "bench-overlay.yml",
        "bench.log",
        "report.json",
    ):
        assert (tmp_path / filename).is_file()


# ── rendering ───────────────────────────────────────────────────────────────


def _results():
    return [
        _module.BenchResult(
            provider="apiclaw-biz-vuln",
            model="deepseek-v4-flash",
            ok=True,
            ttft_seconds=0.5,
            generation_seconds=4.0,
            total_seconds=4.5,
            input_tokens=10,
            output_tokens=200,
            total_tokens=214,
            cost_usd=0.0031,
            tool_calls=1,
            tool_names=["write"],
            stop_reason="stop",
            workdir="/tmp/x",
        ),
        _module.BenchResult(
            provider="openai",
            model="gpt-4o-mini",
            status=_module.STATUS_FAILED,
            error="RuntimeError: boom",
            total_seconds=1.0,
            workdir="/tmp/y",
        ),
    ]


def test_render_table_contains_every_column_and_row():
    table = _module.render_table(_results())
    header, separator, *rows = table.splitlines()
    for column in ("provider", "tps", "ttft s", "out tok", "cost $", "status"):
        assert column in header
    assert set(separator) <= {"-", "+", " "}
    assert len(rows) == 2
    assert "50.00" in rows[0]  # 200 tokens / 4s
    assert "FAIL" in rows[1]


def test_render_details_and_summary_report_failures_and_extremes():
    details = _module.render_details(_results())
    assert "time to first token" in details
    assert "FAIL: RuntimeError: boom" in details

    summary = _module.render_summary(_results())
    assert "1 FAIL" in summary and "1 ok" in summary
    assert "fastest" in summary
    assert "median tokens/s" in summary


def test_status_and_ok_stay_consistent():
    from_ok = _module.BenchResult(provider="p", model="m", ok=True)
    assert from_ok.status == _module.STATUS_OK
    from_status = _module.BenchResult(
        provider="p", model="m", status=_module.STATUS_CANCELLED
    )
    assert from_status.ok is False


def test_partial_results_keep_throughput_and_are_flagged():
    cancelled = _module.BenchResult(
        provider="p",
        model="m",
        status=_module.STATUS_CANCELLED,
        output_tokens=120,
        ttft_seconds=1.0,
        generation_seconds=3.0,
        total_seconds=4.0,
        workdir="/tmp/z",
    )
    assert cancelled.partial is True
    assert cancelled.output_tps == 40.0
    assert cancelled.wall_tps == 30.0

    table = _module.render_table([cancelled])
    assert "CANCEL*" in table
    assert "partial" in table
    details = _module.render_details([cancelled])
    assert "PARTIAL (cancelled)" in details
    # An interrupted model still contributes to the aggregate view.
    assert "1 CANCEL" in _module.render_summary([cancelled])


@pytest.mark.parametrize(
    ("clean_args", "expected_keep_workdirs"),
    [([], True), (["--clean"], False)],
    ids=["default-keeps-workdirs", "clean-removes-workdirs"],
)
def test_main_wires_clean_flag_to_bench(
    tmp_path, clean_args, expected_keep_workdirs
) -> None:
    report = {"results": [], "cancelled": False, "successful_models": 1}
    with (
        patch.object(_module.sys, "stdin", _Sink()),
        patch.object(_module, "create_run_dir", return_value=tmp_path / "run"),
        patch.object(_module, "bench", return_value=report) as bench,
    ):
        assert _module.main(["--provider", "provider", "--task", "prose", *clean_args]) == 0

    assert bench.call_args.kwargs["keep_workdirs"] is expected_keep_workdirs

def test_skipped_result_reports_no_throughput():
    skipped = _module.BenchResult(
        provider="p", model="m", status=_module.STATUS_SKIPPED
    )
    assert skipped.partial is False
    assert skipped.output_tps is None
    assert "SKIP" in _module.render_table([skipped])


# ── live progress ───────────────────────────────────────────────────────────


class _Sink:
    def __init__(self, tty=False):
        self.chunks: list[str] = []
        self._tty = tty

    def write(self, text):
        self.chunks.append(text)
        return len(text)

    def flush(self):
        return None

    def isatty(self):
        return self._tty

    @property
    def text(self):
        return "".join(self.chunks)


def test_model_live_row_reports_progress_columns():
    live = _module.ModelLive(label="p/m")
    live.begin()
    live.note_stream(12)
    live.note_tool("write")
    live.note_tokens(64)
    label, status, elapsed, ttft, tokens, speed, tools, idle, _note = live.row(
        time.monotonic()
    )
    assert label == "p/m"
    assert status.startswith("tool")
    assert elapsed.endswith("s") and ttft.endswith("s")
    assert tokens == "64"
    assert float(speed) > 0
    assert tools == "1"
    assert idle.endswith("s")


def test_model_live_row_estimates_tokens_before_usage_lands():
    live = _module.ModelLive(label="p/m")
    live.begin()
    live.note_stream(40)
    assert live.row(time.monotonic())[4] == "~10"  # chars/4 estimate


def test_model_live_row_surfaces_idle_and_final_status():
    stale = _module.ModelLive(label="p/hung")
    stale.begin()
    stale.last_activity_at = time.monotonic() - 30
    row = stale.row(time.monotonic())
    assert row[7] == "30s"  # idle column — the "is it hung?" signal
    assert stale.idle_seconds(time.monotonic()) >= 30
    assert stale.is_running() is True

    stale.finish(
        _module.STATUS_CANCELLED, "aborted: very long provider error text " * 5
    )
    assert stale.idle_seconds(time.monotonic()) == 0.0
    assert stale.is_running() is False
    finished = stale.row(time.monotonic())
    assert finished[1] == "CANCEL"
    assert finished[7] == "-"
    # Long provider text is collapsed to one padded cell, never wrapped.
    assert len(finished[8]) <= _module.NOTE_WIDTH
    assert "\n" not in finished[8]


def test_live_table_renders_header_divider_and_one_row_per_model():
    lives = [_module.ModelLive(label=f"p/m{index}") for index in range(3)]
    for live in lives:
        live.begin()
    table = _module.LiveTable(lives, stream=_Sink(tty=True), title="bench: x")
    lines = table.render().splitlines()
    assert lines[0] == "bench: x"
    assert "model" in lines[1] and "tok/s" in lines[1] and "idle" in lines[1]
    assert set(lines[2].strip()) == {"─", " "}
    assert [line.split()[0] for line in lines[3:6]] == ["p/m0", "p/m1", "p/m2"]
    assert "0/3 finished" in lines[6]
    assert "Ctrl+C" in lines[6]


def test_live_table_clamps_rows_to_the_window_and_keeps_running_models():
    lives = [_module.ModelLive(label=f"p/m{index}") for index in range(10)]
    for index, live in enumerate(lives):
        live.begin()
        if index < 8:
            live.finish(_module.STATUS_OK)
    table = _module.LiveTable(lives, stream=_Sink(tty=True), height=8)
    rendered = table.render()
    assert "rows hidden" in rendered
    # The still-running models must survive the clamp.
    assert "p/m8" in rendered and "p/m9" in rendered


def test_live_table_repaints_in_place_on_a_tty():
    live = _module.ModelLive(label="p/m")
    live.begin()
    sink = _Sink(tty=True)
    table = _module.LiveTable([live], stream=sink)
    table.paint()
    first_lines = len(table.render().splitlines())
    table.paint()
    assert f"\x1b[{first_lines}F\x1b[0J" in sink.text
    assert sink.text.count("p/m") == 2


def test_live_table_throttles_plain_output_when_not_a_tty():
    live = _module.ModelLive(label="p/m")
    live.begin()
    sink = _Sink(tty=False)
    table = _module.LiveTable([live], stream=sink, heartbeat=1_000)
    table.paint()
    table.paint()
    assert "\x1b[" not in sink.text
    assert sink.text.count("p/m") == 1  # heartbeat window suppresses the second


# ── cancellation ────────────────────────────────────────────────────────────


def test_run_model_skips_when_cancelled_before_start(tmp_path):
    cancel = threading.Event()
    cancel.set()
    result = _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=FakeClient,
        cancel=cancel,
    )
    assert result.status == _module.STATUS_SKIPPED
    assert not FakeClient.calls  # never launched a session


def test_run_model_cancel_aborts_the_turn_and_keeps_partial_stats(tmp_path):
    cancel = threading.Event()
    streaming = threading.Event()

    class HangingClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            self.emit_delta("hello world")
            self.emit_message_end(assistant(output=55, text="partial page"))
            streaming.set()
            # Blocks until the poller calls abort(), like a real stalled turn.
            self.aborted.wait(timeout=10)
            raise RuntimeError("aborted")

    def trigger():
        streaming.wait(timeout=5)
        cancel.set()

    threading.Thread(target=trigger, daemon=True).start()
    result = _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=HangingClient,
        cancel=cancel,
    )

    assert result.status == _module.STATUS_CANCELLED
    assert HangingClient.abort_calls == ["deepseek-v4-flash"]
    # Partial numbers survive the abort.
    assert result.output_tokens == 55
    assert result.streamed_chars == len("hello world")
    assert result.ttft_seconds is not None
    assert result.partial is True
    assert result.output_tps is not None


def test_run_model_stall_timeout_aborts_a_silent_provider(tmp_path):
    class SilentClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            self.aborted.wait(timeout=10)
            raise RuntimeError("aborted")

    live = _module.ModelLive(label="p/silent")
    result = _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=SilentClient,
        stall_timeout=0.3,
        live=live,
    )

    assert result.status == _module.STATUS_STALLED
    assert SilentClient.abort_calls == ["deepseek-v4-flash"]
    assert live.status == _module.STATUS_STALLED


def test_bench_cancel_marks_queued_models_skipped_and_flags_the_report(tmp_path):
    cancel = threading.Event()
    first_running = threading.Event()
    lock = threading.Lock()
    started: list[str] = []

    class CancelOnFirstClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            with lock:
                started.append(self.kwargs["model"])
                first = len(started) == 1
            if first:
                self.emit_delta("chunk")
                self.emit_message_end(assistant(output=20))
                first_running.set()
                cancel.set()
                self.aborted.wait(timeout=10)
                raise RuntimeError("aborted")
            return super().prompt_and_wait(message, timeout=timeout)

    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=CancelOnFirstClient,
        jobs=1,
        cancel=cancel,
        live=False,
        log=lambda _message: None,
    )

    assert report["cancelled"] is True
    statuses = {entry["status"] for entry in report["results"]}
    assert _module.STATUS_CANCELLED in statuses
    assert _module.STATUS_SKIPPED in statuses
    # Only the first model ever launched a turn; the rest were skipped.
    assert len(started) == 1
    cancelled = next(
        entry
        for entry in report["results"]
        if entry["status"] == _module.STATUS_CANCELLED
    )
    assert cancelled["output_tokens"] == 20
    assert cancelled["partial"] is True
    saved = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert saved["cancelled"] is True
    assert saved["status_counts"][_module.STATUS_SKIPPED] == 2


def test_bench_passes_stall_timeout_to_every_model(tmp_path):
    seen: list[float | None] = []
    original = _module.run_model

    def spy(model, **kwargs):
        seen.append(kwargs.get("stall_timeout"))
        return original(model, **kwargs)

    _module.run_model = spy
    try:
        _module.bench(
            query="deepseek-v4-flash",
            mode="partial",
            topic="a tea shop",
            executable="omp",
            root=tmp_path,
            client_factory=FakeClient,
            stall_timeout=42.0,
            live=False,
            log=lambda _message: None,
        )
    finally:
        _module.run_model = original

    assert seen == [42.0, 42.0, 42.0]


def test_run_model_cancels_while_the_session_is_still_starting(tmp_path):
    """Ctrl+C during `client.start()` must not wait out the startup timeout."""
    cancel = threading.Event()
    starting = threading.Event()

    class SlowStartClient(FakeClient):
        def start(self):
            starting.set()
            # A cold/wedged provider sits here for the whole startup timeout and
            # is not released by abort() — the poller must give up on its own.
            time.sleep(30)
            return self

    def trigger():
        starting.wait(timeout=5)
        cancel.set()

    threading.Thread(target=trigger, daemon=True).start()
    began = time.monotonic()
    result = _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=SlowStartClient,
        cancel=cancel,
        abort_grace=0.5,
    )
    elapsed = time.monotonic() - began

    assert result.status in {_module.STATUS_CANCELLED, _module.STATUS_ABANDONED}
    assert elapsed < 10  # bounded by the abort grace, not the 30s startup


def test_run_model_does_not_block_on_a_wedged_abort(tmp_path):
    """A blocking `abort()` is fired on its own thread, never inline."""

    class WedgedAbortClient(FakeClient):
        def abort(self):
            type(self).abort_calls.append(self.kwargs.get("model"))
            time.sleep(30)  # RPC round-trip against a dead process

        def prompt_and_wait(self, message, *, timeout=None):
            self.emit_delta("chunk")
            self.emit_message_end(assistant(output=11))
            time.sleep(30)
            raise RuntimeError("never")

    cancel = threading.Event()
    cancel_thread = threading.Timer(0.2, cancel.set)
    cancel_thread.daemon = True
    cancel_thread.start()

    began = time.monotonic()
    result = _module.run_model(
        FakeModel("p", "deepseek-v4-flash"),
        task="create me landing page on the topic x.",
        root=tmp_path,
        client_factory=WedgedAbortClient,
        cancel=cancel,
        abort_grace=0.5,
    )
    elapsed = time.monotonic() - began

    assert result.status == _module.STATUS_ABANDONED
    assert result.output_tokens == 11  # partial numbers survive
    assert elapsed < 10


def test_bench_prints_within_the_cancel_grace_even_with_a_stuck_model(tmp_path):
    """The batch must never wait forever on a straggler after Ctrl+C."""
    cancel = threading.Event()
    running = threading.Event()

    class StuckClient(FakeClient):
        def prompt_and_wait(self, message, *, timeout=None):
            self.emit_delta("chunk")
            running.set()
            time.sleep(60)  # ignores abort entirely
            raise RuntimeError("never")

    def trigger():
        running.wait(timeout=5)
        cancel.set()

    threading.Thread(target=trigger, daemon=True).start()
    began = time.monotonic()
    report = _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=StuckClient,
        cancel=cancel,
        cancel_grace=1.0,
        live=False,
        log=lambda _message: None,
    )
    elapsed = time.monotonic() - began

    assert elapsed < 20
    assert report["cancelled"] is True
    # Every model still gets a row, so the printed table is complete.
    assert len(report["results"]) == 3
    assert _module.STATUS_ABANDONED in {entry["status"] for entry in report["results"]}
    assert (tmp_path / "report.json").is_file()


def test_bench_routes_model_chatter_to_the_log_file(tmp_path):
    printed: list[str] = []
    _module.bench(
        query="deepseek-v4-flash",
        mode="partial",
        topic="a tea shop",
        executable="omp",
        root=tmp_path,
        client_factory=FakeClient,
        live=False,
        log=printed.append,
    )

    log_text = (tmp_path / "bench.log").read_text(encoding="utf-8")
    assert "started" in log_text and "done in" in log_text
    # Per-model lines never reach the console; only the batch header does.
    assert not any("done in" in line for line in printed)
    assert any("Matched 3 model(s)" in line for line in printed)


# ─────────────────────────────────────────────────────────────────────────────
# Provider sweep, prose task, and the tool-free sandbox
# ─────────────────────────────────────────────────────────────────────────────


def test_select_provider_models_is_exact_and_sorted() -> None:
    models = [
        FakeModel("anoman-vuln", "aion-3-0"),
        FakeModel("anoman-vuln-beta", "aion-9-0"),
        FakeModel("ANOMAN-VULN", "aion-2-0"),
        FakeModel("other", "x-1"),
    ]
    selected = _module.select_provider_models(models, "anoman-vuln")
    # Case-insensitive match, but `anoman-vuln-beta` is a different provider.
    assert [model.id for model in selected] == ["aion-2-0", "aion-3-0"]


def test_select_provider_models_empty_for_unknown_provider() -> None:
    models = [FakeModel("anoman-vuln", "aion-2-0")]
    assert _module.select_provider_models(models, "nope") == []
    assert _module.available_providers(models) == ["anoman-vuln"]


def test_prose_task_asks_for_prose_only_and_no_tools() -> None:
    task = _module.PROSE_TASK_TEMPLATE.format(words=900, subject="a subject")
    assert "at least 900 words" in task
    assert "a subject" in task
    # The task must not invite structure that shortens decode, nor tool use.
    for banned in ("bullet", "headings", "code blocks", "tables"):
        assert banned in task
    assert "single reply" in task


def test_config_overlay_disables_the_always_included_custom_tools() -> None:
    # `learn`/`manage_skill` are custom tools and survive `--no-tools`; only
    # their feature switches keep the tool list empty.
    assert "autolearn:" in _module.CONFIG_OVERLAY
    assert "skills:" in _module.CONFIG_OVERLAY
    assert "enabled: false" in _module.CONFIG_OVERLAY


def test_build_agent_sandbox_copies_credentials_but_never_mcp(tmp_path) -> None:
    source = tmp_path / "agent"
    source.mkdir()
    (source / "auth.json").write_text("{}", encoding="utf-8")
    (source / "models.yml").write_text("providers: {}", encoding="utf-8")
    (source / "models.db").write_text("cache", encoding="utf-8")
    (source / "mcp.json").write_text('{"mcpServers": {}}', encoding="utf-8")
    (source / "plugins").mkdir()
    (source / "plugins" / "p.json").write_text("{}", encoding="utf-8")

    root = tmp_path / "run"
    with patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(source)}):
        sandbox = _module.build_agent_sandbox(root, log=lambda _message: None)

    names = {entry.name for entry in sandbox.iterdir()}
    assert {"auth.json", "models.yml", "models.db"} <= names
    assert "mcp.json" not in names
    assert "plugins" not in names


def test_sandbox_env_redirects_agent_dir_and_home(tmp_path) -> None:
    source = tmp_path / "agent"
    source.mkdir()
    (source / "auth.json").write_text("{}", encoding="utf-8")
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    (fake_home / ".gitconfig").write_text("[user]\n\tname = t\n", encoding="utf-8")
    (fake_home / ".cursor").mkdir()
    (fake_home / ".cursor" / "mcp.json").write_text(
        '{"mcpServers": {"x": {}}}', encoding="utf-8"
    )
    root = tmp_path / "run"
    with patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(source),
            "USERPROFILE": str(fake_home),
            "HOME": str(fake_home),
        },
    ):
        env = _module.sandbox_env(root, log=lambda _message: None)

    # Foreign MCP configs live in the home directory, so it must move too.
    assert env["PI_CODING_AGENT_DIR"] == str(root / "_agent")
    assert env["HOME"] == str(root / "_home")
    assert env["USERPROFILE"] == env["HOME"]
    sandbox_home = Path(env["HOME"])
    assert sandbox_home.is_dir()
    # Host identity is carried over; the MCP declaration is not.
    assert (sandbox_home / ".gitconfig").is_file()
    assert not (sandbox_home / ".cursor").exists()
    # The benchmark process keeps its own environment.
    assert os.environ.get("HOME") != env["HOME"]


def test_render_table_reports_the_builtin_tps_column() -> None:
    result = _module.BenchResult(
        provider="anoman-vuln",
        model="aion-2-0",
        status=_module.STATUS_OK,
        omp_tps=60.46,
        output_tokens=2867,
        generation_seconds=41.47,
        total_seconds=66.18,
    )
    table = _module.render_table([result])
    assert "omp tps" in table
    assert "60.46" in table
    assert "69.13" in table  # locally derived generation rate, kept alongside


def test_omp_tps_survives_the_report_round_trip() -> None:
    result = _module.BenchResult(
        provider="p", model="m", status=_module.STATUS_OK, omp_tps=12.5
    )
    assert result.as_dict()["omp_tps"] == 12.5


def test_create_run_dir_keeps_each_invocation_in_a_unique_child(tmp_path) -> None:
    with patch.object(_module.time, "strftime", return_value="bench-tps-20260909-120000"):
        first = _module.create_run_dir(tmp_path)
        second = _module.create_run_dir(tmp_path)
    assert first.parent == tmp_path
    assert second.parent == tmp_path
    assert first.name == "bench-tps-20260909-120000"
    assert second.name == "bench-tps-20260909-120000-02"


def test_ask_allows_empty_only_when_requested() -> None:
    with patch("builtins.input", side_effect=["", "  ", "value"]):
        # No default and no allow_empty: keeps asking (the interactive hang).
        assert _module._ask("q") == "value"
    with patch("builtins.input", side_effect=[""]):
        assert _module._ask("q", allow_empty=True) == ""
    with patch("builtins.input", side_effect=[""]):
        assert _module._ask("q", "fallback") == "fallback"


def test_ask_int_rejects_junk_and_negatives() -> None:
    with patch("builtins.input", side_effect=["abc", "-1", "3"]):
        assert _module._ask_int("workers", 4) == 3
    with patch("builtins.input", side_effect=[""]):
        assert _module._ask_int("workers", 4) == 4
    # 0 stays reachable: it means "all at once".
    with patch("builtins.input", side_effect=["0"]):
        assert _module._ask_int("workers", 4) == 0


def test_task_menu_covers_every_task_choice() -> None:
    """The interactive menu and `--task` choices must not drift apart."""
    menu_names = {name for _, name, _ in _module.TASK_MENU}
    assert menu_names == {"hi", "dialogue", "prose", "context", "landing", "custom"}
    letters = [letter for letter, name, _ in _module.TASK_MENU]
    assert letters == ["a", "b", "c", "d", "e", "f"]
    assert len(set(letters)) == len(letters)


def test_ask_task_accepts_letters_names_and_default() -> None:
    with patch("builtins.input", side_effect=["a"]):
        assert _module._ask_task() == "hi"
    with patch("builtins.input", side_effect=["b"]):
        assert _module._ask_task() == "dialogue"
    with patch("builtins.input", side_effect=["dialogue"]):
        assert _module._ask_task() == "dialogue"
    # Empty answer keeps the documented default.
    with patch("builtins.input", side_effect=[""]):
        assert _module._ask_task() == "prose"
    # Junk re-asks instead of guessing.
    with patch("builtins.input", side_effect=["nope", "c"]):
        assert _module._ask_task() == "prose"


def test_hi_task_is_a_bare_prompt() -> None:
    """The latency prompt must stay tiny: no instructions to decode."""
    assert _module.HI_TASK.strip().lower() == "hi"
    assert len(_module.HI_TASK) < 8


def test_dialogue_task_requests_prose_only_output() -> None:
    prompt = _module.DIALOGUE_TASK_TEMPLATE.format(
        words=900, subject=_module.DIALOGUE_SUBJECTS[0]
    )
    assert "900" in prompt
    assert _module.DIALOGUE_SUBJECTS[0] in prompt
    # A tool call or a clarifying question would break tokens/second attribution.
    for banned in ("bullet lists", "code blocks", "do not ask questions"):
        assert banned in prompt.lower()
    assert all(subject.strip() for subject in _module.DIALOGUE_SUBJECTS)


def test_overlay_disables_fallback_and_retries() -> None:
    """A benchmark must measure the pinned model or report nothing.

    With fallback enabled, a dead provider's turn is answered by a different
    model and its tokens/second are credited to the pinned one — every broken
    gateway scored "ok".
    """
    overlay = _module.CONFIG_OVERLAY
    assert "modelFallback: false" in overlay
    assert "usageAwareFallback: false" in overlay
    assert "fallbackChains: {}" in overlay
    assert "maxRetries: 0" in overlay


def test_overlay_disables_compaction_so_the_prompt_is_sent_verbatim() -> None:
    """A 1M-token `--task context` prompt must reach the provider unmodified.

    With compaction enabled the input would be summarized away and the run
    would measure compaction, not the advertised context window.
    """
    assert "compaction:\n  enabled: false" in _module.CONFIG_OVERLAY


def test_answered_by_other_model_flags_a_foreign_responder() -> None:
    result = _module.BenchResult(provider="dead-vuln", model="gpt-6-astra")
    result.answered_by = {"other-vuln/kimi-k3"}
    assert _module._answered_by_other_model(result) == "other-vuln/kimi-k3"


def test_answered_by_other_model_accepts_the_pinned_and_resolved_ids() -> None:
    pinned = _module.BenchResult(provider="dead-vuln", model="gpt-6-astra")
    pinned.answered_by = {"dead-vuln/gpt-6-astra"}
    assert _module._answered_by_other_model(pinned) is None

    # `_pin_exact_model` may record a fuller id than the requested one.
    resolved = _module.BenchResult(
        provider="dead-vuln",
        model="gpt-6-astra",
        resolved_provider="dead-vuln",
        resolved_model="openai/gpt-6-astra",
    )
    resolved.answered_by = {"dead-vuln/openai/gpt-6-astra"}
    assert _module._answered_by_other_model(resolved) is None

    # Gateways vary the casing of their own ids.
    cased = _module.BenchResult(provider="dead-vuln", model="gpt-6-astra")
    cased.answered_by = {"Dead-Vuln/GPT-6-Astra"}
    assert _module._answered_by_other_model(cased) is None

    # No attribution at all (older transcript shape) must not fail the row.
    bare = _module.BenchResult(provider="dead-vuln", model="gpt-6-astra")
    assert _module._answered_by_other_model(bare) is None


def test_summarize_turn_records_who_answered() -> None:
    result = _module.BenchResult(provider="pinned", model="model-a")
    _module.summarize_turn(
        result,
        [
            {
                "role": "assistant",
                "provider": "fallback-provider",
                "model": "model-b",
                "usage": {"output": 7},
                "content": [],
            }
        ],
    )
    assert result.answered_by == {"fallback-provider/model-b"}
    assert result.assistant_messages == 1
    assert _module._answered_by_other_model(result) == "fallback-provider/model-b"


def test_answered_by_survives_the_report_round_trip() -> None:
    result = _module.BenchResult(provider="p", model="m")
    result.answered_by = {"p/m"}
    payload = json.loads(json.dumps(result.as_dict()))
    assert payload["answered_by"] == ["p/m"]


def test_bench_result_rebuilt_from_a_report_keeps_a_usable_answered_by() -> None:
    """`as_dict` writes a list (JSON has no set); reconstruction must restore it."""
    original = _module.BenchResult(provider="p", model="m", status=_module.STATUS_OK)
    original.answered_by = {"other/model"}
    payload = json.loads(json.dumps(original.as_dict()))
    payload.pop("output_tps", None)
    payload.pop("wall_tps", None)
    payload.pop("partial", None)

    rebuilt = _module.BenchResult(**payload)
    assert rebuilt.answered_by == {"other/model"}
    assert _module._answered_by_other_model(rebuilt) == "other/model"

    # An empty/missing attribution stays OK — a transcript without provider or
    # model fields must not be reported as a foreign responder.
    empty = _module.BenchResult(provider="p", model="m", answered_by=[])
    assert empty.answered_by == set()
    assert _module._answered_by_other_model(empty) is None


def test_context_probe_hits_the_requested_token_count_when_measured() -> None:
    """The prompt must be SIZED, not estimated.

    A guessed words-per-token ratio produced 1.38M tokens for a 1M request, so a
    gateway with a genuine 1,048,576 window rejected it
    ("you requested about 1447376 tokens") and looked broken.
    """
    tiktoken = pytest.importorskip("tiktoken")
    encoding = tiktoken.get_encoding("o200k_base")
    for requested in (1_000, 50_000):
        prompt = _module.build_context_probe_task(requested)
        actual = len(encoding.encode(prompt))
        assert abs(actual - requested) <= max(32, requested // 100), (requested, actual)


def test_context_probe_clamps_to_the_model_window_minus_output_reserve() -> None:
    # The reported failure: 1,048,576 window, 64,000 reserved for output.
    allowed = _module.resolve_context_input_tokens(1_000_000, 1_048_576, 64_000)
    assert allowed < 1_048_576 - 64_000
    assert allowed > 900_000
    # A small window clamps hard rather than guaranteeing a 400.
    assert _module.resolve_context_input_tokens(1_000_000, 128_000, 8_192) < 120_000
    # Unknown window: honour the request and let the provider answer.
    assert _module.resolve_context_input_tokens(1_000_000, None, None) == 1_000_000
    # Never clamp UP a small request.
    assert _module.resolve_context_input_tokens(10_000, 1_048_576, 64_000) == 10_000


def test_context_probe_asks_for_a_one_word_answer() -> None:
    # Output must stay trivial: this probe measures accepted INPUT, and a long
    # answer would just spend tokens and time.
    prompt = _module.build_context_probe_task(1_000)
    assert prompt.rstrip().endswith("ok")
    for instruction in ("ignore all of it", "do not summarize", "exactly one word"):
        assert instruction in prompt.lower()


def test_context_probe_filler_is_not_repetitive_or_random_per_run() -> None:
    # A repeated prompt can be served from a prefix cache (or squashed by a
    # proxy), which would prove nothing about capacity — so the filler is word
    # salad. It is seeded, so one run is reproducible across models.
    assert _module.build_context_probe_task(2_000) == _module.build_context_probe_task(
        2_000
    )
    head = _module.build_context_probe_task(4_000).split()[:300]
    assert len(set(head)) > 20
    assert len(_module.CONTEXT_FILLER_VOCABULARY) >= 40


def test_context_task_is_offered_in_the_menu_and_cli() -> None:
    assert any(name == "context" for _, name, _ in _module.TASK_MENU)
    letters = [letter for letter, _, _ in _module.TASK_MENU]
    assert letters == ["a", "b", "c", "d", "e", "f"]


def test_only_the_landing_task_gets_tools() -> None:
    """Adding a task opts OUT of tools by default: a tool call interleaves local
    work with decode and destroys the tokens/second being measured."""
    assert _module.TASKS_WITH_TOOLS == frozenset({"landing"})
    for task in ("hi", "dialogue", "prose", "context", "custom"):
        assert task not in _module.TASKS_WITH_TOOLS


def test_run_model_disables_mcp_for_every_task_including_tool_users(tmp_path):
    """`landing` needs built-in tools but never MCP.

    MCP servers are custom tools that mount even under an empty allowlist, and
    each instance forks its own fleet (measured 21 child processes per instance
    vs 1 with the flag). For a tool-using task that is pure startup cost; for a
    parallel batch it starves every other omp on the machine.
    """
    for tools in ([], None, ["read", "write"]):
        _module.run_model(
            FakeModel("p", "m"),
            task="create me landing page on the topic x.",
            root=tmp_path,
            client_factory=FakeClient,
            tools=tools,
        )
        args = FakeClient.calls[-1]["extra_args"]
        assert "--no-mcp" in args, f"tools={tools!r} launched with MCP enabled"
        assert "--no-extensions" in args
        assert "--no-fallback" in args
