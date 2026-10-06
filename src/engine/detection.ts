// Deterministic risk rules (PRD §9: no ML prediction in the MVP). Each one watches for a debit
// that hasn't produced what the customer paid for within a time window. Production windows are
// minutes; the live stage demo compresses them to seconds.

import type { Customer, Severity } from './types.js';

export interface RiskAssessment {
  rule: string;
  ruleDescription: string;
  severity: Severity;
  risk: number;
  signals: string[];
}

export const secondsBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 1000;

export const formatWindow = (seconds: number): string =>
  seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`;

const naira = (n: number) => `₦${n.toLocaleString('en-NG')}`;

function customerSignals(customer: Customer, signals: string[]): number {
  let added = 0;
  if (customer.tier === 'premier') {
    added += 6;
    signals.push('Premier customer');
  }
  if (customer.history.failedTransactions > 0) {
    added += customer.history.failedTransactions * 4;
    signals.push(`${customer.history.failedTransactions} earlier failed transfers`);
  }
  return added;
}

/** A transfer whose debit posted but which NIP hasn't confirmed as successful within the window. */
export function assessTransferRisk(
  customer: Customer, amount: number, debitedAt: string, now: string, nipCode: string, windowSeconds: number,
): RiskAssessment | null {
  const elapsed = secondsBetween(debitedAt, now);
  if (nipCode === '00' || elapsed < windowSeconds) return null;
  const signals = [`${naira(amount)} debited`, `NIP response ${nipCode}, not confirmed after ${formatWindow(elapsed)}`, 'Customer can see the debit in the app'];
  let risk = 80 + customerSignals(customer, signals);
  if (amount >= 50_000) {
    risk += 5;
    signals.push('Amount ≥ ₦50,000');
  }
  risk = Math.min(99, risk);
  return {
    rule: 'DR-TRANSFER-01',
    ruleDescription: `Customer debited + NIP transfer not confirmed successful within ${formatWindow(windowSeconds)}`,
    severity: risk >= 95 ? 'critical' : 'high',
    risk,
    signals,
  };
}

/** A prepaid token purchase that was debited but not delivered within the window. */
export function assessBillRisk(customer: Customer, amount: number, debitedAt: string, now: string, delivered: boolean, windowSeconds: number): RiskAssessment | null {
  const elapsed = secondsBetween(debitedAt, now);
  if (delivered || elapsed < windowSeconds) return null;
  const signals = [`${naira(amount)} debited`, `No token after ${formatWindow(elapsed)}`, 'Customer may have no electricity'];
  const risk = Math.min(99, 84 + customerSignals(customer, signals));
  return {
    rule: 'DR-BILL-01',
    ruleDescription: `Customer debited + no token delivered within ${formatWindow(windowSeconds)}`,
    severity: risk >= 95 ? 'critical' : 'high',
    risk,
    signals,
  };
}
