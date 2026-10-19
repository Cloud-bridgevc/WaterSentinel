// Report builders. In the demo, files are generated in the browser and downloaded.
// In production, the report Lambda renders the same content and stores it in S3
// (see backend/watersentinel/handlers/report.py), returning a short-lived link.

import { state, STATUSES, investigationOf, TECHNICIANS, SITES, METERS, siteById } from './store.js';
import { fmtTime } from './assistant.js';
import { DEMO_NOTICE } from './data.js';

const DAY = 24 * 3600 * 1000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

export function download(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function dailyTotals(meterId, days) {
  const series = state.readings.get(meterId);
  const map = new Map();
  for (const r of series) {
    const d = r.t - (r.t % DAY);
    const cur = map.get(d) ?? { t: d, v: 0, missing: 0 };
    if (r.v == null) cur.missing += 1; else cur.v += r.v;
    map.set(d, cur);
  }
  const all = [...map.values()];
  return days ? all.slice(-days) : all;
}

export function consumptionCsv(days = 28) {
  const rows = [['date', 'site', 'meter_id', 'meter_name', 'litres', 'missing_hours', 'data_source']];
  for (const m of METERS) {
    for (const d of dailyTotals(m.id, days)) {
      rows.push([isoDay(d.t), siteById(m.siteId).name, m.id, m.name, Math.round(d.v), d.missing, 'simulated demo data']);
    }
  }
  return toCsv(rows);
}

export function anomalyHistoryCsv() {
  const rows = [['anomaly_id', 'site', 'meter_id', 'pattern', 'start', 'end', 'span_hours', 'excess_litres', 'peak_robust_z', 'priority_score', 'priority_band', 'status', 'is_verified_leak']];
  for (const a of [...state.alerts].sort((x, y) => x.start - y.start)) {
    const st = investigationOf(a.id).status;
    rows.push([a.id, a.site.name, a.meterId, a.pattern, new Date(a.start).toISOString(), new Date(a.end).toISOString(), a.spanHours,
      Math.round(a.excessLitres), a.peakZ.toFixed(1), a.priority, a.band.label, STATUSES[st].label, st === 'verified_leak' ? 'yes (inspection)' : 'no']);
  }
  return toCsv(rows);
}

const REPORT_CSS = `body{font-family:Inter,system-ui,sans-serif;color:#142033;max-width:860px;margin:32px auto;padding:0 20px;line-height:1.5}
h1{font-size:24px;margin:0}h2{font-size:16px;margin:28px 0 8px;border-bottom:2px solid #0e8f87;padding-bottom:4px}
.meta{color:#66768c;font-size:13px}.banner{background:#e3edf9;padding:8px 12px;border-radius:6px;font-size:13px;margin:16px 0}
.status{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px;background:#fdf0e6;color:#c95f17}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #dde3eb;padding:6px 8px;text-align:left}
th{font-size:11px;text-transform:uppercase;color:#66768c}.r{text-align:right}li{margin:3px 0}`;

export function investigationReportHtml(alert, evidence, brief) {
  const inv = investigationOf(alert.id);
  const tasks = state.workflow.tasks.filter((t) => t.alertId === alert.id);
  const techName = (id) => TECHNICIANS.find((t) => t.id === id)?.name ?? 'Unassigned';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Investigation report ${esc(alert.id)}</title><style>${REPORT_CSS}</style></head><body>
<h1>Investigation report</h1>
<div class="meta">WaterSentinel · ${esc(alert.site.name)} · ${esc(alert.meter.name)} (${esc(alert.meterId)}) · Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</div>
<div class="banner">${esc(DEMO_NOTICE)}</div>
<p>Status: <span class="status">${esc(STATUSES[inv.status].label)}</span></p>
<p><em>A detected anomaly indicates unusual consumption. It is recorded as a verified leak only when an inspection confirms a physical leak.</em></p>
<h2>Summary</h2><p>${esc(brief.summary)}</p>
<h2>Evidence</h2><table>
<tr><th>Measure</th><th class="r">Value</th></tr>
<tr><td>Window</td><td class="r">${esc(evidence.window.start)} – ${esc(evidence.window.end)} (${evidence.window.span_hours} h)</td></tr>
<tr><td>Observed mean flow</td><td class="r">${evidence.flow.observed_mean_lph} L/h</td></tr>
<tr><td>Expected mean flow</td><td class="r">${evidence.flow.expected_mean_lph} L/h</td></tr>
<tr><td>Estimated excess volume</td><td class="r">${evidence.flow.excess_total_litres.toLocaleString('en-US')} L</td></tr>
<tr><td>Peak flow</td><td class="r">${evidence.flow.peak_lph} L/h at ${esc(evidence.flow.peak_time)}</td></tr>
<tr><td>Peak robust z-score</td><td class="r">${evidence.flow.peak_robust_z}</td></tr>
<tr><td>Minimum night flow (before → during)</td><td class="r">${evidence.night_flow.baseline_min_night_flow_lph ?? '–'} → ${evidence.night_flow.event_min_night_flow_lph ?? '–'} L/h</td></tr>
<tr><td>Priority</td><td class="r">${alert.priority} (${esc(alert.band.label)})</td></tr></table>
<h2>Timeline</h2><ul>${brief.timeline.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<h2>Possible explanations</h2><ol>${brief.possible_explanations.map((e) => `<li><strong>${esc(e.explanation)}</strong><br>${esc(e.supporting)}<br><em>Check:</em> ${esc(e.how_to_check)}</li>`).join('')}</ol>
<h2>Recommended inspection</h2><ol>${brief.recommended_inspection.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<h2>Limitations</h2><ul>${brief.limitations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<h2>Inspection tasks</h2>${tasks.length ? `<table><tr><th>Task</th><th>Assignee</th><th>State</th><th>Outcome</th></tr>${tasks.map((t) => `<tr><td>${esc(t.id)} · ${esc(t.title)}</td><td>${esc(techName(t.assignee))}</td><td>${esc(t.state)}</td><td>${esc(t.outcome ? STATUSES[t.outcome].label : '–')}${t.outcomeNote ? `: ${esc(t.outcomeNote)}` : ''}</td></tr>`).join('')}</table>` : '<p>No inspection tasks yet.</p>'}
<h2>Notes</h2>${inv.notes?.length ? `<ul>${inv.notes.map((n) => `<li>${esc(new Date(n.at).toISOString().slice(0, 10))} · ${esc(n.by)}: ${esc(n.text)}</li>`).join('')}</ul>` : '<p>No notes.</p>'}
<p class="meta">${esc(brief.generated_by)}</p>
</body></html>`;
}

export function consumptionSummaryHtml(days = 28) {
  const rows = SITES.map((s) => {
    const meters = METERS.filter((m) => m.siteId === s.id && m.name.startsWith('Main'));
    const totals = meters.flatMap((m) => dailyTotals(m.id, days));
    const litres = totals.reduce((a, d) => a + d.v, 0);
    const prev = meters.flatMap((m) => dailyTotals(m.id, days * 2).slice(0, days)).reduce((a, d) => a + d.v, 0);
    const anomalies = state.alerts.filter((a) => a.site.id === s.id).length;
    return { s, litres, prev, anomalies };
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Consumption summary</title><style>${REPORT_CSS}</style></head><body>
<h1>Consumption summary · last ${days} days</h1><div class="meta">WaterSentinel portfolio report · ${esc(isoDay(state.readings.get(METERS[0].id).at(-1).t))}</div>
<div class="banner">${esc(DEMO_NOTICE)}</div>
<h2>By site (main incoming meters)</h2><table><tr><th>Site</th><th class="r">Total m³</th><th class="r">Prior period m³</th><th class="r">Change</th><th class="r">L / m² / day</th><th class="r">L / occupant / day</th><th class="r">Anomalies detected</th></tr>
${rows.map(({ s, litres, prev, anomalies }) => `<tr><td>${esc(s.name)}</td><td class="r">${(litres / 1000).toFixed(0)}</td><td class="r">${prev ? (prev / 1000).toFixed(0) : '–'}</td><td class="r">${prev ? `${(((litres - prev) / prev) * 100).toFixed(1)}%` : '–'}</td><td class="r">${(litres / s.areaM2 / days).toFixed(2)}</td><td class="r">${(litres / s.occupants / days).toFixed(0)}</td><td class="r">${anomalies}</td></tr>`).join('')}
</table><p class="meta">Anomaly counts are detector output, not verified leaks. Normalised figures do not account for process water, climate or occupancy schedules.</p></body></html>`;
}

export { fmtTime };
