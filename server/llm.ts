// Groq calls. The key stays server-side; prompts are built here from validated inputs, never
// forwarded from the client.

import {
  ADVICE_SCHEMA, ADVISOR_MODEL, buildAdvisorMessages, buildSupportMessages, parseAdvice,
  type AgentAdvice, type AgentBriefing, type ChatMessage, type SupportContext,
} from '../src/engine/advisor.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 7_000;

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

export async function advise(apiKey: string, briefing: AgentBriefing): Promise<{ advice: AgentAdvice; note: string }> {
  const started = Date.now();
  const content = await groq(apiKey, {
    temperature: 0.2,
    messages: buildAdvisorMessages(briefing),
    response_format: { type: 'json_schema', json_schema: { name: 'recovery_advice', strict: true, schema: ADVICE_SCHEMA } },
  });
  const advice = parseAdvice(content, briefing);
  if (!advice) throw new Error('Model output failed validation');
  return { advice, note: `${ADVISOR_MODEL} · ${((Date.now() - started) / 1000).toFixed(1)}s` };
}

export async function supportReply(apiKey: string, context: SupportContext, messages: ChatMessage[]): Promise<string> {
  const reply = (await groq(apiKey, { temperature: 0.4, max_completion_tokens: 600, messages: buildSupportMessages(context, messages) })).trim();
  if (!reply) throw new Error('Empty reply');
  return reply.slice(0, 800);
}
