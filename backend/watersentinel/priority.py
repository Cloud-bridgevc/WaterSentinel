"""Alert prioritization. Mirrors web/js/priority.js."""
from __future__ import annotations

from .detector import AnomalyEvent

DEFAULT_WEIGHTS = {
    "magnitude": 0.30,
    "duration": 0.25,
    "recurrence": 0.15,
    "criticality": 0.15,
    "ongoing": 0.15,
}


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def factors(ev: AnomalyEvent, site_criticality: float) -> dict[str, float]:
    return {
        "magnitude": _clamp((ev.mean_ratio - 1) / 1.5),
        "duration": _clamp(ev.span_hours / 72),
        "recurrence": _clamp(ev.recurrence / 3),
        "criticality": _clamp(site_criticality),
        "ongoing": 1.0 if ev.ongoing else 0.0,
    }


def score(ev: AnomalyEvent, site_criticality: float, weights: dict[str, float] | None = None) -> int:
    w = weights or DEFAULT_WEIGHTS
    total = sum(w.values()) or 1.0
    f = factors(ev, site_criticality)
    return round(sum(100 * w[k] * f[k] for k in w) / total)


def band(s: int) -> str:
    if s >= 65:
        return "P1"
    if s >= 40:
        return "P2"
    return "P3"
