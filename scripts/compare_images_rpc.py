#!/usr/bin/env python3
"""Compare two images with three OMP models in parallel.

Requires the repository's ``omp-rpc`` package:
    pip install -e python/omp-rpc

Example:
    python scripts/compare_images_rpc.py before.png after.png -o report.json
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from time import monotonic
from typing import Callable, Sequence

from omp_rpc import ImageContent, RpcClient


MODEL_CONFIG = (
    ("antigravity-native", "gemini-3.6-flash"),
    ("openai", "luna"),
    ("anthropic", "opus5"),
)
PROMPT_PATH = Path(__file__).with_name("compare_images_prompt.md")


def load_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")



@dataclass(frozen=True)
class ModelResult:
    provider: str
    model: str
    status: str
    response: str | None = None
    error: str | None = None
    elapsed_seconds: float | None = None


def _mime_type(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
        raise ValueError(f"Unsupported image type for {path}: {mime or 'unknown'}")
    return mime


def load_image(path: Path) -> ImageContent:
    if not path.is_file():
        raise FileNotFoundError(path)
    return {
        "type": "image",
        "data": base64.b64encode(path.read_bytes()).decode("ascii"),
        "mimeType": _mime_type(path),
    }


def compare_with_model(
    provider: str,
    model: str,
    images: Sequence[ImageContent],
    *,
    timeout: float,
    client_factory: Callable[..., RpcClient] = RpcClient,
) -> ModelResult:
    started = monotonic()
    try:
        with client_factory(
            provider=provider,
            model=model,
            thinking="high",
            startup_timeout=timeout,
            request_timeout=timeout,
        ) as client:
            turn = client.prompt_and_wait(load_prompt(), images=images, timeout=timeout)
            response = turn.require_assistant_text()
        return ModelResult(
            provider=provider,
            model=model,
            status="ok",
            response=response,
            elapsed_seconds=round(monotonic() - started, 3),
        )
    except Exception as exc:  # Keep one provider failure from hiding other results.
        return ModelResult(
            provider=provider,
            model=model,
            status="error",
            error=f"{type(exc).__name__}: {exc}",
            elapsed_seconds=round(monotonic() - started, 3),
        )


def compare_images(
    before: Path,
    after: Path,
    *,
    timeout: float = 300.0,
    client_factory: Callable[..., RpcClient] = RpcClient,
) -> dict[str, object]:
    images = [load_image(before), load_image(after)]
    results: list[ModelResult] = []
    with ThreadPoolExecutor(max_workers=len(MODEL_CONFIG), thread_name_prefix="omp-vision") as pool:
        futures = {
            pool.submit(
                compare_with_model,
                provider,
                model,
                images,
                timeout=timeout,
                client_factory=client_factory,
            ): (provider, model)
            for provider, model in MODEL_CONFIG
        }
        for future in as_completed(futures):
            results.append(future.result())

    results.sort(key=lambda item: next(index for index, config in enumerate(MODEL_CONFIG) if config == (item.provider, item.model)))
    return {
        "before": str(before),
        "after": str(after),
        "models": [asdict(result) for result in results],
        "successful_models": sum(result.status == "ok" for result in results),
        "failed_models": sum(result.status != "ok" for result in results),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path, help="Baseline/earlier image")
    parser.add_argument("after", type=Path, help="Later/design-under-test image")
    parser.add_argument("-o", "--output", type=Path, help="Write JSON report to this path")
    parser.add_argument("--timeout", type=float, default=300.0, help="Per-model startup/request timeout in seconds")
    args = parser.parse_args(argv)

    try:
        report = compare_images(args.before, args.after, timeout=args.timeout)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    rendered = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0 if report["successful_models"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
