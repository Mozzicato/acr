// Browser client for the API router (same origin; /api/router?path=...).

const ADMIN_KEY_STORAGE = 'acr.adminKey';

/** Picks up ?key= once, so the presenter can open the console with their admin key. */
export function adminKey(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get('key');
    if (fromUrl) localStorage.setItem(ADMIN_KEY_STORAGE, fromUrl);
    return localStorage.getItem(ADMIN_KEY_STORAGE);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);

/** Serverless without Redis has one private bank per instance, so the bank runs and is saved in this browser instead. */
let mode: Promise<'server' | 'local'> | null = null;
export const apiMode = (): Promise<'server' | 'local'> => (mode ??= (async () => {
  try {
    const res = await fetch('/api/router?path=status', { signal: AbortSignal.timeout(8_000) });
    const status = (await res.json()) as { shared?: boolean };
    return status.shared === false ? 'local' : 'server';
  } catch {
    return onLocalhost ? 'server' : 'local';
  }
})());

async function send(params: URLSearchParams, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs: number): Promise<Response> {
  if ((await apiMode()) === 'server') return fetch(`/api/router?${params}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const [{ handle }, { localStore }] = await Promise.all([import('../server/router'), import('./localStore')]);
  return handle(new Request(`${location.origin}/api/router?${params}`, init), {}, localStore);
}

export async function api<T>(path: string, options: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const params = new URLSearchParams({ path, ...options.query });
  const key = adminKey();
  const res = await send(params, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }, options.timeoutMs ?? 30_000);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data;
}
