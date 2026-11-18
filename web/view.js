// Pure helpers for the UI. No DOM access, so they run under node:test.
import { parseISO } from './capacity.js';
import { migrateState, LEGACY_KEYS } from './migrate.js';

export const FIELD_KEYS = [
  'sprintBase', 'sprints', 'weekendDays', 'holidays', 'members', 'pointsPerPersonDay', 'bufferPct',
];

const LIMITS = {
  number: [1, 9999, true],
  length: [1, 60, true],
  points: [0, 100000, false],
  spill: [0, 100000, false],
  pointsPerPersonDay: [0, 1000, false],
  bufferPct: [0, 100, false],
};

/** Turn what someone typed into a number the server will accept. */
export function clampField(name, raw) {
  const [min, max, integer] = LIMITS[name];
  let n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n)) n = 0;
  if (integer) n = Math.floor(n);
  return Math.min(Math.max(n, min), max);
}

export function fmtNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Number(v.toFixed(2))) : '0';
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso, { year = false } = {}) {
  const t = parseISO(iso);
  if (t === null) return '';
  const d = new Date(t);
  const base = `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  return year ? `${base} ${d.getUTCFullYear()}` : base;
}

/** Consecutive runs of the same month, for the header row above the grid. */
export function monthSpans(dates) {
  const spans = [];
  for (const d of dates) {
    const label = MON[Number(d.slice(5, 7)) - 1];
    const last = spans[spans.length - 1];
    if (last && last.label === label) last.span += 1;
    else spans.push({ label, span: 1 });
  }
  return spans;
}

export const portionOn = (leave, date) =>
  (leave ?? []).reduce((m, l) => (l.date === date ? Math.max(m, l.portion) : m), 0);

/** Click cycle for one grid cell: working -> off -> half day -> working. */
export function cycleLeave(leave, date) {
  const cur = portionOn(leave, date);
  const next = cur === 0 ? 1 : cur === 1 ? 0.5 : 0;
  const rest = (leave ?? []).filter((l) => l.date !== date);
  if (next > 0) rest.push({ date, portion: next });
  return rest.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Parts of the capacity bar, to scale against gross capacity. Fixed and spill are cut to fit. */
export function barSegments({ gross, fixed, spill = 0, bufferPoints, net }) {
  if (!(gross > 0)) return [];
  const fixedShown = Math.min(fixed, gross);
  const spillShown = Math.min(spill, gross - fixedShown);
  const parts = [
    { key: 'fixed', value: fixedShown },
    { key: 'spill', value: spillShown },
    { key: 'buffer', value: bufferPoints },
    { key: 'net', value: net },
  ].filter((p) => p.value > 0);
  return parts.map((p) => ({ ...p, flex: p.value / gross }));
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 10);

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Apply a pasted leave table to the team without losing history.
 * - People in the paste: leave on the pasted dates is replaced by what was pasted (id, joined and
 *   left dates are kept). New people are added.
 * - Everyone else keeps their leave. With `markOthersOff` they are also off on the pasted dates,
 *   which is how someone who has left the team stops counting in the newer sheet.
 * Leave on dates the paste does not cover is never touched.
 */
export function applyPaste(existing, parsed, { markOthersOff = true } = {}) {
  const pasted = new Set(parsed.columns ?? []);
  const outside = (leave) => (leave ?? []).filter((l) => !pasted.has(l.date));
  const sortLeave = (leave) => leave.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const result = existing.map((m) => ({ ...m }));
  for (const p of parsed.members) {
    const at = result.findIndex((m) => sameName(m.name, p.name));
    if (at >= 0) result[at] = { ...result[at], name: p.name.trim(), leave: sortLeave([...outside(result[at].leave), ...p.leave]) };
    else result.push({ id: newId(), name: p.name.trim(), leave: sortLeave([...p.leave]) });
  }
  if (markOthersOff) {
    result.forEach((m, i) => {
      if (parsed.members.some((p) => sameName(p.name, m.name))) return;
      result[i] = { ...m, leave: sortLeave([...outside(m.leave), ...[...pasted].map((date) => ({ date, portion: 1 }))]) };
    });
  }
  return result;
}

/** Leave that falls on the given days, in date order (for the compact team summary). */
export function summarizeLeave(leave, days) {
  const set = new Set(days);
  return (leave ?? []).filter((l) => set.has(l.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function makeMember(name) {
  return { id: newId(), name: name.trim(), leave: [] };
}

export function makeFixedItem(label, points) {
  return { id: newId(), label: String(label ?? '').trim(), points: Number(points) || 0 };
}

/** Read a downloaded backup file. Returns only known fields (old backups are converted), or null. */
export function sanitizeBackup(obj) {
  const fields = obj && typeof obj === 'object' ? obj.fields : null;
  if (!fields || typeof fields !== 'object') return null;
  const legacy = LEGACY_KEYS.some((k) => k in fields);
  const src = legacy || FIELD_KEYS.some((k) => k in fields) ? migrateState(fields) : null;
  if (!src) return null;
  const out = {};
  for (const k of FIELD_KEYS) if (k in src) out[k] = src[k];
  return Object.keys(out).length ? out : null;
}

/** '9 Nov' for tabs and tables. */
export function fmtShort(iso) {
  const t = parseISO(iso);
  if (t === null) return '';
  const d = new Date(t);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** A `sprints` edit that makes the room match `incoming` exactly (null deletes the rest). */
export function replaceSprints(current, incoming) {
  const out = { ...incoming };
  for (const k of Object.keys(current ?? {})) if (!(k in out)) out[k] = null;
  return out;
}
