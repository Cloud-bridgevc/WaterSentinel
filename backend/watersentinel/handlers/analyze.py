"""Analysis Lambda: runs hourly (EventBridge Scheduler). Scores recent readings for every
active meter and upserts anomaly events. Workflow status is never changed here: an event
is created as 'detected' and only people move it forward."""
from __future__ import annotations

from datetime import datetime, timezone

from .. import platform as p
from ..detector import DetectorConfig, Reading, detect
from ..priority import band, score

UPSERT_ANOMALY = """INSERT INTO anomalies (event_id, meter_id, start_ts, end_ts, span_hours, flagged_hours, night_hours,
  peak_z, peak_lph, excess_litres, mean_ratio, ongoing, pattern, recurrence, priority_score, priority_band, detector_config)
VALUES (:event_id, :meter_id, to_timestamp(:start_ts), to_timestamp(:end_ts), :span_hours, :flagged_hours, :night_hours,
  :peak_z, :peak_lph, :excess_litres, :mean_ratio, :ongoing, :pattern, :recurrence, :priority_score, :priority_band, :config::jsonb)
ON CONFLICT (event_id) DO UPDATE SET end_ts = EXCLUDED.end_ts, span_hours = EXCLUDED.span_hours,
  flagged_hours = EXCLUDED.flagged_hours, night_hours = EXCLUDED.night_hours, peak_z = EXCLUDED.peak_z,
  peak_lph = EXCLUDED.peak_lph, excess_litres = EXCLUDED.excess_litres, mean_ratio = EXCLUDED.mean_ratio,
  ongoing = EXCLUDED.ongoing, pattern = EXCLUDED.pattern, priority_score = EXCLUDED.priority_score,
  priority_band = EXCLUDED.priority_band, updated_at = now()"""


def analyze_meter(meter: dict, cfg: DetectorConfig) -> int:
    hours = cfg.warmup_hours + 21 * 24
    rows = p.sql(
        """SELECT extract(epoch FROM g.ts)::bigint AS ts, r.litres
           FROM generate_series(date_trunc('hour', now()) - make_interval(hours => :hours), date_trunc('hour', now()) - interval '1 hour', interval '1 hour') AS g(ts)
           LEFT JOIN meter_readings r ON r.meter_id = :meter_id AND r.ts = g.ts AND r.quality <> 'suspect'
           ORDER BY g.ts""",
        {"meter_id": meter["id"], "hours": hours},
    )
    series = [Reading(int(r["ts"]), r["litres"]) for r in rows]
    _, events = detect(meter["id"], series, cfg)
    for ev in events:
        s = score(ev, meter["site_criticality"])
        p.sql(UPSERT_ANOMALY, {**{k: v for k, v in ev.to_dict().items() if k != "meter_id"},
                               "meter_id": meter["id"], "priority_score": s, "priority_band": band(s), "config": cfg.__dict__})
    return len(events)


def handler(_event, _context):
    started = datetime.now(timezone.utc)
    meters = p.sql("""SELECT m.id, s.criticality AS site_criticality, s.detector_config
                      FROM meters m JOIN sites s ON s.id = m.site_id WHERE m.active""")
    total = 0
    for m in meters:
        cfg = DetectorConfig(**(m.get("detector_config") or {}))
        try:
            total += analyze_meter(m, cfg)
        except Exception as exc:  # one bad meter must not stop the run
            p.log("error", "analysis failed", meter_id=m["id"], error=str(exc))
            p.metric("AnalysisErrors", 1)
    p.metric("MetersAnalyzed", len(meters))
    p.metric("AnomalyEventsInWindow", total)
    p.metric("AnalysisDuration", (datetime.now(timezone.utc) - started).total_seconds(), "Seconds")
    return {"meters": len(meters), "events": total}
