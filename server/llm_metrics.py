"""Process-local counters for optional Anthropic calls; never record request text."""

from __future__ import annotations

from collections import Counter, defaultdict
from math import isfinite
import os
from threading import Lock


_LOCK = Lock()
_COUNTERS: dict[str, Counter[str]] = defaultdict(Counter)


def record_llm_metric(adapter: str, name: str, amount: int = 1) -> None:
    with _LOCK:
        _COUNTERS[adapter][name] += amount


def llm_metrics_snapshot() -> dict[str, dict[str, int | float | None]]:
    with _LOCK:
        snapshots = {adapter: dict(values) for adapter, values in _COUNTERS.items()}
    for adapter, values in snapshots.items():
        input_rate = os.environ.get(f"ANTHROPIC_{adapter.upper()}_INPUT_USD_PER_MILLION", "").strip()
        output_rate = os.environ.get(f"ANTHROPIC_{adapter.upper()}_OUTPUT_USD_PER_MILLION", "").strip()
        try:
            if not input_rate or not output_rate:
                raise ValueError("token prices not configured")
            per_input_million = float(input_rate)
            per_output_million = float(output_rate)
            if not isfinite(per_input_million) or not isfinite(per_output_million) or per_input_million < 0 or per_output_million < 0:
                raise ValueError("token prices must be finite and non-negative")
            estimated = (
                values.get("input_tokens", 0) * per_input_million
                + values.get("output_tokens", 0) * per_output_million
            ) / 1_000_000
            values["estimated_cost_usd"] = round(estimated, 6)
        except ValueError:
            values["estimated_cost_usd"] = None
    return snapshots
