// WaterSentinel demo dataset.
// Every site, meter and reading in this file is FICTIONAL and generated
// deterministically from a seed. No live meters are connected to the demo.

export const DEMO_NOTICE =
  'Demo environment: fictional sites and simulated hourly readings. No live meters are connected.';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
export const DAYS = 56;
// Times are stored as UTC milliseconds and displayed as "site local time".
export const END = Date.UTC(2026, 9, 17, 23); // 17 Oct 2026, 23:00
export const START = END - (DAYS * 24 - 1) * HOUR;

export const SITES = [
  {
    id: 'HP', name: 'Harbor Point Medical Center', type: 'Healthcare', city: 'Port Alder',
    areaM2: 42000, occupants: 1800, criticality: 1.0, manager: 'Dana Okafor',
  },
  {
    id: 'RC', name: 'Riverside Commerce Park', type: 'Office campus', city: 'Millbrook',
    areaM2: 28000, occupants: 1400, criticality: 0.6, manager: 'Sam Whitfield',
  },
  {
    id: 'NG', name: 'Northgate Logistics Hub', type: 'Warehouse & distribution', city: 'Ferris Junction',
    areaM2: 60000, occupants: 320, criticality: 0.5, manager: 'Priya Raman',
  },
  {
    id: 'LV', name: 'Lakeview Residences', type: 'Multifamily residential', city: 'Port Alder',
    areaM2: 18000, occupants: 650, criticality: 0.7, manager: 'Jordan Ellis',
  },
];

// profile: shape of normal hourly demand. serial numbers are invented.
export const METERS = [
  { id: 'HP-M01', siteId: 'HP', name: 'Main incoming supply', serial: 'WS-DEMO-10411', sizeMm: 100, profile: 'hospital', register0: 8_412_300 },
  { id: 'HP-M02', siteId: 'HP', name: 'Cooling tower make-up', serial: 'WS-DEMO-10412', sizeMm: 50, profile: 'cooling', register0: 3_120_950 },
  { id: 'HP-M03', siteId: 'HP', name: 'East wing sub-meter', serial: 'WS-DEMO-10413', sizeMm: 40, profile: 'clinical', register0: 1_204_110 },
  { id: 'RC-M01', siteId: 'RC', name: 'Main incoming supply', serial: 'WS-DEMO-20107', sizeMm: 80, profile: 'office', register0: 2_877_420 },
  { id: 'RC-M02', siteId: 'RC', name: 'Landscape irrigation', serial: 'WS-DEMO-20108', sizeMm: 40, profile: 'irrigation', register0: 690_210 },
  { id: 'NG-M01', siteId: 'NG', name: 'Main incoming supply', serial: 'WS-DEMO-30022', sizeMm: 80, profile: 'warehouse', register0: 1_955_800 },
  { id: 'NG-M02', siteId: 'NG', name: 'Vehicle wash bay', serial: 'WS-DEMO-30023', sizeMm: 40, profile: 'washbay', register0: 402_330 },
  { id: 'LV-M01', siteId: 'LV', name: 'Main incoming supply', serial: 'WS-DEMO-40501', sizeMm: 80, profile: 'residential', register0: 3_388_040 },
  { id: 'LV-M02', siteId: 'LV', name: 'Pool & amenities', serial: 'WS-DEMO-40502', sizeMm: 40, profile: 'pool', register0: 515_660 },
];

// Deterministic PRNG so every visitor sees the same story.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const bump = (h, center, width) => Math.exp(-((h - center) ** 2) / (2 * width ** 2));

// Normal expected litres per hour for a profile at a given hour / weekday.
function profileLph(profile, h, dow) {
  const weekend = dow === 0 || dow === 6;
  switch (profile) {
    case 'hospital':
      return 1500 + 900 * bump(h, 10, 3) + 700 * bump(h, 18, 3) - (weekend ? 150 : 0);
    case 'cooling':
      return 650 + 950 * bump(h, 15, 4);
    case 'clinical':
      return 160 + 520 * bump(h, 11, 3.5) * (weekend ? 0.6 : 1);
    case 'office':
      return weekend ? 140 + 120 * bump(h, 12, 3) : 120 + 1300 * bump(h, 12, 3.2) + 300 * bump(h, 9, 1);
    case 'irrigation':
      // Controller schedule: Mon / Wed / Fri, 04:00-05:59.
      return [1, 3, 5].includes(dow) && (h === 4 || h === 5) ? 2400 : 0;
    case 'warehouse':
      return (weekend ? 110 : 160) + (weekend ? 180 : 620) * bump(h, 13, 4);
    case 'washbay':
      return !weekend && h >= 7 && h <= 16 ? 380 + 160 * bump(h, 11, 2) : 4;
    case 'residential':
      return 150 + 700 * bump(h, 7.5, 1.6) + 900 * bump(h, 19.5, 2.2) + 250 * bump(h, 13, 3) + (weekend ? 120 * bump(h, 10, 2) : 0);
    case 'pool':
      return 90 + 160 * bump(h, 15, 3) + (h === 6 ? 450 : 0);
    default:
      return 100;
  }
}

// Scenario events injected into the simulated readings so the detector has
// something to find. Labels are for the README / tests; the app never shows
// them as ground truth.
export const SCENARIO = [
  { meterId: 'LV-M01', fromDay: 50, fromHour: 1, toDay: DAYS - 1, toHour: 23, addLph: 380,
    note: 'Continuous added flow from 01:00 on day 50, still present at end of data.' },
  { meterId: 'RC-M02', days: [36, 43, 49], fromHour: 13, toHour: 14, addLph: 1800,
    note: 'Unscheduled midday irrigation-meter flow on three separate days.' },
  { meterId: 'HP-M02', fromDay: 47, fromHour: 10, toDay: 47, toHour: 14, addLph: 2600,
    note: 'Five-hour make-up surge on the cooling tower meter.' },
  { meterId: 'NG-M02', fromDay: 53, fromHour: 3, toDay: 53, toHour: 3, addLph: 900,
    note: 'Single overnight hour of wash-bay flow.' },
  { meterId: 'NG-M01', gapDay: 40, fromHour: 6, toHour: 11,
    note: 'Telemetry gap: six hourly readings missing.' },
];

function scenarioAdjust(meterId, day, h) {
  let add = 0;
  let missing = false;
  for (const s of SCENARIO) {
    if (s.meterId !== meterId) continue;
    if (s.gapDay !== undefined) {
      if (day === s.gapDay && h >= s.fromHour && h <= s.toHour) missing = true;
    } else if (s.days) {
      if (s.days.includes(day) && h >= s.fromHour && h <= s.toHour) add += s.addLph;
    } else {
      const idx = day * 24 + h;
      if (idx >= s.fromDay * 24 + s.fromHour && idx <= s.toDay * 24 + s.toHour) add += s.addLph;
    }
  }
  return { add, missing };
}

/**
 * Build hourly interval readings for every meter.
 * Returns Map<meterId, Array<{t, v}>> where v is litres in the hour (null = missing).
 */
export function generateReadings(seed = 20261017) {
  const rand = mulberry32(seed);
  const out = new Map();
  for (const m of METERS) {
    const series = [];
    // Slow drift (weather, occupancy) shared across the series.
    let drift = 0;
    for (let i = 0; i < DAYS * 24; i++) {
      const t = START + i * HOUR;
      const d = new Date(t);
      const h = d.getUTCHours();
      const dow = d.getUTCDay();
      const day = Math.floor(i / 24);
      if (h === 0) drift = drift * 0.7 + gaussian(rand) * 0.025;
      const { add, missing } = scenarioAdjust(m.id, day, h);
      const base = profileLph(m.profile, h, dow);
      const noise = 1 + drift + gaussian(rand) * 0.07;
      let v = Math.max(0, base * noise) + add;
      if (base < 10 && add === 0) v = Math.max(0, base + gaussian(rand) * 2);
      series.push({ t, v: missing ? null : Math.round(v) });
    }
    out.set(m.id, series);
  }
  return out;
}

/** Cumulative register value (m³) at the end of the series, as a meter display would show. */
export function registerReading(meter, series) {
  const litres = series.reduce((sum, r) => sum + (r.v ?? 0), 0);
  return meter.register0 + litres / 1000;
}

export const siteById = (id) => SITES.find((s) => s.id === id);
export const meterById = (id) => METERS.find((m) => m.id === id);
export { HOUR, DAY };
