# WaterSentinel AWS architecture

```
 Authorized meter sources                      AWS account (per region)
 ───────────────────────                       ─────────────────────────────────────────────────────────────
 Utility portal / AMI head-end ─┐
 BMS / data logger connector  ──┼─ SigV4 ──▶ API Gateway (HTTP)  /v1/readings ─┐
 Scheduled CSV export ──────────┘          S3 ingest bucket  ingest/*.csv ─────┴▶ λ ingest ──▶ Aurora PostgreSQL
                                                                                               (Serverless v2, Data API)
                                          EventBridge Scheduler (hourly :10) ──▶ λ analyze ──▶   meter_readings (partitioned)
                                                                                                anomalies
 Console (Cognito JWT) ─▶ API Gateway /v1/anomalies/{id}/brief ──▶ λ explain ──▶ Amazon Bedrock (Converse)
                          API Gateway /v1/reports ─────────────▶ λ report ───▶ S3 reports bucket (SSE-KMS, versioned)
 Website form ──────────▶ API Gateway /public/demo-requests ───▶ λ demo_request ──▶ HubSpot CRM API

 All Lambdas ──▶ CloudWatch Logs (JSON) + Embedded Metric Format ──▶ CloudWatch alarms ▶ SNS, dashboard
```

Infrastructure is defined in [`infra/template.yaml`](../infra/template.yaml) (AWS SAM). Schema: [`db/schema.sql`](../db/schema.sql).

## Data design

| Concern | Choice | Why |
|---|---|---|
| Store | Aurora PostgreSQL 16, Serverless v2, Data API | Relational workflow data and time series in one place; Data API removes VPC/connection pooling from Lambdas. |
| Time series | `meter_readings` range-partitioned by month (pg_partman), PK `(meter_id, ts)` | Hourly data: 1,000 meters ≈ 8.8 M rows/year. Partition pruning keeps detector queries (≈7 weeks per meter) cheap; old partitions detach to S3/Parquet for archive. TimescaleDB is not available on Aurora. |
| Daily rollups | `meter_readings_daily` materialized view, refreshed after each analysis run | Charts, comparisons and reports read rollups, not raw hours. |
| Idempotency | `ON CONFLICT` upserts for readings and anomalies | Integrations can resend; reruns don't duplicate. |
| Status integrity | Trigger blocks `investigations.status = 'verified_leak'` unless a completed inspection task has that outcome | The system cannot label a leak from data alone. |

If reading volume grows past ~10k meters at sub-hourly resolution, move raw readings to Amazon Timestream for InfluxDB or S3 + Athena, keeping rollups and workflow in Aurora.

## Detection (λ analyze)

Dual-baseline robust z-score, implemented identically in [`backend/watersentinel/detector.py`](../backend/watersentinel/detector.py) and [`web/js/detector.js`](../web/js/detector.js) (a parity test enforces this):

1. For each hour, compute two baselines from that meter's own history, excluding hours already flagged:
   * hour-of-day median over the previous 14 days;
   * hour-of-week median over the previous 4 weeks (handles weekly schedules such as irrigation).
2. Sigma = max(1.4826 × MAD, 6 % of the median, 15 L/h), so quiet meters don't produce huge scores from tiny noise.
3. Flag the hour only if it beats **both** baselines by the z threshold (default 3.5) **and** by a minimum excess (25 % and 50 L/h).
4. Group flagged hours separated by ≤ 3 normal hours into an event; describe its shape (never its cause).
5. Score priority from magnitude, duration, recurrence, site criticality and whether it is ongoing (weights per site).

Thresholds and weights are stored per site (`sites.detector_config`, `sites.priority_weights`).

## Explanations (λ explain → Amazon Bedrock)

* The Lambda rebuilds an **evidence package** (window, observed vs expected flow, excess volume, minimum night flow before/during, recurrence, data gaps) from stored readings. The model receives only this package.
* The system prompt requires: numbers only from the evidence; several explanations including benign ones; an inspection sequence; data limitations; and never stating or implying a confirmed leak.
* Every reply is parsed and validated (schema + a policy regex). Rejected or failed calls fall back to a deterministic rule-based brief, and are counted in CloudWatch (`BriefsRejected`, `BriefsFallback`).
* Briefs are stored with their evidence and model ID in `anomaly_briefs` for audit.
* Bedrock does not use prompts or completions to train models; requests stay in-region. The model ID is a stack parameter so each environment can pin an enabled model or inference profile.

## Reports (λ report → S3)

CSV/HTML reports are written to a KMS-encrypted, versioned bucket under `reports/YYYY/MM/DD/`, logged in `reports`, and returned via 15-minute presigned URLs. No public access.

## Monitoring (CloudWatch)

| Signal | Source | Alarm |
|---|---|---|
| Analysis failed | `AWS/Lambda Errors` (analyze) | ≥ 1 in an hour |
| Analysis stopped | `WaterSentinel/MetersAnalyzed` | < 1 for 2 hours (missing = breaching) |
| Unauthorized ingestion attempts | `ReadingsRejectedUnauthorized` | > 100 in 15 min |
| Assistant degraded | `BriefsFallback` | > 5 in an hour |

Plus X-Ray tracing on all functions, JSON logs, and the `watersentinel-<stage>` dashboard.

## Security

* Console users authenticate with Cognito (admin-created users, optional TOTP MFA); API routes require a JWT except the public demo-request route (throttled; add AWS WAF bot control in production).
* Ingestion uses IAM (SigV4) for connector roles **and** checks an active, unexpired authorization in `meter_integrations` for every batch.
* Secrets (DB, HubSpot token, integration credentials) live in Secrets Manager; nothing secret is stored in tables.
* S3 buckets block public access and use a customer-managed KMS key with rotation.

## What the demo does not include

The demo in `web/` runs entirely in the browser on fictional data. Not yet implemented in the backend: the CRUD API for investigations, notes and tasks (schema exists), integration connector Lambdas (see [meter-integrations.md](meter-integrations.md)), and HubSpot sync beyond demo requests (see [hubspot-crm.md](hubspot-crm.md)).
