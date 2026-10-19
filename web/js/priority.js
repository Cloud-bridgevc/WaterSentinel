// Alert prioritization. Mirrors backend/watersentinel/priority.py.
// Score is a weighted average of normalised factors, scaled to 0-100.

export const DEFAULT_WEIGHTS = {
  magnitude: 0.3,   // how far above expected (mean observed / expected)
  duration: 0.25,   // span of the event in hours
  recurrence: 0.15, // earlier events on the same meter in the window
  criticality: 0.15, // site criticality (0-1, set per site)
  ongoing: 0.15,    // still present in the latest readings
};

export const FACTOR_LABELS = {
  magnitude: 'Magnitude',
  duration: 'Duration',
  recurrence: 'Recurrence',
  criticality: 'Site criticality',
  ongoing: 'Still ongoing',
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function factors(ev, site) {
  return {
    // ratio 1.0 = normal; 2.5x or more saturates
    magnitude: clamp01((ev.meanRatio - 1) / 1.5),
    // 72 h or longer saturates
    duration: clamp01(ev.spanHours / 72),
    // 3 earlier events saturates
    recurrence: clamp01(ev.recurrence / 3),
    criticality: clamp01(site?.criticality ?? 0.5),
    ongoing: ev.ongoing ? 1 : 0,
  };
}

export function score(ev, site, weights = DEFAULT_WEIGHTS) {
  const f = factors(ev, site);
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  let s = 0;
  const contributions = {};
  for (const k of Object.keys(weights)) {
    contributions[k] = (100 * weights[k] * f[k]) / total;
    s += contributions[k];
  }
  return { score: Math.round(s), factors: f, contributions };
}

export function band(s) {
  if (s >= 65) return { key: 'p1', label: 'Priority 1', hint: 'Review today' };
  if (s >= 40) return { key: 'p2', label: 'Priority 2', hint: 'Review this week' };
  return { key: 'p3', label: 'Priority 3', hint: 'Monitor' };
}

export function rank(events, siteOf, weights = DEFAULT_WEIGHTS) {
  return events
    .map((ev) => {
      const r = score(ev, siteOf(ev), weights);
      return { ...ev, priority: r.score, factors: r.factors, contributions: r.contributions, band: band(r.score) };
    })
    .sort((a, b) => b.priority - a.priority || b.end - a.end);
}
