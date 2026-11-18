// Where the page finds its backend. Edit PROD_WORKER_URL after `wrangler deploy`.
export const ROOM_ID = 'playwright';

const PROD_WORKER_URL = 'wss://sprint-planner.temp66081.workers.dev';
const LOCAL_WORKER_URL = 'ws://localhost:8787';

const isLocal = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);
export const WORKER_URL = isLocal ? LOCAL_WORKER_URL : PROD_WORKER_URL;
