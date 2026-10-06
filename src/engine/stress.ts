// Stress test: thousands of random journeys with injected faults, run through the real engine on
// a simulated clock with production detection windows. Seeded, so any run can be reproduced.
// It reports outcomes and checks the safety invariants a bank would care about.

import { AcrEngine, PRODUCTION_WINDOWS } from './agent.js';
import { AUTO_REVERSAL_LIMIT } from './policy.js';
import { BILLER, OTHER_BANKS } from './seed.js';
import type { BankHealth, BillerHealth } from './systems.js';

export interface StressConfig {
  journeys: number;
  /** Share of journeys with an injected fault, 0–1. */
  failureRate: number;
  seed: number;
}

export interface Invariant {
  name: string;
  passed: boolean;
  detail: string;
}

export interface StressReport {
  config: StressConfig;
  elapsedMs: number;
  counts: {
    journeys: number;
    transfers: number;
    bills: number;
    faultsInjected: number;
    /** Faults the customer would actually notice (excludes "in progress" that settled in time). */
    customerVisible: number;
    detected: number;
    autoRecovered: number;
    escalated: number;
    heldForApproval: number;
    /** "In progress" transfers ACR refused to reverse that later landed: a naive auto-refund would have paid twice. */
    doublePaysAvoided: number;
    moneyReturnedNgn: number;
    tokensDelivered: number;
  };
  timing: {
    detectToFixMedianSec: number | null;
    detectToFixP95Sec: number | null;
  };
  invariants: Invariant[];
}

type Fault = BankHealth | BillerHealth | null;

interface Planned {
  at: number;
  kind: 'transfer' | 'bill';
  customerId: string;
  fault: Fault;
  amount: number;
  bank: string;
  settleAfterSec: number;
  settleOutcome: 'successful' | 'failed';
  journeyId?: string;
  txId?: string;
}

/** Small, fast, seedable PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP_SEC = 30;
const SPACING_SEC = 20;
const CUSTOMERS = 120;

/** Runs the stress test, yielding progress (0–1) as it goes and returning the report. */
export function* runStress(config: StressConfig): Generator<number, StressReport> {
  const started = Date.now();
  const random = rng(config.seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  const engine = AcrEngine.create({ clock: 'sim', level: 2, windows: PRODUCTION_WINDOWS });
  const w = engine.world;

  const customers = Array.from({ length: CUSTOMERS }, (_, i) => engine.join(`Stress Customer ${i + 1}`).id);
  for (const id of customers) w.bank.accounts[w.bank.customers[id].accountNumber].balance = 1_000_000_000;
  const opening = Object.fromEntries(Object.values(w.bank.accounts).map((a) => [a.number, a.balance]));
  const preexisting = new Set(Object.keys(w.bank.transactions));

  const t0 = Date.parse(engine.now());
  const plan: Planned[] = Array.from({ length: config.journeys }, (_, i) => {
    const kind = random() < 0.8 ? 'transfer' : 'bill';
    const faulty = random() < config.failureRate;
    const fault: Fault = !faulty ? null : kind === 'transfer' ? (random() < 0.55 ? 'down' : 'unstable') : (random() < 0.6 ? 'stuck' : 'down');
    const amount = kind === 'bill'
      ? Math.round(1_000 + random() * 49_000)
      : random() < 0.04
        ? Math.round(AUTO_REVERSAL_LIMIT + random() * 1_500_000)
        : Math.round(Math.exp(Math.log(1_000) + random() * (Math.log(500_000) - Math.log(1_000))));
    return {
      at: t0 + i * SPACING_SEC * 1000,
      kind,
      customerId: pick(customers),
      fault,
      amount,
      bank: pick(OTHER_BANKS),
      settleAfterSec: 60 + Math.floor(random() * 1740),
      settleOutcome: random() < 0.6 ? 'successful' : 'failed',
    };
  });

  const settles: Array<{ at: number; p: Planned }> = [];
  let next = 0;
  const lastAt = t0 + config.journeys * SPACING_SEC * 1000 + (PRODUCTION_WINDOWS.transferSeconds + 1800 + 120) * 1000;
  while (Date.parse(engine.now()) <= lastAt) {
    const now = Date.parse(engine.now());
    while (next < plan.length && plan[next].at <= now) {
      const p = plan[next++];
      if (p.kind === 'transfer') {
        engine.setBankStatus(p.bank, (p.fault as BankHealth | null) ?? 'up');
        const account = String(1_000_000_000 + Math.floor(random() * 8_999_999_999)).slice(0, 10);
        const j = engine.startTransfer(p.customerId, { bank: p.bank, account, name: 'Beneficiary', amount: p.amount });
        p.journeyId = j.id;
        p.txId = j.transactionId;
        if (p.fault === 'unstable') settles.push({ at: now + p.settleAfterSec * 1000, p });
      } else {
        engine.setBillerStatus(BILLER, (p.fault as BillerHealth | null) ?? 'up');
        const meter = String(10_000_000_000 + Math.floor(random() * 89_999_999_999)).slice(0, 11);
        const j = engine.startBillPayment(p.customerId, { meter, amount: p.amount });
        p.journeyId = j.id;
        p.txId = j.transactionId;
      }
    }
    for (const s of settles.filter((x) => x.at <= now)) engine.settleTransfer(s.p.txId!, s.p.settleOutcome);
    settles.splice(0, settles.length, ...settles.filter((x) => x.at > now));
    engine.runAutomatic('rules');
    engine.advance(STEP_SEC);
    if (next % 50 === 0) yield Math.min(0.99, next / plan.length);
  }

  return report(engine, config, plan, opening, preexisting, started);
}

export function runStressSync(config: StressConfig): StressReport {
  const it = runStress(config);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function report(engine: AcrEngine, config: StressConfig, plan: Planned[], opening: Record<string, number>, preexisting: Set<string>, started: number): StressReport {
  const w = engine.world;
  const txs = w.bank.transactions;
  const incidentByJourney = new Map(w.incidents.map((i) => [i.journeyId, i]));
  const reversals = Object.values(txs).filter((t) => t.reverses);
  const reversedIds = new Set(reversals.map((t) => t.reverses!));
  const windowSec = (p: Planned) => (p.kind === 'transfer' ? PRODUCTION_WINDOWS.transferSeconds : PRODUCTION_WINDOWS.billSeconds);

  const faulty = plan.filter((p) => p.fault);
  // An "in progress" transfer that lands before the watchdog fires never troubles the customer.
  const settledInTime = (p: Planned) => p.fault === 'unstable' && p.settleOutcome === 'successful' && p.settleAfterSec <= windowSec(p);
  const visible = faulty.filter((p) => !settledInTime(p));
  const missed = visible.filter((p) => !incidentByJourney.has(p.journeyId!));
  const falseAlarms = plan.filter((p) => (!p.fault || settledInTime(p)) && incidentByJourney.has(p.journeyId!));
  const lateLanded = plan.filter((p) => p.fault === 'unstable' && p.settleOutcome === 'successful' && incidentByJourney.has(p.journeyId!));
  const lateLandedReversed = lateLanded.filter((p) => reversedIds.has(p.txId!));
  const doubleReversed = [...reversedIds].filter((id) => reversals.filter((r) => r.reverses === id).length > 1);
  const billReversedWithToken = reversals.filter((r) => txs[r.reverses!].type === 'bill_payment' && w.bank.vends[r.reverses!]?.status === 'successful');

  // Ledger: opening balance plus every transaction since must equal the balance now, to the naira.
  const drift = Object.values(w.bank.accounts).filter((a) => {
    const moved = Object.values(txs)
      .filter((t) => t.accountNumber === a.number && !preexisting.has(t.id))
      .reduce((sum, t) => sum + (t.direction === 'credit' ? t.amount : -t.amount), 0);
    return opening[a.number] + moved !== a.balance;
  });

  const writes = w.audit.filter((a) => a.ok && (a.tool === 'post_reversal' || a.tool === 'deliver_token'));
  const unauthorized = writes.filter((a) => {
    const d = w.decisions[a.incidentId];
    const action = a.tool === 'post_reversal' ? ['reverse_transfer', 'reverse_bill_payment'] : ['redeliver_token'];
    return !d || !d.selectedVerdict.allowed || !action.includes(d.selected.action);
  });

  const bigReversalsAuto = w.audit.filter((a) => a.ok && a.tool === 'post_reversal' && a.actor !== 'operator' && txs[String(a.input.transactionId)]?.amount > AUTO_REVERSAL_LIMIT);
  const stuck = w.incidents.filter((i) => ['investigating', 'planning', 'executing'].includes(i.status));

  const resolved = w.incidents.filter((i) => i.status === 'resolved');
  const detectToFix = w.recoveries.flatMap((r) => (r.recoverySeconds === null ? [] : [r.recoverySeconds]));
  const n = (x: number) => x.toLocaleString('en-NG');

  const invariants: Invariant[] = [
    { name: 'Every failure a customer could see was detected', passed: missed.length === 0, detail: `${n(visible.length - missed.length)} of ${n(visible.length)} detected` },
    { name: 'Healthy transactions were never flagged or touched', passed: falseAlarms.length === 0, detail: `${n(falseAlarms.length)} false alarms across ${n(plan.length - visible.length)} healthy journeys` },
    { name: 'No transaction was ever reversed twice', passed: doubleReversed.length === 0, detail: `${n(reversals.length)} reversals, ${doubleReversed.length} duplicates` },
    { name: 'Never reversed a transfer that could still land', passed: lateLandedReversed.length === 0, detail: `${n(lateLanded.length)} "in progress" transfers later landed; ${lateLandedReversed.length} had been reversed` },
    { name: 'Never refunded a bill whose token was vended', passed: billReversedWithToken.length === 0, detail: `${billReversedWithToken.length} such refunds` },
    { name: 'Every account reconciles to the naira', passed: drift.length === 0, detail: `${n(Object.keys(w.bank.accounts).length)} accounts, ${drift.length} with drift` },
    { name: 'Every money movement had a policy decision allowing it', passed: unauthorized.length === 0, detail: `${n(writes.length)} write actions, ${unauthorized.length} without authorization` },
    { name: `Reversals over ₦${n(AUTO_REVERSAL_LIMIT)} waited for a human`, passed: bigReversalsAuto.length === 0, detail: `${bigReversalsAuto.length} executed without an operator` },
    { name: 'Every incident reached a decision', passed: stuck.length === 0, detail: `${stuck.length} left mid-flight` },
    { name: 'Zero complaint tickets', passed: w.bank.tickets.length === 0, detail: `${w.bank.tickets.length} tickets` },
  ];

  return {
    config,
    elapsedMs: Date.now() - started,
    counts: {
      journeys: plan.length,
      transfers: plan.filter((p) => p.kind === 'transfer').length,
      bills: plan.filter((p) => p.kind === 'bill').length,
      faultsInjected: faulty.length,
      customerVisible: visible.length,
      detected: w.incidents.length,
      autoRecovered: resolved.length,
      escalated: w.incidents.filter((i) => i.status === 'escalated').length,
      heldForApproval: w.incidents.filter((i) => i.status === 'awaiting_approval').length,
      doublePaysAvoided: lateLanded.length - lateLandedReversed.length,
      moneyReturnedNgn: reversals.reduce((s, r) => s + r.amount, 0),
      tokensDelivered: w.audit.filter((a) => a.ok && a.tool === 'deliver_token').length,
    },
    timing: { detectToFixMedianSec: percentile(detectToFix, 0.5), detectToFixP95Sec: percentile(detectToFix, 0.95) },
    invariants,
  };
}
