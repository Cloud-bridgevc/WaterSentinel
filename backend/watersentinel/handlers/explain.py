"""Explanation Lambda: POST /v1/anomalies/{eventId}/brief.

Rebuilds the evidence package from stored readings, asks Bedrock for a brief, validates
it, and stores it. Falls back to a rule-based brief if Bedrock fails or the reply is
rejected by the evidence policy."""
from __future__ import annotations

from .. import platform as p
from ..detector import AnomalyEvent, DetectorConfig, Reading, score_series
from ..evidence import build_evidence
from ..explain import BriefRejected, build_request, fallback_brief, generate_brief


def handler(event, _context):
    event_id = event["pathParameters"]["eventId"]
    rows = p.sql(
        """SELECT a.*, extract(epoch FROM a.start_ts)::bigint AS start_epoch, extract(epoch FROM a.end_ts)::bigint AS end_epoch,
                  m.name AS meter_name, m.serial, s.name AS site_name, s.site_type, s.criticality
           FROM anomalies a JOIN meters m ON m.id = a.meter_id JOIN sites s ON s.id = m.site_id
           WHERE a.event_id = :id""", {"id": event_id})
    if not rows:
        return p.response(404, {"error": "anomaly not found"})
    a = rows[0]
    cfg = DetectorConfig(**(a.get("detector_config") or {}))
    readings = p.sql(
        """SELECT extract(epoch FROM ts)::bigint AS ts, litres FROM meter_readings
           WHERE meter_id = :m AND ts BETWEEN to_timestamp(:from) AND to_timestamp(:to) ORDER BY ts""",
        {"m": a["meter_id"], "from": a["start_epoch"] - cfg.warmup_hours * 3600, "to": a["end_epoch"] + 86400})
    series = [Reading(int(r["ts"]), r["litres"]) for r in readings]
    ev = AnomalyEvent(a["meter_id"], a["start_epoch"], a["end_epoch"], a["flagged_hours"], a["night_hours"], a["peak_z"],
                      a["peak_lph"], a["excess_litres"], a["span_hours"], a["mean_ratio"], a["ongoing"], a["pattern"], a["recurrence"])
    evidence = build_evidence(ev, site={"name": a["site_name"], "type": a["site_type"], "criticality": a["criticality"]},
                              meter={"id": a["meter_id"], "name": a["meter_name"], "serial": a["serial"]},
                              series=series, scored=score_series(series, cfg), cfg=cfg)
    try:
        brief = generate_brief(evidence)
        p.metric("BriefsGenerated", 1, Source="bedrock")
    except BriefRejected as exc:
        p.log("warn", "bedrock brief rejected", event_id=event_id, reason=str(exc))
        p.metric("BriefsRejected", 1)
        brief = fallback_brief(evidence)
    except Exception as exc:  # throttling, timeouts, model access
        p.log("error", "bedrock call failed", event_id=event_id, error=str(exc))
        p.metric("BriefsFallback", 1)
        brief = fallback_brief(evidence)
    p.sql("""INSERT INTO anomaly_briefs (event_id, evidence, brief, model_id) VALUES (:id, :evidence::jsonb, :brief::jsonb, :model)""",
          {"id": event_id, "evidence": evidence, "brief": brief, "model": build_request(evidence)["modelId"]})
    return p.response(200, {"evidence": evidence, "brief": brief})
