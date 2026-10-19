// WaterSentinel console: hash-routed views over the demo store.
import * as S from './store.js';
import { lineChart, barChart, sparkline, SITE_COLORS, fmtNum } from './charts.js';
import { buildEvidence, writeBrief, SYSTEM_PROMPT, fmtTime } from './assistant.js';
import { FACTOR_LABELS } from './priority.js';
import { minimumNightFlow, dataGaps } from './detector.js';
import * as R from './reports.js';
import { DEMO_NOTICE, START, END } from './data.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const OBSERVED = '#2563b0';
const EXPECTED = '#8e9bae';
const FACTOR_COLORS = { magnitude: '#2563b0', duration: '#129c92', recurrence: '#8a5bd6', criticality: '#c2477a', ongoing: '#3a4a60' };
const briefCache = new Map();
const ui = { meterId: 'LV-M01', range: 14, resolution: 'auto', alertFilter: 'open', compareMetric: 'occupant', comparePeriod: 7 };

// ---------- helpers ----------
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function modal(html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
  document.body.appendChild(bg);
  onMount?.(bg, close);
  $('input, select, textarea, button', bg)?.focus();
}

const statusChip = (id) => { const st = S.STATUSES[S.statusOf(id)]; return `<span class="chip ${st.chip}">${esc(st.label)}</span>`; };
const prioBadge = (a) => `<span class="prio ${a.band.key}"><span class="score">${a.priority}</span><span class="lbl">${a.band.label}</span></span>`;
const factorBar = (a) => `<div class="factor-bar" title="${Object.keys(a.contributions).map((k) => `${FACTOR_LABELS[k]} ${a.contributions[k].toFixed(0)}`).join(' · ')}">${Object.keys(a.contributions).map((k) => `<span style="width:${a.contributions[k]}%;background:${FACTOR_COLORS[k]}"></span>`).join('')}</div>`;
const siteDot = (id) => `<span class="site-dot" style="background:${SITE_COLORS[id]}"></span>`;
const techName = (id) => S.TECHNICIANS.find((t) => t.id === id)?.name ?? 'Unassigned';
const openAlerts = () => S.state.alerts.filter((a) => S.isOpen(a.id));
const lastT = () => S.state.readings.get('HP-M01').at(-1).t;

function sumRange(meterId, from, to) {
  let s = 0;
  for (const r of S.state.readings.get(meterId)) if (r.t >= from && r.t <= to && r.v != null) s += r.v;
  return s;
}

function alertItem(a) {
  return `<a class="alert-item" href="#/investigate/${a.id}">
    ${prioBadge(a)}
    <div><div class="t">${esc(a.pattern)}</div>
      <div class="m">${siteDot(a.site.id)}${esc(a.site.name)} · ${esc(a.meter.name)} · ${fmtTime(a.start)}${a.ongoing ? ' → ongoing' : ` – ${fmtTime(a.end)}`}</div></div>
    <div class="btn-row">${factorBar(a)}${statusChip(a.id)}</div>
  </a>`;
}

function setHeader(title, sub = '', actions = '') {
  $('#page-title').textContent = title;
  $('#page-sub').innerHTML = sub;
  $('#page-actions').innerHTML = actions;
  document.title = `${title} · WaterSentinel Console`;
}

// ---------- views ----------
function viewOverview(c) {
  const t1 = lastT();
  const mains = S.METERS.filter((m) => m.name.startsWith('Main'));
  const last7 = mains.reduce((a, m) => a + sumRange(m.id, t1 - 7 * DAY + HOUR, t1), 0);
  const prev7 = mains.reduce((a, m) => a + sumRange(m.id, t1 - 14 * DAY + HOUR, t1 - 7 * DAY), 0);
  const open = openAlerts();
  const p1 = open.filter((a) => a.band.key === 'p1').length;
  const excess = open.reduce((a, x) => a + x.excessLitres, 0);
  const verified = S.state.alerts.filter((a) => S.statusOf(a.id) === 'verified_leak').length;
  setHeader('Portfolio overview', `4 sites · 9 meters · latest reading ${fmtTime(t1)} (site time)`, `<a class="btn primary" href="#/alerts">Review alerts</a>`);

  c.innerHTML = `
  <section class="grid-4">
    <div class="card kpi"><div class="label">Open anomalies</div><div class="value">${open.length} <small>${p1} priority 1</small></div><div class="delta">Detected by statistics, awaiting review or inspection</div></div>
    <div class="card kpi"><div class="label">Verified leaks</div><div class="value">${verified}</div><div class="delta">Recorded only after on-site inspection</div></div>
    <div class="card kpi"><div class="label">Main-meter use, 7 days</div><div class="value">${fmtNum(last7 / 1000)} <small>m³</small></div><div class="delta">${prev7 ? `${last7 >= prev7 ? '+' : ''}${(((last7 - prev7) / prev7) * 100).toFixed(1)}% vs previous 7 days` : ''}</div></div>
    <div class="card kpi"><div class="label">Excess in open anomalies</div><div class="value">${fmtNum(excess / 1000)} <small>m³</small></div><div class="delta">Detector estimate vs expected baseline</div></div>
  </section>
  <section class="grid-4" id="site-cards"></section>
  <section class="grid-3">
    <div class="card">
      <div class="card-head"><div><h2>Daily consumption by site</h2><p class="hint">Main incoming meters, last 28 days. Orange bands mark days with a detected anomaly.</p></div></div>
      <ul class="legend">${S.SITES.map((s) => `<li><span class="sw" style="background:${SITE_COLORS[s.id]}"></span>${esc(s.name)}</li>`).join('')}</ul>
      <div class="chart-wrap" id="ov-chart"></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Needs attention</h2><p class="hint">Highest-priority open anomalies</p></div><a class="btn ghost" href="#/alerts">All →</a></div>
      <div class="alert-list">${open.slice(0, 4).map((a) => `<a class="alert-item" style="grid-template-columns:auto 1fr" href="#/investigate/${a.id}">${prioBadge(a)}<div><div class="t">${esc(a.meter.name)}</div><div class="m">${esc(a.site.name)} · ${esc(a.pattern.toLowerCase())}</div></div></a>`).join('') || '<div class="empty">No open anomalies.</div>'}</div>
    </div>
  </section>
  <section class="card">
    <h2>Data health</h2>
    <p class="hint">Readings are simulated hourly intervals. In production this panel reports ingestion latency per authorized meter integration.</p>
    <div class="table-scroll"><table><thead><tr><th>Meter</th><th>Site</th><th>Latest reading</th><th class="r">Completeness (28 d)</th><th>Gaps</th></tr></thead><tbody>
    ${S.METERS.map((m) => {
      const s = S.state.readings.get(m.id);
      const recent = s.filter((r) => r.t > t1 - 28 * DAY);
      const missing = recent.filter((r) => r.v == null).length;
      const gaps = dataGaps(s);
      return `<tr><td class="mono">${m.id}</td><td>${esc(S.siteById(m.siteId).name)}</td><td>${fmtTime(s.at(-1).t)}</td><td class="r">${(100 - (missing / recent.length) * 100).toFixed(1)}%</td><td>${gaps.length ? gaps.map((g) => `<span class="chip muted">${g.hours} h from ${fmtTime(g.start)}</span>`).join(' ') : '<span class="chip good">None</span>'}</td></tr>`;
    }).join('')}
    </tbody></table></div>
  </section>`;

  $('#site-cards').innerHTML = S.SITES.map((s) => {
    const main = S.METERS.find((m) => m.siteId === s.id && m.name.startsWith('Main'));
    const scored = S.state.scoredByMeter.get(main.id).slice(-7 * 24);
    const flaggedIdx = scored.map((r, i) => (r.flagged ? i : -1)).filter((i) => i >= 0);
    const siteOpen = open.filter((a) => a.site.id === s.id);
    const lit = sumRange(main.id, t1 - 7 * DAY + HOUR, t1);
    return `<a class="card site-card" style="text-decoration:none;color:inherit" href="#/consumption" data-meter="${main.id}">
      <div class="top"><div><h3>${siteDot(s.id)}${esc(s.name)}</h3><div class="meta">${esc(s.type)} · ${esc(s.city)}</div></div>
      ${siteOpen.length ? `<span class="chip alert">${siteOpen.length} open</span>` : '<span class="chip good">Normal</span>'}</div>
      ${sparkline(scored.map((r) => r.v), { width: 260, height: 40, color: SITE_COLORS[s.id], flagged: flaggedIdx })}
      <div class="stat-row"><div><b>${fmtNum(lit / 1000)} m³</b>7-day main</div><div><b>${(lit / 7 / s.occupants).toFixed(0)} L</b>per occupant/day</div></div>
    </a>`;
  }).join('');
  $$('#site-cards [data-meter]').forEach((a) => a.addEventListener('click', () => { ui.meterId = a.dataset.meter; }));
  $$('#site-cards svg.spark').forEach((svg) => { svg.setAttribute('width', '100%'); svg.setAttribute('preserveAspectRatio', 'none'); });

  const series = S.SITES.map((s) => {
    const main = S.METERS.find((m) => m.siteId === s.id && m.name.startsWith('Main'));
    return { name: s.name, color: SITE_COLORS[s.id], points: R.dailyTotals(main.id, 28).map((d) => ({ t: d.t, v: d.v / 1000 })) };
  });
  const bands = open.filter((a) => a.end > t1 - 28 * DAY).map((a) => ({ start: a.start - (a.start % DAY), end: a.end - (a.end % DAY), label: `${a.site.name}: detected anomaly` }));
  lineChart($('#ov-chart'), { series, bands, unit: 'm³/day', daily: true, height: 280, label: 'Daily consumption by site' });
}

function viewMeters(c) {
  const t1 = lastT();
  setHeader('Meter register', 'Every meter WaterSentinel reads, with its current register value and integration status', `<button class="btn" id="exp-meters">Export CSV</button>`);
  const rows = S.METERS.map((m) => {
    const series = S.state.readings.get(m.id);
    const reg = (m.register0 + series.reduce((a, r) => a + (r.v ?? 0), 0) / 1000);
    const last24 = sumRange(m.id, t1 - DAY + HOUR, t1);
    const openA = openAlerts().filter((a) => a.meterId === m.id);
    const gap = dataGaps(series).some((g) => g.end > t1 - 7 * DAY);
    return { m, reg, last24, openA, gap, series };
  });
  c.innerHTML = `<div class="card">
    <div class="notice" style="margin-bottom:14px">All meters below are fictional and their readings are simulated. Integration status reads <b>Simulated</b>; production integrations are added only with the meter owner's or utility's authorization.</div>
    <div class="table-scroll"><table><thead><tr><th>Meter</th><th>Site</th><th>Description</th><th>Serial</th><th class="r">Size</th><th class="r">Register (m³)</th><th class="r">Last 24 h (L)</th><th>Last 7 days</th><th>Status</th><th>Integration</th></tr></thead><tbody>
    ${rows.map(({ m, reg, last24, openA, gap, series }) => `<tr class="click" data-meter="${m.id}">
      <td class="mono">${m.id}</td><td>${siteDot(m.siteId)}${esc(S.siteById(m.siteId).name)}</td><td>${esc(m.name)}</td><td class="mono">${m.serial}</td><td class="r">DN${m.sizeMm}</td>
      <td class="r mono">${reg.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}</td><td class="r">${fmtNum(last24)}</td>
      <td>${sparkline(series.slice(-168).map((r) => r.v), { width: 110, height: 26, color: SITE_COLORS[m.siteId] })}</td>
      <td>${openA.length ? `<span class="chip alert">Anomaly open</span>` : gap ? '<span class="chip muted">Recent data gap</span>' : '<span class="chip good">Normal</span>'}</td>
      <td><span class="chip plain muted">Simulated</span></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $$('tr[data-meter]', c).forEach((tr) => tr.addEventListener('click', () => { ui.meterId = tr.dataset.meter; location.hash = '#/consumption'; }));
  $('#exp-meters').onclick = () => {
    const csv = ['meter_id,site,description,serial,size_mm,register_m3,integration', ...rows.map(({ m, reg }) => [m.id, S.siteById(m.siteId).name, m.name, m.serial, m.sizeMm, reg.toFixed(1), 'simulated'].map((v) => `"${v}"`).join(','))].join('\n');
    R.download('watersentinel-meter-register.csv', csv, 'text/csv');
  };
}

function viewConsumption(c) {
  const meter = S.meterById(ui.meterId);
  const site = S.siteById(meter.siteId);
  setHeader('Consumption', `${esc(site.name)} · ${esc(meter.name)} <span class="mono">(${meter.id})</span>`);
  const resolution = ui.resolution === 'auto' ? (ui.range <= 14 ? 'hourly' : 'daily') : ui.resolution;
  c.innerHTML = `<div class="card">
    <div class="controls" style="margin-bottom:14px">
      <label class="field">Meter<select id="c-meter">${S.SITES.map((s) => `<optgroup label="${esc(s.name)}">${S.METERS.filter((m) => m.siteId === s.id).map((m) => `<option value="${m.id}" ${m.id === meter.id ? 'selected' : ''}>${m.id} · ${esc(m.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <div class="field">Range<div class="seg" id="c-range">${[3, 7, 14, 28, 56].map((d) => `<button data-v="${d}" class="${ui.range === d ? 'on' : ''}">${d === 56 ? '8 wk' : `${d} d`}</button>`).join('')}</div></div>
      <div class="field">Resolution<div class="seg" id="c-res">${['hourly', 'daily'].map((r) => `<button data-v="${r}" class="${resolution === r ? 'on' : ''}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}</div></div>
    </div>
    <ul class="legend"><li><span class="sw" style="background:${OBSERVED}"></span>Observed</li><li><span class="sw-dash"></span>Expected (hour-of-week median)</li><li><span class="sw-band"></span>Detected anomaly</li></ul>
    <div class="chart-wrap" id="c-chart"></div>
    <div class="evidence" id="c-stats" style="margin-top:14px"></div>
  </div>
  <div class="grid-2">
    <div class="card"><h2>Minimum night flow</h2><p class="hint">Lowest hourly reading between 01:00 and 04:59 each day. A sustained rise is a common early sign of unmetered continuous flow, and also of new legitimate night loads.</p><div class="chart-wrap" id="c-mnf"></div></div>
    <div class="card"><h2>Daily totals</h2><p class="hint">Table view of the selected range.</p><div class="table-scroll" style="max-height:300px;overflow:auto"><table id="c-table"></table></div></div>
  </div>`;

  const t1 = lastT();
  const from = t1 - ui.range * DAY + HOUR;
  const scored = S.state.scoredByMeter.get(meter.id).filter((r) => r.t >= from);
  let observed, expected;
  if (resolution === 'hourly') {
    observed = scored.map((r) => ({ t: r.t, v: r.v }));
    expected = scored.map((r) => ({ t: r.t, v: r.expected }));
  } else {
    const days = new Map();
    for (const r of scored) {
      const d = r.t - (r.t % DAY);
      const cur = days.get(d) ?? { t: d, v: 0, e: 0, eOk: true, missing: 0 };
      if (r.v == null) cur.missing++; else cur.v += r.v;
      if (r.expected == null) cur.eOk = false; else cur.e += r.expected;
      days.set(d, cur);
    }
    observed = [...days.values()].map((d) => ({ t: d.t, v: d.v }));
    expected = [...days.values()].map((d) => ({ t: d.t, v: d.eOk ? d.e : null }));
  }
  const alerts = S.state.alerts.filter((a) => a.meterId === meter.id && a.end >= from);
  const bands = alerts.map((a) => resolution === 'hourly'
    ? { start: a.start, end: a.end, label: `Detected anomaly · priority ${a.priority}` }
    : { start: a.start - (a.start % DAY), end: a.end - (a.end % DAY), label: `Detected anomaly · priority ${a.priority}` });
  lineChart($('#c-chart'), {
    series: [{ name: 'Observed', color: OBSERVED, points: observed, area: true }, { name: 'Expected', color: EXPECTED, points: expected, dash: '5 4', width: 1.5 }],
    bands, unit: resolution === 'hourly' ? 'L/h' : 'L/day', daily: resolution === 'daily', height: 300, label: 'Observed vs expected consumption',
  });

  const vals = scored.filter((r) => r.v != null);
  const total = vals.reduce((a, r) => a + r.v, 0);
  const peak = vals.reduce((b, r) => (r.v > b.v ? r : b), vals[0]);
  const mnfAll = minimumNightFlow(S.state.readings.get(meter.id));
  $('#c-stats').innerHTML = `
    <div><div class="k">Total</div><div class="v">${fmtNum(total / 1000)} m³</div></div>
    <div><div class="k">Average</div><div class="v">${fmtNum(total / Math.max(vals.length, 1))} L/h</div></div>
    <div><div class="k">Peak hour</div><div class="v">${fmtNum(peak?.v ?? 0)} L/h</div></div>
    <div><div class="k">Latest night min</div><div class="v">${fmtNum(mnfAll.at(-1)?.v ?? 0)} L/h</div></div>
    <div><div class="k">Detected anomalies</div><div class="v">${alerts.length}</div></div>
    <div><div class="k">Missing hours</div><div class="v">${scored.length - vals.length}</div></div>`;

  const mnf = mnfAll.filter((d) => d.t >= t1 - Math.max(ui.range, 28) * DAY);
  lineChart($('#c-mnf'), {
    series: [{ name: 'Min night flow', color: '#129c92', points: mnf }], daily: true, unit: 'L/h', height: 200,
    bands: alerts.filter((a) => a.nightHours > 0).map((a) => ({ start: a.start - (a.start % DAY), end: a.end - (a.end % DAY), label: 'Anomaly with night-time hours' })),
    label: 'Minimum night flow',
  });
  const daily = R.dailyTotals(meter.id, Math.max(Math.round(ui.range), 1)).reverse();
  $('#c-table').innerHTML = `<thead><tr><th>Date</th><th class="r">Litres</th><th class="r">Missing h</th></tr></thead><tbody>${daily.map((d) => `<tr><td>${fmtDate(d.t)}</td><td class="r">${Math.round(d.v).toLocaleString('en-US')}</td><td class="r">${d.missing || ''}</td></tr>`).join('')}</tbody>`;

  $('#c-meter').onchange = (e) => { ui.meterId = e.target.value; render(); };
  $$('#c-range button').forEach((b) => (b.onclick = () => { ui.range = Number(b.dataset.v); ui.resolution = 'auto'; render(); }));
  $$('#c-res button').forEach((b) => (b.onclick = () => { ui.resolution = b.dataset.v; render(); }));
}

function viewAlerts(c) {
  const all = S.state.alerts;
  const list = all.filter((a) => (ui.alertFilter === 'all' ? true : ui.alertFilter === 'open' ? S.isOpen(a.id) : !S.isOpen(a.id)));
  setHeader('Anomaly alerts', 'Statistically detected consumption anomalies, ranked by configurable priority factors. None of these is a confirmed leak until inspected.');
  const cfg = S.state.config;
  c.innerHTML = `<div class="grid-3">
    <div class="card">
      <div class="card-head"><div><h2>${list.length} ${ui.alertFilter === 'all' ? '' : ui.alertFilter} alert${list.length === 1 ? '' : 's'}</h2><p class="hint">Bar shows each factor's contribution to the priority score.</p></div>
        <div class="seg" id="a-filter">${['open', 'closed', 'all'].map((f) => `<button data-v="${f}" class="${ui.alertFilter === f ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div></div>
      <ul class="legend">${Object.keys(FACTOR_COLORS).map((k) => `<li><span class="sw" style="background:${FACTOR_COLORS[k]};height:8px"></span>${FACTOR_LABELS[k]}</li>`).join('')}</ul>
      <div class="alert-list">${list.map(alertItem).join('') || '<div class="empty">No alerts in this view.</div>'}</div>
    </div>
    <div style="display:grid;gap:18px;align-content:start">
      <div class="card">
        <h2>Prioritization weights</h2><p class="hint">Adjust how each factor counts. Ranking updates immediately.</p>
        <div style="display:grid;gap:10px" id="weights">${Object.keys(S.state.weights).map((k) => `<label class="slider"><span>${FACTOR_LABELS[k]}</span><input type="range" min="0" max="1" step="0.05" value="${S.state.weights[k]}" data-k="${k}"><output>${S.state.weights[k].toFixed(2)}</output></label>`).join('')}</div>
      </div>
      <div class="card">
        <h2>Detector settings</h2><p class="hint">Dual-baseline robust z-score on hourly readings.</p>
        <div style="display:grid;gap:10px">
          <label class="slider"><span>z threshold</span><input type="range" min="2" max="8" step="0.5" value="${cfg.zThreshold}" data-c="zThreshold"><output>${cfg.zThreshold}</output></label>
          <label class="slider"><span>Min excess %</span><input type="range" min="0.05" max="1" step="0.05" value="${cfg.minExcessRatio}" data-c="minExcessRatio"><output>${Math.round(cfg.minExcessRatio * 100)}%</output></label>
          <label class="slider"><span>Min excess L/h</span><input type="range" min="10" max="300" step="10" value="${cfg.minExcessLph}" data-c="minExcessLph"><output>${cfg.minExcessLph}</output></label>
          <label class="slider"><span>Merge gap (h)</span><input type="range" min="0" max="8" step="1" value="${cfg.mergeGapHours}" data-c="mergeGapHours"><output>${cfg.mergeGapHours}</output></label>
        </div>
        <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="rerun">Re-run detection</button><span class="hint" style="margin:0">${all.length} events in window</span></div>
        <p class="hint" style="margin:10px 0 0">Changing settings can change event boundaries; workflow history is kept per event ID.</p>
      </div>
    </div></div>`;
  $$('#a-filter button').forEach((b) => (b.onclick = () => { ui.alertFilter = b.dataset.v; render(); }));
  $$('#weights input').forEach((inp) => {
    inp.oninput = () => { inp.nextElementSibling.textContent = Number(inp.value).toFixed(2); };
    inp.onchange = () => { S.state.weights[inp.dataset.k] = Number(inp.value); S.runDetection(); S.persist(); };
  });
  $$('[data-c]', c).forEach((inp) => (inp.oninput = () => {
    const k = inp.dataset.c; const v = Number(inp.value);
    inp.nextElementSibling.textContent = k === 'minExcessRatio' ? `${Math.round(v * 100)}%` : v;
  }));
  $('#rerun').onclick = () => {
    $$('[data-c]', c).forEach((inp) => { S.state.config[inp.dataset.c] = Number(inp.value); });
    briefCache.clear();
    S.runDetection(); S.persist(); toast(`Detection re-run: ${S.state.alerts.length} events`);
  };
}

function viewInvestigationsIndex(c) {
  setHeader('Investigations', 'Every detected anomaly and where it stands in the review → inspection → outcome workflow');
  const rows = [...S.state.alerts].sort((a, b) => b.end - a.end);
  c.innerHTML = `<div class="card"><div class="table-scroll"><table><thead><tr><th>Anomaly</th><th>Site / meter</th><th>Window</th><th class="r">Excess (L)</th><th>Priority</th><th>Status</th><th>Tasks</th></tr></thead><tbody>
  ${rows.map((a) => `<tr class="click" data-id="${a.id}"><td><b>${esc(a.pattern)}</b><div class="mono" style="font-size:11px;color:var(--ink-3)">${a.id}</div></td><td>${siteDot(a.site.id)}${esc(a.site.name)}<div style="font-size:12px;color:var(--ink-3)">${esc(a.meter.name)}</div></td>
  <td>${fmtTime(a.start)}<div style="font-size:12px;color:var(--ink-3)">${a.ongoing ? 'ongoing' : `${a.spanHours} h`}</div></td><td class="r">${fmtNum(a.excessLitres)}</td><td>${prioBadge(a)}</td><td>${statusChip(a.id)}</td>
  <td>${S.state.workflow.tasks.filter((t) => t.alertId === a.id).length || '–'}</td></tr>`).join('')}
  </tbody></table></div></div>`;
  $$('tr[data-id]', c).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/investigate/${tr.dataset.id}`; }));
}

function getBrief(a) {
  if (!briefCache.has(a.id)) {
    const evidence = buildEvidence(a, { site: a.site, meter: a.meter, series: S.state.readings.get(a.meterId), scored: S.state.scoredByMeter.get(a.meterId), config: S.state.config });
    briefCache.set(a.id, { evidence, brief: writeBrief(evidence, a.meter) });
  }
  return briefCache.get(a.id);
}

function renderBrief(box, a) {
  const { brief } = getBrief(a);
  box.innerHTML = `<div class="brief">
    <div><h3>Summary</h3><p>${esc(brief.summary)}</p></div>
    <div><h3>Timeline</h3><ul>${brief.timeline.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
    <div><h3>Possible explanations</h3><div style="display:grid;gap:8px">${brief.possible_explanations.map((e, i) => `<div class="explain"><b>${i + 1}. ${esc(e.explanation)}</b><span class="s">${esc(e.supporting)}</span><span class="c"><b style="font-size:13px">How to check:</b> ${esc(e.how_to_check)}</span></div>`).join('')}</div></div>
    <div><h3>Recommended inspection</h3><ol>${brief.recommended_inspection.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>
    <div><h3>Limitations</h3><ul>${brief.limitations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
    <p class="hint" style="margin:0">${esc(brief.generated_by)}</p>
  </div>`;
}

function viewInvestigate(c, id) {
  if (!id) return viewInvestigationsIndex(c);
  const a = S.state.alerts.find((x) => x.id === id);
  if (!a) {
    setHeader('Investigation not found');
    c.innerHTML = `<div class="card empty">This anomaly ID is not in the current detection results (detector settings may have changed). <a href="#/investigate">Back to investigations</a></div>`;
    return;
  }
  const inv = S.investigationOf(a.id);
  const tasks = S.state.workflow.tasks.filter((t) => t.alertId === a.id);
  const steps = [['detected', 'Detected'], ['reviewing', 'Under review'], ['inspection_scheduled', 'Inspection scheduled'], ['outcome', 'Outcome recorded']];
  const order = { detected: 0, reviewing: 1, inspection_scheduled: 2, inconclusive: 2 };
  const pos = order[inv.status] ?? 3;
  const closed = !S.isOpen(a.id);
  setHeader(a.pattern, `${siteDot(a.site.id)}${esc(a.site.name)} · ${esc(a.meter.name)} <span class="mono">(${a.meterId})</span> · ${fmtTime(a.start)}${a.ongoing ? ' → ongoing' : ` – ${fmtTime(a.end)}`}`,
    `<button class="btn" id="i-report">Export report</button>`);

  c.innerHTML = `
  <div class="card">
    <div class="card-head" style="margin-bottom:6px"><div class="btn-row">${statusChip(a.id)} ${prioBadge(a)} <span class="chip plain muted mono">${a.id}</span></div>
      <div class="btn-row">
        ${inv.status === 'detected' ? '<button class="btn" id="i-review">Start review</button>' : ''}
        ${!closed ? '<button class="btn primary" id="i-task">Create inspection task</button>' : ''}
        ${!closed && inv.status !== 'inspection_scheduled' ? '<button class="btn ghost" id="i-dismiss">Dismiss as normal variation</button>' : ''}
        ${closed ? '<button class="btn ghost" id="i-reopen">Reopen</button>' : ''}
      </div></div>
    <div class="status-track">${steps.map(([k, l], i) => `<div class="status-step ${i < pos ? 'done' : i === pos ? 'now' : ''}"><span class="dot">${i < pos ? '✓' : i + 1}</span>${i === 3 && pos === 3 ? esc(S.STATUSES[inv.status].label) : l}</div>`).join('')}</div>
    <div class="notice ${inv.status === 'verified_leak' ? 'warn' : ''}" style="margin-top:10px">${inv.status === 'verified_leak'
      ? 'A leak was verified by on-site inspection and recorded against this anomaly.'
      : 'This is a <b>detected anomaly</b>: consumption differed significantly from the expected pattern. It is <b>not a verified leak</b>. Only an on-site inspection can establish the cause.'}</div>
  </div>
  <div class="grid-3">
    <div style="display:grid;gap:18px;min-width:0">
      <div class="card"><h2>Readings around the event</h2><p class="hint">Hourly observed flow vs expected, from 3 days before to 1 day after.</p>
        <ul class="legend"><li><span class="sw" style="background:${OBSERVED}"></span>Observed</li><li><span class="sw-dash"></span>Expected</li><li><span class="sw-band"></span>Flagged window</li></ul>
        <div class="chart-wrap" id="i-chart"></div></div>
      <div class="card"><h2>Minimum night flow, 28 days</h2><p class="hint">Daily lowest reading 01:00–04:59.</p><div class="chart-wrap" id="i-mnf"></div></div>
    </div>
    <div style="display:grid;gap:18px;align-content:start">
      <div class="card"><h2>Evidence</h2><p class="hint">Values computed by the detector; the assistant may only use these.</p><div class="evidence" id="i-evidence"></div></div>
      <div class="card"><h2>Priority breakdown</h2><p class="hint">Score ${a.priority} of 100 · ${a.band.hint}</p>
        <div class="bars">${Object.keys(a.contributions).map((k) => `<div class="bar-row" style="grid-template-columns:110px 1fr 40px"><div class="bar-label">${FACTOR_LABELS[k]}</div><div class="bar-track"><div class="bar-fill" style="width:${a.factors[k] * 100}%;background:${FACTOR_COLORS[k]}"></div></div><div class="bar-value">+${a.contributions[k].toFixed(0)}</div></div>`).join('')}</div></div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><div class="ai-head"><span class="ai-badge">✦ Investigation assistant</span><h2 style="margin:0">Anomaly brief for maintenance staff</h2></div>
      <button class="btn teal" id="i-gen">${briefCache.has(a.id) ? 'Regenerate brief' : 'Generate brief'}</button></div>
    <div id="i-brief">${briefCache.has(a.id) ? '' : '<p class="hint" style="margin:0">Summarises the detected anomaly, its timing and readings, possible explanations and a recommended inspection sequence.</p>'}</div>
    <details class="prompt" style="margin-top:14px"><summary>View the Amazon Bedrock request this brief is based on</summary><pre id="i-prompt"></pre></details>
  </div>
  <div class="grid-2">
    <div class="card"><h2>Inspection tasks</h2><p class="hint">Confirmed review items become inspection tasks with an assignee and outcome.</p>
      ${tasks.length ? tasks.map((t) => `<div class="task" style="margin-bottom:8px"><div class="row"><span class="tt">${esc(t.title)}</span></div><div class="tm">${t.id} · ${esc(techName(t.assignee))} · due ${fmtDate(t.due)}</div><div class="row"><span class="chip ${t.state === 'completed' ? 'good' : 'info'}">${t.state.replace('_', ' ')}</span>${t.outcome ? `<span class="chip ${S.STATUSES[t.outcome].chip}">${S.STATUSES[t.outcome].label}</span>` : ''}<a class="btn ghost" href="#/tasks">Open board →</a></div>${t.outcomeNote ? `<div class="tm">${esc(t.outcomeNote)}</div>` : ''}</div>`).join('') : '<div class="empty">No tasks yet.</div>'}
    </div>
    <div class="card"><h2>Notes &amp; activity</h2>
      <div style="display:grid;gap:8px;margin-bottom:10px">${(inv.notes ?? []).map((n) => `<div style="font-size:13px"><b>${esc(n.by)}</b> <span style="color:var(--ink-3)">${fmtDate(n.at)}</span><br>${esc(n.text)}</div>`).join('') || '<div class="hint">No notes yet.</div>'}</div>
      <textarea id="i-note" placeholder="Add an observation, a call with operations, a contractor visit…" aria-label="New note"></textarea>
      <div class="btn-row" style="margin-top:8px"><button class="btn" id="i-addnote">Add note</button></div>
    </div>
  </div>`;

  // charts
  const scored = S.state.scoredByMeter.get(a.meterId);
  const from = Math.max(a.start - 3 * DAY, START), to = Math.min(a.end + DAY, END);
  const win = scored.filter((r) => r.t >= from && r.t <= to);
  lineChart($('#i-chart'), {
    series: [{ name: 'Observed', color: OBSERVED, points: win.map((r) => ({ t: r.t, v: r.v })), area: true }, { name: 'Expected', color: EXPECTED, points: win.map((r) => ({ t: r.t, v: r.expected })), dash: '5 4', width: 1.5 }],
    bands: [{ start: a.start, end: a.end, label: 'Flagged window' }], unit: 'L/h', height: 280, label: 'Readings around the anomaly',
  });
  const mnf = minimumNightFlow(S.state.readings.get(a.meterId)).slice(-28);
  lineChart($('#i-mnf'), { series: [{ name: 'Min night flow', color: '#129c92', points: mnf }], daily: true, unit: 'L/h', height: 190,
    bands: [{ start: a.start - (a.start % DAY), end: a.end - (a.end % DAY), label: 'Event days' }], label: 'Minimum night flow' });

  const { evidence } = getBrief(a);
  const e = evidence;
  $('#i-evidence').innerHTML = `
    <div><div class="k">Observed mean</div><div class="v">${fmtNum(e.flow.observed_mean_lph)} L/h</div></div>
    <div><div class="k">Expected mean</div><div class="v">${fmtNum(e.flow.expected_mean_lph)} L/h</div></div>
    <div><div class="k">Excess volume</div><div class="v">${fmtNum(e.flow.excess_total_litres)} L</div></div>
    <div><div class="k">Peak</div><div class="v">${fmtNum(e.flow.peak_lph)} L/h</div></div>
    <div><div class="k">Peak robust z</div><div class="v">${e.flow.peak_robust_z}</div></div>
    <div><div class="k">Duration</div><div class="v">${e.window.span_hours} h${e.window.ongoing ? '+' : ''}</div></div>
    <div><div class="k">Night min before</div><div class="v">${e.night_flow.baseline_min_night_flow_lph ?? '–'} L/h</div></div>
    <div><div class="k">Night min during</div><div class="v">${e.night_flow.event_min_night_flow_lph ?? '–'} L/h</div></div>
    <div><div class="k">Earlier events</div><div class="v">${e.recurrence.earlier_events_same_meter}</div></div>`;
  $('#i-prompt').textContent = JSON.stringify({
    modelId: 'anthropic.claude (configured per environment)',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Evidence package:\n${JSON.stringify(e, null, 2)}` }],
  }, null, 2);

  const briefBox = $('#i-brief');
  if (briefCache.has(a.id)) renderBrief(briefBox, a);
  $('#i-gen').onclick = () => {
    briefBox.innerHTML = '<div class="ai-head" style="color:var(--ink-3);font-size:13px"><span class="typing"><i></i><i></i><i></i></span> Reviewing evidence package…</div>';
    $('#i-gen').disabled = true;
    setTimeout(() => { renderBrief(briefBox, a); $('#i-gen').disabled = false; $('#i-gen').textContent = 'Regenerate brief'; }, 900);
  };

  // workflow actions
  $('#i-review')?.addEventListener('click', () => S.setStatus(a.id, 'reviewing', 'Review started.'));
  $('#i-reopen')?.addEventListener('click', () => S.setStatus(a.id, 'reviewing', 'Investigation reopened.'));
  $('#i-dismiss')?.addEventListener('click', () => modal(`
    <h2>Dismiss as normal variation</h2>
    <p class="hint" style="margin:0">Record why this anomaly does not need an inspection. The event stays in the history.</p>
    <textarea id="d-note" placeholder="Reason (required)"></textarea>
    <div class="btn-row"><button class="btn primary" id="d-ok">Dismiss</button><button class="btn" data-close>Cancel</button></div>`, (m, close) => {
    $('#d-ok', m).onclick = () => { const v = $('#d-note', m).value.trim(); if (!v) { $('#d-note', m).focus(); return; } S.setStatus(a.id, 'dismissed', `Dismissed: ${v}`); close(); };
  }));
  $('#i-task')?.addEventListener('click', () => openTaskModal(a));
  $('#i-addnote').onclick = () => { const v = $('#i-note').value.trim(); if (v) S.addNote(a.id, v); };
  $('#i-report').onclick = () => { const { evidence: ev, brief } = getBrief(a); R.download(`investigation-${a.id}.html`, R.investigationReportHtml(a, ev, brief), 'text/html'); };
}

function openTaskModal(a) {
  const sustained = a.spanHours >= 12 && a.nightHours >= 3;
  const defTitle = sustained ? `Zero-demand meter check and walk-down: ${a.meter.name}` : `Inspect equipment on ${a.meter.name}`;
  const defTech = a.meter.profile === 'irrigation' ? 't3' : a.meter.profile === 'cooling' ? 't2' : 't1';
  const due = new Date(lastT() + DAY).toISOString().slice(0, 10);
  modal(`
    <h2>Create inspection task</h2>
    <label class="field">Title<input type="text" id="t-title" value="${esc(defTitle)}"></label>
    <label class="field">Assign to<select id="t-tech">${S.TECHNICIANS.map((t) => `<option value="${t.id}" ${t.id === defTech ? 'selected' : ''}>${esc(t.name)} · ${esc(t.team)}</option>`).join('')}</select></label>
    <label class="field">Due<input type="date" id="t-due" value="${due}"></label>
    <p class="hint" style="margin:0">The anomaly moves to <b>Inspection scheduled</b>. The inspection outcome decides whether a leak is verified.</p>
    <div class="btn-row"><button class="btn primary" id="t-ok">Create task</button><button class="btn" data-close>Cancel</button></div>`, (m, close) => {
    $('#t-ok', m).onclick = () => {
      const title = $('#t-title', m).value.trim() || defTitle;
      const t = S.createTask({ alertId: a.id, title, assignee: $('#t-tech', m).value, due: Date.parse($('#t-due', m).value) || lastT() + DAY });
      close(); toast(`${t.id} assigned to ${techName(t.assignee)}`);
    };
  });
}

function viewTasks(c) {
  setHeader('Maintenance tasks', 'Inspection work created from reviewed anomalies. Recording an outcome closes the loop on the anomaly.');
  const cols = [['open', 'To do'], ['in_progress', 'In progress'], ['completed', 'Completed']];
  const alertById = (id) => S.state.alerts.find((a) => a.id === id);
  c.innerHTML = `<div class="kanban">${cols.map(([k, l]) => {
    const tasks = S.state.workflow.tasks.filter((t) => t.state === k);
    return `<div class="col"><h3>${l} <span>${tasks.length}</span></h3>${tasks.map((t) => {
      const a = alertById(t.alertId);
      return `<div class="task" data-id="${t.id}">
        <div class="tt">${esc(t.title)}</div>
        <div class="tm">${t.id} · ${a ? `<a href="#/investigate/${a.id}">${esc(a.site.name)}</a>` : esc(t.alertId)} · due ${fmtDate(t.due)}</div>
        <div class="row"><select data-assign aria-label="Assignee">${S.TECHNICIANS.map((x) => `<option value="${x.id}" ${x.id === t.assignee ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
        ${t.outcome ? `<div class="row"><span class="chip ${S.STATUSES[t.outcome].chip}">${S.STATUSES[t.outcome].label}</span></div>${t.outcomeNote ? `<div class="tm">${esc(t.outcomeNote)}</div>` : ''}` : ''}
        <div class="row">${k === 'open' ? '<button class="btn" data-start>Start</button>' : ''}${k !== 'completed' ? '<button class="btn primary" data-outcome>Record outcome</button>' : ''}</div>
      </div>`;
    }).join('') || '<div class="empty">Nothing here.</div>'}</div>`;
  }).join('')}</div>`;
  $$('.task', c).forEach((card) => {
    const id = card.dataset.id;
    $('[data-assign]', card).onchange = (e) => S.updateTask(id, { assignee: e.target.value });
    $('[data-start]', card)?.addEventListener('click', () => S.updateTask(id, { state: 'in_progress' }));
    $('[data-outcome]', card)?.addEventListener('click', () => modal(`
      <h2>Record inspection outcome</h2>
      <div style="display:grid;gap:8px">${S.OUTCOMES.map((o, i) => `<label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="radio" name="oc" value="${o}" ${i === 1 ? 'checked' : ''}> ${S.STATUSES[o].label}</label>`).join('')}</div>
      <label class="field">What was found on site (required)<textarea id="o-note" placeholder="e.g. Toilet fill valve in unit 4B running continuously; replaced. Meter static at night after repair."></textarea></label>
      <p class="hint" style="margin:0">Choose <b>Verified leak</b> only if the inspection physically located a leak.</p>
      <div class="btn-row"><button class="btn primary" id="o-ok">Save outcome</button><button class="btn" data-close>Cancel</button></div>`, (m, close) => {
      $('#o-ok', m).onclick = () => {
        const note = $('#o-note', m).value.trim();
        if (!note) { $('#o-note', m).focus(); return; }
        S.updateTask(id, { outcome: $('input[name=oc]:checked', m).value, outcomeNote: note });
        close(); toast('Outcome recorded');
      };
    }));
  });
}

function viewCompare(c) {
  const t1 = lastT();
  const days = ui.comparePeriod;
  setHeader('Site comparison', 'Main incoming meters, normalised by the context each site has on file');
  const rows = S.SITES.map((s) => {
    const main = S.METERS.find((m) => m.siteId === s.id && m.name.startsWith('Main'));
    const litres = sumRange(main.id, t1 - days * DAY + HOUR, t1);
    const prev = sumRange(main.id, t1 - 2 * days * DAY + HOUR, t1 - days * DAY);
    return { s, main, litres, prev };
  });
  const metric = {
    occupant: { label: 'L per occupant per day', f: (r) => r.litres / days / r.s.occupants, unit: 'L/occ/day' },
    area: { label: 'L per m² per day', f: (r) => r.litres / days / r.s.areaM2, unit: 'L/m²/day' },
    total: { label: 'Total m³', f: (r) => r.litres / 1000, unit: 'm³' },
  }[ui.compareMetric];
  c.innerHTML = `
  <div class="card">
    <div class="card-head"><div><h2>${metric.label}, last ${days} days</h2><p class="hint">Intensity figures depend on the occupancy and floor area on file; check them before drawing conclusions.</p></div>
      <div class="btn-row"><div class="seg" id="m-metric">${[['occupant', 'Per occupant'], ['area', 'Per m²'], ['total', 'Total']].map(([k, l]) => `<button data-v="${k}" class="${ui.compareMetric === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" id="m-period">${[7, 28].map((d) => `<button data-v="${d}" class="${days === d ? 'on' : ''}">${d} d</button>`).join('')}</div></div></div>
    <div id="m-bars"></div>
  </div>
  <div class="card"><h2>Daily litres per occupant, 8 weeks</h2><p class="hint">Indexed to occupancy so sites of different size share one scale. Lakeview's rise from 12 Oct coincides with its open anomaly.</p>
    <ul class="legend">${S.SITES.map((s) => `<li><span class="sw" style="background:${SITE_COLORS[s.id]}"></span>${esc(s.name)}</li>`).join('')}</ul>
    <div class="chart-wrap" id="m-line"></div></div>
  <div class="card"><h2>Period over period</h2><div class="table-scroll"><table><thead><tr><th>Site</th><th>Type</th><th class="r">Occupants</th><th class="r">Area m²</th><th class="r">This period m³</th><th class="r">Previous m³</th><th class="r">Change</th><th>Open anomalies</th></tr></thead><tbody>
  ${rows.map((r) => { const ch = r.prev ? ((r.litres - r.prev) / r.prev) * 100 : 0; const oa = openAlerts().filter((a) => a.site.id === r.s.id).length; return `<tr><td>${siteDot(r.s.id)}${esc(r.s.name)}</td><td>${esc(r.s.type)}</td><td class="r">${r.s.occupants.toLocaleString('en-US')}</td><td class="r">${r.s.areaM2.toLocaleString('en-US')}</td><td class="r">${fmtNum(r.litres / 1000)}</td><td class="r">${fmtNum(r.prev / 1000)}</td><td class="r" style="color:${ch > 10 ? 'var(--orange-600)' : 'inherit'}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</td><td>${oa ? `<span class="chip alert">${oa}</span>` : '<span class="chip good">0</span>'}</td></tr>`; }).join('')}
  </tbody></table></div>
  <p class="hint" style="margin:12px 0 0">Context not yet captured in the demo: weather, process water, occupancy schedules and tenant changes. Healthcare and residential sites are expected to use more water per occupant than offices or warehouses.</p></div>`;
  barChart($('#m-bars'), { rows: rows.map((r) => ({ label: r.s.name, value: metric.f(r), color: SITE_COLORS[r.s.id] })), unit: metric.unit });
  lineChart($('#m-line'), {
    series: rows.map((r) => ({ name: r.s.name, color: SITE_COLORS[r.s.id], points: R.dailyTotals(r.main.id).map((d) => ({ t: d.t, v: d.v / r.s.occupants })) })),
    daily: true, unit: 'L/occ/day', height: 280, label: 'Daily litres per occupant by site',
  });
  $$('#m-metric button').forEach((b) => (b.onclick = () => { ui.compareMetric = b.dataset.v; render(); }));
  $$('#m-period button').forEach((b) => (b.onclick = () => { ui.comparePeriod = Number(b.dataset.v); render(); }));
}

function viewReports(c) {
  setHeader('Reports', 'Consumption summaries, anomaly histories and investigation reports');
  c.innerHTML = `
  <div class="notice">In the demo, reports are generated in your browser and downloaded. In production, the report service writes them to Amazon S3 (encrypted, versioned) and returns a time-limited download link.</div>
  <div class="grid-2">
    <div class="card"><h2>Consumption summary</h2><p class="hint">Per-site totals, period change and intensity, plus daily per-meter data.</p>
      <div class="controls"><label class="field">Period<select id="r-days"><option value="7">7 days</option><option value="28" selected>28 days</option></select></label>
      <button class="btn primary" id="r-sum-html">Download report (HTML)</button><button class="btn" id="r-sum-csv">Daily data (CSV)</button></div></div>
    <div class="card"><h2>Anomaly history</h2><p class="hint">Every detected anomaly with priority, status and whether a leak was verified by inspection.</p>
      <div class="btn-row"><button class="btn primary" id="r-hist">Download CSV</button><span class="hint" style="margin:0">${S.state.alerts.length} anomalies</span></div></div>
    <div class="card"><h2>Investigation report</h2><p class="hint">Evidence, assistant brief, tasks, outcome and notes for one anomaly. Suitable for printing or sharing with contractors.</p>
      <div class="controls"><label class="field" style="flex:1">Anomaly<select id="r-inv">${S.state.alerts.map((a) => `<option value="${a.id}">${esc(a.site.name)} · ${esc(a.meter.name)} · ${fmtTime(a.start)}</option>`).join('')}</select></label>
      <button class="btn primary" id="r-inv-dl">Download</button></div></div>
    <div class="card"><h2>Data export</h2><p class="hint">Hourly readings, detector scores and workflow state as JSON, for analysis elsewhere.</p>
      <div class="btn-row"><button class="btn" id="r-json">Download JSON</button></div></div>
  </div>`;
  $('#r-sum-html').onclick = () => R.download(`consumption-summary-${$('#r-days').value}d.html`, R.consumptionSummaryHtml(Number($('#r-days').value)), 'text/html');
  $('#r-sum-csv').onclick = () => R.download(`consumption-daily-${$('#r-days').value}d.csv`, R.consumptionCsv(Number($('#r-days').value)), 'text/csv');
  $('#r-hist').onclick = () => R.download('anomaly-history.csv', R.anomalyHistoryCsv(), 'text/csv');
  $('#r-inv-dl').onclick = () => { const a = S.state.alerts.find((x) => x.id === $('#r-inv').value); const { evidence, brief } = getBrief(a); R.download(`investigation-${a.id}.html`, R.investigationReportHtml(a, evidence, brief), 'text/html'); };
  $('#r-json').onclick = () => R.download('watersentinel-export.json', JSON.stringify({
    notice: DEMO_NOTICE, sites: S.SITES, meters: S.METERS, config: S.state.config, weights: S.state.weights,
    readings: Object.fromEntries([...S.state.readings].map(([k, v]) => [k, v])),
    anomalies: S.state.alerts.map(({ meter, site, ...rest }) => ({ ...rest, status: S.statusOf(rest.id) })),
    workflow: S.state.workflow,
  }), 'application/json');
}

// ---------- router ----------
const routes = { overview: viewOverview, meters: viewMeters, consumption: viewConsumption, alerts: viewAlerts, investigate: viewInvestigate, tasks: viewTasks, compare: viewCompare, reports: viewReports };

function render() {
  const [, route = 'overview', param] = location.hash.split('/');
  const view = routes[route] ?? viewOverview;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  const n = openAlerts().filter((a) => a.band.key !== 'p3').length;
  const badge = $('#alert-count'); badge.hidden = !n; badge.textContent = n;
  const c = $('#content');
  view(c, param ? decodeURIComponent(param) : undefined);
  $('#side').classList.remove('open');
}

S.init();
$('#demo-notice').textContent = DEMO_NOTICE;
window.addEventListener('hashchange', () => { $$('.modal-bg').forEach((m) => m.remove()); render(); window.scrollTo(0, 0); });
S.subscribe(render);
$('#menu-btn').onclick = () => $('#side').classList.toggle('open');
$('#reset-demo').onclick = (e) => { e.preventDefault(); briefCache.clear(); S.resetDemo(); toast('Demo data reset'); };
render();
