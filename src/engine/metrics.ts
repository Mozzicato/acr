// Core metrics (PRD §20), computed from the simulated journeys and recorded outcomes.

import type { EngineState } from './agent.js';

export interface Metrics {
  active: number;
  healthy: number;
  atRisk: number;
  critical: number;
  recovered: number;
  withOperator: number;
  healthPct: number;
  /** Autonomous Recovery Rate: recovered without complaint / total failed journeys. */
  arr: number | null;
  /** Human Escalation Rate: incidents requiring a human / total incidents. */
  her: number | null;
  /** Mean time to recovery in seconds. */
  mttr: number | null;
  /** Mean customer actions required per incident. */
  customerEffort: number | null;
  tickets: number;
}

export function computeMetrics(state: EngineState): Metrics {
  const count = (h: string) => state.journeys.filter((j) => j.health === h).length;
  const healthy = count('healthy') + count('recovered');
  const decided = state.recoveries.filter((r) => r.outcome !== 'observed');
  const recoveredTimes = decided.flatMap((r) => (r.recoverySeconds === null ? [] : [r.recoverySeconds]));
  const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

  return {
    active: state.journeys.length,
    healthy,
    atRisk: count('at_risk'),
    critical: count('critical'),
    recovered: count('recovered'),
    withOperator: count('escalated'),
    healthPct: state.journeys.length ? healthy / state.journeys.length : 1,
    arr: ratio(decided.filter((r) => r.outcome === 'successful' && r.complaintAvoided).length, decided.length),
    her: ratio(decided.filter((r) => r.outcome === 'escalated' || r.outcome === 'failed').length, decided.length),
    mttr: recoveredTimes.length ? recoveredTimes.reduce((a, b) => a + b, 0) / recoveredTimes.length : null,
    customerEffort: state.recoveries.length
      ? state.recoveries.reduce((a, r) => a + r.customerActionsRequired, 0) / state.recoveries.length
      : null,
    tickets: state.tickets.length,
  };
}
