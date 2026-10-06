// Serves /api/router from the Vite dev and preview servers, so local development runs the same
// router as the Vercel function.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { handle } from './router.js';
import type { Env } from './store.js';

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function middleware(env: Env): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (!req.url?.startsWith('/api/router')) {
      next();
      return;
    }
    void toRequest(req).then((request) => handle(request, env)).then((response) => send(res, response));
  };
}

export function apiPlugin(env: Env): Plugin {
  return {
    name: 'acr-api',
    configureServer: (server) => void server.middlewares.use(middleware(env)),
    configurePreviewServer: (server) => void server.middlewares.use(middleware(env)),
  };
}
