"""Report Lambda: POST /v1/reports {"type": "consumption_summary" | "anomaly_history", "days": 28}.

Renders CSV, writes it to the reports bucket (SSE-KMS, versioned), records it, and
returns a 15-minute presigned download URL."""
from __future__ import annotations

import csv
import io
import json
import os
import uuid
from datetime import datetime, timezone

from .. import platform as p

QUERIES = {
    "consumption_summary": """SELECT day::date AS date, s.name AS site, m.id AS meter_id, m.name AS meter, round(litres) AS litres, missing_hours
        FROM meter_readings_daily d JOIN meters m ON m.id = d.meter_id JOIN sites s ON s.id = m.site_id
        WHERE day >= now() - make_interval(days => :days) ORDER BY day, m.id""",
    "anomaly_history": """SELECT a.event_id, s.name AS site, a.meter_id, a.pattern, a.start_ts, a.end_ts, a.span_hours,
        round(a.excess_litres) AS excess_litres, a.priority_score, a.priority_band, coalesce(i.status, 'detected') AS status,
        (coalesce(i.status, '') = 'verified_leak') AS verified_leak_by_inspection
        FROM anomalies a JOIN meters m ON m.id = a.meter_id JOIN sites s ON s.id = m.site_id
        LEFT JOIN investigations i ON i.event_id = a.event_id
        WHERE a.start_ts >= now() - make_interval(days => :days) ORDER BY a.start_ts""",
}


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return buf.getvalue()


def handler(event, _context):
    import boto3

    body = json.loads(event.get("body") or "{}")
    kind = body.get("type")
    if kind not in QUERIES:
        return p.response(400, {"error": f"type must be one of {sorted(QUERIES)}"})
    days = max(1, min(int(body.get("days", 28)), 730))
    rows = p.sql(QUERIES[kind], {"days": days})
    key = f"reports/{datetime.now(timezone.utc):%Y/%m/%d}/{kind}-{uuid.uuid4().hex[:8]}.csv"
    s3 = boto3.client("s3")
    s3.put_object(Bucket=os.environ["REPORTS_BUCKET"], Key=key, Body=to_csv(rows).encode(), ContentType="text/csv",
                  ServerSideEncryption="aws:kms")
    user = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {}).get("email", "unknown")
    p.sql("INSERT INTO reports (s3_key, report_type, params, requested_by) VALUES (:k, :t, :params::jsonb, :u)",
          {"k": key, "t": kind, "params": {"days": days}, "u": user})
    url = s3.generate_presigned_url("get_object", Params={"Bucket": os.environ["REPORTS_BUCKET"], "Key": key}, ExpiresIn=900)
    p.metric("ReportsGenerated", 1, ReportType=kind)
    return p.response(200, {"key": key, "rows": len(rows), "download_url": url, "expires_in": 900})
