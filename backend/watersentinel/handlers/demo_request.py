"""Public POST /public/demo-requests: validates the website form and records it in HubSpot.
Rate-limited at API Gateway; protected by WAF bot control in production."""
from __future__ import annotations

import json
import re

from .. import platform as p
from ..hubspot import PERSONA_TO_SEGMENT, submit_demo_request

EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


def validate(form: dict) -> list[str]:
    errors = []
    if len(form.get("name", "").strip()) < 2:
        errors.append("name")
    if not EMAIL.match(form.get("email", "").strip()):
        errors.append("email")
    if not form.get("company", "").strip():
        errors.append("company")
    if form.get("persona") not in PERSONA_TO_SEGMENT:
        errors.append("persona")
    if form.get("consent") is not True:
        errors.append("consent")
    return errors


def handler(event, _context):
    form = json.loads(event.get("body") or "{}")
    errors = validate(form)
    if errors:
        return p.response(422, {"errors": errors})
    try:
        ids = submit_demo_request(form)
    except Exception as exc:
        p.log("error", "hubspot submission failed", error=str(exc))
        p.metric("DemoRequestFailures", 1)
        return p.response(502, {"error": "could not record request, please try again"})
    p.metric("DemoRequests", 1, Persona=form["persona"])
    return p.response(201, {"ok": True, **ids})
