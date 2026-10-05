// Deterministic delivery-risk rules (PRD §9: no ML prediction in the MVP).

import type { Customer, Journey, JourneyEvent, Order, Severity } from './types';

export const DETECTION_RULE = {
  id: 'DR-DELIVERY-01',
  description: 'Courier rejected route + delivery deadline within 36h + no replacement courier assigned',
  deadlineWindowHours: 36,
  criticalWithinHours: 6,
};

export interface RiskAssessment {
  rule: string;
  ruleDescription: string;
  severity: Severity;
  risk: number;
  signals: string[];
}

export const hoursBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 3_600_000;

/** Returns a risk assessment when the event puts the journey at risk, otherwise null. */
export function assessDeliveryRisk(
  journey: Journey,
  order: Order,
  customer: Customer,
  event: JourneyEvent,
): RiskAssessment | null {
  if (event.type !== 'courier_rejected_route') return null;
  if (order.courierId !== null) return null;
  const hoursLeft = hoursBetween(event.at, journey.deadline);
  if (hoursLeft > DETECTION_RULE.deadlineWindowHours) return null;

  const signals = [
    `Courier rejected route (${String(event.payload.reason ?? 'no reason given')})`,
    `Promised delivery in ${hoursLeft.toFixed(1)}h`,
    'No replacement courier assigned',
  ];
  let risk = 73;
  if (customer.tier === 'priority') {
    risk += 8;
    signals.push('Priority customer');
  }
  if (customer.history.previousDelays > 0) {
    risk += customer.history.previousDelays * 5;
    signals.push(`${customer.history.previousDelays} previous delayed deliveries`);
  }
  if (hoursLeft < 12) risk += 10;
  risk = Math.min(99, risk);

  const severity: Severity = hoursLeft <= DETECTION_RULE.criticalWithinHours || risk >= 95 ? 'critical' : 'high';
  return { rule: DETECTION_RULE.id, ruleDescription: DETECTION_RULE.description, severity, risk, signals };
}

export const ORDER_SYNC_RULE = {
  id: 'DR-ORDER-01',
  description: 'Payment captured + no order created within 10 minutes',
  overdueMinutes: 10,
};

/** Fires when a customer has been charged but the order system has no order for the payment. */
export function assessOrderSyncRisk(
  customer: Customer,
  paymentAt: string,
  now: string,
  orderExists: boolean,
): RiskAssessment | null {
  const minutes = hoursBetween(paymentAt, now) * 60;
  if (orderExists || minutes < ORDER_SYNC_RULE.overdueMinutes) return null;

  const signals = ['Payment captured', `No order created after ${Math.round(minutes)} min`, 'No order confirmation sent to the customer'];
  let risk = 86;
  if (customer.history.supportContacts > 0) {
    risk += 6;
    signals.push(`${customer.history.supportContacts} earlier contact about a missing order confirmation`);
  }
  if (customer.tier === 'priority') risk += 5;
  risk = Math.min(99, risk);
  return { rule: ORDER_SYNC_RULE.id, ruleDescription: ORDER_SYNC_RULE.description, severity: risk >= 95 ? 'critical' : 'high', risk, signals };
}
