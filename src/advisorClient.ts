import type { AgentAdvice, AgentBriefing } from './engine/advisor';

export interface AdvisorStatus {
  configured: boolean;
  model: string;
}

export async function getAdvisorStatus(): Promise<AdvisorStatus> {
  try {
    const res = await fetch('/api/agent/status');
    if (!res.ok) throw new Error();
    return (await res.json()) as AdvisorStatus;
  } catch {
    return { configured: false, model: 'unavailable' };
  }
}

export async function requestAdvice(briefing: AgentBriefing): Promise<{ advice: AgentAdvice; model: string; latencyMs: number }> {
  const res = await fetch('/api/agent/advise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ briefing }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = (await res.json()) as { advice?: AgentAdvice; model?: string; latencyMs?: number; error?: string };
  if (!res.ok || !body.advice) throw new Error(body.error ?? `Advisor returned ${res.status}`);
  return { advice: body.advice, model: body.model ?? 'LLM', latencyMs: body.latencyMs ?? 0 };
}
