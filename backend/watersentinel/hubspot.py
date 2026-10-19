"""HubSpot CRM client for demo requests (see docs/hubspot-crm.md).

Uses a private-app token stored in AWS Secrets Manager. Only the CRM v3 objects API is
used; contacts upsert by email, companies by domain, and a deal is opened in the
"WaterSentinel New Business" pipeline."""
from __future__ import annotations

import json
import os
import urllib.request

API = "https://api.hubapi.com"
PERSONA_TO_SEGMENT = {
    "facility_manager": "Facility manager",
    "property_group": "Property group",
    "utility": "Utility",
    "service_operator": "Service operator",
    "other": "Other",
}
FREE_MAIL = {"gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me"}


def _token() -> str:
    import boto3

    return boto3.client("secretsmanager").get_secret_value(SecretId=os.environ["HUBSPOT_SECRET_ARN"])["SecretString"]


def _call(method: str, path: str, body: dict, token: str) -> dict:
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read() or "{}")


def map_demo_request(form: dict) -> dict:
    """Pure mapping from website form to HubSpot properties (unit-tested)."""
    first, _, last = form["name"].strip().partition(" ")
    domain = form["email"].split("@")[-1].lower()
    return {
        "contact": {"email": form["email"].strip().lower(), "firstname": first, "lastname": last, "company": form["company"],
                    "ws_persona": PERSONA_TO_SEGMENT.get(form.get("persona"), "Other"), "ws_sites_band": form.get("sites", ""),
                    "ws_meters_band": form.get("meters", ""), "ws_plan_interest": form.get("plan", ""),
                    "ws_demo_request_message": form.get("message", "")[:2000], "lifecyclestage": "marketingqualifiedlead"},
        "company": None if domain in FREE_MAIL else {"domain": domain, "name": form["company"],
                                                     "ws_segment": PERSONA_TO_SEGMENT.get(form.get("persona"), "Other")},
        "deal": {"dealname": f"{form['company']} · WaterSentinel demo", "pipeline": os.environ.get("HUBSPOT_PIPELINE_ID", "default"),
                 "dealstage": os.environ.get("HUBSPOT_DEMO_STAGE_ID", "appointmentscheduled"),
                 "ws_plan_interest": form.get("plan", ""), "ws_meters_band": form.get("meters", "")},
    }


def submit_demo_request(form: dict) -> dict:
    token = _token()
    m = map_demo_request(form)
    contact = _call("POST", "/crm/v3/objects/contacts/batch/upsert",
                    {"inputs": [{"idProperty": "email", "id": m["contact"]["email"], "properties": m["contact"]}]}, token)["results"][0]
    company_id = None
    if m["company"]:
        company_id = _call("POST", "/crm/v3/objects/companies/batch/upsert",
                           {"inputs": [{"idProperty": "domain", "id": m["company"]["domain"], "properties": m["company"]}]}, token)["results"][0]["id"]
    assoc = [{"to": {"id": contact["id"]}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 3}]}]
    if company_id:
        assoc.append({"to": {"id": company_id}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 5}]})
    deal = _call("POST", "/crm/v3/objects/deals", {"properties": m["deal"], "associations": assoc}, token)
    return {"contact_id": contact["id"], "company_id": company_id, "deal_id": deal["id"]}
