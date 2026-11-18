import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintDates, workingDays, computeCapacity } from '../web/capacity.js';

const base = {
  dateMode: 'range', startDate: '2026-11-02', endDate: '2026-11-13', numDays: 0,
  weekendDays: [0, 6], holidays: [], members: [],
  pointsPerPersonDay: 1, fixedPoints: 0, bufferPct: 0,
};
const m = (id, leave = []) => ({ id, name: id, leave });

test('range mode lists every calendar day inclusive', () => {
  const r = sprintDates(base);
  assert.equal(r.dates.length, 12);
  assert.equal(r.start, '2026-11-02');
  assert.equal(r.end, '2026-11-13');
  assert.equal(r.numDays, 12);
});

test('days mode derives end date from start + numDays - 1', () => {
  const r = sprintDates({ ...base, dateMode: 'days', numDays: 14, endDate: '' });
  assert.equal(r.end, '2026-11-15');
  assert.equal(r.dates.length, 14);
});

test('days mode crosses month and year boundary and leap day', () => {
  assert.equal(sprintDates({ ...base, dateMode: 'days', startDate: '2026-12-28', numDays: 7 }).end, '2027-01-03');
  assert.equal(sprintDates({ ...base, dateMode: 'days', startDate: '2028-02-27', numDays: 3 }).end, '2028-02-29');
});

test('invalid or reversed range yields empty dates', () => {
  assert.equal(sprintDates({ ...base, endDate: '2026-11-01' }).dates.length, 0);
  assert.equal(sprintDates({ ...base, startDate: '' }).dates.length, 0);
  assert.equal(sprintDates({ ...base, dateMode: 'days', numDays: 0 }).dates.length, 0);
});

test('working days exclude weekends', () => {
  assert.equal(workingDays(base).length, 10);
});

test('working days exclude holidays, ignoring holidays on weekends or outside sprint', () => {
  const s = { ...base, holidays: ['2026-11-09', '2026-11-10', '2026-11-08', '2027-01-01'] };
  assert.equal(workingDays(s).length, 8);
});

test('custom weekend days (e.g. Fri/Sat)', () => {
  const s = { ...base, weekendDays: [5, 6] };
  assert.equal(workingDays(s).length, 9); // Nov 6, 7, 13 are Fri/Sat/Fri
  assert.ok(workingDays(s).includes('2026-11-08')); // Sunday works
});

test('no members: zero capacity, no crash', () => {
  const c = computeCapacity(base);
  assert.equal(c.workingDays, 10);
  assert.equal(c.personDays, 0);
  assert.equal(c.net, 0);
});

test('person-days = members x working days minus leave', () => {
  const c = computeCapacity({ ...base, members: [m('a'), m('b', [{ date: '2026-11-03', portion: 1 }])] });
  assert.equal(c.personDays, 19);
  assert.equal(c.members[1].available, 9);
  assert.equal(c.members[1].leaveDays, 1);
});

test('half-day leave counts 0.5', () => {
  const c = computeCapacity({ ...base, members: [m('a', [{ date: '2026-11-03', portion: 0.5 }])] });
  assert.equal(c.personDays, 9.5);
});

test('leave on weekend, holiday or outside sprint is ignored', () => {
  const leave = [
    { date: '2026-11-07', portion: 1 }, { date: '2026-11-09', portion: 1 }, { date: '2026-12-01', portion: 1 },
  ];
  const c = computeCapacity({ ...base, holidays: ['2026-11-09'], members: [m('a', leave)] });
  assert.equal(c.members[0].available, 9);
  assert.equal(c.members[0].leaveDays, 0);
});

test('duplicate leave dates for one member count once (max portion wins)', () => {
  const leave = [{ date: '2026-11-03', portion: 0.5 }, { date: '2026-11-03', portion: 1 }];
  const c = computeCapacity({ ...base, members: [m('a', leave)] });
  assert.equal(c.members[0].leaveDays, 1);
});

test('available never goes below zero', () => {
  const leave = [{ date: '2026-11-03', portion: 1 }];
  const c = computeCapacity({ ...base, startDate: '2026-11-03', endDate: '2026-11-03', members: [m('a', leave)] });
  assert.equal(c.members[0].available, 0);
});

test('gross = personDays x points per person-day', () => {
  const c = computeCapacity({ ...base, pointsPerPersonDay: 1.5, members: [m('a'), m('b')] });
  assert.equal(c.gross, 30);
});

test('net = (gross - fixed) x (1 - buffer%)', () => {
  const c = computeCapacity({ ...base, fixedPoints: 10, bufferPct: 20, members: [m('a'), m('b')] });
  assert.equal(c.gross, 20);
  assert.equal(c.afterFixed, 10);
  assert.equal(c.bufferPoints, 2);
  assert.equal(c.net, 8);
});

test('buffer 0% and 100%', () => {
  const ms = [m('a')];
  assert.equal(computeCapacity({ ...base, bufferPct: 0, members: ms }).net, 10);
  assert.equal(computeCapacity({ ...base, bufferPct: 100, members: ms }).net, 0);
});

test('fixed > gross floors net at 0 and warns', () => {
  const c = computeCapacity({ ...base, fixedPoints: 50, members: [m('a')] });
  assert.equal(c.net, 0);
  assert.equal(c.afterFixed, 0);
  assert.ok(c.warnings.some((w) => /fixed/i.test(w)));
});

test('warns when no working days or dates are invalid', () => {
  const c = computeCapacity({ ...base, startDate: '' });
  assert.equal(c.workingDays, 0);
  assert.ok(c.warnings.length > 0);
});

test('results are rounded to 2 decimals (no float noise)', () => {
  const c = computeCapacity({ ...base, pointsPerPersonDay: 0.7, bufferPct: 15, members: [m('a'), m('b'), m('c')] });
  assert.equal(c.gross, 21);
  assert.equal(c.net, 17.85);
});

test('negative or non-numeric inputs are treated as 0', () => {
  const c = computeCapacity({ ...base, fixedPoints: -5, bufferPct: 'abc', pointsPerPersonDay: '2', members: [m('a')] });
  assert.equal(c.gross, 20);
  assert.equal(c.net, 20);
});
