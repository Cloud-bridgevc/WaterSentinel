"""Unit tests for the pure parts of the backend (no AWS calls). Run: python3 -m unittest discover -s backend/tests -t backend"""
import json
import math
import random
import unittest
from datetime import datetime, timezone

from watersentinel.detector import DetectorConfig, Reading, detect, minimum_night_flow
from watersentinel.evidence import build_evidence
from watersentinel.explain import BriefRejected, fallback_brief, validate_brief, violates_evidence_policy
from watersentinel.handlers.demo_request import validate as validate_demo
from watersentinel.handlers.ingest import validate_batch
from watersentinel.hubspot import map_demo_request
from watersentinel.priority import band, score

START = int(datetime(2026, 8, 23, tzinfo=timezone.utc).timestamp())


def synthetic(days=56, leak_from_day=None, leak_lph=380, spike=None, seed=7):
    """Residential-like hourly profile with noise; optional continuous added flow or one-off spike."""
    rnd = random.Random(seed)
    out = []
    for i in range(days * 24):
        ts = START + i * 3600
        h = i % 24
        base = 150 + 700 * math.exp(-((h - 7.5) ** 2) / 5) + 900 * math.exp(-((h - 19.5) ** 2) / 9.7)
        v = max(0.0, base * (1 + rnd.gauss(0, 0.07)))
        if leak_from_day is not None and i >= leak_from_day * 24 + 1:
            v += leak_lph
        if spike and spike[0] <= i <= spike[1]:
            v += spike[2]
        out.append(Reading(ts, round(v)))
    return out


class DetectorTests(unittest.TestCase):
    def test_normal_series_has_no_large_events(self):
        _, events = detect("M", synthetic())
        self.assertTrue(all(e.span_hours <= 2 for e in events), [e.to_dict() for e in events])

    def test_continuous_added_flow_is_one_sustained_ongoing_event(self):
        _, events = detect("M", synthetic(leak_from_day=50))
        big = max(events, key=lambda e: e.excess_litres)
        self.assertEqual(big.pattern, "Sustained elevated flow, including overnight")
        self.assertTrue(big.ongoing)
        self.assertGreaterEqual(big.span_hours, 100)
        self.assertGreater(big.night_hours, 10)

    def test_spike_detected_and_bounded(self):
        i0 = 45 * 24 + 13
        _, events = detect("M", synthetic(spike=(i0, i0 + 2, 2000)))
        hit = [e for e in events if e.start_ts == START + i0 * 3600]
        self.assertEqual(len(hit), 1)
        self.assertEqual(hit[0].span_hours, 3)
        self.assertFalse(hit[0].ongoing)

    def test_warmup_never_flags(self):
        scored, _ = detect("M", synthetic(leak_from_day=5))
        self.assertFalse(any(s.flagged for s in scored[: DetectorConfig().warmup_hours]))

    def test_missing_readings_are_tolerated(self):
        series = synthetic()
        for i in range(40 * 24, 40 * 24 + 6):
            series[i] = Reading(series[i].ts, None)
        scored, _ = detect("M", series)
        self.assertTrue(all(s.litres is None and not s.flagged for s in scored[40 * 24 : 40 * 24 + 6]))

    def test_higher_threshold_flags_fewer_hours(self):
        series = synthetic(leak_from_day=50, leak_lph=200)
        low = sum(s.flagged for s in detect("M", series, DetectorConfig(z_threshold=3))[0])
        high = sum(s.flagged for s in detect("M", series, DetectorConfig(z_threshold=8))[0])
        self.assertGreater(low, high)

    def test_minimum_night_flow_rises_with_leak(self):
        mnf = minimum_night_flow(synthetic(leak_from_day=50))
        self.assertGreater(mnf[-1][1] - mnf[40][1], 300)


class PriorityTests(unittest.TestCase):
    def test_sustained_ongoing_event_outranks_short_spike(self):
        _, e1 = detect("A", synthetic(leak_from_day=50))
        i0 = 45 * 24 + 13
        _, e2 = detect("B", synthetic(spike=(i0, i0 + 2, 2000)))
        leak = max(e1, key=lambda e: e.excess_litres)
        spike = max(e2, key=lambda e: e.excess_litres)
        self.assertGreater(score(leak, 0.7), score(spike, 0.7))
        self.assertEqual(band(score(leak, 1.0)), "P1")


class ExplainTests(unittest.TestCase):
    def evidence(self):
        series = synthetic(leak_from_day=50)
        scored, events = detect("LV-M01", series)
        ev = max(events, key=lambda e: e.excess_litres)
        return build_evidence(ev, site={"name": "Lakeview Residences", "type": "Residential", "criticality": 0.7},
                              meter={"id": "LV-M01", "name": "Main incoming supply"}, series=series, scored=scored)

    def test_evidence_shows_night_flow_increase(self):
        e = self.evidence()
        self.assertEqual(e["status"], "detected_anomaly_unverified")
        self.assertGreater(e["night_flow"]["event_min_night_flow_lph"], e["night_flow"]["baseline_min_night_flow_lph"] + 250)

    def test_policy_blocks_confirmation_language(self):
        self.assertTrue(violates_evidence_policy("A leak has been confirmed in the riser."))
        self.assertTrue(violates_evidence_policy("This is a confirmed leak."))
        self.assertTrue(violates_evidence_policy("There is a leak on level 2."))
        self.assertFalse(violates_evidence_policy("This is a statistical anomaly, not a confirmed leak."))
        self.assertFalse(violates_evidence_policy("Record the outcome: verified leak, no leak found, or explained by operations."))
        # Deliberately strict: ambiguous phrasing is rejected and the safe fallback brief is used instead.
        self.assertTrue(violates_evidence_policy("A leak was found in the riser."))

    def test_validate_rejects_bad_model_output(self):
        good = fallback_brief(self.evidence())
        bad = json.loads(json.dumps(good))
        bad["summary"] = "There is a leak in the basement."
        with self.assertRaises(BriefRejected):
            validate_brief(bad)
        with self.assertRaises(BriefRejected):
            validate_brief({"summary": "x"})

    def test_generate_brief_with_stub_client(self):
        from watersentinel.explain import generate_brief

        reply = fallback_brief(self.evidence())

        class Stub:
            def converse(self, **kwargs):
                assert "never state or imply" in kwargs["system"][0]["text"].lower()
                return {"output": {"message": {"content": [{"text": "Here you go:\n" + json.dumps(reply)}]}}}

        brief = generate_brief(self.evidence(), client=Stub())
        self.assertIn("not a confirmed leak", brief["summary"])
        self.assertTrue(brief["generated_by"].startswith("Amazon Bedrock"))


class IngestTests(unittest.TestCase):
    def test_validation(self):
        now = int(datetime(2026, 10, 18, tzinfo=timezone.utc).timestamp())
        ok, bad = validate_batch([
            {"ts": "2026-10-17T10:00:00Z", "litres": 420},
            {"ts": "2026-10-17T11:00:00+00:00", "litres": None},
            {"ts": "2026-10-17T12:00:00Z", "litres": 999999},
            {"ts": "2026-10-17T12:30:00Z", "litres": 10},
            {"ts": "2026-10-17T10:00:00Z", "litres": 1},
            {"ts": "2026-10-17T13:00:00", "litres": 1},
            {"ts": "2026-10-19T13:00:00Z", "litres": 1},
            {"ts": "2026-10-17T14:00:00Z", "litres": -4},
        ], size_mm=80, now_ts=now)
        self.assertEqual([r["quality"] for r in ok], ["ok", "missing", "suspect"])
        self.assertEqual(len(bad), 5)


class CrmTests(unittest.TestCase):
    FORM = {"name": "Alex Morgan", "email": "Alex@ExampleFacilities.com", "company": "Example Facilities", "persona": "facility_manager",
            "sites": "6–20", "meters": "51–250", "plan": "Professional", "message": "Night flow at two buildings", "consent": True}

    def test_mapping(self):
        m = map_demo_request(self.FORM)
        self.assertEqual(m["contact"]["email"], "alex@examplefacilities.com")
        self.assertEqual(m["contact"]["ws_persona"], "Facility manager")
        self.assertEqual(m["company"]["domain"], "examplefacilities.com")
        self.assertIn("Example Facilities", m["deal"]["dealname"])

    def test_free_mail_creates_no_company(self):
        self.assertIsNone(map_demo_request({**self.FORM, "email": "someone@gmail.com"})["company"])

    def test_form_validation(self):
        self.assertEqual(validate_demo(self.FORM), [])
        self.assertEqual(set(validate_demo({**self.FORM, "email": "nope", "consent": False})), {"email", "consent"})


if __name__ == "__main__":
    unittest.main()
