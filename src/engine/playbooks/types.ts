// A playbook holds everything specific to one failure type: how it is simulated and detected,
// how to investigate it, which recoveries to propose, and how to carry out and verify the chosen
// one. The engine owns the shared loop, the policy decision, escalation and learning.

import type { RiskAssessment } from '../detection';
import type { PolicyFacts } from '../policy';
import type { BankSystems, SimClock } from '../systems';
import type { Authorization, ToolLayer } from '../tools';
import type { Customer, FailureKind, Incident, Journey, Phase, PolicyDecision, RecoveryOption, TraceStep } from '../types';

export interface SimulationContext {
  journey: Journey;
  customer: Customer;
  systems: BankSystems;
  clock: SimClock;
  addEvent(type: string, summary: string, payload?: Record<string, unknown>): void;
}

export interface Simulation {
  /** Title and detail of the signal ACR received. */
  received: [string, string];
  risk: RiskAssessment | null;
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
  /** Name of the simulated failure event, for the demo button. */
  trigger: string;
  canTrigger(journey: Journey): boolean;
  simulate(ctx: SimulationContext): Simulation;
  investigate(ctx: PlaybookContext): Investigation;
  execute(ctx: PlaybookContext, decision: PolicyDecision, auth: Authorization, investigation: Investigation): Execution;
}
