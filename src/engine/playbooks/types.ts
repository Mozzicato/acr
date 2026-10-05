// A playbook holds everything specific to one failure type: how to investigate it, which
// recoveries to propose, and how to carry out and verify the chosen one. The engine owns the
// shared loop, the policy decision, escalation and learning.

import type { PolicyFacts } from '../policy';
import type { BusinessSystems } from '../systems';
import type { Authorization, ToolLayer } from '../tools';
import type { Customer, FailureKind, Incident, Journey, Phase, PolicyDecision, RecoveryOption, TraceStep } from '../types';

export interface PlaybookContext {
  incident: Incident;
  journey: Journey;
  tools: ToolLayer;
  /** Read-only use: lets the policy facts be taken from the systems of record, not from the agent's notes. */
  systems: BusinessSystems;
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
  /** What was promised to the customer, for the planner. */
  promise: string;
}

export type Execution =
  | {
      ok: true;
      resolution: string;
      notification: string;
      journeyState: string;
      events: Array<{ type: string; summary: string; payload: Record<string, unknown> }>;
    }
  | { ok: false; reason: string };

export interface Playbook {
  kind: FailureKind;
  /** Label for the learning record. */
  failure: string;
  investigate(ctx: PlaybookContext): Investigation;
  execute(ctx: PlaybookContext, decision: PolicyDecision, auth: Authorization, investigation: Investigation): Execution;
}
