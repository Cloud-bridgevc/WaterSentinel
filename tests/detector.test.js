// Browser-module tests (Node's built-in runner): node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReadings, SCENARIO } from '../web/js/data.js';
import { detectAll, DEFAULT_CONFIG } from '../web/js/detector.js';
import { rank } from '../web/js/priority.js';
import { buildEvidence, writeBrief, violatesEvidencePolicy } from '../web/js/assistant.js';
import { SITES, METERS } from '../web/js/data.js';

const readings = generateReadings();
const { events, scoredByMeter } = detectAll(readings);
const siteOf = (ev) => SITES.find((s) => s.id === METERS.find((m) => m.id === ev.meterId).siteId);

test('demo data is deterministic', () => {
  assert.deepEqual(generateReadings().get('LV-M01').slice(-5), readings.get('LV-M01').slice(-5));
});

test('every injected scenario (except the data gap) is detected', () => {
  for (const s of SCENARIO.filter((x) => x.gapDay === undefined)) {
    assert.ok(events.some((e) => e.meterId === s.meterId), `missed scenario on ${s.meterId}`);
  }
});

test('scheduled irrigation runs are not flagged', () => {
  const irrigation = events.filter((e) => e.meterId === 'RC-M02');
  assert.ok(irrigation.every((e) => new Date(e.start).getUTCHours() === 13), 'only the unscheduled 13:00 runs');
  assert.equal(irrigation.length, 3);
  assert.equal(irrigation[2].recurrence, 2);
});

test('sustained overnight event ranks first', () => {
  const ranked = rank(events, siteOf);
  assert.equal(ranked[0].meterId, 'LV-M01');
  assert.equal(ranked[0].pattern, 'Sustained elevated flow, including overnight');
  assert.equal(ranked[0].band.key, 'p1');
  assert.ok(ranked[0].ongoing);
});

test('briefs never claim a confirmed leak and always state the distinction', () => {
  for (const ev of events) {
    const meter = METERS.find((m) => m.id === ev.meterId);
    const evidence = buildEvidence(ev, { site: siteOf(ev), meter, series: readings.get(ev.meterId), scored: scoredByMeter.get(ev.meterId), config: DEFAULT_CONFIG });
    const brief = writeBrief(evidence, meter);
    assert.ok(!violatesEvidencePolicy(JSON.stringify(brief)));
    assert.match(brief.summary, /not a confirmed leak/);
    assert.ok(brief.possible_explanations.length >= 3);
  }
});

test('policy check catches confirmation language', () => {
  assert.ok(violatesEvidencePolicy('Leak has been confirmed at the riser'.replace('Leak', 'leak')));
  assert.ok(violatesEvidencePolicy('This is a confirmed leak.'));
  assert.ok(!violatesEvidencePolicy('This is not a confirmed leak.'));
});
