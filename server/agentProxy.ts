// Dev/preview server middleware that calls Groq on the agent's behalf, so the API key
// never reaches the browser bundle. The endpoint builds its own prompt from a briefing;
// it does not forward arbitrary prompts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { ADVICE_SCHEMA, ADVISOR_MODEL, buildAdvisorMessages, parseAdvice, type AgentBriefing } from '../src/engine/advisor';

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

function middleware(apiKey: string | undefined): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url === '/api/agent/status' && req.method === 'GET') {
      send(res, 200, { configured: !!apiKey, model: ADVISOR_MODEL });
      return;
    }
    if (req.url !== '/api/agent/advise' || req.method !== 'POST') {
      next();
      return;
    }
    if (!apiKey) {
      send(res, 503, { error: 'GROQ_API_KEY is not set.' });
      return;
    }
    void (async () => {
      const started = Date.now();
      try {
        const { briefing } = (await readJson(req)) as { briefing: AgentBriefing };
        if (!briefing || !Array.isArray(briefing.options)) {
          send(res, 400, { error: 'Expected { briefing }.' });
          return;
        }
        const response = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            model: ADVISOR_MODEL,
            temperature: 0.2,
            reasoning_effort: 'low',
            messages: buildAdvisorMessages(briefing),
            response_format: { type: 'json_schema', json_schema: { name: 'recovery_advice', strict: true, schema: ADVICE_SCHEMA } },
          }),
        });
        const data = (await response.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
        if (!response.ok) {
          send(res, 502, { error: data.error?.message ?? `Groq returned ${response.status}` });
          return;
        }
        const advice = parseAdvice(data.choices?.[0]?.message?.content, briefing);
        if (!advice) {
          send(res, 502, { error: 'Model output failed validation.' });
          return;
        }
        send(res, 200, { advice, model: ADVISOR_MODEL, latencyMs: Date.now() - started });
      } catch (error) {
        send(res, 502, { error: error instanceof Error ? error.message : 'Advisor request failed.' });
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
