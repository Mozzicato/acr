// Where the live world is kept between requests. Serverless functions don't share memory, so on
// Vercel the world lives in Upstash Redis (add it from the Vercel Marketplace). Locally, and as a
// fallback, it lives in process memory, which is fine for a single dev server.

import { AcrEngine, createWorld, LIVE_WINDOWS, type World } from '../src/engine/agent.js';

const WORLD_KEY = 'acr:world:v2';
const LOCK_KEY = 'acr:lock:v2';
const LOCK_TTL_MS = 25_000;
const LOCK_WAIT_MS = 12_000;

export type Env = Record<string, string | undefined>;

export class Busy extends Error {}

export interface Store {
  kind: 'redis' | 'memory';
  load(): Promise<World | null>;
  save(world: World): Promise<void>;
  lock(): Promise<() => Promise<void>>;
}

export const newLiveWorld = (): World => createWorld({ clock: 'real', windows: LIVE_WINDOWS, level: 2 });

// ── In-memory (dev) ──
interface MemoryState {
  world: World | null;
  queue: Promise<void>;
}
const memory: MemoryState = ((globalThis as Record<string, unknown>).__acrMemory as MemoryState) ?? { world: null, queue: Promise.resolve() };
(globalThis as Record<string, unknown>).__acrMemory = memory;

const memoryStore: Store = {
  kind: 'memory',
  load: async () => (memory.world ? structuredClone(memory.world) : null),
  save: async (world) => {
    memory.world = structuredClone(world);
  },
  lock: () =>
    new Promise((acquired) => {
      memory.queue = memory.queue.then(() => new Promise<void>((release) => acquired(async () => release())));
    }),
};

// ── Upstash Redis (REST) ──
function redisStore(url: string, token: string): Store {
  const call = async (command: Array<string | number>): Promise<unknown> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`Redis: ${body.error ?? res.status}`);
    return body.result;
  };
  return {
    kind: 'redis',
    load: async () => {
      const raw = (await call(['GET', WORLD_KEY])) as string | null;
      return raw ? (JSON.parse(raw) as World) : null;
    },
    save: async (world) => {
      await call(['SET', WORLD_KEY, JSON.stringify(world)]);
    },
    lock: async () => {
      const owner = crypto.randomUUID();
      const deadline = Date.now() + LOCK_WAIT_MS;
      while ((await call(['SET', LOCK_KEY, owner, 'NX', 'PX', LOCK_TTL_MS])) !== 'OK') {
        if (Date.now() > deadline) throw new Busy('The bank is busy. Try again in a moment.');
        await new Promise((r) => setTimeout(r, 120));
      }
      return async () => {
        await call(['EVAL', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, LOCK_KEY, owner]);
      };
    },
  };
}

export function storeFor(env: Env): Store {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  return url && token ? redisStore(url, token) : memoryStore;
}

/** Loads the world (creating it on first use) without locking. For reads only. */
export async function read(store: Store): Promise<AcrEngine> {
  return new AcrEngine((await store.load()) ?? newLiveWorld());
}

/** Loads, changes and saves the world under a lock, so concurrent requests can't lose updates. */
export async function mutate<T>(store: Store, change: (engine: AcrEngine) => T): Promise<T> {
  const release = await store.lock();
  try {
    const engine = new AcrEngine((await store.load()) ?? newLiveWorld());
    const result = change(engine);
    engine.compact();
    await store.save(engine.world);
    return result;
  } finally {
    await release();
  }
}
