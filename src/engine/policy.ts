// Recovery policy engine (PRD §11, §13). It is the final authority: an action runs only if it
// matches a named policy, its evidence holds, and the autonomy level permits it.

import type { AutonomyLevel, Courier, Order, PolicyDecision, PolicyVerdict, RecoveryOption } from './types';

export const MAX_COURIER_CAPACITY = 0.9;

export const POLICIES = {
  'DELIVERY-REASSIGN-01': 'Reassign when payment is confirmed, stock is reserved, the original courier is unavailable, and an alternate courier in the same zone has capacity below 90% and keeps the promised delivery time.',
  'ORDER-REPLAY-01': 'Recreate an order from its checkout when the payment is captured, no order exists for that payment (no duplicates), the captured amount matches the cart, the order webhook is recorded as failed, and stock is available.',
  'FINANCIAL-HOLD-01': 'Credits and refunds are Level 3 actions that need human approval. They are not executable in the MVP.',
  'ESCALATE-01': 'Hand off to a human whenever no autonomous recovery is authorized.',
} as const;

export const AUTONOMY_LEVELS: Record<AutonomyLevel, { name: string; summary: string }> = {
  0: { name: 'Observe', summary: 'ACR detects and investigates, but takes no action.' },
  1: { name: 'Recommend', summary: 'ACR proposes a recovery. An operator approves it.' },
  2: { name: 'Autonomous', summary: 'ACR runs low-risk recoveries on its own.' },
};

/** Facts the policy engine checks for itself rather than trusting the agent's plan. */
export type PolicyFacts =
  | {
      kind: 'courier_rejected';
      order: Order;
      paymentConfirmed: boolean;
      inventoryReserved: boolean;
      originalCourierUnavailable: boolean;
      candidate: Courier | null;
    }
  | {
      kind: 'order_not_created';
      orderId: string;
      paymentCaptured: boolean;
      capturedAmount: number;
      cartAmount: number;
      orderExists: boolean;
      webhookFailed: boolean;
      stockOnHand: number;
    };

export function eligibilityProblems(order: Order, courier: Courier, projectedEta: string): string[] {
  const problems: string[] = [];
  if (!courier.available) problems.push('unavailable');
  if (courier.zone !== order.zone) problems.push(`serves ${courier.zone}, not ${order.zone}`);
  if (courier.capacity >= MAX_COURIER_CAPACITY) problems.push(`capacity ${Math.round(courier.capacity * 100)}% ≥ 90%`);
  if (Date.parse(projectedEta) > Date.parse(order.promisedBy)) problems.push('would miss promised time');
  return problems;
}

function levelReason(allowed: boolean, level: AutonomyLevel, failures: string[]): string {
  if (!allowed) return `Blocked: ${failures.join('; ')}.`;
  if (level === 2) return 'All conditions met. Level 2 allows autonomous execution.';
  if (level === 1) return 'All conditions met. Level 1 needs operator approval.';
  return 'All conditions met, but Level 0 only observes.';
}

function notApplicable(action: RecoveryOption['action'], policy: string): PolicyVerdict {
  return { action, policy, allowed: false, autonomous: false, reason: 'Blocked: not applicable to this failure.' };
}

function verdictFor(option: RecoveryOption, facts: PolicyFacts, level: AutonomyLevel): PolicyVerdict {
  switch (option.action) {
    case 'reassign_courier': {
      if (facts.kind !== 'courier_rejected') return notApplicable(option.action, 'DELIVERY-REASSIGN-01');
      const failures: string[] = [];
      if (!facts.paymentConfirmed) failures.push('payment not confirmed');
      if (!facts.inventoryReserved) failures.push('stock not reserved');
      if (!facts.originalCourierUnavailable) failures.push('original courier still available');
      if (!facts.candidate || !option.projectedEta || facts.candidate.id !== option.courierId) {
        failures.push('no eligible alternate courier');
      } else {
        failures.push(...eligibilityProblems(facts.order, facts.candidate, option.projectedEta).map((p) => `${facts.candidate!.name} ${p}`));
      }
      const allowed = failures.length === 0;
      return { action: option.action, policy: 'DELIVERY-REASSIGN-01', allowed, autonomous: allowed && level === 2, reason: levelReason(allowed, level, failures) };
    }
    case 'recreate_order': {
      if (facts.kind !== 'order_not_created') return notApplicable(option.action, 'ORDER-REPLAY-01');
      const failures: string[] = [];
      if (!facts.paymentCaptured) failures.push('payment not captured');
      if (facts.orderExists) failures.push('an order already exists for this payment');
      if (facts.capturedAmount !== facts.cartAmount) failures.push('captured amount differs from cart');
      if (!facts.webhookFailed) failures.push('no failed order webhook on record');
      if (facts.stockOnHand < 1) failures.push('item out of stock');
      if (option.orderId !== facts.orderId) failures.push('order differs from the paid checkout');
      const allowed = failures.length === 0;
      return { action: option.action, policy: 'ORDER-REPLAY-01', allowed, autonomous: allowed && level === 2, reason: levelReason(allowed, level, failures) };
    }
    case 'delay_with_credit':
    case 'refund':
      return { action: option.action, policy: 'FINANCIAL-HOLD-01', allowed: false, autonomous: false, reason: 'Blocked: financial action, needs Level 3 human approval.' };
    case 'human_review':
      return { action: option.action, policy: 'ESCALATE-01', allowed: true, autonomous: true, reason: 'Always permitted.' };
  }
}

/** Evaluates every proposed option and selects the first permitted one in the agent's ranking. */
export function decide(incidentId: string, ranked: RecoveryOption[], facts: PolicyFacts, level: AutonomyLevel): PolicyDecision {
  const verdicts = ranked.map((o) => verdictFor(o, facts, level));
  const index = verdicts.findIndex((v) => v.allowed);
  if (index < 0) throw new Error('Policy configuration error: human_review must always be permitted.');
  return { incidentId, verdicts, selected: ranked[index], selectedVerdict: verdicts[index], level };
}
