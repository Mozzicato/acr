// A playbook holds everything specific to one failure type: what it watches for, how to investigate
// it, which recoveries to propose, and how to carry out and verify the chosen one. The engine owns
// the shared loop, the policy decision, escalation and learning.

import type { RiskAssessment } from '../detection.js';
import type { PolicyFacts } from '../policy.js';
import type { BankSystems } from '../systems.js';
import type { Authorization, ToolLayer } from '../tools.js';
import type { Customer, FailureKind, Incident, Journey, Phase, PolicyDecision, RecoveryOption, TraceStep } from '../types.js';

export interface DetectionContext {
  journey: Journey;
  customer: Customer;
  systems: BankSystems;
  now: string;
  windowSeconds: number;
}

export interface Detection {
  /** Title and detail of the signal ACR received. */
  received: [string, string];
  risk: RiskAssessment;
}

export interface PlaybookContext {
  incident: Incident;
  journey: Journey;
  tools: ToolLayer;
  /** Read-only use: lets the policy facts come from the systems of record, not from the agent's notes. */
  systems: BankSystems;
  now(): string;
  step(phase: Phase, status: TraceStep['status'], title: string, detail?: string): void;
}

export interface Investigation {
  cause: string;
  confidence: number;
  options: RecoveryOption[];
  facts: PolicyFacts;
  customer: Customer;
  /** One line on what the customer is experiencing, for the planner. */
  situation: string;
  /** What the customer expected, for the planner. */
  promise: string;
}

export type Execution =
  | {
      ok: true;
      resolution: string;
      notification: { title: string; body: string };
      journeyState: string;
      events: Array<{ type: string; summary: string; payload: Record<string, unknown> }>;
    }
  | { ok: false; reason: string };

export interface Playbook {
  kind: FailureKind;
  /** Label for the learning record. */
  failure: string;
  /** Journey state this playbook's watchdog sweeps. */
  watches: string;
  /** Which detection window applies. */
  window: 'transferSeconds' | 'billSeconds';
  detect(ctx: DetectionContext): Detection | null;
  investigate(ctx: PlaybookContext): Investigation;
  execute(ctx: PlaybookContext, decision: PolicyDecision, auth: Authorization, investigation: Investigation): Execution;
}
