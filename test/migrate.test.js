import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateState, LEGACY_KEYS } from '../web/migrate.js';

const legacy = {
  revision: 4, updatedAt: 123, expiresAt: 456,
  sprintName: 'Sprint 9', dateMode: 'range', startDate: '2026-11-02', endDate: '2026-11-13', numDays: 14,
  weekendDays: [0, 6], holidays: ['2026-11-09'], members: [{ id: 'a', name: 'Asha', leave: [] }],
  pointsPerPersonDay: 1.5, fixedPoints: 12, bufferPct: 20,
};

test('old single-sprint data becomes the anchor sprint, keeping team, holidays and numbers', () => {
  const s = migrateState(legacy);
  assert.deepEqual(s.sprintBase, { number: 9, startDate: '2026-11-02', length: 12 });
  assert.deepEqual(s.members, legacy.members);
  assert.deepEqual(s.holidays, ['2026-11-09']);
  assert.equal(s.pointsPerPersonDay, 1.5);
  assert.equal(s.bufferPct, 20);
  assert.equal(s.revision, 4);
  assert.equal(s.expiresAt, 456);
});

test('old fixed points become a fixed item on that sprint', () => {
  const s = migrateState(legacy);
  assert.equal(s.sprints[9].fixedItems.length, 1);
  assert.equal(s.sprints[9].fixedItems[0].points, 12);
  assert.ok(s.sprints[9].fixedItems[0].id);
});

test('legacy keys are removed', () => {
  const s = migrateState(legacy);
  for (const k of LEGACY_KEYS) assert.equal(k in s, false, k);
});

test('days mode uses numDays as the sprint length', () => {
  const s = migrateState({ ...legacy, dateMode: 'days', numDays: 14, endDate: '' });
  assert.equal(s.sprintBase.length, 14);
});

test('sprint number comes from the name digits, defaults to 1', () => {
  assert.equal(migrateState({ ...legacy, sprintName: 'Team Sprint 21 (QA)' }).sprintBase.number, 21);
  assert.equal(migrateState({ ...legacy, sprintName: '' }).sprintBase.number, 1);
});

test('no fixed points means no sprint entry; missing dates fall back to a 14 day sprint', () => {
  const s = migrateState({ ...legacy, fixedPoints: 0, startDate: '', endDate: '', dateMode: 'range' });
  assert.deepEqual(s.sprints, {});
  assert.equal(s.sprintBase.length, 14);
  assert.equal(s.sprintBase.startDate, '');
});

test('already-new data is returned unchanged (idempotent)', () => {
  const once = migrateState(legacy);
  assert.deepEqual(migrateState(once), once);
});

test('empty or odd input gives a usable blank state', () => {
  for (const input of [null, undefined, {}, 'x']) {
    const s = migrateState(input);
    assert.deepEqual(s.members, []);
    assert.equal(s.sprintBase.length, 14);
    assert.deepEqual(s.weekendDays, [0, 6]);
  }
});

test('length is clamped to a sane range', () => {
  assert.equal(migrateState({ ...legacy, endDate: '2027-12-31' }).sprintBase.length, 60);
});

test('migrated and existing data gets an empty fixed section name, and keeps a custom one', () => {
  assert.equal(migrateState({ sprintName: 'Sprint 9' }).fixedLabel, '');
  assert.equal(migrateState({ sprintBase: { number: 1, startDate: '', length: 14 }, fixedLabel: 'RCA' }).fixedLabel, 'RCA');
});
