// Live sync + autosave client. No DOM. Talks the room protocol (see worker/src/room.ts):
//   client -> { type: 'set', id, fields } | { type: 'clear' }
//   server -> { type: 'state', state, ack? } | { type: 'error', message }
//
// Local edits are shown at once ("pending"), sent after a short pause ("in flight"),
// and kept on screen until the server acknowledges them, so other people's edits
// never make a field flicker back. Offline edits are re-sent after reconnecting.

const OPEN = 1;
// Map fields merge key by key instead of being replaced whole: two people editing
// different sprints never overwrite each other. A null value deletes that key.
const MAP_FIELDS = ['sprints'];
const BACKOFF = [1000, 2000, 4000, 8000, 15000];

export class SyncClient {
  constructor({ url, WebSocketImpl = globalThis.WebSocket, debounceMs = 500, initial = {}, onState = () => {}, onStatus = () => {} }) {
    this.url = url;
    this.WS = WebSocketImpl;
    this.debounceMs = debounceMs;
    this.onState = onState;
    this.onStatus = onStatus;
    this.server = { ...initial };
    this.state = { ...initial };
    this.pending = {};
    this.inflight = new Map(); // id -> fields
    this.status = 'connecting';
    this.clientId = Math.random().toString(36).slice(2, 8);
    this.seq = 0;
    this.attempt = 0;
    this.synced = false; // got a state message on the current connection
    this.closed = false;
    this.ws = null;
    this.flushTimer = null;
    this.retryTimer = null;
  }

  connect() {
    if (this.closed) return;
    this.synced = false;
    this.setStatus('connecting');
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => { if (this.ws === ws) this.attempt = 0; });
    ws.addEventListener('message', (e) => { if (this.ws === ws) this.handle(e.data); });
    ws.addEventListener('close', () => { if (this.ws === ws) this.dropped(); });
    ws.addEventListener('error', () => { /* a close event follows */ });
  }

  /** Apply fields locally right now and save them shortly after. */
  update(fields) {
    this.pending = mergeFields(this.pending, fields);
    this.recompute();
    this.onState(this.state);
    if (this.connected()) this.setStatus('saving');
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Send pending edits now. Used when the page is being hidden or closed. */
  flushNow() {
    clearTimeout(this.flushTimer);
    this.flush();
  }

  /** Delete all room data on the server. Returns false when not connected. */
  clear() {
    if (!this.connected()) return false;
    this.ws.send(JSON.stringify({ type: 'clear' }));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  // ---- internals ----

  connected() { return this.ws && this.ws.readyState === OPEN; }

  setStatus(status, info = {}) {
    this.status = status;
    this.onStatus(status, info);
  }

  recompute() {
    let s = { ...this.server };
    for (const f of this.inflight.values()) s = overlay(s, f);
    this.state = overlay(s, this.pending);
  }

  busy() { return this.inflight.size > 0 || Object.keys(this.pending).length > 0; }

  flush() {
    if (!this.connected() || !this.synced || Object.keys(this.pending).length === 0) return;
    const id = `${this.clientId}-${++this.seq}`;
    const fields = this.pending;
    this.pending = {};
    this.inflight.set(id, fields);
    this.ws.send(JSON.stringify({ type: 'set', id, fields }));
  }

  handle(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg?.type === 'state' && msg.state && typeof msg.state === 'object') {
      this.server = msg.state;
      this.synced = true;
      if (msg.ack !== undefined) this.inflight.delete(msg.ack);
      this.recompute();
      this.onState(this.state);
      if (this.busy()) {
        this.setStatus('saving');
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.flush(), this.debounceMs);
      } else {
        this.setStatus('saved', { savedAt: msg.state.updatedAt ?? Date.now() });
      }
    } else if (msg?.type === 'error') {
      this.inflight.clear(); // the server rejected an edit; fall back to server values
      this.recompute();
      this.onState(this.state);
      this.setStatus('error', { message: String(msg.message ?? 'Save failed') });
    }
  }

  dropped() {
    if (this.closed) return;
    // anything not acknowledged may or may not have been applied; sending again is safe
    let carried = {};
    for (const f of this.inflight.values()) carried = mergeFields(carried, f);
    this.pending = mergeFields(carried, this.pending);
    this.inflight.clear();
    this.synced = false;
    this.setStatus('offline');
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}

/** Combine two sets of edits; later wins. Map fields combine per key. */
function mergeFields(a, b) {
  const out = { ...a, ...b };
  for (const k of MAP_FIELDS) if (k in a && k in b) out[k] = { ...a[k], ...b[k] };
  return out;
}

/** Show `edits` on top of `state`. Map fields combine per key; null removes the key. */
function overlay(state, edits) {
  const out = { ...state, ...edits };
  for (const k of MAP_FIELDS) {
    if (!(k in edits)) continue;
    const merged = { ...(state[k] ?? {}), ...edits[k] };
    for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
    out[k] = merged;
  }
  return out;
}
