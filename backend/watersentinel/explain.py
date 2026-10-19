"""Investigation briefs via Amazon Bedrock.

The model receives only the evidence package computed by the detector and must
return structured JSON. Every reply is validated: schema, numbers-only-from-evidence
is encouraged by the prompt, and a policy check rejects any text that states or
implies a confirmed leak. On failure the caller falls back to a rule-based brief.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

SYSTEM_PROMPT = """You are the WaterSentinel investigation assistant for facility maintenance staff.
You receive a JSON evidence package describing a statistically detected consumption anomaly.
Rules:
- Use only numbers present in the evidence. Do not estimate costs or volumes not provided.
- Describe the anomaly as "detected" or "unusual consumption". Never state or imply that a leak is confirmed, found, or certain. A leak can only be verified by physical inspection.
- Offer several possible explanations, including benign operational ones, and say what evidence would distinguish them.
- Recommend a proportionate, practical inspection sequence.
- Mention data limitations (gaps, short history, single meter).
Return only JSON: {"summary": string, "timeline": string[], "possible_explanations": [{"explanation": string, "supporting": string, "how_to_check": string}], "recommended_inspection": string[], "limitations": string[]}."""

FORBIDDEN = [
    re.compile(r"\bleak (?:is|was|has been) (?:confirmed|found|detected|identified|verified)\b", re.I),
    re.compile(r"(?<!not a )(?<!no )\bconfirmed leak\b", re.I),
    re.compile(r"\bdefinitely (?:a )?leak", re.I),
    re.compile(r"\bthere is a leak\b", re.I),
    re.compile(r"\bcaused by a leak\b", re.I),
]

REQUIRED_KEYS = {"summary": str, "timeline": list, "possible_explanations": list, "recommended_inspection": list, "limitations": list}


class BriefRejected(ValueError):
    pass


def violates_evidence_policy(text: str) -> bool:
    return any(p.search(text) for p in FORBIDDEN)


def validate_brief(brief: Any) -> dict:
    if not isinstance(brief, dict):
        raise BriefRejected("brief is not an object")
    for key, typ in REQUIRED_KEYS.items():
        if not isinstance(brief.get(key), typ):
            raise BriefRejected(f"missing or invalid field: {key}")
    if len(brief["possible_explanations"]) < 2:
        raise BriefRejected("needs at least two possible explanations")
    for e in brief["possible_explanations"]:
        if not all(isinstance(e.get(k), str) for k in ("explanation", "supporting", "how_to_check")):
            raise BriefRejected("explanation entries incomplete")
    if violates_evidence_policy(json.dumps(brief)):
        raise BriefRejected("brief claims a confirmed leak")
    return brief


def build_request(evidence: dict) -> dict:
    """Bedrock Converse API request body."""
    return {
        "modelId": os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet"),
        "system": [{"text": SYSTEM_PROMPT}],
        "messages": [{"role": "user", "content": [{"text": "Evidence package:\n" + json.dumps(evidence, indent=2)}]}],
        "inferenceConfig": {"maxTokens": 1500, "temperature": 0.2},
    }


def _extract_json(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise BriefRejected("no JSON object in model output")
    return json.loads(text[start : end + 1])


def generate_brief(evidence: dict, client=None) -> dict:
    """Call Bedrock and return a validated brief. Raises BriefRejected on policy/schema failure."""
    if client is None:
        import boto3  # imported lazily so unit tests run without AWS SDK

        client = boto3.client("bedrock-runtime")
    resp = client.converse(**build_request(evidence))
    text = "".join(part.get("text", "") for part in resp["output"]["message"]["content"])
    brief = validate_brief(_extract_json(text))
    brief["generated_by"] = f"Amazon Bedrock ({build_request(evidence)['modelId']})"
    return brief


def fallback_brief(evidence: dict) -> dict:
    """Deterministic brief used when Bedrock is unavailable or its reply is rejected."""
    f, w = evidence["flow"], evidence["window"]
    brief = {
        "summary": (
            f"WaterSentinel detected unusual consumption on {evidence['meter']['name']} at {evidence['site']['name']}, "
            f"from {w['start']} {'(ongoing)' if w['ongoing'] else 'to ' + w['end']}. Average flow during flagged hours was "
            f"{f['observed_mean_lph']} L/h against an expected {f['expected_mean_lph']} L/h. "
            "This is a statistical anomaly, not a confirmed leak; inspection is required to establish the cause."
        ),
        "timeline": [f"{w['start']}: first flagged hour.", f"{w['end']}: last flagged hour."],
        "possible_explanations": [
            {"explanation": "Unmetered continuous draw downstream of the meter", "supporting": "Elevated flow relative to baseline.",
             "how_to_check": "Zero-demand meter check during the night window."},
            {"explanation": "Planned or operational use not yet recorded", "supporting": "Step changes often follow operational changes.",
             "how_to_check": "Check work orders, BMS and contractor logs."},
        ],
        "recommended_inspection": ["Confirm operational activity for the window.", "Perform a zero-demand meter check.",
                                   "Walk down fixtures and plant served by the meter.", "Record the outcome in WaterSentinel."],
        "limitations": ["Single-meter evidence; location of any source is unknown."],
        "generated_by": "Rule-based fallback",
    }
    return validate_brief(brief)
