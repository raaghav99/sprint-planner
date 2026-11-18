// Pure parser: pasted Excel/Sheets text (tab separated) -> leave entries.
// No DOM, no network. See plan: matrix layout (people x dates) and list layout.
import { parseISO, toISO, dayOfWeek } from './capacity.js';

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY_MS = 86400000;
const SKIP_NAME_RE = /^(total|totals|grand total|sprint|resource|capacity|availability|week|w\d+)\b/i;
const VALUE_RE = /^(\d+([.,]\d*)?|[.,]\d+|[A-Za-z]{1,12})$/;
const NUM_RE = /^(\d+([.,]\d*)?|[.,]\d+)$/;

const pad = (n) => String(n).padStart(2, '0');

function monthIndex(word) {
  const w = word.toLowerCase();
  if (w === 'sept') return 8;
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(w));
  return w.length >= 3 ? i : -1;
}

function build(y, m, d) {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return parseISO(iso) === null ? null : iso;
}

const fullYear = (s) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/**
 * Parse one cell as a date. Returns { iso, hasYear } or null.
 * opts: { yearHint, order: 'dmy' | 'mdy' }
 */
export function parseSheetDate(text, opts = {}) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const hint = opts.yearHint ?? new Date().getUTCFullYear();
  let m;

  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    const iso = build(+m[1], +m[2], +m[3]);
    return iso ? { iso, hasYear: true } : null;
  }
  // 2-Nov, 02-Nov-2026, 2 November 2026
  if ((m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})\.?(?:[-/. ,]+(\d{2}|\d{4}))?$/.exec(s))) {
    const mi = monthIndex(m[2]);
    if (mi < 0) return null;
    const iso = build(m[3] ? fullYear(m[3]) : hint, mi + 1, +m[1]);
    return iso ? { iso, hasYear: Boolean(m[3]) } : null;
  }
  // 02/11/2026, 02-11-2026, 02.11.2026 (year required except with "/")
  if ((m = /^(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{2}|\d{4}))?$/.exec(s))) {
    if (!m[4] && m[2] !== '/') return null;
    const [a, b] = [+m[1], +m[3]];
    const [day, month] = opts.order === 'mdy' ? [b, a] : [a, b];
    const iso = build(m[4] ? fullYear(m[4]) : hint, month, day);
    return iso ? { iso, hasYear: Boolean(m[4]) } : null;
  }
  return null;
}

function emptyResult(opts) {
  return {
    layout: 'unknown', convention: null, columns: [], outsideColumns: [], members: [], errors: [], warnings: [],
    holidayHints: [], missingDates: [], ignoredRows: [], blankAsOff: opts.blankAsOff !== false,
  };
}

function splitRows(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasTab = lines.some((l) => l.includes('\t'));
  const delim = hasTab ? /\t/ : /\s{2,}|;|,/;
  return lines.map((l) => l.split(delim).map((c) => c.trim()));
}

const isBlankRow = (cells) => cells.every((c) => c === '');

function parseValue(raw) {
  if (raw === '') return { kind: 'blank' };
  if (NUM_RE.test(raw)) return { kind: 'num', v: Number(raw.replace(',', '.')) };
  return { kind: 'text', raw };
}

/** Merge duplicate names; max portion per date. */
class MemberBook {
  constructor() { this.map = new Map(); }
  add(name, date, portion) {
    if (!this.map.has(name)) this.map.set(name, new Map());
    if (date) {
      const m = this.map.get(name);
      m.set(date, Math.max(m.get(date) ?? 0, portion));
    }
  }
  toArray() {
    return [...this.map].map(([name, m]) => ({
      name,
      leave: [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, portion]) => ({ date, portion })),
    }));
  }
}

export function parseLeaveSheet(input, opts = {}) {
  const result = emptyResult(opts);
  const text = typeof input === 'string' ? input : '';
  const rows = splitRows(text);
  if (rows.every(isBlankRow)) {
    result.errors.push({ row: 0, message: 'Nothing to parse. Paste the leave table from Excel.' });
    return result;
  }

  const yearHint = opts.yearHint ?? (opts.sprintStart ? Number(opts.sprintStart.slice(0, 4)) : new Date().getUTCFullYear());
  const inWindow = (d) => (!opts.sprintStart || d >= opts.sprintStart) && (!opts.sprintEnd || d <= opts.sprintEnd);
  const dateOpts = { yearHint, order: opts.order };

  // ---- find a matrix header row ----
  let header = null;
  for (let i = 0; i < rows.length && !header; i++) {
    const dateCols = [];
    rows[i].forEach((c, ci) => { if (parseSheetDate(c, dateOpts)) dateCols.push(ci); });
    if (dateCols.length === 0 || dateCols[0] === 0) continue;
    const hasValueRowBelow = rows.slice(i + 1).some((r) =>
      dateCols.some((c) => r[c] && !parseSheetDate(r[c], dateOpts) && VALUE_RE.test(r[c])));
    if (hasValueRowBelow) header = { index: i, dateCols };
  }

  if (header) return parseMatrix(rows, header, result, { ...opts, yearHint, inWindow, dateOpts });
  return parseList(rows, result, { ...opts, yearHint, inWindow, dateOpts });
}

function parseMatrix(rows, header, result, o) {
  result.layout = 'matrix';
  const { dateCols } = header;
  const nameCol = dateCols[0] - 1;

  // assign dates left to right, rolling the year over (Dec -> Jan)
  let year = o.yearHint;
  let prevMonth = null;
  const colDate = new Map();
  for (const c of dateCols) {
    let p = parseSheetDate(rows[header.index][c], { ...o.dateOpts, yearHint: year });
    if (!p.hasYear) {
      const month = Number(p.iso.slice(5, 7));
      if (prevMonth !== null && month < prevMonth) year += 1;
      prevMonth = month;
      p = parseSheetDate(rows[header.index][c], { ...o.dateOpts, yearHint: year });
    } else {
      year = Number(p.iso.slice(0, 4));
      prevMonth = null;
    }
    colDate.set(c, p.iso);
  }
  result.columns = dateCols.map((c) => colDate.get(c));
  const used = dateCols.filter((c) => o.inWindow(colDate.get(c)));
  result.outsideColumns = result.columns.filter((d) => !o.inWindow(d));

  // ---- gather person rows ----
  const people = [];
  rows.slice(header.index + 1).forEach((cells, k) => {
    const rowNo = header.index + 2 + k;
    if (isBlankRow(cells)) return;
    const name = (cells[nameCol] ?? '').trim();
    if (dateCols.filter((c) => parseSheetDate(cells[c], o.dateOpts)).length >= 2) {
      result.ignoredRows.push({ row: rowNo, reason: 'repeated header' });
      return;
    }
    if (!name) { result.ignoredRows.push({ row: rowNo, reason: 'no name' }); return; }
    if (SKIP_NAME_RE.test(name) || NUM_RE.test(name)) { result.ignoredRows.push({ row: rowNo, reason: `summary row "${name}"` }); return; }
    people.push({ rowNo, name, cells: dateCols.map((c) => parseValue(cells[c] ?? '')) });
  });

  // ---- decide cell meaning ----
  let convention = o.convention && o.convention !== 'auto' ? o.convention : null;
  if (!convention) {
    let total = 0, filled = 0, ones = 0;
    for (const p of people) for (const v of p.cells) {
      total++;
      if (v.kind !== 'blank') { filled++; if (v.kind === 'num' && v.v === 1) ones++; }
    }
    convention = total > 0 && filled / total >= 0.5 && ones / filled >= 0.5 ? 'availability' : 'leave';
  }
  result.convention = convention;

  // ---- convert cells to leave ----
  const book = new MemberBook();
  const blankAsOff = result.blankAsOff;
  let blankOff = 0;
  const active = []; // members with at least one non-blank cell
  const offBy = new Map(); // date -> [{active, off}]
  for (const p of people) {
    book.add(p.name);
    const isActive = p.cells.some((v) => v.kind !== 'blank');
    p.cells.forEach((v, idx) => {
      const c = dateCols[idx];
      const date = colDate.get(c);
      if (!o.inWindow(date)) return;
      let portion = 0;
      if (convention === 'availability') {
        if (v.kind === 'blank') { if (blankAsOff) { portion = 1; blankOff++; } }
        else if (v.kind === 'num') portion = v.v >= 1 ? 0 : Math.round((1 - Math.max(v.v, 0)) * 100) / 100;
        else result.errors.push({ row: p.rowNo, message: `Unrecognised value "${v.raw}" for ${p.name} on ${date}` });
      } else if (v.kind === 'num') portion = Math.min(v.v, 1);
      else if (v.kind === 'text') portion = /^(h|half)$/i.test(v.raw) ? 0.5 : 1;
      if (portion > 0) book.add(p.name, date, portion);
      if (isActive) {
        if (!offBy.has(date)) offBy.set(date, []);
        offBy.get(date).push(portion >= 1);
      }
    });
    if (isActive) active.push(p.name);
  }
  result.members = book.toArray();
  if (blankOff > 0) result.warnings.push(`${blankOff} blank cell(s) treated as not available (blank = off). Turn this off if blank means available.`);

  result.holidayHints = used
    .map((c) => colDate.get(c))
    .filter((d) => (offBy.get(d)?.length ?? 0) >= 2 && offBy.get(d).every(Boolean));

  // weekday dates inside the window with no pasted column
  if (o.sprintStart && o.sprintEnd) {
    const have = new Set(result.columns);
    const weekend = new Set(o.weekendDays ?? [0, 6]);
    const s = parseISO(o.sprintStart), e = parseISO(o.sprintEnd);
    if (s !== null && e !== null) {
      for (let t = s; t <= e; t += DAY_MS) {
        const d = toISO(t);
        if (!have.has(d) && !weekend.has(dayOfWeek(d))) result.missingDates.push(d);
      }
    }
  }
  if (result.missingDates.length) result.warnings.push(`${result.missingDates.length} sprint day(s) are not in the pasted table; assumed available.`);
  return result;
}

function parseList(rows, result, o) {
  const book = new MemberBook();
  const outside = new Set();
  let sawDate = false;
  rows.forEach((cells, i) => {
    const rowNo = i + 1;
    if (isBlankRow(cells)) return;
    const name = cells[0] ?? '';
    const d1 = parseSheetDate(cells[1], o.dateOpts);
    if (!d1) {
      if (i === 0 || !name) { result.ignoredRows.push({ row: rowNo, reason: 'header or empty' }); return; }
      result.errors.push({ row: rowNo, message: `Could not read a date in "${cells[1] ?? ''}"` });
      return;
    }
    sawDate = true;
    if (!name) { result.errors.push({ row: rowNo, message: 'Missing name' }); return; }
    const d2 = parseSheetDate(cells[2], o.dateOpts);
    const typeRaw = d2 ? cells[3] ?? '' : cells[2] ?? '';
    const portion = /^(half|h|0?\.5)$/i.test(typeRaw.trim()) ? 0.5 : 1;
    const a = parseISO(d1.iso);
    const b = d2 ? parseISO(d2.iso) : a;
    if (b < a) { result.errors.push({ row: rowNo, message: `End date is before start date for ${name}` }); return; }
    book.add(name);
    for (let t = a, n = 0; t <= b && n < 366; t += DAY_MS, n++) {
      const d = toISO(t);
      if (o.inWindow(d)) book.add(name, d, portion);
      else outside.add(d);
    }
  });
  if (!sawDate) {
    result.errors.push({ row: 0, message: 'Could not recognise the table. Expected people as rows and dates as columns, or Name / Date rows.' });
    return result;
  }
  result.layout = 'list';
  result.members = book.toArray();
  result.outsideColumns = [...outside].sort();
  return result;
}
