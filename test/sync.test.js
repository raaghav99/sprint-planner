import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../web/sync.js';

class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    this.listeners = {};
    FakeWS.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, ev = {}) { (this.listeners[type] || []).forEach((fn) => fn(ev)); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit('close'); }
  // test helpers
  serverOpen() { this.readyState = 1; this.emit('open'); }
  serverSend(o) { this.emit('message', { data: typeof o === 'string' ? o : JSON.stringify(o) }); }
  serverDrop() { this.readyState = 3; this.emit('close'); }
  sets() { return this.sent.filter((m) => m.type === 'set'); }
}

const base = (over = {}) => ({ revision: 0, sprintName: '', fixedPoints: 0, bufferPct: 0, members: [], ...over });
let events, client;
const last = () => FakeWS.instances[FakeWS.instances.length - 1];

function make(opts = {}) {
  events = { states: [], statuses: [] };
  client = new SyncClient({
    url: 'ws://x/ws/playwright',
    WebSocketImpl: FakeWS,
    debounceMs: 500,
    initial: base(),
    onState: (s) => events.states.push(s),
    onStatus: (st, info) => events.statuses.push([st, info]),
    ...opts,
  });
  return client;
}
const statusNow = () => events.statuses[events.statuses.length - 1]?.[0];

beforeEach(() => {
  FakeWS.instances = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
});
afterEach(() => { client?.close(); mock.timers.reset(); });

test('connects, shows connecting, then saved with server state', () => {
  make().connect();
  assert.equal(statusNow(), 'connecting');
  last().serverOpen();
  last().serverSend({ type: 'state', state: base({ revision: 3, sprintName: 'S14', updatedAt: 999 }) });
  assert.equal(client.state.sprintName, 'S14');
  assert.equal(statusNow(), 'saved');
  assert.equal(events.statuses.at(-1)[1].savedAt, 999);
});

test('update applies locally at once and flags saving; sends nothing until debounce', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ fixedPoints: 5 });
  assert.equal(client.state.fixedPoints, 5);
  assert.equal(statusNow(), 'saving');
  assert.equal(last().sets().length, 0);
  mock.timers.tick(499);
  assert.equal(last().sets().length, 0);
  mock.timers.tick(1);
  assert.equal(last().sets().length, 1);
  assert.deepEqual(last().sets()[0].fields, { fixedPoints: 5 });
  assert.ok(last().sets()[0].id);
});

test('rapid edits are batched into one message, last value wins', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ fixedPoints: 1 });
  mock.timers.tick(300);
  client.update({ fixedPoints: 2, bufferPct: 10 });
  mock.timers.tick(300); // debounce restarts on each edit
  assert.equal(last().sets().length, 0);
  mock.timers.tick(200);
  assert.equal(last().sets().length, 1);
  assert.deepEqual(last().sets()[0].fields, { fixedPoints: 2, bufferPct: 10 });
});

test('ack from server marks saved with the server time', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ fixedPoints: 5 });
  mock.timers.tick(500);
  const id = last().sets()[0].id;
  last().serverSend({ type: 'state', ack: id, state: base({ revision: 1, fixedPoints: 5, updatedAt: 5000 }) });
  assert.equal(statusNow(), 'saved');
  assert.equal(events.statuses.at(-1)[1].savedAt, 5000);
});

test('a remote change does not overwrite a field with a pending local edit', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ fixedPoints: 9 });
  last().serverSend({ type: 'state', state: base({ revision: 1, fixedPoints: 1, bufferPct: 30 }) });
  assert.equal(client.state.fixedPoints, 9); // mine, still pending
  assert.equal(client.state.bufferPct, 30); // theirs
});

test('in-flight fields stay on screen until our own ack (no flicker from others)', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ fixedPoints: 9 });
  mock.timers.tick(500);
  const id = last().sets()[0].id;
  last().serverSend({ type: 'state', state: base({ revision: 1, bufferPct: 30 }) }); // someone else's change, no ack
  assert.equal(client.state.fixedPoints, 9);
  last().serverSend({ type: 'state', ack: id, state: base({ revision: 2, fixedPoints: 9, bufferPct: 30 }) });
  assert.equal(client.state.fixedPoints, 9);
  assert.equal(statusNow(), 'saved');
});

test('acks for ids this client never sent are ignored', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ fixedPoints: 9 });
  mock.timers.tick(500);
  last().serverSend({ type: 'state', ack: 'someone-elses', state: base({ revision: 1 }) });
  assert.equal(statusNow(), 'saving');
  assert.equal(client.state.fixedPoints, 9);
});

test('offline: status offline, edits kept, reconnect with backoff, flushed on reconnect', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  last().serverDrop();
  assert.equal(statusNow(), 'offline');
  client.update({ sprintName: 'while offline' });
  mock.timers.tick(600);
  assert.equal(FakeWS.instances.length, 1); // reconnect not due yet (first retry at 1000ms)
  mock.timers.tick(500);
  assert.equal(FakeWS.instances.length, 2);
  const ws2 = last();
  ws2.serverOpen();
  ws2.serverSend({ type: 'state', state: base({ revision: 4 }) });
  mock.timers.tick(500);
  assert.deepEqual(ws2.sets().at(-1).fields, { sprintName: 'while offline' });
  assert.equal(client.state.sprintName, 'while offline');
});

test('an unacked in-flight edit is re-sent after reconnect', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ fixedPoints: 7 });
  mock.timers.tick(500);
  assert.equal(last().sets().length, 1);
  last().serverDrop();
  mock.timers.tick(1000);
  const ws2 = last();
  ws2.serverOpen();
  ws2.serverSend({ type: 'state', state: base() });
  mock.timers.tick(500);
  assert.deepEqual(ws2.sets()[0].fields, { fixedPoints: 7 });
  assert.equal(client.state.fixedPoints, 7);
});

test('backoff grows to a 15s cap and resets after a successful connection', () => {
  make().connect();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    const before = FakeWS.instances.length;
    last().serverDrop();
    let waited = 0;
    while (FakeWS.instances.length === before && waited < 20000) { mock.timers.tick(250); waited += 250; }
    delays.push(waited);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  last().serverOpen();
  last().serverSend({ type: 'state', state: base() });
  last().serverDrop();
  const before = FakeWS.instances.length;
  mock.timers.tick(1000);
  assert.equal(FakeWS.instances.length, before + 1);
});

test('server error sets error status and reverts the rejected edit', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base({ fixedPoints: 1 }) });
  client.update({ fixedPoints: 5 });
  mock.timers.tick(500);
  last().serverSend({ type: 'error', message: 'Invalid value for "fixedPoints"' });
  assert.equal(statusNow(), 'error');
  assert.match(events.statuses.at(-1)[1].message, /fixedPoints/);
  assert.equal(client.state.fixedPoints, 1);
});

test('clear sends a clear message when connected, returns false when offline', () => {
  make().connect();
  assert.equal(client.clear(), false);
  last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  assert.equal(client.clear(), true);
  assert.deepEqual(last().sent.at(-1), { type: 'clear' });
});

test('close stops reconnecting', () => {
  make().connect(); last().serverOpen();
  client.close();
  mock.timers.tick(60000);
  assert.equal(FakeWS.instances.length, 1);
});

test('ignores malformed or unknown messages', () => {
  make().connect(); last().serverOpen();
  last().serverSend('{nope');
  last().serverSend({ type: 'mystery' });
  last().serverSend({ type: 'state' });
  assert.equal(events.states.length, 0);
});

test('edits made before the first server state are kept and sent once connected', () => {
  make().connect();
  client.update({ sprintName: 'early' });
  last().serverOpen();
  last().serverSend({ type: 'state', state: base({ sprintName: 'server' }) });
  assert.equal(client.state.sprintName, 'early');
  mock.timers.tick(500);
  assert.deepEqual(last().sets()[0].fields, { sprintName: 'early' });
});

// ---------- per-sprint merge ("sprints" is a map; each key merges on its own) ----------
const sp = (o) => ({ fixedItems: [], spillOut: 0, spillIn: null, ...o });

test('sprints edits merge per sprint, so edits to different sprints are sent together', () => {
  make({ initial: base({ sprints: { 13: sp({ spillOut: 1 }) } }) }).connect();
  last().serverOpen(); last().serverSend({ type: 'state', state: base({ sprints: { 13: sp({ spillOut: 1 }) } }) });
  client.update({ sprints: { 12: sp({ spillOut: 2 }) } });
  client.update({ sprints: { 14: sp({ spillOut: 3 }) } });
  assert.deepEqual(Object.keys(client.state.sprints).sort(), ['12', '13', '14']);
  mock.timers.tick(500);
  assert.deepEqual(Object.keys(last().sets()[0].fields.sprints).sort(), ['12', '14']); // only what changed
});

test('a null sprint entry deletes that sprint locally', () => {
  make({ initial: base({ sprints: { 12: sp({}) } }) }).connect();
  last().serverOpen(); last().serverSend({ type: 'state', state: base({ sprints: { 12: sp({}), 13: sp({}) } }) });
  client.update({ sprints: { 12: null } });
  assert.deepEqual(Object.keys(client.state.sprints), ['13']);
});

test('a remote edit to another sprint does not disturb my pending sprint edit', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base({ sprints: {} }) });
  client.update({ sprints: { 12: sp({ spillOut: 9 }) } });
  last().serverSend({ type: 'state', state: base({ revision: 1, sprints: { 12: sp({ spillOut: 1 }), 13: sp({ spillOut: 5 }) } }) });
  assert.equal(client.state.sprints[12].spillOut, 9); // mine, still pending
  assert.equal(client.state.sprints[13].spillOut, 5); // theirs
});

test('in-flight sprint edits stay visible until acknowledged', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base({ sprints: {} }) });
  client.update({ sprints: { 12: sp({ spillOut: 9 }) } });
  mock.timers.tick(500);
  const id = last().sets()[0].id;
  last().serverSend({ type: 'state', state: base({ revision: 1, sprints: { 13: sp({}) } }) });
  assert.equal(client.state.sprints[12].spillOut, 9);
  last().serverSend({ type: 'state', ack: id, state: base({ revision: 2, sprints: { 12: sp({ spillOut: 9 }), 13: sp({}) } }) });
  assert.equal(client.state.sprints[12].spillOut, 9);
  assert.equal(statusNow(), 'saved');
});

// ---------- flushNow (page is closing or hidden) ----------
test('flushNow sends pending edits immediately instead of waiting for the pause', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.update({ bufferPct: 5 });
  assert.equal(last().sets().length, 0);
  client.flushNow();
  assert.equal(last().sets().length, 1);
  assert.deepEqual(last().sets()[0].fields, { bufferPct: 5 });
  mock.timers.tick(1000);
  assert.equal(last().sets().length, 1); // the timer does not send it again
});

test('flushNow does nothing when there is nothing to send, or when offline', () => {
  make().connect(); last().serverOpen(); last().serverSend({ type: 'state', state: base() });
  client.flushNow();
  assert.equal(last().sets().length, 0);
  last().serverDrop();
  client.update({ bufferPct: 5 });
  assert.doesNotThrow(() => client.flushNow());
});
