// Small dependency-free SVG charts: time-series line chart with crosshair tooltip,
// horizontal bar chart with hover, and sparkline.

const NS = 'http://www.w3.org/2000/svg';
const HOUR = 3600 * 1000;

// Site colours, fixed order (validated for CVD separation on the light surface).
export const SITE_COLORS = { HP: '#2563b0', RC: '#129c92', NG: '#8a5bd6', LV: '#c2477a' };

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export const fmtNum = (v) => (v >= 10000 ? `${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k` : Math.round(v).toLocaleString('en-US'));
const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const fmtHourFull = (t) => `${new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' })} ${String(new Date(t).getUTCHours()).padStart(2, '0')}:00`;

function tooltip(container) {
  let tip = container.querySelector(':scope > .chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    container.appendChild(tip);
  }
  return tip;
}

function nearestIndex(points, t) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].t - t) < Math.abs(points[lo].t - t)) lo -= 1;
  return lo;
}

/**
 * Time-series line chart.
 * opts: { series: [{name, color, points:[{t,v}], dash?, width?, area?}], bands: [{start,end,label}],
 *         height, unit, daily (x labels as days), yMax }
 */
export function lineChart(container, opts) {
  const draw = () => {
    container.querySelectorAll(':scope > svg').forEach((n) => n.remove());
    const W = Math.max(container.clientWidth, 280);
    const H = opts.height ?? 260;
    const m = { t: 12, r: 14, b: 26, l: 48 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const all = opts.series.flatMap((s) => s.points);
    if (!all.length) return;
    const t0 = Math.min(...opts.series.map((s) => s.points[0]?.t ?? Infinity));
    const t1 = Math.max(...opts.series.map((s) => s.points.at(-1)?.t ?? -Infinity));
    const vmax = opts.yMax ?? niceMax(Math.max(...all.map((p) => p.v ?? 0)) * 1.08);
    const x = (t) => m.l + ((t - t0) / Math.max(t1 - t0, 1)) * iw;
    const y = (v) => m.t + ih - (v / vmax) * ih;

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label ?? 'Time-series chart' });
    container.prepend(svg);

    // anomaly bands behind everything
    for (const b of opts.bands ?? []) {
      const bx = x(b.start - HOUR / 2), bw = Math.max(x(b.end + HOUR / 2) - bx, 3);
      el('rect', { x: Math.max(bx, m.l), y: m.t, width: Math.min(bw, m.l + iw - Math.max(bx, m.l)), height: ih, class: 'band-anomaly' }, svg);
    }
    // grid + y axis
    for (let i = 0; i <= 4; i++) {
      const v = (vmax / 4) * i;
      el('line', { x1: m.l, x2: m.l + iw, y1: y(v), y2: y(v), class: i === 0 ? 'axis-base' : 'grid' }, svg);
      const tx = el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg);
      tx.textContent = fmtNum(v);
    }
    if (opts.unit) {
      const u = el('text', { x: m.l + 6, y: m.t + 10, class: 'tick unit' }, svg);
      u.textContent = opts.unit;
    }
    // x ticks: roughly every 90px
    const spanDays = (t1 - t0) / (24 * HOUR);
    const stepDays = Math.max(1, Math.ceil(spanDays / Math.max(iw / 90, 1)));
    const firstDay = Math.ceil(t0 / (24 * HOUR)) * 24 * HOUR;
    if (spanDays > 1.5) {
      for (let t = firstDay; t <= t1; t += stepDays * 24 * HOUR) {
        const tx = el('text', { x: x(t), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, svg);
        tx.textContent = fmtDay(t);
      }
    } else {
      for (let t = Math.ceil(t0 / (6 * HOUR)) * 6 * HOUR; t <= t1; t += 6 * HOUR) {
        const tx = el('text', { x: x(t), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, svg);
        tx.textContent = `${String(new Date(t).getUTCHours()).padStart(2, '0')}:00`;
      }
    }

    // series (break lines on nulls)
    for (const s of opts.series) {
      let d = '';
      let pen = false;
      for (const p of s.points) {
        if (p.v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
        pen = true;
      }
      if (s.area) {
        const pts = s.points.filter((p) => p.v != null);
        if (pts.length) {
          el('path', { d: `${d}L${x(pts.at(-1).t)},${y(0)}L${x(pts[0].t)},${y(0)}Z`, fill: s.color, opacity: 0.08, stroke: 'none' }, svg);
        }
      }
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width ?? 2, 'stroke-dasharray': s.dash ?? '', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    }

    // hover layer
    const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);
    const dots = opts.series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
    const tip = tooltip(container);
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.style.opacity = 0; };
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('mousemove', (evt) => {
      const r = svg.getBoundingClientRect();
      const px = evt.clientX - r.left;
      const t = t0 + ((px - m.l) / iw) * (t1 - t0);
      const ref = opts.series[0].points;
      const idx = nearestIndex(ref, t);
      const tt = ref[idx].t;
      cross.setAttribute('x1', x(tt)); cross.setAttribute('x2', x(tt)); cross.setAttribute('visibility', 'visible');
      let rows = '';
      opts.series.forEach((s, i) => {
        const p = s.points[nearestIndex(s.points, tt)];
        if (!p || p.t !== tt || p.v == null) { dots[i].setAttribute('visibility', 'hidden'); rows += `<div class="tip-row"><span class="sw" style="background:${s.color}"></span>${s.name}<b>${p && p.t === tt ? 'no data' : '–'}</b></div>`; return; }
        dots[i].setAttribute('cx', x(tt)); dots[i].setAttribute('cy', y(p.v)); dots[i].setAttribute('visibility', 'visible');
        rows += `<div class="tip-row"><span class="sw" style="background:${s.color}"></span>${s.name}<b>${fmtNum(p.v)}${opts.unit ? ` ${opts.unit}` : ''}</b></div>`;
      });
      const band = (opts.bands ?? []).find((b) => tt >= b.start && tt <= b.end);
      tip.innerHTML = `<div class="tip-h">${opts.daily ? fmtDay(tt) : fmtHourFull(tt)}</div>${rows}${band ? `<div class="tip-flag">${band.label ?? 'Detected anomaly'}</div>` : ''}`;
      const left = Math.min(Math.max(x(tt) + 12, 0), W - 210);
      tip.style.left = `${x(tt) > W - 230 ? x(tt) - 222 : left}px`;
      tip.style.top = `${m.t + 4}px`;
      tip.style.opacity = 1;
    });
  };
  draw();
  if (!container._ro) {
    container._ro = new ResizeObserver(() => { if (container._lastW !== container.clientWidth) { container._lastW = container.clientWidth; container._draw?.(); } });
    container._ro.observe(container);
  }
  container._draw = draw;
  container._lastW = container.clientWidth;
}

/**
 * Horizontal bar chart. rows: [{label, value, color, note}]
 */
export function barChart(container, { rows, unit = '', max }) {
  const vmax = max ?? niceMax(Math.max(...rows.map((r) => r.value)) * 1.05);
  container.innerHTML = `<div class="bars">${rows.map((r) => `
    <div class="bar-row" tabindex="0" title="${r.label}: ${fmtNum(r.value)} ${unit}${r.note ? ` · ${r.note}` : ''}">
      <div class="bar-label">${r.label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(100 * r.value) / vmax}%;background:${r.color}"></div></div>
      <div class="bar-value">${fmtNum(r.value)} <span>${unit}</span></div>
    </div>`).join('')}</div>`;
}

export function sparkline(values, { width = 120, height = 32, color = 'var(--blue-600)', flagged = [] } = {}) {
  const vs = values.map((v) => v ?? 0);
  const max = Math.max(...vs, 1);
  const step = width / Math.max(vs.length - 1, 1);
  const pts = vs.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`);
  const marks = flagged.map((i) => `<rect x="${(i * step - step / 2).toFixed(1)}" y="0" width="${Math.max(step, 1.5).toFixed(1)}" height="${height}" class="band-anomaly"/>`).join('');
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${marks}<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
