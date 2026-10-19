"""Consumption anomaly detector (backend build).

Mirrors web/js/detector.js; keep the two in sync.

Method: dual-baseline robust z-score on hourly interval readings.
  * Baseline A: same hour-of-day over the previous ``day_window`` days.
  * Baseline B: same hour-of-week over the previous ``week_window`` weeks.
  For each: expected = median, sigma = max(1.4826 * MAD, ratio floor, absolute floor).
  An hour is flagged only if it exceeds BOTH baselines by ``z_threshold`` and by a
  minimum excess. Flagged hours are excluded from later baselines. Consecutive
  flagged hours (allowing short gaps) are grouped into events.

The detector reports *anomalies*. It never classifies anything as a leak.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from statistics import median
from typing import Optional, Sequence

HOUR_S = 3600


@dataclass(frozen=True)
class DetectorConfig:
    day_window: int = 14
    week_window: int = 4
    z_threshold: float = 3.5
    min_excess_ratio: float = 0.25
    min_excess_lph: float = 50.0
    sigma_floor_ratio: float = 0.06
    sigma_floor_lph: float = 15.0
    merge_gap_hours: int = 3
    night_start_hour: int = 1
    night_end_hour: int = 4

    @property
    def warmup_hours(self) -> int:
        return max(self.day_window, self.week_window * 7) * 24


@dataclass
class Reading:
    ts: int  # epoch seconds, start of the hourly interval
    litres: Optional[float]  # None = missing


@dataclass
class Scored:
    ts: int
    litres: Optional[float]
    expected: Optional[float] = None
    z: Optional[float] = None
    flagged: bool = False
    warmup: bool = False


@dataclass
class AnomalyEvent:
    meter_id: str
    start_ts: int
    end_ts: int
    flagged_hours: int = 0
    night_hours: int = 0
    peak_z: float = 0.0
    peak_lph: float = 0.0
    excess_litres: float = 0.0
    span_hours: int = 0
    mean_ratio: float = 1.0
    ongoing: bool = False
    pattern: str = ""
    recurrence: int = 0
    _sum_obs: float = field(default=0.0, repr=False)
    _sum_exp: float = field(default=0.0, repr=False)

    @property
    def event_id(self) -> str:
        return f"{self.meter_id}-{datetime.fromtimestamp(self.start_ts, timezone.utc):%Y%m%d%H}"

    def to_dict(self) -> dict:
        d = {k: v for k, v in asdict(self).items() if not k.startswith("_")}
        d["event_id"] = self.event_id
        return d


def _robust(samples: Sequence[float], cfg: DetectorConfig) -> tuple[float, float]:
    med = median(samples)
    mad = median([abs(x - med) for x in samples])
    sigma = max(1.4826 * mad, cfg.sigma_floor_ratio * med, cfg.sigma_floor_lph)
    return med, sigma


def score_series(series: Sequence[Reading], cfg: DetectorConfig = DetectorConfig()) -> list[Scored]:
    """Score an hourly, ascending, evenly spaced series for one meter."""
    flagged = [False] * len(series)
    out: list[Scored] = []
    for i, r in enumerate(series):
        if r.litres is None or i < cfg.warmup_hours:
            out.append(Scored(r.ts, r.litres, warmup=i < cfg.warmup_hours))
            continue
        day = [series[i - k * 24].litres for k in range(1, cfg.day_window + 1)
               if i - k * 24 >= 0 and series[i - k * 24].litres is not None and not flagged[i - k * 24]]
        week = [series[i - k * 168].litres for k in range(1, cfg.week_window + 1)
                if i - k * 168 >= 0 and series[i - k * 168].litres is not None and not flagged[i - k * 168]]
        if len(day) < 3 or len(week) < 2:
            out.append(Scored(r.ts, r.litres, warmup=True))
            continue
        exp_a, sig_a = _robust(day, cfg)
        exp_b, sig_b = _robust(week, cfg)
        z = min((r.litres - exp_a) / sig_a, (r.litres - exp_b) / sig_b)
        ref = max(exp_a, exp_b)
        is_flag = z >= cfg.z_threshold and (r.litres - ref) >= max(cfg.min_excess_lph, cfg.min_excess_ratio * ref)
        flagged[i] = is_flag
        out.append(Scored(r.ts, r.litres, expected=exp_b, z=z, flagged=is_flag))
    return out


def _is_night(ts: int, cfg: DetectorConfig) -> bool:
    h = datetime.fromtimestamp(ts, timezone.utc).hour
    return cfg.night_start_hour <= h <= cfg.night_end_hour


def describe_pattern(ev: AnomalyEvent) -> str:
    """Neutral, observational description. Never a cause."""
    if ev.span_hours >= 12 and ev.night_hours >= 3:
        return "Sustained elevated flow, including overnight"
    if ev.span_hours <= 6 and ev.night_hours == ev.flagged_hours:
        return "Short overnight flow"
    if ev.span_hours <= 6:
        return "Short-duration surge"
    return "Elevated usage over several hours"


def group_events(meter_id: str, scored: Sequence[Scored], cfg: DetectorConfig = DetectorConfig()) -> list[AnomalyEvent]:
    events: list[AnomalyEvent] = []
    cur: Optional[AnomalyEvent] = None
    gap = 0
    last_ts = scored[-1].ts if scored else 0

    def close() -> None:
        nonlocal cur
        if cur is None:
            return
        cur.span_hours = (cur.end_ts - cur.start_ts) // HOUR_S + 1
        cur.mean_ratio = cur._sum_obs / max(cur._sum_exp, 1.0)
        cur.ongoing = last_ts - cur.end_ts <= cfg.merge_gap_hours * HOUR_S
        cur.pattern = describe_pattern(cur)
        events.append(cur)
        cur = None

    for r in scored:
        if r.flagged:
            if cur is None:
                cur = AnomalyEvent(meter_id, r.ts, r.ts)
            cur.end_ts = r.ts
            cur.flagged_hours += 1
            cur.night_hours += int(_is_night(r.ts, cfg))
            cur.peak_z = max(cur.peak_z, r.z or 0.0)
            cur.peak_lph = max(cur.peak_lph, r.litres or 0.0)
            cur.excess_litres += (r.litres or 0.0) - (r.expected or 0.0)
            cur._sum_obs += r.litres or 0.0
            cur._sum_exp += r.expected or 0.0
            gap = 0
        elif cur is not None:
            gap += 1
            if gap > cfg.merge_gap_hours:
                close()
    close()
    for idx, ev in enumerate(events):
        ev.recurrence = idx
    return events


def minimum_night_flow(series: Sequence[Reading], cfg: DetectorConfig = DetectorConfig()) -> list[tuple[int, float]]:
    by_day: dict[int, float] = {}
    for r in series:
        if r.litres is None or not _is_night(r.ts, cfg):
            continue
        day = r.ts - r.ts % 86400
        by_day[day] = min(by_day.get(day, float("inf")), r.litres)
    return sorted(by_day.items())


def detect(meter_id: str, series: Sequence[Reading], cfg: DetectorConfig = DetectorConfig()) -> tuple[list[Scored], list[AnomalyEvent]]:
    scored = score_series(series, cfg)
    return scored, group_events(meter_id, scored, cfg)
