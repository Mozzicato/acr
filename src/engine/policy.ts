// Recovery policy engine (PRD §11, §13). It is the final authority: an action runs only if it
// matches a named policy, its evidence holds, and the autonomy level permits it.

import type { AutonomyLevel, PolicyDecision, PolicyVerdict, RecoveryOption } from './types';

/** Reversals above this need an operator even at Level 2. */
export const AUTO_REVERSAL_LIMIT = 1_000_000;

export const POLICIES = {
  'TRANSFER-REVERSAL-01': 'Reverse a transfer when the debit posted, the NIP switch reports a final failure (not "in progress"), and it has not already been reversed. Above ₦1,000,000 an operator must approve.',
  'TRANSFER-RETRY-01': 'Never resend money without the customer\'s say-so. Retrying is the customer\'s decision.',
  'BILL-REDELIVER-01': 'Redeliver a token when the customer was debited and the biller confirms it vended a token that the customer never received.',
  'BILL-REVERSAL-01': 'Reverse a bill payment only when the biller confirms the vend failed. Never when a token exists, and never while the status is unknown.',
  'FINANCIAL-HOLD-01': 'Goodwill credits move the bank\'s money. They are Level 3 actions that need human approval and are not executable in the MVP.',
  'ESCALATE-01': 'Hand off to a human whenever no autonomous recovery is authorized.',
} as const;

export const AUTONOMY_LEVELS: Record<AutonomyLevel, { name: string; summary: string }> = {
  0: { name: 'Observe', summary: 'ACR detects and investigates, but takes no action.' },
  1: { name: 'Recommend', summary: 'ACR proposes a recovery. An operator approves it.' },
  2: { name: 'Autonomous', summary: 'ACR runs low-risk recoveries on its own.' },
};

/** Facts the policy engine checks for itself, from the systems of record, rather than trusting the agent. */
export type PolicyFacts =
  | {
      kind: 'transfer_not_credited';
      transactionId: string;
      amount: number;
      debitPosted: boolean;
      nipFinal: boolean;
      nipCode: string;
      alreadyReversed: boolean;
    }
  | {
      kind: 'bill_token_missing';
      transactionId: string;
      amount: number;
      debitPosted: boolean;
      vendStatus: 'successful' | 'failed' | 'unknown';
      tokenAvailable: boolean;
      delivered: boolean;
      alreadyReversed: boolean;
    };

function verdict(option: RecoveryOption, policy: string, failures: string[], level: AutonomyLevel, needsOperator?: string): PolicyVerdict {
  const allowed = failures.length === 0;
  const autonomous = allowed && level === 2 && !needsOperator;
  let reason: string;
  if (!allowed) reason = `Blocked: ${failures.join('; ')}.`;
  else if (needsOperator) reason = `All conditions met, but ${needsOperator}: needs operator approval.`;
  else if (level === 2) reason = 'All conditions met. Level 2 allows autonomous execution.';
  else if (level === 1) reason = 'All conditions met. Level 1 needs operator approval.';
  else reason = 'All conditions met, but Level 0 only observes.';
  return { action: option.action, policy, allowed, autonomous, reason };
}

function verdictFor(option: RecoveryOption, facts: PolicyFacts, level: AutonomyLevel): PolicyVerdict {
  const wrongTarget = option.transactionId !== facts.transactionId ? ['targets a different transaction'] : [];
  switch (option.action) {
    case 'reverse_transfer': {
      if (facts.kind !== 'transfer_not_credited') return verdict(option, 'TRANSFER-REVERSAL-01', ['not applicable to this failure'], level);
      const failures = [...wrongTarget];
      if (!facts.debitPosted) failures.push('no debit to reverse');
      if (!facts.nipFinal) failures.push(`NIP status ${facts.nipCode} is not final, so the money may still land and a reversal could pay twice`);
      if (facts.alreadyReversed) failures.push('already reversed');
      const overLimit = facts.amount > AUTO_REVERSAL_LIMIT ? 'amount is above the ₦1,000,000 autonomous limit' : undefined;
      return verdict(option, 'TRANSFER-REVERSAL-01', failures, level, overLimit);
    }
    case 'retry_transfer':
      return verdict(option, 'TRANSFER-RETRY-01', ['resending money needs the customer\'s confirmation'], level);
    case 'redeliver_token': {
      if (facts.kind !== 'bill_token_missing') return verdict(option, 'BILL-REDELIVER-01', ['not applicable to this failure'], level);
      const failures = [...wrongTarget];
      if (!facts.debitPosted) failures.push('customer was not debited');
      if (facts.vendStatus !== 'successful' || !facts.tokenAvailable) failures.push(`biller vend status is "${facts.vendStatus}", no token to deliver`);
      if (facts.delivered) failures.push('token already delivered');
      return verdict(option, 'BILL-REDELIVER-01', failures, level);
    }
    case 'reverse_bill_payment': {
      if (facts.kind !== 'bill_token_missing') return verdict(option, 'BILL-REVERSAL-01', ['not applicable to this failure'], level);
      const failures = [...wrongTarget];
      if (facts.vendStatus === 'successful') failures.push('the biller vended a token, so the customer got what they paid for');
      if (facts.vendStatus === 'unknown') failures.push('vend status unknown, so the token may still arrive');
      if (facts.alreadyReversed) failures.push('already reversed');
      const overLimit = facts.amount > AUTO_REVERSAL_LIMIT ? 'amount is above the ₦1,000,000 autonomous limit' : undefined;
      return verdict(option, 'BILL-REVERSAL-01', failures, level, overLimit);
    }
    case 'goodwill_credit':
      return verdict(option, 'FINANCIAL-HOLD-01', ['moves the bank\'s money, needs Level 3 human approval'], level);
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
