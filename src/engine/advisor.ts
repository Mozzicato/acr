// The LLM's role (PRD §9, §13): summarize the evidence and choose among policy-permitted options.
// It cannot invent actions or call tools; the policy engine still has the final say.

import type { ActionId } from './types';

export const ADVISOR_MODEL = 'openai/gpt-oss-120b';

export interface AgentBriefing {
  incidentId: string;
  failureType: string;
  situation: string;
  promise: string;
  orderId: string;
  item: string;
  customer: { name: string; tier: string; previousDelays: number };
  signals: string[];
  evidence: string[];
  rootCause: string | null;
  options: Array<{
    action: ActionId;
    label: string;
    successProbability: number;
    costNgn: number;
    customerImpact: string;
    policy: string;
    permitted: boolean;
    policyReason: string;
  }>;
}

export interface AgentAdvice {
  diagnosis: string;
  selectedAction: ActionId;
  rationale: string;
  confidence: number;
}

export const ADVICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis', 'selectedAction', 'rationale', 'confidence'],
  properties: {
    diagnosis: { type: 'string', description: 'One or two sentences: what went wrong and why, grounded only in the evidence.' },
    selectedAction: { type: 'string', enum: ['reassign_courier', 'recreate_order', 'delay_with_credit', 'refund', 'human_review'] },
    rationale: { type: 'string', description: 'One or two sentences on why this option best recovers the customer.' },
    confidence: { type: 'number', description: 'Confidence in the diagnosis, 0 to 1.' },
  },
} as const;

const SYSTEM_PROMPT = `You are the diagnosis and recovery-planning agent inside ACR (Autonomous Customer Recovery) for an e-commerce company in Lagos.
A deterministic detector has flagged a customer journey at risk, and read-only tools have gathered evidence.
Your job:
1. Diagnose the root cause using ONLY the evidence provided. Do not invent facts.
2. Choose exactly one recovery option. You MUST choose an option marked permitted=true; options with permitted=false are blocked by policy and will be rejected.
3. Prefer the option that keeps the promise made to the customer with the lowest cost and customer impact.
Be concise and concrete. Name couriers, times and amounts from the evidence.`;

export function buildAdvisorMessages(briefing: AgentBriefing): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(briefing, null, 2) },
  ];
}

/** Validates model output against the briefing. Returns null when it can't be trusted. */
export function parseAdvice(raw: unknown, briefing: AgentBriefing): AgentAdvice | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const option = briefing.options.find((o) => o.action === v.selectedAction);
  if (!option || typeof v.diagnosis !== 'string' || typeof v.rationale !== 'string' || typeof v.confidence !== 'number') return null;
  return {
    diagnosis: v.diagnosis.trim().slice(0, 600),
    selectedAction: option.action,
    rationale: v.rationale.trim().slice(0, 600),
    confidence: Math.max(0, Math.min(1, v.confidence)),
  };
}
