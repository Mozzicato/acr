// What the customer sees in their app, and what the support assistant may know about them.
// Both are built server-side from the world, so the client can't widen the assistant's context.

import type { AcrEngine } from './agent.js';
import type { SupportContext } from './advisor.js';
import { BANK_NAME } from './seed.js';
import type { Incident, Journey, Notification, Transaction } from './types.js';
import { formatNgn, formatTime } from '../format.js';

/** How a journey looks to the customer: plain status, never internal incident jargon. */
export type CustomerStatus = 'processing' | 'successful' | 'failed' | 'fixing' | 'fixed' | 'with_agent' | 'held';

export interface CustomerJourney {
  id: string;
  title: string;
  transactionId: string;
  status: CustomerStatus;
  amount: number;
  /** The other bank, for transfers. */
  bank: string | null;
  /** What ACR did for the customer once fixed. */
  outcome: 'reversed' | 'delivered' | 'token' | null;
  /** What the agent is doing, in plain words, for the live progress list. */
  agentSteps: Array<{ title: string; detail?: string; tone: 'ok' | 'warn' | 'fail' | 'info' }>;
  /** Customer-facing timeline. */
  steps: Array<{ at: string; label: string; tone: 'ok' | 'warn' | 'fail' | 'agent' }>;
  token: string | null;
  /** What ACR told the customer about this journey, if anything. */
  notification: { title: string; body: string } | null;
}

export interface CustomerView {
  customer: { id: string; name: string; tier: string; accountNumber: string };
  balance: number;
  /** Debit under active recovery; it is not settled or available to spend. */
  pendingRecovery: { amount: number; title: string } | null;
  transactions: Transaction[];
  notifications: Notification[];
  journeys: CustomerJourney[];
  banks: string[];
  bankStatus: Record<string, string>;
}

const CUSTOMER_STEPS: Record<string, { label: string; tone: CustomerJourney['steps'][number]['tone'] }> = {
  transfer_submitted: { label: 'Transfer sent', tone: 'ok' },
  account_debited: { label: 'Account debited', tone: 'ok' },
  transfer_successful: { label: 'Received by the other bank', tone: 'ok' },
  transfer_pending: { label: 'Waiting for the other bank', tone: 'warn' },
  transfer_failed: { label: 'The other bank did not respond', tone: 'fail' },
  transfer_held: { label: 'We are holding it while the bank confirms', tone: 'agent' },
  transfer_recalled: { label: 'You asked for your money back', tone: 'agent' },
  transfer_settled: { label: 'Received by the other bank', tone: 'ok' },
  bill_paid: { label: 'Payment made', tone: 'ok' },
  token_delivered: { label: 'Token delivered', tone: 'ok' },
  vend_timeout: { label: 'Token delayed', tone: 'warn' },
  incident_opened: { label: 'We noticed a problem and started fixing it', tone: 'agent' },
  transfer_reversed: { label: 'Money returned to your account', tone: 'agent' },
  token_redelivered: { label: 'Token delivered by our team', tone: 'agent' },
  escalated_to_human: { label: 'A support agent is handling this', tone: 'agent' },
};

function statusOf(journey: Journey, incident: Incident | undefined, held: boolean): CustomerStatus {
  if (held) return 'held';
  if (incident?.status === 'resolved') return 'fixed';
  if (incident?.status === 'escalated') return 'with_agent';
  if (incident) return 'fixing';
  if (journey.currentState === 'completed') return 'successful';
  if (journey.events.some((e) => e.type === 'transfer_failed')) return 'failed';
  return 'processing';
}

const DECIDE_COPY: Record<string, string> = {
  'ACTION APPROVED': 'Confirmed safe to return your money',
  'ESCALATED TO HUMAN': 'Handed to a support agent with everything we found',
  'TRANSFER HELD': 'Holding your transfer: it may still go through',
};

function agentSteps(w: AcrEngine['world'], journey: Journey): CustomerJourney['agentSteps'] {
  const own = w.trace.filter((s) => s.journeyId === journey.id);
  if (!own.length) return [];
  const steps: CustomerJourney['agentSteps'] = [{ title: 'ACR noticed this transfer was not confirmed', tone: 'warn' }];
  for (const s of own) {
    if (s.phase === 'decide' && (DECIDE_COPY[s.title] || s.status === 'info')) steps.push({ title: DECIDE_COPY[s.title] ?? s.title, detail: DECIDE_COPY[s.title] ? undefined : s.detail, tone: s.status === 'ok' ? 'ok' : 'info' });
    else if (['investigate', 'act', 'verify'].includes(s.phase) && !s.title.startsWith('Customer:') && !s.title.startsWith('Investigating')) {
      steps.push({ title: s.title, detail: s.detail, tone: s.status === 'ok' ? 'ok' : s.status === 'fail' ? 'fail' : s.status === 'warn' ? 'warn' : 'info' });
    }
  }
  return steps.slice(0, 12);
}

function isUnsettled(journey: Journey): boolean {
  return journey.currentState.startsWith('debited_awaiting');
}

export function customerView(engine: AcrEngine, customerId: string): CustomerView {
  const w = engine.world;
  const customer = engine.systems.getCustomer(customerId);
  const account = engine.systems.getAccount(customer.accountNumber);
  const pendingJourney = w.journeys
    .filter((j) => j.customerId === customerId)
    .map((journey) => ({ journey, incident: w.incidents.filter((i) => i.journeyId === journey.id).at(-1) }))
    .find(({ journey, incident }) => isUnsettled(journey) && (!incident || !['resolved', 'escalated'].includes(incident.status)));
  const pendingTransaction = pendingJourney && w.bank.transactions[pendingJourney.journey.transactionId];
  const journeys = w.journeys
    .filter((j) => j.customerId === customerId && j.transactionId && !j.transactionId.startsWith('HIS-'))
    .slice(-10)
    .reverse()
    .map((j): CustomerJourney => {
      const incident = w.incidents.filter((i) => i.journeyId === j.id).at(-1);
      const tx = w.bank.transactions[j.transactionId];
      return {
        id: j.id,
        title: j.title,
        transactionId: j.transactionId,
        status: statusOf(j, incident, engine.isHeld(j)),
        amount: tx?.amount ?? 0,
        bank: tx?.beneficiary?.bank ?? null,
        outcome: incident?.status !== 'resolved' ? null : tx?.status === 'reversed' ? 'reversed' : tx?.bill?.delivered ? 'token' : tx?.status === 'successful' ? 'delivered' : null,
        agentSteps: agentSteps(w, j),
        steps: j.events.flatMap((e) => (CUSTOMER_STEPS[e.type] ? [{ at: e.at, ...CUSTOMER_STEPS[e.type] }] : [])),
        token: tx?.bill?.delivered ? tx.bill.token : null,
        notification: (incident && w.bank.outbox.filter((n) => n.incidentId === incident.id).map(({ title, body }) => ({ title, body })).at(-1)) ?? null,
      };
    });
  return {
    customer: { id: customer.id, name: customer.name, tier: customer.tier, accountNumber: customer.accountNumber },
    balance: account.balance,
    pendingRecovery: pendingTransaction?.direction === 'debit'
      ? { amount: pendingTransaction.amount, title: pendingJourney!.journey.title }
      : null,
    transactions: engine.systems.transactionsFor(account.number).slice(0, 15),
    notifications: w.bank.outbox.filter((n) => n.customerId === customerId),
    journeys,
    banks: Object.keys(w.bank.bankStatus),
    bankStatus: { ...w.bank.bankStatus },
  };
}

export function supportContext(engine: AcrEngine, customerId: string): SupportContext {
  const view = customerView(engine, customerId);
  const w = engine.world;
  const latest = view.journeys.find((journey) => isUnsettled(w.journeys.find((candidate) => candidate.id === journey.id)!)) ?? view.journeys[0];
  const incident = latest && w.incidents.filter((i) => i.journeyId === latest.id).at(-1);
  const sent = incident && w.bank.outbox.filter((n) => n.incidentId === incident.id).at(-1);
  return {
    bank: BANK_NAME,
    customerName: view.customer.name,
    balance: formatNgn(view.balance),
    balanceState: view.pendingRecovery
      ? `Your available balance is ${formatNgn(view.balance)}. It includes a pending debit of ${formatNgn(view.pendingRecovery.amount)} for ${view.pendingRecovery.title}; that money has not been returned or settled yet.`
      : `Your available balance is ${formatNgn(view.balance)} and there is no unresolved ACR recovery.`,
    recentTransactions: view.transactions.slice(0, 6).map((t) => ({
      when: formatTime(t.at),
      description: t.narration,
      amount: `${t.direction === 'credit' ? '+' : '-'}${formatNgn(t.amount)}`,
      status: t.status,
    })),
    issue: latest && (incident || isUnsettled(w.journeys.find((journey) => journey.id === latest.id)!)) ? {
      what: latest.title,
      status: latest.status === 'fixed' ? 'fixed automatically' : latest.status === 'held' ? 'on hold because the other bank is unstable; the transfer may still go through, and the customer can tap Return my money on the transfer screen' : latest.status === 'with_agent' ? 'with a human agent' : 'being looked into',
      whatAcrDid: incident?.status === 'resolved' ? incident.resolution : null,
      messageSent: sent?.body ?? null,
    } : null,
  };
}
