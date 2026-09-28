from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from threading import Lock


SCRIPT = Path(__file__).parents[3] / "scripts" / "compare_images_rpc.py"
_spec = importlib.util.spec_from_file_location("compare_images_rpc", SCRIPT)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _module
_spec.loader.exec_module(_module)


class FakeTurn:
    def __init__(self, text: str):
        self._text = text

    def require_assistant_text(self) -> str:
        return self._text


class FakeClient:
    calls: list[dict] = []
    lock = Lock()

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        with self.lock:
            self.calls.append(kwargs)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def prompt_and_wait(self, _message, *, images, timeout):
        assert len(images) == 2
        assert all(image["type"] == "image" for image in images)
        assert timeout == 7
        return FakeTurn(f"{self.kwargs['provider']}/{self.kwargs['model']}")


def test_compare_images_runs_all_models_in_parallel(tmp_path):
    before = tmp_path / "before.png"
    after = tmp_path / "after.jpg"
    before.write_bytes(b"before")
    after.write_bytes(b"after")
    FakeClient.calls.clear()

    report = _module.compare_images(before, after, timeout=7, client_factory=FakeClient)

    assert report["successful_models"] == 3
    assert report["failed_models"] == 0
    assert [result["provider"] for result in report["models"]] == [
        "antigravity-native",
        "openai",
        "anthropic",
    ]
    assert len(FakeClient.calls) == 3
    assert all(call["thinking"] == "high" for call in FakeClient.calls)
    assert all("tools" not in call for call in FakeClient.calls)


def test_one_model_failure_does_not_hide_other_results(tmp_path):
    before = tmp_path / "before.png"
    after = tmp_path / "after.png"
    before.write_bytes(b"before")
    after.write_bytes(b"after")

    class PartlyFailingClient(FakeClient):
        def __init__(self, **kwargs):
            if kwargs["provider"] == "openai":
                raise RuntimeError("simulated provider failure")
            super().__init__(**kwargs)

    report = _module.compare_images(before, after, timeout=7, client_factory=PartlyFailingClient)

    assert report["successful_models"] == 2
    assert report["failed_models"] == 1
    failed = next(result for result in report["models"] if result["provider"] == "openai")
    assert failed["status"] == "error"
    assert "simulated provider failure" in failed["error"]


def test_report_is_json_serializable(tmp_path):
    before = tmp_path / "before.webp"
    after = tmp_path / "after.gif"
    before.write_bytes(b"before")
    after.write_bytes(b"after")

    report = _module.compare_images(before, after, client_factory=FakeClient)
    json.dumps(report)
