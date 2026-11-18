// Strict validation for room state. Anything unexpected is rejected, never stored.

export interface LeaveEntry { date: string; portion: 0.5 | 1 }
export interface Member { id: string; name: string; leave: LeaveEntry[] }

export interface RoomFields {
  sprintName: string;
  dateMode: 'range' | 'days';
  startDate: string;
  endDate: string;
  numDays: number;
  weekendDays: number[];
  holidays: string[];
  members: Member[];
  pointsPerPersonDay: number;
  fixedPoints: number;
  bufferPct: number;
}

export interface RoomState extends RoomFields {
  revision: number;
  updatedAt: number | null;
  expiresAt: number | null;
}

export const DEFAULT_FIELDS: RoomFields = {
  sprintName: '',
  dateMode: 'range',
  startDate: '',
  endDate: '',
  numDays: 14,
  weekendDays: [0, 6],
  holidays: [],
  members: [],
  pointsPerPersonDay: 1,
  fixedPoints: 0,
  bufferPct: 0,
};

export const MAX_MESSAGE_BYTES = 256 * 1024;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const isNum = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

type Check = (v: unknown) => boolean;

const CHECKS: Record<keyof RoomFields, Check> = {
  sprintName: (v) => isStr(v, 80),
  dateMode: (v) => v === 'range' || v === 'days',
  startDate: (v) => v === '' || isIsoDate(v),
  endDate: (v) => v === '' || isIsoDate(v),
  numDays: (v) => isNum(v, 0, 366),
  weekendDays: (v) => Array.isArray(v) && v.length <= 7 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  holidays: (v) => Array.isArray(v) && v.length <= 200 && v.every(isIsoDate),
  members: (v) =>
    Array.isArray(v) && v.length <= 100 && v.every((m) =>
      m && typeof m === 'object' && isStr(m.id, 40) && m.id.length > 0 && isStr(m.name, 80) && m.name.trim().length > 0 &&
      Array.isArray(m.leave) && m.leave.length <= 400 &&
      m.leave.every((l: any) => l && isIsoDate(l.date) && (l.portion === 1 || l.portion === 0.5))),
  pointsPerPersonDay: (v) => isNum(v, 0, 1000),
  fixedPoints: (v) => isNum(v, 0, 100000),
  bufferPct: (v) => isNum(v, 0, 100),
};

/** Returns the cleaned fields or an error message. Only known keys are copied. */
export function validateFields(input: unknown): { ok: true; fields: Partial<RoomFields> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'fields must be an object' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const check = (CHECKS as Record<string, Check>)[k];
    if (!check) return { ok: false, error: `Unknown field "${k}"` };
    if (!check(v)) return { ok: false, error: `Invalid value for "${k}"` };
    out[k] = v;
  }
  return { ok: true, fields: out as Partial<RoomFields> };
}
