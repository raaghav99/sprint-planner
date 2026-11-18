// Pure capacity maths. No DOM, no network. Dates are 'YYYY-MM-DD' strings.

const DAY_MS = 86400000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseISO(s) {
  const m = ISO_RE.exec(s || '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  // reject overflow like 2026-02-31
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return t;
}

export function toISO(t) {
  return new Date(t).toISOString().slice(0, 10);
}

export function dayOfWeek(iso) {
  return new Date(parseISO(iso)).getUTCDay();
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Resolve the sprint window from either end date or number of days. */
export function sprintDates(state) {
  const empty = { start: state.startDate || '', end: '', numDays: 0, dates: [] };
  const s = parseISO(state.startDate);
  if (s === null) return empty;
  let e;
  if (state.dateMode === 'days') {
    const n = Math.floor(num(state.numDays));
    if (n < 1) return empty;
    e = s + (n - 1) * DAY_MS;
  } else {
    e = parseISO(state.endDate);
    if (e === null || e < s) return empty;
  }
  const dates = [];
  for (let t = s; t <= e; t += DAY_MS) dates.push(toISO(t));
  return { start: toISO(s), end: toISO(e), numDays: dates.length, dates };
}

/** Sprint dates that are not weekends and not holidays. */
export function workingDays(state) {
  const weekend = new Set(state.weekendDays ?? [0, 6]);
  const holidays = new Set(state.holidays ?? []);
  return sprintDates(state).dates.filter((d) => !weekend.has(dayOfWeek(d)) && !holidays.has(d));
}

export function computeCapacity(state) {
  const warnings = [];
  const days = workingDays(state);
  const daySet = new Set(days);
  const range = sprintDates(state);

  if (range.dates.length === 0) warnings.push('Sprint dates are missing or invalid.');
  else if (days.length === 0) warnings.push('Sprint has no working days.');

  const members = (state.members ?? []).map((mem) => {
    const perDate = new Map(); // dedupe: max portion per date
    for (const l of mem.leave ?? []) {
      if (!daySet.has(l.date)) continue;
      perDate.set(l.date, Math.max(perDate.get(l.date) ?? 0, Math.min(num(l.portion), 1)));
    }
    let leaveDays = 0;
    for (const p of perDate.values()) leaveDays += p;
    leaveDays = round2(leaveDays);
    return { id: mem.id, name: mem.name, leaveDays, available: round2(Math.max(days.length - leaveDays, 0)) };
  });

  const personDays = round2(members.reduce((a, x) => a + x.available, 0));
  const gross = round2(personDays * num(state.pointsPerPersonDay));
  const fixed = round2(num(state.fixedPoints));
  const bufferPct = Math.min(num(state.bufferPct), 100);
  if (fixed > gross) warnings.push(`Fixed points (${fixed}) exceed gross capacity (${gross}).`);
  const afterFixed = round2(Math.max(gross - fixed, 0));
  const bufferPoints = round2((afterFixed * bufferPct) / 100);
  const net = round2(afterFixed - bufferPoints);

  return {
    sprint: range,
    workingDays: days.length,
    members,
    personDays,
    gross,
    fixed,
    afterFixed,
    bufferPct,
    bufferPoints,
    net,
    warnings,
  };
}
