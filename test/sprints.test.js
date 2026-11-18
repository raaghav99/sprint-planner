import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, sprintDatesFor, currentSprint, sprintNumbers, spillInFor, fixedTotal, flatInput, overview, DEFAULT_BASE,
} from '../web/sprints.js';

const base = { number: 14, startDate: '2026-11-09', length: 14 };
const st = (over = {}) => ({
  sprintBase: base, sprints: {}, weekendDays: [0, 6], holidays: [], members: [],
  pointsPerPersonDay: 1, bufferPct: 0, ...over,
});
const m = (id, over = {}) => ({ id, name: id, leave: [], ...over });

test('addDays crosses month, year and leap day', () => {
  assert.equal(addDays('2026-11-09', 14), '2026-11-23');
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-11-09', -14), '2026-10-26');
});

test('sprint dates are generated back to back from the anchor sprint', () => {
  const d = (n) => { const w = sprintDatesFor(st(), n); return [w.start, w.end]; };
  assert.deepEqual(d(14), ['2026-11-09', '2026-11-22']);
  assert.deepEqual(d(15), ['2026-11-23', '2026-12-06']);
  assert.deepEqual(d(13), ['2026-10-26', '2026-11-08']);
  assert.deepEqual(d(11), ['2026-09-28', '2026-10-11']);
  assert.equal(sprintDatesFor(st(), 14).dates.length, 14);
});

test('a sprint can override its own start and end', () => {
  const s = st({ sprints: { 15: { startDate: '2026-11-23', endDate: '2026-12-11' } } });
  const w = sprintDatesFor(s, 15);
  assert.equal(w.end, '2026-12-11');
  assert.equal(w.dates.length, 19);
  assert.equal(sprintDatesFor(s, 14).end, '2026-11-22'); // others unaffected
});

test('no anchor start date means no sprint dates', () => {
  assert.equal(sprintDatesFor(st({ sprintBase: DEFAULT_BASE }), 1), null);
});

test('current sprint follows today, rolling forward on its own', () => {
  const cur = (today) => currentSprint(st(), today);
  assert.equal(cur('2026-11-09'), 14);
  assert.equal(cur('2026-11-18'), 14);
  assert.equal(cur('2026-11-22'), 14);
  assert.equal(cur('2026-11-23'), 15);
  assert.equal(cur('2026-11-08'), 13);
  assert.equal(cur('2027-03-01'), 14 + Math.floor(112 / 14));
  assert.equal(currentSprint(st({ sprintBase: DEFAULT_BASE }), '2026-11-18'), null);
});

test('sprint list is 3 before, current, 3 after, never below sprint 1', () => {
  assert.deepEqual(sprintNumbers(st(), '2026-11-18'), [11, 12, 13, 14, 15, 16, 17]);
  const early = st({ sprintBase: { number: 2, startDate: '2026-11-09', length: 14 } });
  assert.deepEqual(sprintNumbers(early, '2026-11-18'), [1, 2, 3, 4, 5]);
});

test('spillover in comes from the previous sprint spillover out, unless overridden', () => {
  const s = st({ sprints: { 13: { spillOut: 6 }, 14: {}, 15: { spillOut: 3, spillIn: 0 }, 16: {} } });
  assert.equal(spillInFor(s, 14), 6);
  assert.equal(spillInFor(s, 13), 0);
  assert.equal(spillInFor(s, 15), 0); // not set -> prev (14) spillOut is 0
  assert.equal(spillInFor(st({ sprints: { 14: { spillOut: 5 }, 15: { spillIn: 0 } } }), 15), 0); // explicit 0 wins
  assert.equal(spillInFor(st({ sprints: { 14: { spillOut: 5 }, 15: { spillIn: 2 } } }), 15), 2);
  assert.equal(spillInFor(s, 16), 3);
});

test('fixed total adds up the fixed items and ignores junk', () => {
  assert.equal(fixedTotal({ fixedItems: [{ points: 3 }, { points: 2.5 }] }), 5.5);
  assert.equal(fixedTotal({}), 0);
  assert.equal(fixedTotal(undefined), 0);
  assert.equal(fixedTotal({ fixedItems: [{ points: -4 }, { points: 'x' }] }), 0);
});

test('flatInput maps one sprint onto the capacity calculator input', () => {
  const s = st({
    members: [m('a')], bufferPct: 10, pointsPerPersonDay: 2,
    sprints: { 13: { spillOut: 4 }, 14: { fixedItems: [{ id: 'x', label: 'Support', points: 6 }] } },
  });
  const f = flatInput(s, 14);
  assert.equal(f.startDate, '2026-11-09');
  assert.equal(f.endDate, '2026-11-22');
  assert.equal(f.dateMode, 'range');
  assert.equal(f.fixedPoints, 6);
  assert.equal(f.spillPoints, 4);
  assert.equal(f.bufferPct, 10);
  assert.equal(f.pointsPerPersonDay, 2);
  assert.equal(f.members.length, 1);
});

test('overview lists 7 sprints with capacity, flags the current one and shows active people', () => {
  const s = st({
    members: [m('a'), m('b', { until: '2026-11-08' }), m('c', { from: '2026-11-23' })],
    sprints: { 14: { fixedItems: [{ id: 'x', label: 'S', points: 2 }], spillOut: 1 } },
  });
  const rows = overview(s, '2026-11-18');
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((r) => r.number), [11, 12, 13, 14, 15, 16, 17]);
  const r14 = rows.find((r) => r.number === 14);
  assert.equal(r14.isCurrent, true);
  assert.equal(r14.activeMembers, 1); // only a: b left, c not joined yet
  assert.equal(r14.gross, 10);
  assert.equal(r14.fixed, 2);
  assert.equal(r14.net, 8);
  const r15 = rows.find((r) => r.number === 15);
  assert.equal(r15.spillIn, 1);
  assert.equal(r15.activeMembers, 2); // a and c
  assert.equal(r15.net, 19);
  assert.equal(rows.find((r) => r.number === 13).activeMembers, 2); // a and b
  assert.equal(rows.filter((r) => r.isCurrent).length, 1);
});

test('overview is empty until the anchor sprint has a start date', () => {
  assert.deepEqual(overview(st({ sprintBase: DEFAULT_BASE }), '2026-11-18'), []);
});

// ---------- dayCapacity (today view) ----------
import { dayCapacity } from '../web/sprints.js';

const dayState = {
  weekendDays: [0, 6], holidays: ['2026-11-12'], pointsPerPersonDay: 2,
  members: [
    { id: 'a', name: 'Asha', leave: [] },
    { id: 'b', name: 'Ben', leave: [{ date: '2026-11-18', portion: 1 }] },
    { id: 'c', name: 'Cy', leave: [{ date: '2026-11-18', portion: 0.5 }] },
    { id: 'd', name: 'Di', from: '2026-11-20', leave: [] },
    { id: 'e', name: 'Eli', until: '2026-11-17', leave: [] },
  ],
};

test('dayCapacity counts people on the team that day and lists who is on leave', () => {
  const d = dayCapacity(dayState, '2026-11-18');
  assert.equal(d.working, true);
  assert.equal(d.team, 3); // Asha, Ben, Cy (Di not joined, Eli left)
  assert.equal(d.available, 1 + 0 + 0.5);
  assert.equal(d.points, 3);
  assert.deepEqual(d.onLeave, [{ name: 'Ben', portion: 1 }, { name: 'Cy', portion: 0.5 }]);
});

test('dayCapacity: weekends and holidays are not working days', () => {
  assert.deepEqual([dayCapacity(dayState, '2026-11-14').working, dayCapacity(dayState, '2026-11-14').reason], [false, 'weekend']);
  assert.equal(dayCapacity(dayState, '2026-11-12').reason, 'holiday');
  assert.equal(dayCapacity(dayState, '2026-11-12').available, 0);
});

test('dayCapacity: joined and last day limit who counts', () => {
  assert.equal(dayCapacity(dayState, '2026-11-20').team, 4); // Asha, Ben, Cy, Di (Eli gone)
  assert.equal(dayCapacity(dayState, '2026-11-16').team, 4); // Asha, Ben, Cy, Eli
});

test('dayCapacity: bad date and empty team do not throw', () => {
  assert.equal(dayCapacity(dayState, 'nope').working, false);
  assert.equal(dayCapacity({}, '2026-11-18').team, 0);
});

// ---------- sprintProgress (days left) ----------
import { sprintProgress } from '../web/sprints.js';

const prog = { sprintBase: { number: 14, startDate: '2026-11-09', length: 14 }, weekendDays: [0, 6], holidays: [] };

test('sprintProgress: current sprint counts working days left, today included', () => {
  const p = sprintProgress(prog, 14, '2026-11-18'); // Wed; ends Sun 22
  assert.deepEqual([p.status, p.workingLeft, p.endsIn], ['current', 3, 4]);
});

test('sprintProgress: first day, last day, and holidays', () => {
  assert.equal(sprintProgress(prog, 14, '2026-11-09').workingLeft, 10);
  const last = sprintProgress(prog, 14, '2026-11-22');
  assert.deepEqual([last.workingLeft, last.endsIn], [0, 0]); // a Sunday
  assert.equal(sprintProgress({ ...prog, holidays: ['2026-11-19'] }, 14, '2026-11-18').workingLeft, 2);
});

test('sprintProgress: upcoming and past sprints', () => {
  assert.deepEqual(sprintProgress(prog, 15, '2026-11-18'), { status: 'upcoming', startsIn: 5 });
  assert.deepEqual(sprintProgress(prog, 13, '2026-11-18'), { status: 'past', endedAgo: 10 });
});

test('sprintProgress: no anchor or bad date gives null', () => {
  assert.equal(sprintProgress({}, 14, '2026-11-18'), null);
  assert.equal(sprintProgress(prog, 14, 'x'), null);
});
