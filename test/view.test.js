import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleLeave, portionOn, monthSpans, fmtDate, fmtNum, barSegments, clampField, mergeMembers, sanitizeBackup, FIELD_KEYS,
} from '../web/view.js';

test('cycleLeave: working -> off -> half -> working', () => {
  let leave = [];
  leave = cycleLeave(leave, '2026-11-03');
  assert.deepEqual(leave, [{ date: '2026-11-03', portion: 1 }]);
  leave = cycleLeave(leave, '2026-11-03');
  assert.deepEqual(leave, [{ date: '2026-11-03', portion: 0.5 }]);
  leave = cycleLeave(leave, '2026-11-03');
  assert.deepEqual(leave, []);
});
test('cycleLeave: leaves other dates alone and does not mutate input', () => {
  const orig = [{ date: '2026-11-02', portion: 1 }];
  const next = cycleLeave(orig, '2026-11-03');
  assert.equal(orig.length, 1);
  assert.deepEqual(next, [{ date: '2026-11-02', portion: 1 }, { date: '2026-11-03', portion: 1 }]);
});
test('cycleLeave: output is sorted by date', () => {
  const next = cycleLeave([{ date: '2026-11-05', portion: 1 }], '2026-11-02');
  assert.deepEqual(next.map((l) => l.date), ['2026-11-02', '2026-11-05']);
});
test('portionOn returns the largest portion for a date, 0 when none', () => {
  assert.equal(portionOn([], '2026-11-03'), 0);
  assert.equal(portionOn([{ date: '2026-11-03', portion: 0.5 }, { date: '2026-11-03', portion: 1 }], '2026-11-03'), 1);
});

test('monthSpans groups consecutive dates by month', () => {
  assert.deepEqual(monthSpans(['2026-11-30', '2026-12-01', '2026-12-02']), [
    { label: 'Nov', span: 1 }, { label: 'Dec', span: 2 },
  ]);
  assert.deepEqual(monthSpans([]), []);
});
test('fmtDate is timezone safe', () => {
  assert.equal(fmtDate('2026-11-02'), 'Mon 2 Nov');
  assert.equal(fmtDate('2026-12-31'), 'Thu 31 Dec');
  assert.equal(fmtDate(''), '');
  assert.equal(fmtDate('2026-11-02', { year: true }), 'Mon 2 Nov 2026');
});
test('fmtNum trims float noise and trailing zeros', () => {
  assert.equal(fmtNum(17.850000000000001), '17.85');
  assert.equal(fmtNum(10), '10');
  assert.equal(fmtNum(0.1 + 0.2), '0.3');
  assert.equal(fmtNum(NaN), '0');
});

test('barSegments: proportional to gross, in fixed / buffer / net order', () => {
  const segs = barSegments({ gross: 40, fixed: 10, bufferPoints: 3, net: 27 });
  assert.deepEqual(segs.map((s) => s.key), ['fixed', 'buffer', 'net']);
  assert.deepEqual(segs.map((s) => s.value), [10, 3, 27]);
  assert.equal(Math.round(segs.reduce((a, s) => a + s.flex, 0) * 1000) / 1000, 1);
});
test('barSegments: fixed larger than gross fills the bar, no negative parts', () => {
  const segs = barSegments({ gross: 10, fixed: 50, bufferPoints: 0, net: 0 });
  assert.deepEqual(segs.map((s) => [s.key, s.value]), [['fixed', 10]]);
});
test('barSegments: zero gross gives no segments; zero-size parts are dropped', () => {
  assert.deepEqual(barSegments({ gross: 0, fixed: 0, bufferPoints: 0, net: 0 }), []);
  assert.deepEqual(barSegments({ gross: 10, fixed: 0, bufferPoints: 0, net: 10 }).map((s) => s.key), ['net']);
});

test('clampField keeps values inside what the server accepts', () => {
  assert.equal(clampField('bufferPct', '150'), 100);
  assert.equal(clampField('bufferPct', '-5'), 0);
  assert.equal(clampField('fixedPoints', ''), 0);
  assert.equal(clampField('fixedPoints', 'abc'), 0);
  assert.equal(clampField('fixedPoints', '12.5'), 12.5);
  assert.equal(clampField('numDays', '14.7'), 14);
  assert.equal(clampField('numDays', '9999'), 366);
  assert.equal(clampField('pointsPerPersonDay', '2000'), 1000);
});

test('mergeMembers keeps ids for people who already exist (case-insensitive)', () => {
  const existing = [{ id: 'keep', name: 'Asha', leave: [] }];
  const merged = mergeMembers(existing, [{ name: 'asha', leave: [{ date: '2026-11-03', portion: 1 }] }, { name: 'Ben', leave: [] }]);
  assert.equal(merged[0].id, 'keep');
  assert.equal(merged[0].name, 'asha');
  assert.ok(merged[1].id && merged[1].id !== 'keep');
  assert.equal(merged.length, 2);
});
test('mergeMembers drops people not in the paste (paste replaces the team)', () => {
  const merged = mergeMembers([{ id: 'x', name: 'Old', leave: [] }], [{ name: 'New', leave: [] }]);
  assert.deepEqual(merged.map((m) => m.name), ['New']);
});

test('sanitizeBackup picks known fields only and rejects non-backups', () => {
  const ok = sanitizeBackup({ version: 1, fields: { sprintName: 'S', evil: 1, fixedPoints: 3 } });
  assert.deepEqual(ok, { sprintName: 'S', fixedPoints: 3 });
  assert.equal(sanitizeBackup(null), null);
  assert.equal(sanitizeBackup({ nope: 1 }), null);
  assert.equal(sanitizeBackup({ fields: {} }), null);
  assert.ok(FIELD_KEYS.includes('members'));
});
