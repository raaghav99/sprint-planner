import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_FIELDS, MAX_MESSAGE_BYTES, mergeSprints, validateFields, type RoomState } from './validate';
import { LEGACY_KEYS, migrateState } from '../../web/migrate.js';

/** Data is wiped 3 months (90 days) after the last edit. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const freshState = (revision = 0): RoomState => ({
  ...structuredClone(DEFAULT_FIELDS),
  revision,
  updatedAt: null,
  expiresAt: null,
});

export class Room extends DurableObject<Env> {
  private state: RoomState = freshState();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<RoomState>('state');
      if (stored) {
        // data saved by the first (single sprint) version is converted once, here
        const legacy = LEGACY_KEYS.some((k) => k in stored);
        this.state = { ...freshState(), ...(migrateState(stored) as Partial<RoomState>) };
        if (legacy) await ctx.storage.put('state', this.state);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'state', state: this.state }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const reply = (o: unknown) => ws.send(JSON.stringify(o));
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) return reply({ type: 'error', message: 'Message too large' });

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return reply({ type: 'error', message: 'Invalid JSON' });
    }

    if (msg?.type === 'set') {
      const v = validateFields(msg.fields);
      if (!v.ok) return reply({ type: 'error', message: v.error });
      const { sprints: partial, ...rest } = v.fields;
      let sprints = this.state.sprints;
      if (partial) {
        const merged = mergeSprints(sprints, partial as never);
        if (!merged) return reply({ type: 'error', message: 'Too many sprints' });
        sprints = merged;
      }
      const now = Date.now();
      this.state = { ...this.state, ...rest, sprints, revision: this.state.revision + 1, updatedAt: now, expiresAt: now + RETENTION_MS };
      await this.ctx.storage.put('state', this.state);
      await this.ctx.storage.setAlarm(this.state.expiresAt!);
      return this.broadcast(msg.id);
    }

    if (msg?.type === 'clear') {
      await this.wipe();
      return this.broadcast();
    }

    return reply({ type: 'error', message: 'Unknown message type' });
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
  }

  /** Retention: nobody edited for 90 days, so delete everything. */
  async alarm(): Promise<void> {
    await this.wipe();
    this.broadcast();
  }

  private async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.state = freshState();
  }

  /** `ack` is the id of the client message that caused this change (if it sent one). */
  private broadcast(ack?: unknown): void {
    const safeAck = typeof ack === 'number' || typeof ack === 'string' ? ack : undefined;
    const payload = JSON.stringify({ type: 'state', state: this.state, ack: safeAck });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* socket gone */ }
    }
  }
}
