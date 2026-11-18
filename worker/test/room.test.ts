import { describe, it, expect, beforeEach } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';

const ORIGIN = 'http://localhost:8080';
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

function stub() {
  return env.ROOM.get(env.ROOM.idFromName('playwright'));
}

async function open(room = 'playwright', origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (origin) headers.Origin = origin;
  return exports.default.fetch(new Request(`http://worker.test/ws/${room}`, { headers }));
}

async function connect() {
  const res = await open();
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.addEventListener('message', (e: MessageEvent) => {
    const m = JSON.parse(e.data as string);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = () => new Promise<any>((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), 2000);
    waiters.push((m) => { clearTimeout(t); resolve(m); });
  });
  const send = (o: unknown) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  return { ws, next, send };
}

const member = { id: 'm1', name: 'Asha', leave: [{ date: '2026-11-03', portion: 1 }] };
const sprint = (over: Record<string, unknown> = {}) => ({
  fixedItems: [{ id: 'f1', label: 'Support', points: 3 }], spillOut: 2, spillIn: null, ...over,
});

// The same Durable Object is reused across tests, so start each one from an empty room.
beforeEach(async () => {
  const c = await connect();
  await c.next();
  c.send({ type: 'clear' });
  await c.next();
  c.ws.close();
});

describe('connection rules', () => {
  it('rejects a disallowed Origin with 403', async () => {
    expect((await open('playwright', 'https://evil.example')).status).toBe(403);
  });
  it('rejects a missing Origin with 403', async () => {
    expect((await open('playwright', null)).status).toBe(403);
  });
  it('returns 404 for any room other than playwright', async () => {
    expect((await open('other')).status).toBe(404);
    expect((await open('Playwright')).status).toBe(404);
  });
  it('returns 426 when not a websocket upgrade', async () => {
    const res = await exports.default.fetch(new Request('http://worker.test/ws/playwright', { headers: { Origin: ORIGIN } }));
    expect(res.status).toBe(426);
  });
  it('returns 404 for unknown paths and 200 for /health', async () => {
    expect((await exports.default.fetch(new Request('http://worker.test/nope'))).status).toBe(404);
    expect((await exports.default.fetch(new Request('http://worker.test/health'))).status).toBe(200);
  });
});

describe('state sync', () => {
  it('sends the default state on connect', async () => {
    const a = await connect();
    const m = await a.next();
    expect(m.type).toBe('state');
    expect(m.state.revision).toBe(0);
    expect(m.state.members).toEqual([]);
    expect(m.state.sprints).toEqual({});
    expect(m.state.sprintBase).toEqual({ number: 1, startDate: '', length: 14 });
    expect(m.state.expiresAt).toBeNull();
    expect('fixedPoints' in m.state).toBe(false);
  });

  it('applies a set, bumps revision and broadcasts to every socket', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', fields: { bufferPct: 15, pointsPerPersonDay: 2 } });
    const ma = await a.next();
    const mb = await b.next();
    for (const m of [ma, mb]) {
      expect(m.type).toBe('state');
      expect(m.state.revision).toBe(1);
      expect(m.state.bufferPct).toBe(15);
      expect(m.state.pointsPerPersonDay).toBe(2);
    }
  });

  it('echoes the message id as ack so a client can tell its own saves apart', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', id: 7, fields: { bufferPct: 3 } });
    expect((await a.next()).ack).toBe(7);
    expect((await b.next()).ack).toBe(7);
    b.send({ type: 'set', fields: { bufferPct: 4 } });
    expect((await a.next()).ack).toBeUndefined();
  });

  it('only changes the fields sent (per-field merge)', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', fields: { bufferPct: 5 } });
    await a.next(); await b.next();
    b.send({ type: 'set', fields: { pointsPerPersonDay: 3 } });
    const m = await a.next();
    expect(m.state.bufferPct).toBe(5);
    expect(m.state.pointsPerPersonDay).toBe(3);
    expect(m.state.revision).toBe(2);
  });

  it('persists members, with joined and left dates, for new connections', async () => {
    const a = await connect();
    await a.next();
    const people = [{ ...member, from: '2026-01-05', until: '2026-12-18' }];
    a.send({ type: 'set', fields: { members: people } });
    await a.next();
    a.ws.close();
    const b = await connect();
    expect((await b.next()).state.members).toEqual(people);
  });

  it('keeps data across a Durable Object restart', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { sprints: { 12: sprint() }, bufferPct: 9 } });
    await a.next();
    await evictDurableObject(stub());
    const b = await connect();
    const m = (await b.next()).state;
    expect(m.bufferPct).toBe(9);
    expect(m.sprints['12'].spillOut).toBe(2);
  });
});

describe('sprints merge per sprint', () => {
  it('a set with sprints only changes the keys sent', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', fields: { sprints: { 12: sprint({ spillOut: 1 }) } } });
    await a.next(); await b.next();
    b.send({ type: 'set', fields: { sprints: { 13: sprint({ spillOut: 5 }) } } });
    const m = await a.next();
    expect(Object.keys(m.state.sprints).sort()).toEqual(['12', '13']);
    expect(m.state.sprints['12'].spillOut).toBe(1); // not clobbered by the other editor
    expect(m.state.sprints['13'].spillOut).toBe(5);
  });

  it('replaces one sprint whole when its key is sent again', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { sprints: { 12: sprint() } } });
    await a.next();
    a.send({ type: 'set', fields: { sprints: { 12: { spillOut: 8 } } } });
    const m = await a.next();
    expect(m.state.sprints['12']).toEqual({ spillOut: 8 });
  });

  it('a null value deletes that sprint', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { sprints: { 12: sprint(), 13: sprint() } } });
    await a.next();
    a.send({ type: 'set', fields: { sprints: { 12: null } } });
    expect(Object.keys((await a.next()).state.sprints)).toEqual(['13']);
  });

  it('refuses to hold more than 100 sprints', async () => {
    const a = await connect();
    await a.next();
    const batch = (from: number, to: number) =>
      Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [String(from + i), sprint({ fixedItems: [] })]));
    a.send({ type: 'set', fields: { sprints: batch(1, 60) } });
    expect((await a.next()).type).toBe('state');
    a.send({ type: 'set', fields: { sprints: batch(61, 100) } });
    expect((await a.next()).type).toBe('state'); // exactly 100
    a.send({ type: 'set', fields: { sprints: { 101: sprint() } } });
    expect((await a.next()).type).toBe('error');
  });

  it('accepts the anchor sprint and sprint dates', async () => {
    const a = await connect();
    await a.next();
    const fields = {
      sprintBase: { number: 14, startDate: '2026-11-09', length: 14 },
      sprints: { 15: { startDate: '2026-11-23', endDate: '2026-12-11', spillIn: 0, spillOut: 0, fixedItems: [] } },
    };
    a.send({ type: 'set', fields });
    const m = await a.next();
    expect(m.state.sprintBase).toEqual(fields.sprintBase);
    expect(m.state.sprints['15'].endDate).toBe('2026-12-11');
  });
});

describe('validation', () => {
  const bad: [string, unknown][] = [
    ['unknown field', { hacker: 1 }],
    ['old single sprint field', { fixedPoints: 3 }],
    ['old sprint name field', { sprintName: 'x' }],
    ['non-number points', { pointsPerPersonDay: 'x' }],
    ['bufferPct over 100', { bufferPct: 101 }],
    ['negative bufferPct', { bufferPct: -1 }],
    ['bad weekend day', { weekendDays: [7] }],
    ['bad holiday', { holidays: ['nope'] }],
    ['anchor length 0', { sprintBase: { number: 1, startDate: '', length: 0 } }],
    ['anchor length 61', { sprintBase: { number: 1, startDate: '', length: 61 } }],
    ['anchor number 0', { sprintBase: { number: 0, startDate: '', length: 14 } }],
    ['anchor bad date', { sprintBase: { number: 1, startDate: '2026-13-45', length: 14 } }],
    ['anchor extra key', { sprintBase: { number: 1, startDate: '', length: 14, x: 1 } }],
    ['sprint key not a number', { sprints: { abc: sprint() } }],
    ['sprint key zero', { sprints: { 0: sprint() } }],
    ['sprint extra key', { sprints: { 12: { hack: 1 } } }],
    ['negative spillOut', { sprints: { 12: { spillOut: -1 } } }],
    ['spillIn text', { sprints: { 12: { spillIn: 'x' } } }],
    ['bad sprint start date', { sprints: { 12: { startDate: 'soon' } } }],
    ['fixed item negative points', { sprints: { 12: { fixedItems: [{ id: 'a', label: 'x', points: -2 }] } } }],
    ['fixed item without id', { sprints: { 12: { fixedItems: [{ id: '', label: 'x', points: 2 }] } } }],
    ['fixed item label too long', { sprints: { 12: { fixedItems: [{ id: 'a', label: 'x'.repeat(100), points: 2 }] } } }],
    ['too many fixed items', { sprints: { 12: { fixedItems: Array.from({ length: 31 }, (_, i) => ({ id: 'i' + i, label: 'x', points: 1 })) } } }],
    ['member without name', { members: [{ id: 'x', leave: [] }] }],
    ['member bad leave portion', { members: [{ id: 'x', name: 'A', leave: [{ date: '2026-11-03', portion: 2 }] }] }],
    ['member bad joined date', { members: [{ id: 'x', name: 'A', leave: [], from: 'yesterday' }] }],
    ['member extra key', { members: [{ id: 'x', name: 'A', leave: [], admin: true }] }],
    ['too many members', { members: Array.from({ length: 101 }, (_, i) => ({ id: 'm' + i, name: 'n' + i, leave: [] })) }],
  ];
  for (const [label, fields] of bad) {
    it(`rejects ${label} and leaves state untouched`, async () => {
      const a = await connect();
      await a.next();
      a.send({ type: 'set', fields });
      expect((await a.next()).type).toBe('error');
      a.send({ type: 'set', fields: { bufferPct: 1 } });
      expect((await a.next()).state.revision).toBe(1);
    });
  }

  it('rejects malformed JSON and unknown message types', async () => {
    const a = await connect();
    await a.next();
    a.send('{not json');
    expect((await a.next()).type).toBe('error');
    a.send({ type: 'explode' });
    expect((await a.next()).type).toBe('error');
  });

  it('rejects oversize messages', async () => {
    const a = await connect();
    await a.next();
    a.send(JSON.stringify({ type: 'set', fields: { bufferPct: 1 }, pad: 'y'.repeat(300_000) }));
    expect((await a.next()).type).toBe('error');
  });

  it('accepts a full import of every field', async () => {
    const a = await connect();
    await a.next();
    const fields = {
      sprintBase: { number: 14, startDate: '2026-11-09', length: 14 },
      sprints: { 14: sprint(), 15: sprint({ spillIn: 4 }) },
      weekendDays: [0, 6], holidays: ['2026-11-09'], members: [member],
      pointsPerPersonDay: 1.5, bufferPct: 20,
    };
    a.send({ type: 'set', fields });
    const m = await a.next();
    expect(m.type).toBe('state');
    expect(m.state).toMatchObject(fields);
  });
});

describe('moving old data to the multi sprint shape', () => {
  it('converts data saved by the first version when the room loads', async () => {
    const legacy = {
      revision: 6, updatedAt: 1000, expiresAt: Date.now() + 1000,
      sprintName: 'Sprint 9', dateMode: 'range', startDate: '2026-11-02', endDate: '2026-11-15', numDays: 14,
      weekendDays: [0, 6], holidays: ['2026-11-09'], members: [member],
      pointsPerPersonDay: 1.5, fixedPoints: 12, bufferPct: 20,
    };
    await runInDurableObject(stub(), (_i, s) => s.storage.put('state', legacy));
    await evictDurableObject(stub());

    const a = await connect();
    const m = (await a.next()).state;
    expect(m.sprintBase).toEqual({ number: 9, startDate: '2026-11-02', length: 14 });
    expect(m.sprints['9'].fixedItems[0].points).toBe(12);
    expect(m.members).toEqual([member]);
    expect(m.holidays).toEqual(['2026-11-09']);
    expect(m.bufferPct).toBe(20);
    for (const k of ['sprintName', 'dateMode', 'startDate', 'endDate', 'numDays', 'fixedPoints']) expect(k in m).toBe(false);

    const stored: any = await runInDurableObject(stub(), (_i, s) => s.storage.get('state'));
    expect('fixedPoints' in stored).toBe(false); // saved back in the new shape
  });

  it('new data is left as it is on restart', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { sprints: { 12: sprint() } } });
    const before = (await a.next()).state;
    await evictDurableObject(stub());
    const b = await connect();
    expect((await b.next()).state).toEqual(before);
  });
});

describe('retention (3 months)', () => {
  it('sets an alarm 90 days after every write and pushes it back on each edit', async () => {
    const a = await connect();
    await a.next();
    const before = Date.now();
    a.send({ type: 'set', fields: { bufferPct: 1 } });
    const m = await a.next();
    const alarm1 = await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm());
    expect(alarm1).not.toBeNull();
    expect(alarm1!).toBeGreaterThanOrEqual(before + NINETY_DAYS);
    expect(alarm1!).toBeLessThan(Date.now() + NINETY_DAYS + 5000);
    expect(m.state.expiresAt).toBe(alarm1);

    await new Promise((r) => setTimeout(r, 20));
    a.send({ type: 'set', fields: { bufferPct: 2 } });
    await a.next();
    const alarm2 = await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm());
    expect(alarm2!).toBeGreaterThan(alarm1!);
  });

  it('a sprint edit also pushes the deletion date back', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { bufferPct: 1 } });
    await a.next();
    const alarm1 = await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm());
    await new Promise((r) => setTimeout(r, 20));
    a.send({ type: 'set', fields: { sprints: { 12: sprint() } } });
    await a.next();
    expect((await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm()))!).toBeGreaterThan(alarm1!);
  });

  it('wipes all data when the alarm fires and tells connected clients', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { members: [member], sprints: { 12: sprint() } } });
    await a.next();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const m = await a.next();
    expect(m.type).toBe('state');
    expect(m.state.members).toEqual([]);
    expect(m.state.sprints).toEqual({});
    expect(m.state.expiresAt).toBeNull();
    expect(await runInDurableObject(stub(), (_i, s) => s.storage.get('state'))).toBeUndefined();
    const b = await connect();
    expect((await b.next()).state.members).toEqual([]);
  });

  it('does not schedule an alarm for a room that was never written', async () => {
    const a = await connect();
    await a.next();
    expect(await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  it('clear message deletes data and cancels the alarm', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', fields: { sprints: { 12: sprint() } } });
    await a.next(); await b.next();
    a.send({ type: 'clear' });
    const mb = await b.next();
    expect(mb.state.sprints).toEqual({});
    await a.next();
    expect(await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm())).toBeNull();
    expect(await runInDurableObject(stub(), (_i, s) => s.storage.get('state'))).toBeUndefined();
  });
});
