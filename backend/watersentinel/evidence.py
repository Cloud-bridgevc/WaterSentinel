"""Evidence package: the only facts the investigation assistant may use. Mirrors buildEvidence in web/js/assistant.js."""
from __future__ import annotations

from datetime import datetime, timezone
from statistics import mean
from typing import Sequence

from .detector import AnomalyEvent, DetectorConfig, Reading, Scored, minimum_night_flow


def fmt_time(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%a %d %b %H:00")


def build_evidence(ev: AnomalyEvent, *, site: dict, meter: dict, series: Sequence[Reading],
                   scored: Sequence[Scored], cfg: DetectorConfig = DetectorConfig()) -> dict:
    window = [r for r in scored if ev.start_ts <= r.ts <= ev.end_ts and r.litres is not None]
    obs = mean(r.litres for r in window) if window else 0.0
    exp = mean((r.expected or 0.0) for r in window) if window else 0.0
    peak = max(window, key=lambda r: r.litres) if window else None

    mnf = minimum_night_flow(series, cfg)
    ev_day = ev.start_ts - ev.start_ts % 86400
    before = [v for d, v in mnf if d < ev_day][-14:]
    during = [v for d, v in mnf if ev_day <= d <= ev.end_ts]

    gaps, run_start = [], None
    for r in series:
        if r.litres is None and run_start is None:
            run_start = r.ts
        elif r.litres is not None and run_start is not None:
            gaps.append((run_start, (r.ts - run_start) // 3600))
            run_start = None
    near = [g for g in gaps if ev.start_ts - 7 * 86400 <= g[0] <= ev.end_ts + 86400]

    return {
        "anomaly_id": ev.event_id,
        "status": "detected_anomaly_unverified",
        "site": {"name": site["name"], "type": site.get("type"), "criticality": site.get("criticality")},
        "meter": {"id": meter["id"], "name": meter["name"], "serial": meter.get("serial")},
        "pattern": ev.pattern,
        "window": {"start": fmt_time(ev.start_ts), "end": fmt_time(ev.end_ts), "span_hours": ev.span_hours,
                   "flagged_hours": ev.flagged_hours, "ongoing": ev.ongoing},
        "flow": {
            "observed_mean_lph": round(obs), "expected_mean_lph": round(exp), "excess_mean_lph": round(obs - exp),
            "excess_total_litres": round(ev.excess_litres), "peak_lph": round(peak.litres) if peak else 0,
            "peak_time": fmt_time(peak.ts) if peak else None, "peak_robust_z": round(ev.peak_z, 1),
        },
        "night_flow": {
            "flagged_night_hours": ev.night_hours,
            "baseline_min_night_flow_lph": round(mean(before)) if before else None,
            "event_min_night_flow_lph": round(mean(during)) if during else None,
        },
        "recurrence": {"earlier_events_same_meter": ev.recurrence},
        "data_quality": {"gaps_nearby": [{"start": fmt_time(s), "hours": h} for s, h in near], "history_days_used": cfg.day_window},
        "detector": {"method": "dual-baseline robust z-score (hour-of-day and hour-of-week medians)", "z_threshold": cfg.z_threshold},
    }
