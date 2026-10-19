# HubSpot CRM plan

WaterSentinel uses HubSpot for the commercial relationship (who the customers are, what they buy, how they are supported). Operational data — readings, anomalies, inspections — stays in WaterSentinel; only **aggregated, non-sensitive signals** sync to HubSpot.

Implemented now: the website demo-request flow (`backend/watersentinel/hubspot.py`, `handlers/demo_request.py`). Everything else below is the plan.

## Object model

| HubSpot object | Represents | Key custom properties (`ws_` prefix) |
|---|---|---|
| Contact | A person: facility manager, asset manager, utility programme lead, contractor | `ws_persona`, `ws_sites_band`, `ws_meters_band`, `ws_plan_interest`, `ws_console_user` (bool), `ws_last_login` |
| Company | Customer org, property group, utility, or service operator | `ws_segment` (Facility manager / Property group / Utility / Service operator), `ws_org_id`, `ws_sites_monitored`, `ws_meters_monitored`, `ws_plan`, `ws_open_p1_anomalies`, `ws_integrations_active` |
| Deal | A sales opportunity or expansion | `ws_plan_interest`, `ws_meters_band`, `ws_integration_types`, `ws_pilot_start`, `ws_pilot_success_criteria` |
| Ticket | Customer-success issue (integration down, data gap, onboarding) | `ws_integration_id`, `ws_issue_type` |
| Association labels | Company ↔ Company: *manages property for*, *services sites of*, *utility serving* | Models property groups, operators and utilities linked to facility customers |

Personas map to the four segments in the brief:

* **Facility managers** – single organisation, operational buyer, champions inspection workflow.
* **Property groups** – portfolio buyer; parent company with child companies per asset or fund.
* **Utilities** – partner/channel; programmes offering WaterSentinel to commercial customers. Separate pipeline.
* **Service operators** – FM contractors and plumbing partners; both resellers and task recipients.

## Pipelines

**New Business (direct)**: Demo requested → Discovery → Data access confirmed → Pilot (shadow mode) → Proposal → Closed won / lost.
`Data access confirmed` requires the customer's written authorization for the meters in scope (mirrors `meter_integrations`).

**Utility Partnerships**: Intro → Programme design → Data-sharing agreement → Pilot cohort → Contract → Live.

**Expansion**: auto-created when a customer's monitored meters reach 80 % of plan limit, or a property group adds sites.

## Workflows

| Trigger | Action |
|---|---|
| Website demo request (`/public/demo-requests`) | Upsert contact by email, company by domain (skipped for free-mail), create deal in *Demo requested*, assign owner by segment and region, send confirmation email, create follow-up task due in 1 business day. |
| Persona = Utility | Route to partnerships owner and Utility Partnerships pipeline instead. |
| Deal → *Pilot* | Notify onboarding; create WaterSentinel org in shadow mode via internal API; write `ws_org_id` back. |
| Pilot ends + ≥ 1 inspection outcome recorded | Move to *Proposal*; attach pilot summary (counts only: anomalies detected, inspections, outcomes). |
| Nightly sync (planned λ `crm_sync`) | Update company `ws_sites_monitored`, `ws_meters_monitored`, `ws_integrations_active`, `ws_open_p1_anomalies`; contacts' `ws_last_login`. Log every call in `crm_sync_log`. |
| Integration inactive > 24 h | Create ticket for customer success. |
| No console login for 21 days | Enroll champion in re-engagement sequence; alert CSM. |

## Data boundaries

* Never sync raw readings, meter serials, addresses of individual units, or investigation notes.
* Never describe an anomaly in HubSpot as a leak. Counts are labelled "detected anomalies"; verified leaks appear only as a count of inspection outcomes.
* The demo website does **not** transmit form data; production posts to the Lambda, which holds the private-app token in Secrets Manager (scopes: `crm.objects.contacts.write`, `crm.objects.companies.write`, `crm.objects.deals.write`).
