// Deterministic risk rules (PRD §9: no ML prediction in the MVP). Each one watches for a debit
// that hasn't produced what the customer paid for within a time window.

import type { Customer, Severity } from './types';

export interface RiskAssessment {
  rule: string;
  ruleDescription: string;
  severity: Severity;
  risk: number;
  signals: string[];
}

export const minutesBetween = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 60_000;

export const TRANSFER_RULE = {
  id: 'DR-TRANSFER-01',
  description: 'Customer debited + NIP transfer not confirmed successful within 10 minutes',
  windowMinutes: 10,
};

export const BILL_RULE = {
  id: 'DR-BILL-01',
  description: 'Customer debited + no token delivered within 5 minutes',
  windowMinutes: 5,
};

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

/** A transfer whose debit posted but which the switch hasn't confirmed as successful. */
export function assessTransferRisk(
  customer: Customer, amount: number, debitedAt: string, now: string, nipCode: string,
): RiskAssessment | null {
  const minutes = minutesBetween(debitedAt, now);
  if (nipCode === '00' || minutes < TRANSFER_RULE.windowMinutes) return null;
  const signals = [`₦${amount.toLocaleString('en-NG')} debited`, `NIP response ${nipCode}, not confirmed after ${Math.round(minutes)} min`, 'Customer can see the debit in the app'];
  let risk = 80 + customerSignals(customer, signals);
  if (amount >= 50_000) {
    risk += 5;
    signals.push('Amount ≥ ₦50,000');
  }
  risk = Math.min(99, risk);
  return { rule: TRANSFER_RULE.id, ruleDescription: TRANSFER_RULE.description, severity: risk >= 95 ? 'critical' : 'high', risk, signals };
}

/** A prepaid token purchase that was debited but never delivered. */
export function assessBillRisk(customer: Customer, amount: number, debitedAt: string, now: string, delivered: boolean): RiskAssessment | null {
  const minutes = minutesBetween(debitedAt, now);
  if (delivered || minutes < BILL_RULE.windowMinutes) return null;
  const signals = [`₦${amount.toLocaleString('en-NG')} debited`, `No token after ${Math.round(minutes)} min`, 'Customer may have no electricity'];
  const risk = Math.min(99, 84 + customerSignals(customer, signals));
  return { rule: BILL_RULE.id, ruleDescription: BILL_RULE.description, severity: risk >= 95 ? 'critical' : 'high', risk, signals };
}
