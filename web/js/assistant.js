// Leak Investigation Assistant (browser demo).
//
// In production the backend sends the evidence package below to Amazon Bedrock
// (see backend/watersentinel/explain.py) and validates the reply. In this demo the
// brief is produced by a deterministic, rule-based writer that follows the same
// output contract, so the page works offline and never invents numbers.
//
// Ground rule for both paths: consumption data can show that usage was unusual.
// It cannot confirm a leak. Only a physical inspection can.

import { minimumNightFlow, dataGaps, DEFAULT_CONFIG } from './detector.js';

const HOUR = 3600 * 1000;

export const SYSTEM_PROMPT = `You are the WaterSentinel investigation assistant for facility maintenance staff.
You receive a JSON evidence package describing a statistically detected consumption anomaly.
Rules:
- Use only numbers present in the evidence. Do not estimate costs or volumes not provided.
- Describe the anomaly as "detected" or "unusual consumption". Never state or imply that a leak is confirmed, found, or certain. A leak can only be verified by physical inspection.
- Offer several possible explanations, including benign operational ones, and say what evidence would distinguish them.
- Recommend a proportionate, practical inspection sequence.
- Mention data limitations (gaps, short history, single meter).
Return JSON: {"summary": string, "timeline": string[], "possible_explanations": [{"explanation": string, "supporting": string, "how_to_check": string}], "recommended_inspection": string[], "limitations": string[]}.`;

// Phrases the assistant must never produce. Checked on every brief, including Bedrock output.
const FORBIDDEN = [
  /\bleak (?:is|was|has been) (?:confirmed|found|detected|identified|verified)\b/i,
  /(?<!not a )(?<!no )\bconfirmed leak\b/i,
  /\bdefinitely (?:a )?leak/i,
  /\bthere is a leak\b/i,
  /\bcaused by a leak\b/i,
];

export function violatesEvidencePolicy(text) {
  return FORBIDDEN.some((re) => re.test(text));
}

const fmtL = (l) => `${Math.round(l).toLocaleString('en-US')} L`;
const fmtLph = (l) => `${Math.round(l).toLocaleString('en-US')} L/h`;
export const fmtTime = (t) => {
  const d = new Date(t);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
};

/** Assemble the facts the assistant (or Bedrock) is allowed to use. */
export function buildEvidence(ev, { site, meter, series, scored, config = DEFAULT_CONFIG }) {
  const startIdx = scored.findIndex((r) => r.t === ev.start);
  const endIdx = scored.findIndex((r) => r.t === ev.end);
  const window = scored.slice(startIdx, endIdx + 1).filter((r) => r.v != null);
  const expectedMean = window.reduce((a, r) => a + (r.expected ?? 0), 0) / Math.max(window.length, 1);
  const observedMean = window.reduce((a, r) => a + r.v, 0) / Math.max(window.length, 1);

  const mnf = minimumNightFlow(series, config);
  const evDay = ev.start - (ev.start % (24 * HOUR));
  const before = mnf.filter((d) => d.t < evDay).slice(-14).map((d) => d.v);
  const during = mnf.filter((d) => d.t >= evDay && d.t <= ev.end).map((d) => d.v);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const gaps = dataGaps(series).filter((g) => g.end >= ev.start - 7 * 24 * HOUR && g.start <= ev.end + 24 * HOUR);
  const peak = window.reduce((best, r) => (r.v > (best?.v ?? -1) ? r : best), null);

  return {
    anomaly_id: ev.id,
    status: 'detected_anomaly_unverified',
    site: { name: site.name, type: site.type, criticality: site.criticality },
    meter: { id: meter.id, name: meter.name, serial: meter.serial },
    pattern: ev.pattern,
    window: { start: fmtTime(ev.start), end: fmtTime(ev.end), span_hours: ev.spanHours, flagged_hours: ev.flaggedHours, ongoing: ev.ongoing },
    flow: {
      observed_mean_lph: Math.round(observedMean),
      expected_mean_lph: Math.round(expectedMean),
      excess_mean_lph: Math.round(observedMean - expectedMean),
      excess_total_litres: Math.round(ev.excessLitres),
      peak_lph: Math.round(peak?.v ?? 0),
      peak_time: peak ? fmtTime(peak.t) : null,
      peak_robust_z: Number(ev.peakZ.toFixed(1)),
    },
    night_flow: {
      flagged_night_hours: ev.nightHours,
      baseline_min_night_flow_lph: before.length ? Math.round(avg(before)) : null,
      event_min_night_flow_lph: during.length ? Math.round(avg(during)) : null,
    },
    recurrence: { earlier_events_same_meter: ev.recurrence },
    data_quality: { gaps_nearby: gaps.map((g) => ({ start: fmtTime(g.start), hours: g.hours })), history_days_used: config.dayWindow },
    detector: { method: 'dual-baseline robust z-score (hour-of-day and hour-of-week medians)', z_threshold: config.zThreshold },
  };
}

function explanationsFor(meter, e) {
  const p = meter.profile;
  const overnight = e.night_flow.flagged_night_hours >= 3;
  const sustained = e.window.span_hours >= 12;
  const list = [];

  if (sustained && overnight) {
    list.push({
      explanation: 'Continuous flow downstream of the meter (for example a running fixture, a stuck float or fill valve, or an underground or concealed pipe failure)',
      supporting: `Night-time minimum flow rose from about ${fmtLph(e.night_flow.baseline_min_night_flow_lph ?? 0)} to about ${fmtLph(e.night_flow.event_min_night_flow_lph ?? 0)}, and the excess (~${fmtLph(e.flow.excess_mean_lph)}) is present day and night.`,
      how_to_check: 'Perform a zero-demand meter check overnight: confirm no planned use, then watch the register or flow indicator for 15 minutes. Movement with all known outlets closed points to an unmetered draw.',
    });
    list.push({
      explanation: 'A new legitimate continuous load (equipment commissioned, a tank or pool being filled, temporary works, a tenant change)',
      supporting: 'A step change that starts at a specific hour and then stays flat is also typical of a deliberate new load.',
      how_to_check: `Ask building operations and contractors whether anything started around ${e.window.start}.`,
    });
    list.push({
      explanation: 'Pressure-reducing or irrigation valve failing to close',
      supporting: 'A failed valve gives a roughly constant added flow, as seen here.',
      how_to_check: 'Check PRV outlet pressure against setpoint and isolate irrigation zones one by one while observing the meter.',
    });
  } else if (p === 'irrigation') {
    list.push({
      explanation: 'Irrigation controller schedule changed or a manual / extra run was started',
      supporting: `Flow appeared at ${e.window.start}, outside the regular schedule, with a peak of ${fmtLph(e.flow.peak_lph)}.`,
      how_to_check: 'Download the controller run log and compare run times to the flagged hours.',
    });
    list.push({
      explanation: 'Landscaping contractor activity (hand watering, new planting, flushing lines)',
      supporting: e.recurrence.earlier_events_same_meter > 0
        ? `This is the ${ordinal(e.recurrence.earlier_events_same_meter + 1)} similar event on this meter in the detection window, which suggests a repeating activity.`
        : 'Short, bounded runs are typical of manual activity.',
      how_to_check: 'Check contractor visit records for those dates.',
    });
    list.push({
      explanation: 'Broken head or lateral that only flows while the zone is pressurised',
      supporting: 'Would increase volume during runs; does not by itself explain off-schedule timing.',
      how_to_check: 'Run each zone briefly and walk it during the run looking for pooling or geysers.',
    });
  } else if (p === 'cooling') {
    list.push({
      explanation: 'Cooling tower blowdown or refill after maintenance or water-treatment adjustment',
      supporting: `A bounded ${e.window.span_hours}-hour surge peaking at ${fmtLph(e.flow.peak_lph)} that returns to normal afterwards.`,
      how_to_check: 'Check the BMS and water-treatment logs for blowdown or conductivity setpoint changes on that day.',
    });
    list.push({
      explanation: 'Make-up valve or float malfunction causing overflow to drain',
      supporting: 'Would produce elevated make-up flow; the return to normal suggests it may have self-corrected or been reset.',
      how_to_check: 'Inspect the basin overflow and make-up valve; ask whether anyone attended an alarm.',
    });
    list.push({
      explanation: 'High cooling load on a hot afternoon',
      supporting: 'Evaporation rises with load, but usually not this sharply against the hour-of-week baseline.',
      how_to_check: 'Compare with chiller load and outdoor temperature for the same hours.',
    });
  } else {
    list.push({
      explanation: 'One-off operational use (cleaning, flushing, filling, a contractor drawing water)',
      supporting: `The event lasted ${e.window.span_hours} hour(s) and then returned to normal.`,
      how_to_check: 'Check work orders, cleaning schedules and site access records for that time.',
    });
    list.push({
      explanation: 'Fixture or equipment left running temporarily',
      supporting: overnight ? 'Flow occurred during hours when this meter normally reads near its minimum.' : 'Short elevated flow with no recurrence.',
      how_to_check: 'Ask the area supervisor; inspect hoses, wash equipment and sanitary fixtures served by this meter.',
    });
    list.push({
      explanation: 'Normal variation or a metering/telemetry artefact',
      supporting: `Peak robust z-score was ${e.flow.peak_robust_z}; ${e.flow.peak_robust_z < 6 ? 'this is close to the detection threshold.' : 'this is well above the threshold, so variation alone is less likely.'}`,
      how_to_check: 'Monitor for recurrence before dispatching anyone; check the meter for transmission errors.',
    });
  }
  return list;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function inspectionFor(meter, e) {
  const sustained = e.window.span_hours >= 12 && e.night_flow.flagged_night_hours >= 3;
  if (sustained) {
    return [
      `Confirm with operations that no new continuous load started near ${e.window.start}.`,
      'Carry out a zero-demand meter check during the night window and record the register movement over 15 minutes.',
      'Walk restrooms, plant rooms, tanks and riser closets served by this meter for running fixtures, float valves and visible water.',
      'If the meter still moves with all known outlets closed, isolate sections (risers, irrigation, amenities) one at a time to narrow the zone.',
      'If no visible source is found, arrange an acoustic or tracer-gas survey of buried and concealed pipework.',
      'Record the outcome in WaterSentinel: verified leak, no leak found, or explained by operations.',
    ];
  }
  return [
    'Check operational records (work orders, BMS/controller logs, contractor visits) for the flagged hours.',
    `Inspect equipment served by ${meter.name.toLowerCase()} for running water or overflow.`,
    'If no explanation is found, keep the meter on watch for a recurrence before dispatching a full inspection.',
    'Record the outcome in WaterSentinel so the detector history stays accurate.',
  ];
}

/** Produce the structured brief from evidence. Deterministic: same evidence, same brief. */
export function writeBrief(evidence, meter) {
  const e = evidence;
  const ongoing = e.window.ongoing ? 'and is still present in the most recent reading' : `and ended ${e.window.end}`;
  const ratio = e.flow.expected_mean_lph > 20 ? `, about ${(e.flow.observed_mean_lph / e.flow.expected_mean_lph).toFixed(1)}× the expected level` : ' (this meter normally reads close to zero at these hours)';
  const summary =
    `WaterSentinel detected unusual consumption on ${e.meter.name} (${e.meter.id}) at ${e.site.name}. ` +
    `The pattern, "${e.pattern.toLowerCase()}", began ${e.window.start} ${ongoing}. ` +
    `Average flow during flagged hours was ${fmtLph(e.flow.observed_mean_lph)} against an expected ${fmtLph(e.flow.expected_mean_lph)}${ratio}, ` +
    `an estimated excess of ${fmtL(e.flow.excess_total_litres)}. ` +
    'This is a statistical anomaly, not a confirmed leak: physical inspection is needed to establish the cause.';

  const timeline = [
    `${e.window.start}: first hour above both baselines.`,
    e.flow.peak_time ? `${e.flow.peak_time}: highest hourly reading, ${fmtLph(e.flow.peak_lph)}. Largest robust z-score in the event: ${e.flow.peak_robust_z}.` : null,
    e.night_flow.flagged_night_hours ? `${e.night_flow.flagged_night_hours} flagged hour(s) fell in the 01:00–04:59 night window.` : null,
    e.window.ongoing ? `${e.window.end}: latest reading still flagged.` : `${e.window.end}: last flagged hour; readings returned to the expected range.`,
  ].filter(Boolean);

  const limitations = [
    'Based on a single meter; sub-metering or a site visit is needed to locate any source.',
    `Baselines use the previous ${e.data_quality.history_days_used} days (hour-of-day) and 4 weeks (hour-of-week); seasonal or occupancy changes can shift normal demand.`,
  ];
  if (e.data_quality.gaps_nearby.length) {
    limitations.push(`Telemetry gaps near the event: ${e.data_quality.gaps_nearby.map((g) => `${g.hours} h from ${g.start}`).join('; ')}.`);
  }
  if (e.flow.peak_robust_z < 6) limitations.push('Peak score is close to the detection threshold; treat as low-confidence.');

  const brief = {
    summary,
    timeline,
    possible_explanations: explanationsFor(meter, e),
    recommended_inspection: inspectionFor(meter, e),
    limitations,
    generated_by: 'Rule-based demo writer (production: Amazon Bedrock with the same evidence and output contract)',
  };
  if (violatesEvidencePolicy(JSON.stringify(brief))) throw new Error('Brief violates evidence policy');
  return brief;
}
