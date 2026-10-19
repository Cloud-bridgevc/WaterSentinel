// Consumption anomaly detector (browser build).
// Mirrors backend/watersentinel/detector.py; keep the two in sync.
//
// Method: dual-baseline robust z-score.
//  - Baseline A: same hour-of-day over the previous `dayWindow` days.
//  - Baseline B: same hour-of-week over the previous `weekWindow` weeks.
//  For each baseline: expected = median, sigma = max(1.4826 * MAD, ratio floor, absolute floor).
//  An hour is flagged only when it exceeds BOTH baselines by the z threshold and by a
//  minimum excess, so scheduled weekly loads (e.g. irrigation) do not trip the detector.
//  Flagged hours are excluded from later baselines to limit contamination by a long event.
//  Consecutive flagged hours (allowing short gaps) are grouped into anomaly events.

export const DEFAULT_CONFIG = {
  dayWindow: 14,          // days of history for hour-of-day baseline
  weekWindow: 4,          // weeks of history for hour-of-week baseline
  zThreshold: 3.5,        // robust z-score that must be exceeded on both baselines
  minExcessRatio: 0.25,   // excess must be at least this share of expected
  minExcessLph: 50,       // and at least this many litres per hour
  sigmaFloorRatio: 0.06,  // sigma floor as a share of expected (noise floor)
  sigmaFloorLph: 15,      // absolute sigma floor
  mergeGapHours: 3,       // flagged hours separated by <= this many normal hours merge
  nightStartHour: 1,      // night window used for minimum-night-flow evidence
  nightEndHour: 4,
};

const HOUR = 3600 * 1000;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function robustStats(samples, cfg) {
  const med = median(samples);
  const mad = median(samples.map((x) => Math.abs(x - med)));
  const sigma = Math.max(1.4826 * mad, cfg.sigmaFloorRatio * med, cfg.sigmaFloorLph);
  return { expected: med, sigma, n: samples.length };
}

/**
 * Score every reading of one meter.
 * @param {Array<{t:number, v:number|null}>} series hourly, ascending, evenly spaced
 * @returns {Array<{t, v, expected, z, flagged, warmup, missing}>}
 */
export function scoreSeries(series, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const warmupHours = Math.max(cfg.dayWindow, cfg.weekWindow * 7) * 24;
  const flagged = new Uint8Array(series.length);
  const out = new Array(series.length);

  for (let i = 0; i < series.length; i++) {
    const { t, v } = series[i];
    if (v === null || v === undefined) {
      out[i] = { t, v: null, expected: null, z: null, flagged: false, warmup: i < warmupHours, missing: true };
      continue;
    }
    if (i < warmupHours) {
      out[i] = { t, v, expected: null, z: null, flagged: false, warmup: true, missing: false };
      continue;
    }
    const daySamples = [];
    for (let k = 1; k <= cfg.dayWindow; k++) {
      const j = i - k * 24;
      if (j >= 0 && series[j].v != null && !flagged[j]) daySamples.push(series[j].v);
    }
    const weekSamples = [];
    for (let k = 1; k <= cfg.weekWindow; k++) {
      const j = i - k * 168;
      if (j >= 0 && series[j].v != null && !flagged[j]) weekSamples.push(series[j].v);
    }
    if (daySamples.length < 3 || weekSamples.length < 2) {
      out[i] = { t, v, expected: null, z: null, flagged: false, warmup: true, missing: false };
      continue;
    }
    const a = robustStats(daySamples, cfg);
    const b = robustStats(weekSamples, cfg);
    const zA = (v - a.expected) / a.sigma;
    const zB = (v - b.expected) / b.sigma;
    // Report against the hour-of-week baseline (most specific), score with the weaker evidence.
    const expected = b.expected;
    const z = Math.min(zA, zB);
    const excess = v - Math.max(a.expected, b.expected);
    const minExcess = Math.max(cfg.minExcessLph, cfg.minExcessRatio * Math.max(a.expected, b.expected));
    const isFlag = z >= cfg.zThreshold && excess >= minExcess;
    if (isFlag) flagged[i] = 1;
    out[i] = { t, v, expected, sigma: b.sigma, z, flagged: isFlag, warmup: false, missing: false };
  }
  return out;
}

const isNight = (t, cfg) => {
  const h = new Date(t).getUTCHours();
  return h >= cfg.nightStartHour && h <= cfg.nightEndHour;
};

/** Describe an event's shape in neutral, observational terms (never a cause). */
export function describePattern(ev) {
  if (ev.spanHours >= 12 && ev.nightHours >= 3) return 'Sustained elevated flow, including overnight';
  if (ev.spanHours <= 6 && ev.nightHours === ev.flaggedHours) return 'Short overnight flow';
  if (ev.spanHours <= 6) return 'Short-duration surge';
  return 'Elevated usage over several hours';
}

/** Group flagged hours into events. */
export function groupEvents(meterId, scored, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const events = [];
  let cur = null;
  let gap = 0;
  const lastT = scored.length ? scored[scored.length - 1].t : 0;

  const close = () => {
    if (!cur) return;
    const ev = cur;
    ev.spanHours = Math.round((ev.end - ev.start) / HOUR) + 1;
    ev.meanRatio = ev.sumObserved / Math.max(ev.sumExpected, 1);
    ev.ongoing = lastT - ev.end <= cfg.mergeGapHours * HOUR;
    ev.pattern = describePattern(ev);
    delete ev.sumObserved; delete ev.sumExpected;
    events.push(ev);
    cur = null;
  };

  for (const r of scored) {
    if (r.flagged) {
      if (!cur) {
        cur = {
          meterId, start: r.t, end: r.t, flaggedHours: 0, nightHours: 0, peakZ: 0, peakLph: 0,
          excessLitres: 0, sumObserved: 0, sumExpected: 0,
        };
      }
      cur.end = r.t;
      cur.flaggedHours += 1;
      if (isNight(r.t, cfg)) cur.nightHours += 1;
      cur.peakZ = Math.max(cur.peakZ, r.z);
      cur.peakLph = Math.max(cur.peakLph, r.v);
      cur.excessLitres += r.v - r.expected;
      cur.sumObserved += r.v;
      cur.sumExpected += r.expected;
      gap = 0;
    } else if (cur) {
      gap += 1;
      if (gap > cfg.mergeGapHours) close();
    }
  }
  close();
  // Recurrence = number of earlier events on the same meter in the detection window.
  events.forEach((ev, idx) => { ev.recurrence = idx; ev.id = `${meterId}-${new Date(ev.start).toISOString().slice(0, 13).replace(/[-T]/g, '')}`; });
  return events;
}

/** Daily minimum-night-flow series: a standard water-loss indicator. */
export function minimumNightFlow(series, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const byDay = new Map();
  for (const r of series) {
    if (r.v == null || !isNight(r.t, cfg)) continue;
    const day = r.t - (r.t % (24 * HOUR));
    byDay.set(day, Math.min(byDay.get(day) ?? Infinity, r.v));
  }
  return [...byDay.entries()].map(([t, v]) => ({ t, v }));
}

export function dataGaps(series) {
  const gaps = [];
  let start = null;
  series.forEach((r, i) => {
    if (r.v == null && start === null) start = r.t;
    if (r.v != null && start !== null) { gaps.push({ start, end: series[i - 1].t, hours: Math.round((series[i - 1].t - start) / HOUR) + 1 }); start = null; }
  });
  if (start !== null) gaps.push({ start, end: series[series.length - 1].t, hours: Math.round((series[series.length - 1].t - start) / HOUR) + 1 });
  return gaps;
}

/** Run detection for every meter. */
export function detectAll(readingsByMeter, config = {}) {
  const scoredByMeter = new Map();
  const events = [];
  for (const [meterId, series] of readingsByMeter) {
    const scored = scoreSeries(series, config);
    scoredByMeter.set(meterId, scored);
    events.push(...groupEvents(meterId, scored, config));
  }
  return { scoredByMeter, events };
}
