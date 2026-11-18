import { Room } from './room';

export { Room };

/** One room for now. Add names here (and passcodes later) to support more rooms. */
const ROOMS = new Set(['playwright']);

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') return new Response('ok');

    const m = /^\/ws\/([^/]+)$/.exec(url.pathname);
    if (!m) return new Response('Not found', { status: 404 });

    let room: string;
    try { room = decodeURIComponent(m[1]); } catch { return new Response('Not found', { status: 404 }); }
    if (!ROOMS.has(room)) return new Response('Not found', { status: 404 });

    const origin = request.headers.get('Origin');
    if (!origin || !allowedOrigins(env).includes(origin)) return new Response('Forbidden', { status: 403 });

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });

    const stub = env.ROOM.get(env.ROOM.idFromName(room));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
