// Strict validation for room state. Anything unexpected is rejected, never stored.

export interface LeaveEntry { date: string; portion: 0.5 | 1 }
export interface Member { id: string; name: string; leave: LeaveEntry[]; from?: string; until?: string }
export interface FixedItem { id: string; label: string; points: number }
export interface Sprint {
  fixedItems?: FixedItem[];
  spillOut?: number;
  spillIn?: number | null;
  startDate?: string;
  endDate?: string;
}
export interface SprintBase { number: number; startDate: string; length: number }

export interface RoomFields {
  sprintBase: SprintBase;
  /** Stored: sprint number -> sprint. In a `set` message it is partial: only the keys sent change, and null deletes one. */
  sprints: Record<string, Sprint>;
  weekendDays: number[];
  holidays: string[];
  members: Member[];
  pointsPerPersonDay: number;
  bufferPct: number;
}

export interface RoomState extends RoomFields {
  revision: number;
  updatedAt: number | null;
  expiresAt: number | null;
}

export const DEFAULT_FIELDS: RoomFields = {
  sprintBase: { number: 1, startDate: '', length: 14 },
  sprints: {},
  weekendDays: [0, 6],
  holidays: [],
  members: [],
  pointsPerPersonDay: 1,
  bufferPct: 0,
};

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_SPRINTS = 100;
const SPRINT_KEY_RE = /^[1-9]\d{0,3}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const isNum = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isInt = (v: unknown, min: number, max: number): v is number => isNum(v, min, max) && Number.isInteger(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isOptDate = (v: unknown) => v === undefined || v === '' || isIsoDate(v);

function onlyKeys(o: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function validFixedItem(i: unknown): boolean {
  return isObj(i) && onlyKeys(i, ['id', 'label', 'points']) && isStr(i.id, 40) && (i.id as string).length > 0 &&
    isStr(i.label, 80) && isNum(i.points, 0, 100000);
}

export function validSprint(s: unknown): boolean {
  if (!isObj(s) || !onlyKeys(s, ['fixedItems', 'spillOut', 'spillIn', 'startDate', 'endDate'])) return false;
  if (s.fixedItems !== undefined && !(Array.isArray(s.fixedItems) && s.fixedItems.length <= 30 && s.fixedItems.every(validFixedItem))) return false;
  if (s.spillOut !== undefined && !isNum(s.spillOut, 0, 100000)) return false;
  if (s.spillIn !== undefined && s.spillIn !== null && !isNum(s.spillIn, 0, 100000)) return false;
  return isOptDate(s.startDate) && isOptDate(s.endDate);
}

function validMember(m: unknown): boolean {
  if (!isObj(m) || !onlyKeys(m, ['id', 'name', 'leave', 'from', 'until'])) return false;
  return isStr(m.id, 40) && (m.id as string).length > 0 && isStr(m.name, 80) && (m.name as string).trim().length > 0 &&
    Array.isArray(m.leave) && m.leave.length <= 800 &&
    m.leave.every((l: any) => isObj(l) && isIsoDate(l.date) && (l.portion === 1 || l.portion === 0.5)) &&
    isOptDate(m.from) && isOptDate(m.until);
}

type Check = (v: unknown) => boolean;

const CHECKS: Record<keyof RoomFields, Check> = {
  sprintBase: (v) => isObj(v) && onlyKeys(v, ['number', 'startDate', 'length']) &&
    isInt(v.number, 1, 9999) && (v.startDate === '' || isIsoDate(v.startDate)) && isInt(v.length, 1, 60),
  sprints: (v) => isObj(v) && Object.keys(v).length <= 60 &&
    Object.entries(v).every(([k, s]) => SPRINT_KEY_RE.test(k) && (s === null || validSprint(s))),
  weekendDays: (v) => Array.isArray(v) && v.length <= 7 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  holidays: (v) => Array.isArray(v) && v.length <= 200 && v.every(isIsoDate),
  members: (v) => Array.isArray(v) && v.length <= 100 && v.every(validMember),
  pointsPerPersonDay: (v) => isNum(v, 0, 1000),
  bufferPct: (v) => isNum(v, 0, 100),
};

/** Returns the cleaned fields or an error message. Only known keys are copied. */
export function validateFields(input: unknown): { ok: true; fields: Partial<RoomFields> } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: 'fields must be an object' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const check = (CHECKS as Record<string, Check>)[k];
    if (!check) return { ok: false, error: `Unknown field "${k}"` };
    if (!check(v)) return { ok: false, error: `Invalid value for "${k}"` };
    out[k] = v;
  }
  return { ok: true, fields: out as Partial<RoomFields> };
}

/** Apply a partial `sprints` map: keys replace, null deletes. Returns null if it would hold too many sprints. */
export function mergeSprints(current: Record<string, Sprint>, partial: Record<string, Sprint | null>): Record<string, Sprint> | null {
  const next: Record<string, Sprint> = { ...current };
  for (const [k, v] of Object.entries(partial)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return Object.keys(next).length <= MAX_SPRINTS ? next : null;
}
