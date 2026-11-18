import { describe, it, expect, beforeEach } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';

const ORIGIN = 'http://localhost:8080';
const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

function stub() {
  return env.ROOM.get(env.ROOM.idFromName('playwright'));
}

async function open(room = 'playwright', origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (origin) headers.Origin = origin;
  const res = await exports.default.fetch(new Request(`http://worker.test/ws/${room}`, { headers }));
  return res;
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
  it('sends default state on connect', async () => {
    const a = await connect();
    const m = await a.next();
    expect(m.type).toBe('state');
    expect(m.state.revision).toBe(0);
    expect(m.state.members).toEqual([]);
    expect(m.state.dateMode).toBe('range');
    expect(m.state.expiresAt).toBeNull();
  });

  it('applies a set, bumps revision and broadcasts to every socket', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', fields: { sprintName: 'Sprint 14', fixedPoints: 12 } });
    const ma = await a.next();
    const mb = await b.next();
    for (const m of [ma, mb]) {
      expect(m.type).toBe('state');
      expect(m.state.revision).toBe(1);
      expect(m.state.sprintName).toBe('Sprint 14');
      expect(m.state.fixedPoints).toBe(12);
    }
  });

  it('echoes the message id as ack so a client can tell its own saves apart', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', id: 7, fields: { fixedPoints: 3 } });
    expect((await a.next()).ack).toBe(7);
    expect((await b.next()).ack).toBe(7); // same payload; b ignores ids it never sent
    b.send({ type: 'set', fields: { fixedPoints: 4 } });
    expect((await a.next()).ack).toBeUndefined();
  });

  it('only changes the fields sent (per-field merge, no clobbering)', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', fields: { fixedPoints: 5 } });
    await a.next(); await b.next();
    b.send({ type: 'set', fields: { bufferPct: 20 } });
    const m = await a.next();
    expect(m.state.fixedPoints).toBe(5);
    expect(m.state.bufferPct).toBe(20);
    expect(m.state.revision).toBe(2);
  });

  it('persists members and leave, and a new connection sees them', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { members: [member] } });
    await a.next();
    a.ws.close();
    const b = await connect();
    const m = await b.next();
    expect(m.state.members).toEqual([member]);
  });

  it('keeps data across a Durable Object restart', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { sprintName: 'Persist me' } });
    await a.next();
    await runInDurableObject(stub(), async (_i, state) => {
      // new in-memory state is rebuilt from storage
      expect(await state.storage.get('state')).toBeTruthy();
    });
    const b = await connect();
    expect((await b.next()).state.sprintName).toBe('Persist me');
  });
});

describe('validation', () => {
  const bad: [string, unknown][] = [
    ['unknown field', { hacker: 1 }],
    ['bad dateMode', { dateMode: 'weeks' }],
    ['bad start date', { startDate: '2026-13-45' }],
    ['numDays too big', { numDays: 9999 }],
    ['negative fixedPoints', { fixedPoints: -1 }],
    ['bufferPct over 100', { bufferPct: 101 }],
    ['non-number points', { pointsPerPersonDay: 'x' }],
    ['bad weekend day', { weekendDays: [7] }],
    ['bad holiday', { holidays: ['nope'] }],
    ['member without name', { members: [{ id: 'x', leave: [] }] }],
    ['bad leave portion', { members: [{ id: 'x', name: 'A', leave: [{ date: '2026-11-03', portion: 2 }] }] }],
    ['too many members', { members: Array.from({ length: 101 }, (_, i) => ({ id: 'm' + i, name: 'n' + i, leave: [] })) }],
    ['sprintName too long', { sprintName: 'x'.repeat(200) }],
  ];
  for (const [label, fields] of bad) {
    it(`rejects ${label} and leaves state untouched`, async () => {
      const a = await connect();
      await a.next();
      a.send({ type: 'set', fields });
      const m = await a.next();
      expect(m.type).toBe('error');
      a.send({ type: 'set', fields: { sprintName: 'ok' } });
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
    a.send(JSON.stringify({ type: 'set', fields: { sprintName: 'x' }, pad: 'y'.repeat(300_000) }));
    expect((await a.next()).type).toBe('error');
  });

  it('accepts a full import of every field', async () => {
    const a = await connect();
    await a.next();
    const fields = {
      sprintName: 'S', dateMode: 'days', startDate: '2026-11-02', endDate: '', numDays: 14,
      weekendDays: [0, 6], holidays: ['2026-11-09'], members: [member],
      pointsPerPersonDay: 1.5, fixedPoints: 10, bufferPct: 20,
    };
    a.send({ type: 'set', fields });
    const m = await a.next();
    expect(m.type).toBe('state');
    expect(m.state).toMatchObject(fields);
  });
});

describe('retention (3 months)', () => {
  it('sets an alarm 90 days after every write and pushes it back on each edit', async () => {
    const a = await connect();
    await a.next();
    const before = Date.now();
    a.send({ type: 'set', fields: { fixedPoints: 1 } });
    const m = await a.next();
    const alarm1 = await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm());
    expect(alarm1).not.toBeNull();
    expect(alarm1!).toBeGreaterThanOrEqual(before + NINETY_DAYS);
    expect(alarm1!).toBeLessThan(Date.now() + NINETY_DAYS + 5000);
    expect(m.state.expiresAt).toBe(alarm1);

    await new Promise((r) => setTimeout(r, 20));
    a.send({ type: 'set', fields: { fixedPoints: 2 } });
    await a.next();
    const alarm2 = await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm());
    expect(alarm2!).toBeGreaterThan(alarm1!);
  });

  it('wipes all data when the alarm fires and tells connected clients', async () => {
    const a = await connect();
    await a.next();
    a.send({ type: 'set', fields: { members: [member], sprintName: 'old' } });
    await a.next();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const m = await a.next();
    expect(m.type).toBe('state');
    expect(m.state.members).toEqual([]);
    expect(m.state.sprintName).toBe('');
    expect(m.state.expiresAt).toBeNull();
    const stored = await runInDurableObject(stub(), (_i, s) => s.storage.get('state'));
    expect(stored).toBeUndefined();
    const b = await connect();
    expect((await b.next()).state.members).toEqual([]);
  });

  it('does not schedule an alarm for a room that was never written', async () => {
    const a = await connect();
    await a.next();
    const alarm = await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm());
    expect(alarm).toBeNull();
  });

  it('clear message deletes data and cancels the alarm', async () => {
    const a = await connect();
    const b = await connect();
    await a.next(); await b.next();
    a.send({ type: 'set', fields: { sprintName: 'bye' } });
    await a.next(); await b.next();
    a.send({ type: 'clear' });
    const mb = await b.next();
    expect(mb.state.sprintName).toBe('');
    await a.next();
    expect(await runInDurableObject(stub(), (_i, s) => s.storage.getAlarm())).toBeNull();
    expect(await runInDurableObject(stub(), (_i, s) => s.storage.get('state'))).toBeUndefined();
  });
});
