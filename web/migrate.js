// Turns the first version of the room data (one sprint) into the multi-sprint shape.
// Used by the Worker when it loads stored data, and when restoring an old backup.
import { parseISO } from './capacity.js';

export const LEGACY_KEYS = ['sprintName', 'dateMode', 'startDate', 'endDate', 'numDays', 'fixedPoints'];

const DAY_MS = 86400000;
const clampLen = (n) => Math.min(Math.max(Math.floor(n), 1), 60);

export function migrateState(input) {
  const old = input && typeof input === 'object' ? input : {};
  const out = { ...old };

  if (!out.sprintBase) {
    let length = 14;
    if (old.dateMode === 'days' && Number(old.numDays) >= 1) length = clampLen(Number(old.numDays));
    else if (parseISO(old.startDate) !== null && parseISO(old.endDate) !== null && parseISO(old.endDate) >= parseISO(old.startDate)) {
      length = clampLen((parseISO(old.endDate) - parseISO(old.startDate)) / DAY_MS + 1);
    }
    const digits = /(\d+)/.exec(String(old.sprintName ?? ''));
    const number = digits ? Math.max(Number(digits[1]), 1) : 1;
    out.sprintBase = { number, startDate: parseISO(old.startDate) !== null ? old.startDate : '', length };

    const sprints = { ...(old.sprints ?? {}) };
    const fixed = Number(old.fixedPoints);
    if (Number.isFinite(fixed) && fixed > 0) {
      sprints[number] = { fixedItems: [{ id: 'migrated', label: 'Fixed points', points: fixed }], spillOut: 0, spillIn: null };
    }
    out.sprints = sprints;
  }

  out.sprints ??= {};
  out.weekendDays ??= [0, 6];
  out.holidays ??= [];
  out.members ??= [];
  out.pointsPerPersonDay ??= 1;
  out.bufferPct ??= 0;
  for (const k of LEGACY_KEYS) delete out[k];
  return out;
}
