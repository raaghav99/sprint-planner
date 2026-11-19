import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleLeave, portionOn, monthSpans, fmtDate, fmtNum, barSegments, clampField, applyPaste, sanitizeBackup, FIELD_KEYS,
  summarizeLeave, makeFixedItem,
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


test('barSegments: spillover is its own segment between fixed and buffer', () => {
  const segs = barSegments({ gross: 40, fixed: 10, spill: 5, bufferPoints: 3, net: 22 });
  assert.deepEqual(segs.map((s) => s.key), ['fixed', 'spill', 'buffer', 'net']);
  assert.equal(Math.round(segs.reduce((a, s) => a + s.flex, 0) * 1000) / 1000, 1);
});
test('barSegments: fixed and spill together larger than gross are cut to fit', () => {
  const segs = barSegments({ gross: 10, fixed: 8, spill: 8, bufferPoints: 0, net: 0 });
  assert.deepEqual(segs.map((s) => [s.key, s.value]), [['fixed', 8], ['spill', 2]]);
});

test('clampField keeps values inside what the server accepts', () => {
  assert.equal(clampField('bufferPct', '150'), 100);
  assert.equal(clampField('bufferPct', '-5'), 0);
  assert.equal(clampField('points', ''), 0);
  assert.equal(clampField('points', 'abc'), 0);
  assert.equal(clampField('points', '12.5'), 12.5);
  assert.equal(clampField('points', '999999'), 100000);
  assert.equal(clampField('spill', '3,5'), 3.5);
  assert.equal(clampField('length', '14.7'), 14);
  assert.equal(clampField('length', '0'), 1);
  assert.equal(clampField('length', '999'), 60);
  assert.equal(clampField('number', '0'), 1);
  assert.equal(clampField('pointsPerPersonDay', '2000'), 1000);
});

const d = (day) => `2026-11-${String(day).padStart(2, '0')}`;
const L = (...days) => days.map((x) => ({ date: d(x), portion: 1 }));

test('applyPaste: updates people in the paste, keeps ids, joined and left dates', () => {
  const existing = [{ id: 'keep', name: 'Asha', leave: L(2), from: '2026-01-01', until: '' }];
  const parsed = { members: [{ name: 'asha', leave: L(3) }], columns: [d(2), d(3), d(4)] };
  const out = applyPaste(existing, parsed);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'keep');
  assert.equal(out[0].from, '2026-01-01');
  assert.deepEqual(out[0].leave, L(3)); // old leave on pasted dates replaced
});

test('applyPaste: leave on dates the paste does not cover is kept', () => {
  const existing = [{ id: 'a', name: 'Asha', leave: L(2, 20), from: '', until: '' }];
  const out = applyPaste(existing, { members: [{ name: 'Asha', leave: [] }], columns: [d(2), d(3)] });
  assert.deepEqual(out[0].leave, L(20));
});

test('applyPaste: new people are added with an id', () => {
  const out = applyPaste([], { members: [{ name: 'Ben', leave: L(3) }], columns: [d(3)] });
  assert.equal(out.length, 1);
  assert.ok(out[0].id);
  assert.equal(out[0].name, 'Ben');
});

test('applyPaste: people missing from the paste keep their history, and are off for the pasted dates', () => {
  const existing = [
    { id: 'a', name: 'Asha', leave: [], from: '', until: '' },
    { id: 'z', name: 'Zed', leave: L(20), from: '', until: '' },
  ];
  const parsed = { members: [{ name: 'Asha', leave: [] }], columns: [d(2), d(3)] };
  const out = applyPaste(existing, parsed, { markOthersOff: true });
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].leave, [...L(2, 3), ...L(20)]);
  const kept = applyPaste(existing, parsed, { markOthersOff: false });
  assert.deepEqual(kept[1].leave, L(20));
});

test('summarizeLeave lists only leave on the given days, in order', () => {
  const leave = [{ date: d(5), portion: 0.5 }, { date: d(2), portion: 1 }, { date: d(30), portion: 1 }];
  assert.deepEqual(summarizeLeave(leave, [d(2), d(3), d(5)]), [{ date: d(2), portion: 1 }, { date: d(5), portion: 0.5 }]);
  assert.deepEqual(summarizeLeave([], [d(2)]), []);
});

test('makeFixedItem gives each item an id and clean values', () => {
  const a = makeFixedItem('  Support  ', 3);
  const b = makeFixedItem('x', 1);
  assert.equal(a.label, 'Support');
  assert.equal(a.points, 3);
  assert.notEqual(a.id, b.id);
});

test('sanitizeBackup picks known fields only and rejects non-backups', () => {
  const ok = sanitizeBackup({ version: 2, fields: { bufferPct: 5, evil: 1, sprintBase: { number: 3, startDate: '2026-11-02', length: 14 } } });
  assert.equal(ok.bufferPct, 5);
  assert.equal('evil' in ok, false);
  assert.equal(ok.sprintBase.number, 3);
  assert.equal(sanitizeBackup(null), null);
  assert.equal(sanitizeBackup({ nope: 1 }), null);
  assert.equal(sanitizeBackup({ fields: {} }), null);
  assert.ok(FIELD_KEYS.includes('members') && FIELD_KEYS.includes('sprints') && FIELD_KEYS.includes('sprintBase'));
});

test('sanitizeBackup converts a version 1 backup (single sprint) to the new shape', () => {
  const ok = sanitizeBackup({
    version: 1,
    fields: { sprintName: 'Sprint 9', dateMode: 'range', startDate: '2026-11-02', endDate: '2026-11-15', fixedPoints: 5, bufferPct: 10, members: [], holidays: [], weekendDays: [0, 6], pointsPerPersonDay: 1, numDays: 14 },
  });
  assert.equal(ok.sprintBase.number, 9);
  assert.equal(ok.sprintBase.length, 14);
  assert.equal(ok.sprints[9].fixedItems[0].points, 5);
  assert.equal('fixedPoints' in ok, false);
});

test('fmtShort gives day and month', async () => {
  const { fmtShort } = await import('../web/view.js');
  assert.equal(fmtShort('2026-11-09'), '9 Nov');
  assert.equal(fmtShort('2026-12-31'), '31 Dec');
  assert.equal(fmtShort(''), '');
});

test('replaceSprints: restoring a backup removes sprints that are not in it', async () => {
  const { replaceSprints } = await import('../web/view.js');
  const current = { 10: { spillOut: 1 }, 11: { spillOut: 2 } };
  const incoming = { 11: { spillOut: 5 }, 12: { spillOut: 6 } };
  assert.deepEqual(replaceSprints(current, incoming), { 10: null, 11: { spillOut: 5 }, 12: { spillOut: 6 } });
  assert.deepEqual(replaceSprints({}, {}), {});
  assert.deepEqual(replaceSprints(undefined, { 1: { spillOut: 1 } }), { 1: { spillOut: 1 } });
});

// ---------- fixedName (custom title of the fixed points section) ----------
import { fixedName, DEFAULT_FIXED_LABEL } from '../web/view.js';

test('fixedName: default when empty, missing or blank', () => {
  assert.equal(DEFAULT_FIXED_LABEL, 'Fixed story points');
  for (const s of [{}, null, { fixedLabel: '' }, { fixedLabel: '   ' }, { fixedLabel: 5 }]) assert.equal(fixedName(s), 'Fixed story points');
});

test('fixedName: the alias replaces the default name', () => {
  assert.equal(fixedName({ fixedLabel: '  RCA ' }), 'RCA');
  assert.equal(fixedName({ fixedLabel: '(RCA)' }), 'RCA');
});

test('backups include the custom name', () => {
  assert.ok(FIELD_KEYS.includes('fixedLabel'));
  const out = sanitizeBackup({ version: 2, fields: { sprintBase: { number: 1, startDate: '', length: 14 }, fixedLabel: 'RCA' } });
  assert.equal(out.fixedLabel, 'RCA');
});

import { swapFixed } from '../web/view.js';
test('swapFixed: replaces every mention of fixed points with the alias', () => {
  const s = { fixedLabel: 'RCA' };
  assert.equal(swapFixed('Fixed points (3) and spillover (1)', s), 'RCA (3) and spillover (1)');
  assert.equal(swapFixed('minus fixed story points and Fixed Story Points', s), 'minus RCA and RCA');
});
test('swapFixed: no alias leaves the text alone', () => {
  assert.equal(swapFixed('Fixed points (3)', {}), 'Fixed points (3)');
  assert.equal(swapFixed('Fixed points (3)', { fixedLabel: '  ' }), 'Fixed points (3)');
});
