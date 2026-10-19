// Dashboard state: readings, detection results, investigation workflow and tasks.
// Workflow state is kept in this browser's localStorage for the demo; in production it
// lives in the PostgreSQL `investigations` and `inspection_tasks` tables behind the API.

import { SITES, METERS, generateReadings, siteById, meterById, END } from './data.js';
import { detectAll, DEFAULT_CONFIG } from './detector.js';
import { rank, DEFAULT_WEIGHTS } from './priority.js';

const KEY = 'watersentinel.demo.v1';

// Investigation lifecycle. A "verified leak" can only be recorded as the outcome of
// an inspection task; detection alone never moves an anomaly past "detected".
export const STATUSES = {
  detected: { label: 'Detected anomaly', chip: 'alert', open: true },
  reviewing: { label: 'Under review', chip: 'info', open: true },
  inspection_scheduled: { label: 'Inspection scheduled', chip: 'info', open: true },
  verified_leak: { label: 'Verified leak (inspected)', chip: 'alert', open: false },
  no_leak_found: { label: 'No leak found', chip: 'good', open: false },
  explained_operational: { label: 'Explained by operations', chip: 'good', open: false },
  inconclusive: { label: 'Inspection inconclusive', chip: 'muted', open: true },
  dismissed: { label: 'Dismissed (normal variation)', chip: 'muted', open: false },
};

export const OUTCOMES = ['verified_leak', 'no_leak_found', 'explained_operational', 'inconclusive'];

export const TECHNICIANS = [
  { id: 't1', name: 'Marcus Lee', team: 'Plumbing' },
  { id: 't2', name: 'Aisha Bello', team: 'Mechanical' },
  { id: 't3', name: 'Tomás Reyes', team: 'Grounds & irrigation' },
  { id: 't4', name: 'Hannah Cole', team: 'Building services' },
];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? null; } catch { return null; }
}

function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: keep in memory */ }
}

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => fn());

export const state = {
  readings: generateReadings(),
  config: { ...DEFAULT_CONFIG },
  weights: { ...DEFAULT_WEIGHTS },
  scoredByMeter: new Map(),
  alerts: [],
  workflow: { investigations: {}, tasks: [], seeded: false },
};

export function runDetection() {
  const { scoredByMeter, events } = detectAll(state.readings, state.config);
  state.scoredByMeter = scoredByMeter;
  state.alerts = rank(events, (ev) => siteById(meterById(ev.meterId).siteId), state.weights);
  for (const a of state.alerts) {
    a.meter = meterById(a.meterId);
    a.site = siteById(a.meter.siteId);
  }
}

export function persist() {
  save({ workflow: state.workflow, config: state.config, weights: state.weights });
  emit();
}

function seedWorkflow() {
  // Seed a realistic in-flight history so the workspace is not empty on first visit.
  const irrigation = state.alerts.filter((a) => a.meterId === 'RC-M02').sort((a, b) => a.start - b.start);
  const cooling = state.alerts.find((a) => a.meterId === 'HP-M02' && a.spanHours >= 4);
  const day = 24 * 3600 * 1000;
  if (irrigation[0]) {
    state.workflow.investigations[irrigation[0].id] = {
      status: 'explained_operational',
      notes: [{ at: irrigation[0].end + day, by: 'Sam Whitfield', text: 'Controller log shows a manual run started by the landscaping contractor.' }],
    };
    state.workflow.tasks.push({
      id: 'TSK-1001', alertId: irrigation[0].id, title: 'Check irrigation controller log', assignee: 't3',
      due: irrigation[0].end + 2 * day, state: 'completed', outcome: 'explained_operational',
      outcomeNote: 'Manual run by contractor during new planting. Controller schedule unchanged.', createdAt: irrigation[0].end + day,
    });
  }
  if (cooling) {
    state.workflow.investigations[cooling.id] = {
      status: 'inspection_scheduled',
      notes: [{ at: cooling.end + day, by: 'Dana Okafor', text: 'No blowdown logged in BMS for that afternoon. Asked mechanical to inspect make-up valve and basin overflow.' }],
    };
    state.workflow.tasks.push({
      id: 'TSK-1002', alertId: cooling.id, title: 'Inspect cooling tower make-up valve and overflow', assignee: 't2',
      due: END + 2 * day, state: 'in_progress', createdAt: cooling.end + day,
    });
  }
  state.workflow.seeded = true;
}

export function init() {
  const saved = load();
  if (saved) {
    Object.assign(state.config, saved.config ?? {});
    Object.assign(state.weights, saved.weights ?? {});
    state.workflow = saved.workflow ?? state.workflow;
  }
  runDetection();
  if (!state.workflow.seeded) { seedWorkflow(); save({ workflow: state.workflow, config: state.config, weights: state.weights }); }
}

export function resetDemo() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  state.config = { ...DEFAULT_CONFIG };
  state.weights = { ...DEFAULT_WEIGHTS };
  state.workflow = { investigations: {}, tasks: [], seeded: false };
  runDetection();
  seedWorkflow();
  persist();
}

export const investigationOf = (id) => state.workflow.investigations[id] ?? { status: 'detected', notes: [] };
export const statusOf = (id) => investigationOf(id).status;
export const isOpen = (id) => STATUSES[statusOf(id)].open;

export function setStatus(id, status, note, by = 'You') {
  const inv = { ...investigationOf(id) };
  inv.status = status;
  inv.notes = [...(inv.notes ?? [])];
  if (note) inv.notes.push({ at: Date.now(), by, text: note });
  state.workflow.investigations[id] = inv;
  persist();
}

export function addNote(id, text, by = 'You') {
  const inv = { ...investigationOf(id) };
  inv.notes = [...(inv.notes ?? []), { at: Date.now(), by, text }];
  state.workflow.investigations[id] = inv;
  persist();
}

export function createTask({ alertId, title, assignee, due }) {
  const n = 1000 + state.workflow.tasks.length + 1;
  const task = { id: `TSK-${n}`, alertId, title, assignee, due, state: 'open', createdAt: Date.now() };
  state.workflow.tasks.push(task);
  if (['detected', 'reviewing', 'inconclusive'].includes(statusOf(alertId))) {
    setStatus(alertId, 'inspection_scheduled', `Inspection task ${task.id} created: ${title}`);
  } else persist();
  return task;
}

export function updateTask(id, patch) {
  const t = state.workflow.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  if (patch.outcome) {
    t.state = 'completed';
    setStatus(t.alertId, patch.outcome, `Inspection ${t.id} outcome: ${STATUSES[patch.outcome].label}. ${patch.outcomeNote ?? ''}`.trim());
  } else persist();
}

export { SITES, METERS, siteById, meterById };
