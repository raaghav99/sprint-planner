// Pure helpers for the UI. No DOM access, so they run under node:test.
import { parseISO } from './capacity.js';

export const FIELD_KEYS = [
  'sprintName', 'dateMode', 'startDate', 'endDate', 'numDays', 'weekendDays',
  'holidays', 'members', 'pointsPerPersonDay', 'fixedPoints', 'bufferPct',
];

const LIMITS = {
  numDays: [0, 366, true],
  pointsPerPersonDay: [0, 1000, false],
  fixedPoints: [0, 100000, false],
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

/** Parts of the capacity bar, to scale against gross capacity. */
export function barSegments({ gross, fixed, bufferPoints, net }) {
  if (!(gross > 0)) return [];
  const fixedShown = Math.min(fixed, gross);
  const parts = [
    { key: 'fixed', value: fixedShown },
    { key: 'buffer', value: bufferPoints },
    { key: 'net', value: net },
  ].filter((p) => p.value > 0);
  return parts.map((p) => ({ ...p, flex: p.value / gross }));
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 10);

/** Replace the team with pasted people, keeping ids of people who already exist. */
export function mergeMembers(existing, parsed) {
  const byName = new Map(existing.map((m) => [m.name.trim().toLowerCase(), m.id]));
  return parsed.map((p) => ({
    id: byName.get(p.name.trim().toLowerCase()) ?? newId(),
    name: p.name.trim(),
    leave: p.leave,
  }));
}

export function makeMember(name) {
  return { id: newId(), name: name.trim(), leave: [] };
}

/** Read a downloaded backup file. Returns only known fields, or null if it is not a backup. */
export function sanitizeBackup(obj) {
  const fields = obj && typeof obj === 'object' ? obj.fields : null;
  if (!fields || typeof fields !== 'object') return null;
  const out = {};
  for (const k of FIELD_KEYS) if (k in fields) out[k] = fields[k];
  return Object.keys(out).length ? out : null;
}
