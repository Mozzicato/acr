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

export async function api<T>(path: string, options: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const params = new URLSearchParams({ path, ...options.query });
  const key = adminKey();
  const res = await fetch(`/api/router?${params}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data;
}
