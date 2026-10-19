# Meter integrations (future production deployment)

WaterSentinel only ingests data the customer is authorized to share. The demo has **no live integrations**: every reading in `web/` is simulated, and the console labels every meter "Simulated".

## Authorization model

Each source is a row in `meter_integrations` with `status`, `authorized_by`, `authorization_ref` (data-sharing agreement or utility consent reference) and `authorization_expires_at`. A database check prevents `status = 'active'` without all three. The ingest Lambda rejects readings for any meter whose integration is not active and unexpired, and reports rejections to CloudWatch.

Onboarding checklist:

1. Confirm who owns the meter and its data (customer, landlord, or utility).
2. Obtain written authorization naming the meters, the data, the purpose and the term.
3. Store credentials in Secrets Manager; record the agreement reference.
4. Map meters (serial ↔ WaterSentinel ID, pipe size, units, interval, timezone).
5. Backfill at least 4 weeks so the detector has baselines (it does not flag during warm-up).
6. Run in "shadow" for a week and review detections with the site team before enabling alerts.
7. Revoke automatically at expiry; review annually.

## Supported source types

| Kind | How it connects | Notes |
|---|---|---|
| `utility_portal` | Scheduled connector Lambda calls the utility's customer data API with the customer's delegated credentials | Often daily batches of hourly intervals; latency up to 24 h. |
| `ami_headend` | Utility pushes interval reads via SFTP/S3 or API under a data-sharing agreement | For utility customers of the platform. |
| `bms` | On-site gateway or BMS export posts to `/v1/readings` (SigV4 via IAM Roles Anywhere) | Pulse or Modbus meters wired to a BMS. |
| `data_logger` | Cellular logger vendor API → connector Lambda | Typical for remote or retrofit meters. |
| `file_drop` | CSV uploaded to `s3://<ingest-bucket>/ingest/<integration_id>/<meter_id>/*.csv` | Columns `ts,litres`; ISO-8601 with UTC offset, hour-aligned. |

## Ingestion contract

`POST /v1/readings` (IAM-authenticated):

```json
{
  "integration_id": "6f0c…",
  "meter_id": "LV-M01",
  "readings": [{ "ts": "2026-10-17T22:00:00Z", "litres": 1184 }, { "ts": "2026-10-17T23:00:00Z", "litres": null }]
}
```

Validation (see `validate_batch`): hour-aligned, timezone-aware, not in the future, no duplicates, non-negative. Values above a physical cap for the pipe size are kept but marked `suspect` and excluded from detection. `null` records a known gap.

Cumulative register sources are converted to interval volumes in the connector, with rollover and meter-replacement handling.
