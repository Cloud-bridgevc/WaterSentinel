"""Ingestion Lambda: POST /v1/readings (API Gateway) and S3 CSV drops (ingest/ prefix).

Readings are accepted only for meters linked to an integration whose authorization is
active. The demo build has no integrations; production integrations are added per
docs/meter-integrations.md.
"""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone

from .. import platform as p

# Upper bound on plausible hourly volume by nominal pipe size (litres/hour at ~3 m/s).
MAX_LPH_BY_DN = {15: 2_000, 20: 3_500, 25: 5_500, 40: 14_000, 50: 22_000, 80: 55_000, 100: 85_000, 150: 190_000}
UPSERT = """INSERT INTO meter_readings (meter_id, ts, litres, quality, source_integration_id)
VALUES (:meter_id, :ts::timestamptz, :litres, :quality, :integration_id::uuid)
ON CONFLICT (meter_id, ts) DO UPDATE SET litres = EXCLUDED.litres, quality = EXCLUDED.quality, received_at = now()"""


def parse_ts(value: str) -> int:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("timestamp must include a UTC offset")
    return int(dt.timestamp())


def validate_batch(readings: list[dict], *, size_mm: int, now_ts: int) -> tuple[list[dict], list[dict]]:
    """Return (accepted, rejected). Pure function: no I/O."""
    cap = MAX_LPH_BY_DN.get(size_mm, max(MAX_LPH_BY_DN.values()))
    accepted, rejected, seen = [], [], set()
    for i, r in enumerate(readings):
        try:
            ts = parse_ts(str(r["ts"]))
            if ts % 3600:
                raise ValueError("timestamp must be aligned to the hour")
            if ts > now_ts + 300:
                raise ValueError("timestamp is in the future")
            if ts in seen:
                raise ValueError("duplicate timestamp in batch")
            litres = r.get("litres")
            if litres is None:
                quality = "missing"
            else:
                litres = float(litres)
                if litres < 0:
                    raise ValueError("negative volume")
                quality = "suspect" if litres > cap else "ok"
            seen.add(ts)
            accepted.append({"ts": datetime.fromtimestamp(ts, timezone.utc).isoformat(), "litres": litres, "quality": quality})
        except (KeyError, ValueError, TypeError) as exc:
            rejected.append({"index": i, "error": str(exc)})
    return accepted, rejected


def _authorized_meter(integration_id: str, meter_id: str) -> dict | None:
    rows = p.sql(
        """SELECT m.id, m.size_mm FROM meters m JOIN meter_integrations i ON i.id = m.integration_id
           WHERE m.id = :meter_id AND i.id = :integration_id::uuid AND i.status = 'active'
             AND i.authorization_expires_at > now()""",
        {"meter_id": meter_id, "integration_id": integration_id},
    )
    return rows[0] if rows else None


def ingest(integration_id: str, meter_id: str, readings: list[dict]) -> dict:
    meter = _authorized_meter(integration_id, meter_id)
    if not meter:
        p.metric("ReadingsRejectedUnauthorized", len(readings))
        return {"status": 403, "error": "meter is not linked to an active, authorized integration"}
    accepted, rejected = validate_batch(readings, size_mm=meter["size_mm"], now_ts=int(datetime.now(timezone.utc).timestamp()))
    p.sql_batch(UPSERT, ({**r, "meter_id": meter_id, "integration_id": integration_id} for r in accepted))
    p.metric("ReadingsAccepted", len(accepted), MeterId=meter_id)
    p.metric("ReadingsRejected", len(rejected), MeterId=meter_id)
    return {"status": 200, "accepted": len(accepted), "rejected": rejected}


def handler(event, _context):
    if "Records" in event:  # S3 CSV drop: ingest/<integration_id>/<meter_id>/<file>.csv
        import boto3

        s3 = boto3.client("s3")
        results = []
        for rec in event["Records"]:
            bucket, key = rec["s3"]["bucket"]["name"], rec["s3"]["object"]["key"]
            _, integration_id, meter_id, _ = key.split("/", 3)
            body = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode()
            rows = [{"ts": r["ts"], "litres": r["litres"] or None} for r in csv.DictReader(io.StringIO(body))]
            results.append(ingest(integration_id, meter_id, rows))
        return {"results": results}

    # API route uses AWS_IAM auth: only integration connector roles can call it, and the
    # integration/meter pairing is still checked against an active authorization above.
    body = json.loads(event.get("body") or "{}")
    result = ingest(body.get("integration_id", ""), body.get("meter_id", ""), body.get("readings", []))
    return p.response(result.pop("status"), result)
