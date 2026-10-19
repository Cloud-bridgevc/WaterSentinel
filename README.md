# WaterSentinel

Water consumption monitoring and anomaly detection for facility teams: detect unusual consumption, explain the evidence, and turn it into inspection work.

> **Demo build.** All sites, meters and readings are fictional and simulated. No live meters are connected. A *detected anomaly* means consumption differed significantly from the expected pattern; a *verified leak* is recorded only after an on-site inspection finds one.

## Run it

```bash
npm start
```

Then open http://localhost:8080 (website) and http://localhost:8080/app.html (console). No build step or dependencies; any static server works.

```bash
npm test
```

Runs the browser-module tests, a JS↔Python detector parity test, and the backend unit tests (Python 3.11+, no AWS needed).

## What's here

| Path | Contents |
|---|---|
| `web/index.html` | Public website: live-replay sample dashboard, interactive detector demo, use cases, pricing, demo-request form |
| `web/app.html` | Console: portfolio overview, meter register, consumption charts, anomaly alerts with tunable detector and priority weights, investigation workspace with assistant briefs, maintenance task board, site comparison, report exports |
| `web/js/` | `data.js` fictional dataset · `detector.js` statistics · `priority.js` ranking · `assistant.js` evidence package + brief writer · `charts.js` SVG charts · `store.js` workflow state · `reports.js` exports |
| `backend/watersentinel/` | Lambda code: detector (Python port), priority, evidence, Bedrock explainer with output validation, handlers for ingest / analyze / explain / report / demo-request, HubSpot client |
| `db/schema.sql` | Aurora PostgreSQL schema: partitioned readings, anomalies, briefs, investigations, tasks, integrations, reports, audit |
| `infra/template.yaml` | AWS SAM: Aurora Serverless v2 (Data API), Lambdas, HTTP API + Cognito, S3 (KMS), EventBridge schedule, CloudWatch alarms and dashboard |
| `docs/` | [Architecture](docs/architecture.md) · [HubSpot CRM plan](docs/hubspot-crm.md) · [Meter integrations](docs/meter-integrations.md) |

## The demonstration story

Eight weeks of hourly readings for 9 meters at 4 fictional sites, with these scenarios injected (see `SCENARIO` in `web/js/data.js`):

| Meter | What was simulated | What the detector reports |
|---|---|---|
| Lakeview Residences, main | +380 L/h continuous from 12 Oct 01:00 | Sustained elevated flow incl. overnight, ongoing → **Priority 1** |
| Riverside, irrigation | Unscheduled 13:00 runs on three days | Three short surges; recurrence raises the later ones |
| Harbor Point, cooling tower | 5-hour make-up surge | Short-duration surge (seeded as *inspection scheduled*) |
| Northgate, wash bay | One overnight hour | Short overnight flow, low priority |
| Northgate, main | 6 missing readings | Shown as a data gap, not an anomaly |

Two near-threshold events from random noise also appear at low priority, which is realistic and shows why ranking matters.

In the console, open the Lakeview alert, generate the brief, create an inspection task, then record an outcome on the task board. The anomaly only becomes a *verified leak* if you choose that outcome and describe what was found.

## The AI assistant, honestly

In the browser demo, briefs come from a deterministic rule-based writer that follows the same output contract as the production Bedrock path, so the page works offline and never invents numbers. The console shows the exact Bedrock request (system prompt + evidence JSON) each brief is based on. In production, `backend/watersentinel/explain.py` calls Bedrock's Converse API, validates the JSON and rejects anything implying a confirmed leak, falling back to the rule-based brief.

## Deploying (outline)

1. Enable a Bedrock model in the target region; create the HubSpot token secret.
2. `sam build -t infra/template.yaml && sam deploy --guided`
3. Apply `db/schema.sql` via the RDS Query Editor or Data API.
4. Add integrations per `docs/meter-integrations.md`; backfill 4 weeks before enabling alerts.
5. Point the website form at `<ApiUrl>/public/demo-requests` (currently it does not submit anywhere).

The investigations/tasks CRUD API is not implemented yet. The schema supports it, and the console keeps that state in browser storage.
