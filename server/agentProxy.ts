// Dev/preview server middleware that calls Groq on the app's behalf, so the API key never reaches
// the browser bundle. Each endpoint builds its own prompt; neither forwards arbitrary prompts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import {
  ADVICE_SCHEMA, ADVISOR_MODEL, MAX_CHAT_MESSAGES, buildAdvisorMessages, buildSupportMessages, parseAdvice,
  type AgentBriefing, type ChatMessage, type SupportContext,
} from '../src/engine/advisor';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function groq(apiKey: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model: ADVISOR_MODEL, reasoning_effort: 'low', ...body }),
  });
  const data = (await response.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
  if (!response.ok) throw new Error(data.error?.message ?? `Groq returned ${response.status}`);
  return data.choices?.[0]?.message?.content ?? '';
}

type Handler = (body: unknown, apiKey: string) => Promise<{ status: number; body: unknown }>;

const advise: Handler = async (body, apiKey) => {
  const { briefing } = body as { briefing: AgentBriefing };
  if (!briefing || !Array.isArray(briefing.options)) return { status: 400, body: { error: 'Expected { briefing }.' } };
  const started = Date.now();
  const content = await groq(apiKey, {
    temperature: 0.2,
    messages: buildAdvisorMessages(briefing),
    response_format: { type: 'json_schema', json_schema: { name: 'recovery_advice', strict: true, schema: ADVICE_SCHEMA } },
  });
  const advice = parseAdvice(content, briefing);
  if (!advice) return { status: 502, body: { error: 'Model output failed validation.' } };
  return { status: 200, body: { advice, model: ADVISOR_MODEL, latencyMs: Date.now() - started } };
};

const chat: Handler = async (body, apiKey) => {
  const { context, messages } = body as { context: SupportContext; messages: ChatMessage[] };
  const valid = context && typeof context.customerName === 'string' && Array.isArray(messages) && messages.length > 0
    && messages.length <= MAX_CHAT_MESSAGES && messages.every((m) => (m.role === 'customer' || m.role === 'assistant') && typeof m.text === 'string');
  if (!valid) return { status: 400, body: { error: 'Expected { context, messages }.' } };
  const reply = (await groq(apiKey, { temperature: 0.4, max_completion_tokens: 600, messages: buildSupportMessages(context, messages) })).trim();
  if (!reply) return { status: 502, body: { error: 'Empty reply.' } };
  return { status: 200, body: { reply: reply.slice(0, 800), model: ADVISOR_MODEL } };
};

const ROUTES: Record<string, Handler> = {
  '/api/agent/advise': advise,
  '/api/support/chat': chat,
};

function middleware(apiKey: string | undefined): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url === '/api/agent/status' && req.method === 'GET') {
      send(res, 200, { configured: !!apiKey, model: ADVISOR_MODEL });
      return;
    }
    const handler = req.method === 'POST' && req.url ? ROUTES[req.url] : undefined;
    if (!handler) {
      next();
      return;
    }
    if (!apiKey) {
      send(res, 503, { error: 'GROQ_API_KEY is not set.' });
      return;
    }
    void (async () => {
      try {
        const result = await handler(await readJson(req), apiKey);
        send(res, result.status, result.body);
      } catch (error) {
        send(res, 502, { error: error instanceof Error ? error.message : 'Request failed.' });
      }
    })();
  };
}

export function agentProxy(apiKey: string | undefined): Plugin {
  const key = apiKey?.trim() || undefined;
  return {
    name: 'acr-agent-proxy',
    configureServer: (server) => void server.middlewares.use(middleware(key)),
    configurePreviewServer: (server) => void server.middlewares.use(middleware(key)),
  };
}
