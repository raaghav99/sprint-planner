// Sprint calendar maths: one anchor sprint generates every other sprint, back to back.
// Pure functions, no DOM.
import { computeCapacity, parseISO, toISO } from './capacity.js';

const DAY_MS = 86400000;
export const DEFAULT_BASE = { number: 1, startDate: '', length: 14 };
/** How many sprints to show on each side of the current one. */
export const SPAN = 3;

export function addDays(iso, n) {
  return toISO(parseISO(iso) + n * DAY_MS);
}

const baseOf = (state) => ({ ...DEFAULT_BASE, ...(state.sprintBase ?? {}) });
const validBase = (b) => parseISO(b.startDate) !== null && b.length >= 1;

/** Dates of sprint `n`, or null while the anchor sprint has no start date. */
export function sprintDatesFor(state, n) {
  const b = baseOf(state);
  if (!validBase(b)) return null;
  const over = state.sprints?.[n] ?? {};
  const start = over.startDate || addDays(b.startDate, (n - b.number) * b.length);
  const end = over.endDate && over.endDate >= start ? over.endDate : addDays(start, b.length - 1);
  const dates = [];
  for (let t = parseISO(start); t <= parseISO(end); t += DAY_MS) dates.push(toISO(t));
  return { number: n, start, end, numDays: dates.length, dates };
}

/** The sprint that contains `today`, following the anchor sprint's rhythm. Null if no anchor. */
export function currentSprint(state, today) {
  const b = baseOf(state);
  if (!validBase(b) || parseISO(today) === null) return null;
  const days = Math.round((parseISO(today) - parseISO(b.startDate)) / DAY_MS);
  return b.number + Math.floor(days / b.length);
}

/** The sprint numbers on screen: 3 before the current one, the current one, 3 after (never below 1). */
export function sprintNumbers(state, today) {
  const cur = currentSprint(state, today);
  if (cur === null) return [];
  const out = [];
  for (let n = cur - SPAN; n <= cur + SPAN; n++) if (n >= 1) out.push(n);
  return out;
}

/** Points carried into sprint `n`: the previous sprint's spillover out, unless typed over. */
export function spillInFor(state, n) {
  const own = state.sprints?.[n]?.spillIn;
  if (own !== null && own !== undefined) return Number(own) || 0;
  return Number(state.sprints?.[n - 1]?.spillOut) || 0;
}

export function fixedTotal(sprint) {
  let sum = 0;
  for (const it of sprint?.fixedItems ?? []) {
    const p = Number(it?.points);
    if (Number.isFinite(p) && p > 0) sum += p;
  }
  return Math.round(sum * 100) / 100;
}

/** One sprint expressed as the flat input `computeCapacity` understands. */
export function flatInput(state, n) {
  const w = sprintDatesFor(state, n);
  return {
    dateMode: 'range',
    startDate: w?.start ?? '',
    endDate: w?.end ?? '',
    weekendDays: state.weekendDays,
    holidays: state.holidays,
    members: state.members,
    pointsPerPersonDay: state.pointsPerPersonDay,
    bufferPct: state.bufferPct,
    fixedPoints: fixedTotal(state.sprints?.[n]),
    spillPoints: spillInFor(state, n),
  };
}

export function capacityFor(state, n) {
  return computeCapacity(flatInput(state, n));
}

/** One row per visible sprint, for the overview table. */
export function overview(state, today) {
  const cur = currentSprint(state, today);
  return sprintNumbers(state, today).map((n) => {
    const c = capacityFor(state, n);
    return {
      number: n,
      start: c.sprint.start,
      end: c.sprint.end,
      isCurrent: n === cur,
      activeMembers: c.activeMembers,
      personDays: c.personDays,
      gross: c.gross,
      fixed: c.fixed,
      spillIn: c.spill,
      net: c.net,
    };
  });
}
