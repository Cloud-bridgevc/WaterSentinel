// The browser detector (web/js) and the Lambda detector (backend/) must find the same events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateReadings } from '../web/js/data.js';
import { detectAll } from '../web/js/detector.js';

const backend = fileURLToPath(new URL('../backend', import.meta.url));

test('JS and Python detectors agree on the demo dataset', () => {
  const readings = generateReadings();
  const js = detectAll(readings).events.map((e) => [`${e.id}|${e.spanHours}|${e.flaggedHours}`, e.excessLitres]).sort((a, b) => a[0].localeCompare(b[0]));
  const payload = JSON.stringify(Object.fromEntries([...readings].map(([k, v]) => [k, v.map((r) => [r.t / 1000, r.v])])));
  const py = execFileSync('python3', ['-c', `
import json, sys
from watersentinel.detector import Reading, detect
data = json.load(sys.stdin)
out = []
for meter, rows in data.items():
    _, events = detect(meter, [Reading(int(t), v) for t, v in rows])
    out += [[f"{e.event_id}|{e.span_hours}|{e.flagged_hours}", e.excess_litres] for e in events]
print(json.dumps(sorted(out)))
`], { cwd: backend, input: payload }).toString();
  const pyEvents = JSON.parse(py);
  assert.deepEqual(pyEvents.map((e) => e[0]), js.map((e) => e[0]));
  pyEvents.forEach((e, i) => assert.ok(Math.abs(e[1] - js[i][1]) < 1, `excess differs for ${e[0]}`));
});
