import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSheetDate, parseLeaveSheet } from '../web/parser.js';
import { computeCapacity } from '../web/capacity.js';

const sheet = fs.readFileSync(new URL('./fixtures/nov26-sheet.tsv', import.meta.url), 'utf8');
const win = { sprintStart: '2026-11-09', sprintEnd: '2026-11-20' };
const byName = (r, n) => r.members.find((m) => m.name === n);
const dates = (m) => m.leave.map((l) => l.date);

// ---------- date parsing ----------
test('parseSheetDate: D-Mon without year uses hint', () => {
  assert.deepEqual(parseSheetDate('2-Nov', { yearHint: 2026 }), { iso: '2026-11-02', hasYear: false });
  assert.equal(parseSheetDate('1-Dec', { yearHint: 2026 }).iso, '2026-12-01');
});
test('parseSheetDate: formats with year', () => {
  assert.equal(parseSheetDate('2026-11-02').iso, '2026-11-02');
  assert.equal(parseSheetDate('02/11/2026').iso, '2026-11-02');
  assert.equal(parseSheetDate('02-Nov-2026').iso, '2026-11-02');
  assert.equal(parseSheetDate('2 November 2026').iso, '2026-11-02');
  assert.equal(parseSheetDate('02/11/26').iso, '2026-11-02');
  assert.equal(parseSheetDate('02.11.2026').iso, '2026-11-02');
});
test('parseSheetDate: ambiguous numeric order is dmy by default, mdy on request', () => {
  assert.equal(parseSheetDate('03/04/2026').iso, '2026-04-03');
  assert.equal(parseSheetDate('03/04/2026', { order: 'mdy' }).iso, '2026-03-04');
});
test('parseSheetDate: rejects junk and impossible dates', () => {
  for (const s of ['', 'w1', 'Total', '30', '0.5', '31-Feb-2026', 'Sprint 14', '32/01/2026']) {
    assert.equal(parseSheetDate(s, { yearHint: 2026 }), null, s);
  }
});

// ---------- real sheet (matrix, availability) ----------
test('matrix: detects layout, convention and all 22 date columns', () => {
  const r = parseLeaveSheet(sheet, { ...win });
  assert.equal(r.layout, 'matrix');
  assert.equal(r.convention, 'availability');
  assert.equal(r.columns.length, 22);
  assert.equal(r.columns[0], '2026-11-02');
  assert.equal(r.columns[21], '2026-12-01');
});
test('matrix: ignores week row, Resource header, Total and Sprint Capacity rows', () => {
  const r = parseLeaveSheet(sheet, { ...win });
  assert.deepEqual(r.members.map((m) => m.name), [
    'Mina Rao', 'Arjun Shah', 'Neha Iyer', 'Sanjay Mehta', 'Tara Bose', 'Rohan Das', 'Kavya Nair', 'Isha Verma',
  ]);
});
test('matrix: availability 0 becomes full leave, 0.5 becomes half-day leave', () => {
  const r = parseLeaveSheet(sheet, { ...win });
  assert.deepEqual(dates(byName(r, 'Arjun Shah')), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  const tara = byName(r, 'Tara Bose');
  assert.ok(tara.leave.filter((l) => l.date >= '2026-11-16' && l.date <= '2026-11-20').every((l) => l.portion === 0.5));
});
test('matrix: only sprint-window columns are applied, others reported', () => {
  const r = parseLeaveSheet(sheet, { ...win });
  for (const m of r.members) assert.ok(m.leave.every((l) => l.date >= win.sprintStart && l.date <= win.sprintEnd));
  assert.equal(r.outsideColumns.length, 12);
});
test('matrix: blank cell counts as off by default, toggle makes it available', () => {
  const on = parseLeaveSheet(sheet, { ...win });
  assert.equal(byName(on, 'Mina Rao').leave.length, 10);
  const off = parseLeaveSheet(sheet, { ...win, blankAsOff: false });
  assert.equal(byName(off, 'Mina Rao').leave.length, 0);
  assert.ok(on.warnings.some((w) => /blank/i.test(w)));
});
test('matrix: holiday hint when everyone is off', () => {
  const r = parseLeaveSheet(sheet, { ...win });
  assert.deepEqual(r.holidayHints, ['2026-11-09', '2026-11-10']);
});
test('matrix: no window means all columns applied', () => {
  const r = parseLeaveSheet(sheet, {});
  assert.equal(r.outsideColumns.length, 0);
  assert.equal(byName(r, 'Kavya Nair').leave.some((l) => l.date === '2026-12-01'), true);
});
test('matrix: year from hint, Dec to Jan rollover increments year', () => {
  const txt = ['Resource\t29-Dec\t30-Dec\t4-Jan\t5-Jan', 'A\t1\t0\t1\t0'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026 });
  assert.deepEqual(r.columns, ['2026-12-29', '2026-12-30', '2027-01-04', '2027-01-05']);
});
test('matrix: year falls back to sprint start year', () => {
  const r = parseLeaveSheet(sheet, { sprintStart: '2026-11-09', sprintEnd: '2026-11-20' });
  assert.equal(r.columns[0].slice(0, 4), '2026');
});
test('matrix: end to end with capacity matches hand count for Sprint 14', () => {
  const r = parseLeaveSheet(sheet, { ...win });
  const state = {
    dateMode: 'range', startDate: win.sprintStart, endDate: win.sprintEnd, weekendDays: [0, 6],
    holidays: r.holidayHints, members: r.members.map((m, i) => ({ id: 'm' + i, ...m })),
    pointsPerPersonDay: 1, fixedPoints: 0, bufferPct: 0,
  };
  const c = computeCapacity(state);
  assert.equal(c.workingDays, 8); // 11-13 Nov + 16-20 Nov (9, 10 Nov are holidays)
  const by = Object.fromEntries(c.members.map((x) => [x.name, x.available]));
  assert.equal(by['Mina Rao'], 0);
  assert.equal(by['Arjun Shah'], 5);
  assert.equal(by['Neha Iyer'], 8);
  assert.equal(by['Sanjay Mehta'], 8);
  assert.equal(by['Tara Bose'], 4.5);
  assert.equal(by['Rohan Das'], 4);
  assert.equal(by['Kavya Nair'], 7);
  assert.equal(by['Isha Verma'], 6.5);
  assert.equal(c.personDays, 43);
});

// ---------- convention ----------
test('auto-detects leave convention when mostly blank with marks', () => {
  const txt = ['Name\t2-Nov\t3-Nov\t4-Nov\t5-Nov', 'A\t\t1\t\t', 'B\t\t\t\t', 'C\t0.5\t\t\t'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026 });
  assert.equal(r.convention, 'leave');
  assert.deepEqual(byName(r, 'A').leave, [{ date: '2026-11-03', portion: 1 }]);
  assert.deepEqual(byName(r, 'C').leave, [{ date: '2026-11-02', portion: 0.5 }]);
  assert.equal(byName(r, 'B').leave.length, 0);
});
test('explicit convention overrides auto-detect', () => {
  const txt = ['Name\t2-Nov\t3-Nov', 'A\t1\t1', 'B\t1\t0'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026, convention: 'leave' });
  assert.equal(r.convention, 'leave');
  assert.equal(r.members[0].leave.length, 2);
});
test('leave convention: text marks (x, L) are full day, H/half is half day', () => {
  const txt = ['Name\t2-Nov\t3-Nov\t4-Nov', 'A\tx\tH\t', 'B\t\t\t', 'C\t\t\t'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026, convention: 'leave' });
  assert.deepEqual(r.members[0].leave, [{ date: '2026-11-02', portion: 1 }, { date: '2026-11-03', portion: 0.5 }]);
});

// ---------- robustness ----------
test('values above 1 mean no leave; unrecognised text is reported not fatal', () => {
  const txt = ['Name\t2-Nov\t3-Nov\t4-Nov', 'A\t2\tabc\t1', 'B\t1\t1\t1'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026, convention: 'availability' });
  assert.equal(r.members[0].leave.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /abc/);
});
test('handles CRLF, trailing blank lines, comma decimals and uneven rows', () => {
  const txt = 'Name\t2-Nov\t3-Nov\r\nA\t0,5\r\nB\t1\t1\r\n\r\n';
  const r = parseLeaveSheet(txt, { yearHint: 2026, convention: 'availability', blankAsOff: false });
  assert.deepEqual(byName(r, 'A').leave, [{ date: '2026-11-02', portion: 0.5 }]);
});
test('duplicate names are merged (max portion per date)', () => {
  const txt = ['Name\t2-Nov\t3-Nov', 'A\t0\t1', 'A\t0.5\t0'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026, convention: 'availability' });
  assert.equal(r.members.length, 1);
  assert.deepEqual(r.members[0].leave, [{ date: '2026-11-02', portion: 1 }, { date: '2026-11-03', portion: 1 }]);
});
test('names are trimmed; empty names skipped', () => {
  const txt = ['Name\t2-Nov', '  A  \t0', '\t0'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026, convention: 'availability' });
  assert.deepEqual(r.members.map((m) => m.name), ['A']);
});
test('names column located even when paste has an empty leading column', () => {
  const txt = ['\tName\t2-Nov\t3-Nov', '\tA\t1\t0'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026, convention: 'availability' });
  assert.equal(r.members[0].name, 'A');
  assert.equal(r.members[0].leave.length, 1);
});
test('missing weekday columns inside sprint are reported', () => {
  const txt = ['Name\t2-Nov\t4-Nov', 'A\t1\t1'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026, sprintStart: '2026-11-02', sprintEnd: '2026-11-06' });
  assert.deepEqual(r.missingDates, ['2026-11-03', '2026-11-05', '2026-11-06']);
});
test('empty or garbage input returns unknown layout with an error, no throw', () => {
  for (const t of ['', '   \n  ', 'hello world', '\t\t\t']) {
    const r = parseLeaveSheet(t, { yearHint: 2026 });
    assert.equal(r.layout, 'unknown', JSON.stringify(t));
    assert.equal(r.members.length, 0);
    assert.ok(r.errors.length > 0);
  }
});
test('non-string input does not throw', () => {
  assert.equal(parseLeaveSheet(null, {}).layout, 'unknown');
  assert.equal(parseLeaveSheet(undefined, {}).layout, 'unknown');
});

// ---------- list layout ----------
test('list layout: Name, Date, Half/Full', () => {
  const txt = ['Name\tDate\tType', 'Asha\t03/11/2026\tFull', 'Asha\t04/11/2026\tHalf', 'Ben\t2026-11-05'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026 });
  assert.equal(r.layout, 'list');
  assert.deepEqual(byName(r, 'Asha').leave, [{ date: '2026-11-03', portion: 1 }, { date: '2026-11-04', portion: 0.5 }]);
  assert.deepEqual(byName(r, 'Ben').leave, [{ date: '2026-11-05', portion: 1 }]);
});
test('list layout: Name, From, To expands inclusive range', () => {
  const r = parseLeaveSheet('Asha\t03/11/2026\t05/11/2026', { yearHint: 2026 });
  assert.equal(r.layout, 'list');
  assert.deepEqual(dates(byName(r, 'Asha')), ['2026-11-03', '2026-11-04', '2026-11-05']);
});
test('list layout: bad rows reported with row number, good rows kept', () => {
  const txt = ['Asha\t03/11/2026', 'Ben\tnot a date', 'Cy\t04/11/2026'].join('\n');
  const r = parseLeaveSheet(txt, { yearHint: 2026 });
  assert.equal(r.members.length, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].row, 2);
});
test('list layout: window filter applies', () => {
  const txt = ['Asha\t03/11/2026', 'Asha\t03/12/2026'].join('\n');
  const r = parseLeaveSheet(txt, { sprintStart: '2026-11-01', sprintEnd: '2026-11-30' });
  assert.deepEqual(dates(byName(r, 'Asha')), ['2026-11-03']);
  assert.equal(r.outsideColumns.length, 1);
});
test('list layout: reversed range is an error', () => {
  const r = parseLeaveSheet('Asha\t05/11/2026\t03/11/2026', { yearHint: 2026 });
  assert.equal(r.errors.length, 1);
});
