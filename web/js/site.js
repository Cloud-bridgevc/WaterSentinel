// Public website: hero replay, detector demo and demo-request form.
import { generateReadings, meterById, siteById } from './data.js';
import { scoreSeries, groupEvents, minimumNightFlow, DEFAULT_CONFIG } from './detector.js';
import { buildEvidence, writeBrief } from './assistant.js';
import { score as priorityScore, band } from './priority.js';
import { lineChart, fmtNum } from './charts.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const METER = 'LV-M01';
const meter = meterById(METER);
const site = siteById(meter.siteId);
const series = generateReadings().get(METER);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- hero: replay of the sample meter ----------
const baseScored = scoreSeries(series, DEFAULT_CONFIG);
const baseEvents = groupEvents(METER, baseScored, DEFAULT_CONFIG);
const mainEvent = baseEvents.reduce((a, b) => (b.excessLitres > (a?.excessLitres ?? 0) ? b : a), null);
const mnf = minimumNightFlow(series);

if (mainEvent) {
  const ev = buildEvidence(mainEvent, { site, meter, series, scored: baseScored });
  const p = priorityScore(mainEvent, site);
  $('#h-alert').innerHTML = `<b>Detected anomaly · ${band(p.score).label}</b>
    <span>${esc(mainEvent.pattern)}. Night minimum up from ~${ev.night_flow.baseline_min_night_flow_lph} to ~${ev.night_flow.event_min_night_flow_lph} L/h.</span>
    <span class="ai">Not a confirmed leak. Suggested next step: zero-demand meter check tonight, then a walk-down of risers and plant rooms.</span>`;
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Start the loop a day and a half before the event so visitors see it develop quickly.
const heroStart = mainEvent ? baseScored.findIndex((r) => r.t === mainEvent.start) - 36 : baseScored.length - 7 * 24;
let cursor = reduceMotion ? baseScored.length - 1 : heroStart;
function heroTick() {
  const win = baseScored.slice(Math.max(cursor - 72, 0), cursor + 1);
  const r = baseScored[cursor];
  const flagged = win.filter((x) => x.flagged);
  lineChart($('#hero-chart'), {
    series: [
      { name: 'Observed', color: '#2563b0', points: win.map((x) => ({ t: x.t, v: x.v })), area: true },
      { name: 'Expected', color: '#8e9bae', points: win.map((x) => ({ t: x.t, v: x.expected })), dash: '5 4', width: 1.5 },
    ],
    bands: flagged.length ? [{ start: flagged[0].t, end: flagged.at(-1).t, label: 'Detected anomaly' }] : [],
    unit: 'L/h', height: 190, yMax: 2000, label: 'Sample hourly flow',
  });
  $('#h-flow').innerHTML = `${fmtNum(r.v)} <small>L/h</small>`;
  $('#h-exp').innerHTML = `${fmtNum(r.expected ?? 0)} <small>L/h</small>`;
  const day = r.t - (r.t % DAY);
  const m = [...mnf].reverse().find((d) => d.t <= day);
  $('#h-mnf').innerHTML = `${fmtNum(m?.v ?? 0)} <small>L/h</small>`;
  const d = new Date(r.t);
  $('#h-time').textContent = `${d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' })} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
  $('#h-alert').classList.toggle('hide', !(mainEvent && r.t >= mainEvent.start + 6 * HOUR));
}
heroTick();
if (!reduceMotion) {
  setInterval(() => {
    cursor += 1;
    if (cursor >= baseScored.length) cursor = heroStart;
    heroTick();
  }, 220);
}

// ---------- detector demo ----------
function runDemo(z) {
  const cfg = { ...DEFAULT_CONFIG, zThreshold: z };
  const scored = scoreSeries(series, cfg);
  const events = groupEvents(METER, scored, cfg);
  const from = scored.at(-1).t - 14 * DAY;
  const win = scored.filter((r) => r.t > from);
  const visible = events.filter((e) => e.end > from);
  lineChart($('#demo-chart'), {
    series: [
      { name: 'Observed', color: '#2563b0', points: win.map((r) => ({ t: r.t, v: r.v })), area: true },
      { name: 'Expected', color: '#8e9bae', points: win.map((r) => ({ t: r.t, v: r.expected })), dash: '5 4', width: 1.5 },
    ],
    bands: visible.map((e) => ({ start: Math.max(e.start, from), end: e.end, label: `Flagged · ${e.pattern.toLowerCase()}` })),
    unit: 'L/h', height: 260, label: 'Detector demo chart',
  });
  $('#d-hours').textContent = win.filter((r) => r.flagged).length;
  $('#d-events').textContent = visible.length;
  $('#d-excess').textContent = `${fmtNum(visible.reduce((a, e) => a + e.excessLitres, 0) / 1000)} m³`;

  const ev = visible.reduce((a, b) => (b.excessLitres > (a?.excessLitres ?? 0) ? b : a), null);
  const box = $('#demo-brief');
  if (!ev) {
    box.innerHTML = `<span class="tag">✦ Investigation assistant</span><p>No hours exceed both baselines at z ≥ ${z}. At very high thresholds, real problems can go unflagged; at very low ones, normal variation creates noise. The default is 3.5.</p>`;
    return;
  }
  const brief = writeBrief(buildEvidence(ev, { site, meter, series, scored, config: cfg }), meter);
  box.innerHTML = `<span class="tag">✦ Investigation assistant · sample brief</span>
    <div><h4>Summary</h4><p>${esc(brief.summary)}</p></div>
    <div><h4>Most likely explanations to check</h4><ol>${brief.possible_explanations.slice(0, 2).map((e) => `<li><b>${esc(e.explanation)}.</b> ${esc(e.how_to_check)}</li>`).join('')}</ol></div>
    <div><h4>Recommended inspection</h4><ol>${brief.recommended_inspection.slice(0, 3).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>
    <p style="font-size:12.5px;color:var(--ink-3)">Full brief, evidence and inspection workflow in the <a href="app.html#/investigate/${ev.id}">sample console</a>.</p>`;
}
const z = $('#z');
z.addEventListener('input', () => { $('#z-out').textContent = z.value; runDemo(Number(z.value)); });
runDemo(Number(z.value));

// ---------- demo request form ----------
// The demo site does not transmit form data. In production the form posts to
// POST /api/demo-requests (API Gateway -> Lambda), which validates the payload and
// creates/updates the HubSpot contact, company and deal (see docs/hubspot-crm.md).
const form = $('#demo-form');
document.querySelectorAll('[data-plan]').forEach((a) => a.addEventListener('click', () => { form.plan.value = a.dataset.plan; }));

const rules = {
  name: (v) => (v.trim().length >= 2 ? '' : 'Please enter your name.'),
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Please enter a valid work email.'),
  company: (v) => (v.trim() ? '' : 'Please enter your organisation.'),
  persona: (v) => (v ? '' : 'Please choose the option that fits best.'),
};
function validateField(name) {
  const input = form.elements[name];
  const msg = rules[name](input.value);
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  input.parentElement.querySelector('.err').textContent = msg;
  return !msg;
}
Object.keys(rules).forEach((n) => form.elements[n].addEventListener('blur', () => validateField(n)));
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const ok = Object.keys(rules).map(validateField).every(Boolean);
  if (!form.consent.checked) { $('#form-status').textContent = 'Please tick the consent box so we can reply.'; $('#form-status').style.color = 'var(--orange-600)'; }
  if (!ok || !form.consent.checked) { form.querySelector('[aria-invalid=true]')?.focus(); return; }
  const first = esc(form.name.value.trim().split(' ')[0]);
  form.innerHTML = `<div class="success" role="status"><div class="check">✓</div><h3>Thanks, ${first}.</h3>
    <p style="color:var(--ink-2)">Your request is noted. This is a demonstration site, so nothing was sent. In the live product your request goes straight to our team and you'd hear back within one business day.</p>
    <a class="btn btn-dark" href="app.html">Explore the sample console meanwhile</a></div>`;
});
