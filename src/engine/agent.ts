// The ACR agentic loop (PRD §8): detect → investigate → plan → decide → act → verify → notify → learn.
// Failure-specific work lives in playbooks; this engine owns the loop, the policy decision,
// escalation and learning. The planner (LLM or rules) may only propose; policy decides.
//
// All state lives in a plain-JSON World, so a serverless API can load it, run a step, and save it.

import { decide } from './policy.js';
import { billTokenPlaybook } from './playbooks/billToken.js';
import { transferPlaybook } from './playbooks/transfer.js';
import type { Investigation, Playbook, PlaybookContext } from './playbooks/types.js';
import { addCustomer, BILLER, NEW_CUSTOMER_BALANCE, OTHER_BANKS, seedBank, starterHistory } from './seed.js';
import { BankSystems, RealClock, SimClock, type BankData, type BankHealth, type BillerHealth, type Clock } from './systems.js';
import { ToolLayer, type Authorization } from './tools.js';
import { formatNgn } from '../format.js';
import type { AgentAdvice, AgentBriefing } from './advisor.js';
import type {
  Account, Actor, AuditEntry, AutonomyLevel, Customer, FailureKind, Health, Incident, Journey, Notification, Phase,
  PolicyDecision, RecoveryOption, RecoveryRecord, TraceStep, Transaction,
} from './types.js';

export interface Settings {
  level: AutonomyLevel;
  /** Who orders the recovery options: the LLM (when configured) or fixed rules. */
  planner: 'llm' | 'rules';
  /** How long a debit may stay unconfirmed before the watchdog opens an incident. */
  windows: { transferSeconds: number; billSeconds: number };
}

/** Everything ACR knows, as plain JSON. */
export interface World {
  version: 2;
  createdAt: string;
  clock: { mode: 'sim' | 'real'; ms: number };
  settings: Settings;
  bank: BankData;
  journeys: Journey[];
  incidents: Incident[];
  options: Record<string, RecoveryOption[]>;
  decisions: Record<string, PolicyDecision>;
  investigations: Record<string, Investigation>;
  briefings: Record<string, AgentBriefing>;
  /** Incidents a worker has taken for LLM planning, with the time it took them. */
  claims: Record<string, number>;
  trace: TraceStep[];
  audit: AuditEntry[];
  recoveries: RecoveryRecord[];
  seq: number;
  auditSeq: number;
  /** LLM calls made by the support chat, capped per world to bound cost on a public demo. */
  chatCalls: number;
}

/** A read-only view of the world for the operations console. */
export interface EngineState {
  level: AutonomyLevel;
  now: string;
  settings: Settings;
  bankStatus: Record<string, BankHealth>;
  billerStatus: Record<string, BillerHealth>;
  journeys: Journey[];
  incidents: Incident[];
  options: Record<string, RecoveryOption[]>;
  decisions: Record<string, PolicyDecision>;
  trace: TraceStep[];
  audit: AuditEntry[];
  notifications: Notification[];
  recoveries: RecoveryRecord[];
  tickets: string[];
  customers: Customer[];
  accounts: Account[];
  transactions: Transaction[];
}

export const PLAYBOOKS: Record<FailureKind, Playbook> = {
  transfer_not_credited: transferPlaybook,
  bill_token_missing: billTokenPlaybook,
};

export const PRODUCTION_WINDOWS = { transferSeconds: 600, billSeconds: 300 };
export const LIVE_WINDOWS = { transferSeconds: 20, billSeconds: 15 };

const OPEN: Incident['status'][] = ['investigating', 'planning', 'awaiting_approval', 'executing'];
/** Keep the persisted world small during a long live session. */
const MAX_TRACE = 3000;
const MAX_AUDIT = 3000;

export function createWorld(opts: { clock?: 'sim' | 'real'; start?: string; level?: AutonomyLevel; windows?: Settings['windows'] } = {}): World {
  const { bank, journeys } = seedBank();
  const start = opts.start ?? '2026-10-04T12:59:00+01:00';
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    clock: { mode: opts.clock ?? 'sim', ms: Date.parse(start) },
    settings: { level: opts.level ?? 2, planner: 'llm', windows: opts.windows ?? PRODUCTION_WINDOWS },
    bank,
    journeys,
    incidents: [], options: {}, decisions: {}, investigations: {}, briefings: {}, claims: {},
    trace: [], audit: [], recoveries: [],
    seq: 0, auditSeq: 0, chatCalls: 0,
  };
}

export class AcrEngine {
  readonly systems: BankSystems;
  private readonly clock: Clock;
  private readonly tools: ToolLayer;

  constructor(readonly world: World) {
    this.systems = new BankSystems(world.bank);
    this.clock = world.clock.mode === 'sim' ? new SimClock(world.clock) : new RealClock();
    this.tools = new ToolLayer(this.systems, this.clock, world);
  }

  static create(opts?: Parameters<typeof createWorld>[0]): AcrEngine {
    return new AcrEngine(createWorld(opts));
  }

  now(): string {
    return this.clock.now();
  }

  /** Moves simulated time forward. No effect on a real-time world. */
  advance(seconds: number): string {
    return this.clock.advance(seconds);
  }

  setLevel(level: AutonomyLevel): void {
    this.world.settings.level = level;
  }

  setBankStatus(bank: string, status: BankHealth): void {
    if (!(bank in this.world.bank.bankStatus)) throw new Error(`Unknown bank ${bank}`);
    this.world.bank.bankStatus[bank] = status;
  }

  setBillerStatus(biller: string, status: BillerHealth): void {
    if (!(biller in this.world.bank.billerStatus)) throw new Error(`Unknown biller ${biller}`);
    this.world.bank.billerStatus[biller] = status;
  }

  // ── Customer actions (from the mobile app) ────────────────────────────────────
  join(name: string): Customer {
    const clean = name.replace(/[^\p{L} '-]/gu, '').trim().slice(0, 40) || 'Guest';
    const id = `C${300 + Object.keys(this.world.bank.customers).length}`;
    return addCustomer(this.world.bank, { id, name: clean, balance: NEW_CUSTOMER_BALANCE, history: starterHistory(this.now()) });
  }

  startTransfer(customerId: string, input: { bank: string; account: string; name: string; amount: number; narration?: string }): Journey {
    const customer = this.systems.getCustomer(customerId);
    const account = this.systems.getAccount(customer.accountNumber);
    if (!(OTHER_BANKS as readonly string[]).includes(input.bank)) throw new Error('Choose a bank from the list.');
    if (!/^\d{10}$/.test(input.account)) throw new Error('Account number must be 10 digits.');
    const amount = Math.round(input.amount);
    if (!Number.isFinite(amount) || amount < 100) throw new Error('Minimum transfer is ₦100.');
    if (amount > account.balance) throw new Error('Insufficient balance.');

    const now = this.now();
    const beneficiary = { name: input.name.trim().slice(0, 60) || 'Beneficiary', bank: input.bank, account: input.account };
    const tx = this.systems.sendTransfer(account.number, amount, beneficiary, input.narration?.trim().slice(0, 60) || `Transfer to ${beneficiary.name}`, now);
    const nip = this.systems.statusQuery(tx.id);
    const journey = this.newJourney(customer, tx, `Transfer ${formatNgn(amount)} to ${beneficiary.name}`, 'Money reaches the beneficiary, or comes back fast');
    this.addEvent(journey, 'transfer_submitted', `Sent ${formatNgn(amount)} to ${beneficiary.name} (${beneficiary.bank})`, { transactionId: tx.id });
    this.addEvent(journey, 'account_debited', `Debited ${formatNgn(amount)}. Balance ${formatNgn(account.balance)}`, { transactionId: tx.id });
    if (nip.responseCode === '00') {
      this.addEvent(journey, 'transfer_successful', `${beneficiary.bank} confirmed the credit`, { responseCode: '00' });
      journey.currentState = 'completed';
    } else {
      this.addEvent(journey, nip.final ? 'transfer_failed' : 'transfer_pending', `NIP ${nip.responseCode}: ${nip.message}`, { responseCode: nip.responseCode });
      journey.currentState = 'debited_awaiting_credit';
    }
    return journey;
  }

  startBillPayment(customerId: string, input: { meter: string; amount: number }): Journey {
    const customer = this.systems.getCustomer(customerId);
    const account = this.systems.getAccount(customer.accountNumber);
    if (!/^\d{11}$/.test(input.meter)) throw new Error('Meter number must be 11 digits.');
    const amount = Math.round(input.amount);
    if (!Number.isFinite(amount) || amount < 500) throw new Error('Minimum token purchase is ₦500.');
    if (amount > account.balance) throw new Error('Insufficient balance.');

    const tx = this.systems.buyToken(account.number, amount, BILLER, input.meter, this.now());
    const journey = this.newJourney(customer, tx, `Buy ${formatNgn(amount)} ${BILLER} token`, 'Token delivered right after payment');
    this.addEvent(journey, 'bill_paid', `Paid ${formatNgn(amount)} for a ${BILLER} token (meter ${input.meter})`, { transactionId: tx.id });
    if (tx.bill!.delivered) {
      this.addEvent(journey, 'token_delivered', 'Token delivered', { transactionId: tx.id });
      journey.currentState = 'completed';
    } else {
      this.addEvent(journey, 'vend_timeout', `${BILLER} did not respond. No token shown`, { transactionId: tx.id });
      journey.currentState = 'debited_awaiting_token';
    }
    return journey;
  }

  /** NIP finally settles an "in progress" transfer (used by the stress test). */
  settleTransfer(transactionId: string, outcome: 'successful' | 'failed'): void {
    if (!this.systems.settleTransfer(transactionId, outcome)) return;
    const journey = this.world.journeys.find((j) => j.transactionId === transactionId);
    if (!journey) return;
    this.addEvent(journey, outcome === 'successful' ? 'transfer_settled' : 'transfer_failed', `NIP settled: ${outcome}`, { transactionId });
    if (outcome === 'successful' && journey.currentState === 'debited_awaiting_credit') journey.currentState = 'completed';
  }

  // ── Detect ────────────────────────────────────────────────────────────────
  /** The watchdog: opens an incident for every debit that is overdue. */
  sweep(): Incident[] {
    const now = this.now();
    const covered = new Set(this.world.incidents.map((i) => i.journeyId));
    const opened: Incident[] = [];
    for (const playbook of Object.values(PLAYBOOKS)) {
      for (const journey of this.world.journeys) {
        if (journey.currentState !== playbook.watches || covered.has(journey.id)) continue;
        const detection = playbook.detect({
          journey,
          customer: this.systems.getCustomer(journey.customerId),
          systems: this.systems,
          now,
          windowSeconds: this.world.settings.windows[playbook.window],
        });
        if (detection) opened.push(this.open(journey, playbook.kind, detection.received, detection.risk));
      }
    }
    return opened;
  }

  private open(journey: Journey, kind: FailureKind, received: [string, string], risk: NonNullable<ReturnType<Playbook['detect']>>['risk']): Incident {
    const incident: Incident = {
      id: `INC-${String(this.world.incidents.length + 1).padStart(4, '0')}`,
      journeyId: journey.id,
      kind,
      severity: risk.severity,
      risk: risk.risk,
      rule: risk.rule,
      ruleDescription: risk.ruleDescription,
      signals: risk.signals,
      cause: null,
      confidence: null,
      assessment: null,
      status: 'investigating',
      resolution: null,
      detectedAt: this.now(),
      resolvedAt: null,
    };
    this.world.incidents.push(incident);
    journey.health = risk.severity === 'critical' ? 'critical' : 'at_risk';
    journey.healthScore = 100 - risk.risk;
    this.addEvent(journey, 'incident_opened', `${incident.id} opened: ${risk.severity} risk`, { incidentId: incident.id });
    this.step(incident, 'detect', 'info', ...received);
    this.step(incident, 'detect', 'warn', `Rule ${risk.rule} fired: ${risk.severity.toUpperCase()} risk (${risk.risk}%)`, risk.signals.join(' + '));
    return incident;
  }

  // ── Investigate, plan, decide ───────────────────────────────────────────────
  /** Gathers evidence through read-only tools and proposes options. Returns the planner's briefing. */
  investigate(incidentId: string): AgentBriefing {
    const incident = this.incident(incidentId);
    if (incident.status !== 'investigating') throw new Error(`${incidentId} is not under investigation.`);
    const journey = this.journey(incident.journeyId);
    const id = incident.id;

    const inv = PLAYBOOKS[incident.kind].investigate(this.context(incident));
    incident.cause = inv.cause;
    incident.confidence = inv.confidence;
    this.step(incident, 'investigate', 'info', 'Root cause identified', `${inv.cause} Confidence ${Math.round(inv.confidence * 100)}%.`);
    this.world.investigations[id] = inv;
    this.world.options[id] = inv.options;
    this.step(incident, 'plan', 'info', `Evaluating ${inv.options.length} recovery options`,
      inv.options.map((o) => `${o.label}: ${o.successProbability}% success, ${formatNgn(o.costNgn)}`).join('\n'));

    // The policy engine screens options up front so the planner knows which are permitted.
    const screened = decide(id, inv.options, inv.facts, this.world.settings.level).verdicts;
    incident.status = 'planning';

    const briefing: AgentBriefing = {
      incidentId: id,
      failureType: PLAYBOOKS[incident.kind].failure,
      situation: inv.situation,
      promise: inv.promise,
      reference: journey.transactionId,
      activity: journey.title,
      customer: { name: inv.customer.name, tier: inv.customer.tier, pastFailedTransactions: inv.customer.history.failedTransactions },
      signals: incident.signals,
      evidence: this.world.trace.filter((t) => t.incidentId === id && t.phase === 'investigate').map((t) => (t.detail ? `${t.title}: ${t.detail}` : t.title)),
      rootCause: incident.cause,
      options: inv.options.map((o, i) => ({
        action: o.action, label: o.label, successProbability: o.successProbability, costNgn: o.costNgn, customerImpact: o.customerImpact,
        policy: screened[i].policy, permitted: screened[i].allowed, policyReason: screened[i].reason,
      })),
    };
    this.world.briefings[id] = briefing;
    return briefing;
  }

  /**
   * Chooses the recovery. The planner's advice (LLM) only reorders the options; the policy
   * engine still selects the first permitted one. Without advice, the default ranking is used.
   */
  conclude(incidentId: string, advice: AgentAdvice | null, plannerNote?: string): Incident {
    const incident = this.incident(incidentId);
    if (incident.status !== 'planning') throw new Error(`${incidentId} is not ready for a decision.`);
    const id = incident.id;
    const options = this.world.options[id];
    const { facts } = this.world.investigations[id];
    const level = this.world.settings.level;
    delete this.world.claims[id];

    let ranked = options;
    if (advice) {
      incident.assessment = { ...advice, source: plannerNote ?? 'LLM' };
      this.step(incident, 'plan', 'info', `Agent reasoning (${plannerNote ?? 'LLM'})`,
        `${advice.diagnosis}\nChoice: ${advice.selectedAction}. ${advice.rationale}`);
      const preferred = options.find((o) => o.action === advice.selectedAction);
      if (preferred) ranked = [preferred, ...options.filter((o) => o !== preferred)];
    } else {
      this.step(incident, 'plan', 'info', 'Deterministic planner used', plannerNote ?? 'Options ranked by customer impact, then cost.');
    }

    // Decide: the policy engine has the final say.
    const decision = decide(id, ranked, facts, level);
    this.world.decisions[id] = decision;
    for (const v of decision.verdicts.filter((v) => !v.allowed)) {
      this.step(incident, 'decide', 'warn', `${v.policy} blocked ${v.action}`, v.reason);
    }
    const { selected, selectedVerdict } = decision;
    if (advice && selected.action !== advice.selectedAction) {
      this.step(incident, 'decide', 'warn', 'Policy overrode the agent', `Agent chose ${advice.selectedAction}, but policy does not permit it. Using ${selected.action}.`);
    }
    this.world.audit.push({
      id: `AUD-P${id.slice(4)}`, incidentId: id, tool: 'policy.evaluate', actor: 'policy-engine',
      input: { level, proposed: ranked.map((o) => o.action), agentChoice: advice?.selectedAction ?? null },
      output: { selected: selected.action, policy: selectedVerdict.policy, autonomous: selectedVerdict.autonomous },
      at: this.now(), ok: true,
    });

    if (level === 0) {
      incident.status = 'observing';
      this.step(incident, 'decide', 'info', `Level 0 (Observe): recommending "${selected.label}"`, 'No action taken. An operator must act manually.');
      this.finish(incident, selected.action, null, 'observed', 'medium', false);
    } else if (selected.action === 'human_review') {
      this.escalate(incident, 'No autonomous recovery is authorized. Handed to a human agent with the full investigation.');
    } else if (selectedVerdict.autonomous) {
      incident.status = 'executing';
      this.step(incident, 'decide', 'ok', 'ACTION APPROVED', `${selectedVerdict.policy}: ${selected.label}. ${selectedVerdict.reason}`);
    } else {
      incident.status = 'awaiting_approval';
      this.step(incident, 'decide', 'warn', 'Awaiting operator approval', `${selectedVerdict.policy}: ${selected.label}. ${selectedVerdict.reason}`);
    }
    return incident;
  }

  // ── Act, verify, notify, learn ─────────────────────────────────────────────
  /** Runs the authorized recovery. Below Level 2 (or over a limit) the operator's approval is the authorization. */
  execute(incidentId: string, approvedBy: Actor = 'policy-engine'): Incident {
    const incident = this.incident(incidentId);
    const decision = this.world.decisions[incidentId];
    if (incident.status === 'awaiting_approval' && approvedBy === 'operator') {
      this.clock.advance(90);
      this.step(incident, 'decide', 'ok', 'ACTION APPROVED by operator', decision.selected.label);
    } else if (incident.status !== 'executing') {
      throw new Error(`${incidentId} is not ready to execute (status: ${incident.status}).`);
    }
    incident.status = 'executing';
    const auth: Authorization = { decision, approvedBy };
    const investigation = this.world.investigations[incidentId];
    const journey = this.journey(incident.journeyId);

    const result = PLAYBOOKS[incident.kind].execute(this.context(incident), decision, auth, investigation);
    if (!result.ok) {
      this.escalate(incident, `${result.reason} Handed to a human agent.`, 'failed');
      return incident;
    }
    for (const e of result.events) this.addEvent(journey, e.type, e.summary, e.payload);
    journey.currentState = result.journeyState;

    const sent = this.tools.write(incidentId, 'send_notification', { customerId: investigation.customer.id, ...result.notification }, auth) as Notification;
    this.addEvent(journey, 'customer_notified', `Customer informed via ${sent.channel.toUpperCase()}`, { notificationId: sent.id });
    this.step(incident, 'notify', 'ok', `Customer notified via ${sent.channel.toUpperCase()}`, sent.to);

    incident.status = 'resolved';
    incident.resolution = result.resolution;
    journey.health = 'recovered';
    journey.healthScore = 94;
    this.finish(incident, decision.selected.action, decision.selected.action, 'successful', 'none', true);
    return incident;
  }

  /** Operator declines the recommendation. */
  reject(incidentId: string): Incident {
    const incident = this.incident(incidentId);
    if (incident.status !== 'awaiting_approval') throw new Error(`${incidentId} is not awaiting approval.`);
    this.clock.advance(60);
    this.escalate(incident, 'Operator rejected the recommendation. The incident stays with the operator.');
    return incident;
  }

  /** Runs every step that needs no LLM: sweep, investigate, and execute what policy cleared. */
  runAutomatic(plan: 'rules' | 'defer'): { opened: number; planning: string[] } {
    const opened = this.sweep().length;
    for (const i of this.world.incidents.filter((x) => x.status === 'investigating')) this.investigate(i.id);
    const planning = this.world.incidents.filter((x) => x.status === 'planning').map((x) => x.id);
    if (plan === 'rules') {
      for (const id of planning) this.conclude(id, null);
      this.executeReady();
      return { opened, planning: [] };
    }
    return { opened, planning };
  }

  executeReady(): void {
    for (const i of this.world.incidents.filter((x) => x.status === 'executing')) this.execute(i.id);
  }

  /** Marks planning incidents as taken, so concurrent workers don't plan the same one twice. */
  claim(ids: string[], staleAfterMs = 30_000): string[] {
    const now = Date.now();
    const mine = ids.filter((id) => !this.world.claims[id] || now - this.world.claims[id] > staleAfterMs);
    for (const id of mine) this.world.claims[id] = now;
    return mine;
  }

  snapshot(): EngineState {
    const w = this.world;
    return structuredClone({
      level: w.settings.level,
      now: this.now(),
      settings: w.settings,
      bankStatus: w.bank.bankStatus,
      billerStatus: w.bank.billerStatus,
      journeys: w.journeys,
      incidents: w.incidents,
      options: w.options,
      decisions: w.decisions,
      trace: w.trace,
      audit: w.audit,
      notifications: w.bank.outbox,
      recoveries: w.recoveries,
      tickets: w.bank.tickets,
      customers: Object.values(w.bank.customers),
      accounts: Object.values(w.bank.accounts),
      transactions: Object.values(w.bank.transactions),
    });
  }

  /** Trims the oldest trace and audit records so a long session stays small. */
  compact(): void {
    if (this.world.trace.length > MAX_TRACE) this.world.trace.splice(0, this.world.trace.length - MAX_TRACE);
    if (this.world.audit.length > MAX_AUDIT) this.world.audit.splice(0, this.world.audit.length - MAX_AUDIT);
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private newJourney(customer: Customer, tx: Transaction, title: string, objective: string): Journey {
    const journey: Journey = {
      id: `JRN-${3000 + ++this.world.seq}`,
      title,
      customerId: customer.id,
      transactionId: tx.id,
      objective,
      currentState: 'submitted',
      expectedState: 'completed',
      deadline: tx.at,
      health: 'healthy',
      healthScore: 97,
      events: [],
    };
    this.world.journeys.push(journey);
    return journey;
  }

  private context(incident: Incident): PlaybookContext {
    return {
      incident,
      journey: this.journey(incident.journeyId),
      tools: this.tools,
      systems: this.systems,
      now: () => this.now(),
      step: (phase, status, title, detail) => this.step(incident, phase, status, title, detail),
    };
  }

  private escalate(incident: Incident, reason: string, outcome: 'escalated' | 'failed' = 'escalated'): void {
    incident.status = 'escalated';
    incident.resolution = reason;
    const journey = this.journey(incident.journeyId);
    journey.health = 'escalated';
    this.addEvent(journey, 'escalated_to_human', 'Handed to a human agent', { incidentId: incident.id });
    this.step(incident, 'decide', 'warn', 'ESCALATED TO HUMAN', `${reason} Customer not contacted yet.`);
    this.finish(incident, this.world.decisions[incident.id]?.selected.action ?? 'human_review', null, outcome, 'medium', false);
  }

  private finish(
    incident: Incident, proposed: RecoveryRecord['proposedAction'], actual: RecoveryRecord['actualAction'],
    outcome: RecoveryRecord['outcome'], impact: RecoveryRecord['customerImpact'], complaintAvoided: boolean,
  ): void {
    const now = this.now();
    incident.resolvedAt = outcome === 'successful' ? now : null;
    const record: RecoveryRecord = {
      incidentId: incident.id,
      journeyId: incident.journeyId,
      failure: PLAYBOOKS[incident.kind].failure,
      proposedAction: proposed,
      actualAction: actual,
      costNgn: actual ? (this.world.decisions[incident.id]?.selected.costNgn ?? 0) : 0,
      outcome,
      customerImpact: impact,
      complaintAvoided,
      ticketsCreated: this.world.bank.tickets.length,
      customerActionsRequired: 0,
      recoverySeconds: outcome === 'successful' ? (Date.parse(now) - Date.parse(incident.detectedAt)) / 1000 : null,
    };
    this.world.recoveries.push(record);
    this.step(incident, 'learn', outcome === 'successful' ? 'ok' : 'info', 'Outcome recorded',
      `Failure: ${record.failure} · Action: ${actual ?? 'none'} · Outcome: ${outcome} · Cost: ${formatNgn(record.costNgn)} · Complaint avoided: ${complaintAvoided ? 'yes' : 'not yet'}`);
    if (outcome === 'successful') this.step(incident, 'learn', 'ok', 'RECOVERY COMPLETE');
  }

  private step(incident: Incident, phase: Phase, status: TraceStep['status'], title: string, detail?: string): void {
    this.world.trace.push({ id: `TR-${String(++this.world.seq).padStart(5, '0')}`, incidentId: incident.id, journeyId: incident.journeyId, phase, status, title, detail, at: this.now() });
  }

  private addEvent(journey: Journey, type: string, summary: string, payload: Record<string, unknown>) {
    const event = { id: `${journey.id}-X${++this.world.seq}`, journeyId: journey.id, at: this.now(), type, summary, payload };
    journey.events.push(event);
    return event;
  }

  journey(id: string): Journey {
    const journey = this.world.journeys.find((j) => j.id === id);
    if (!journey) throw new Error(`Unknown journey ${id}`);
    return journey;
  }

  incident(id: string): Incident {
    const incident = this.world.incidents.find((i) => i.id === id);
    if (!incident) throw new Error(`Unknown incident ${id}`);
    return incident;
  }

  isOpen(incident: Incident): boolean {
    return OPEN.includes(incident.status);
  }
}

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  at_risk: 'At risk',
  critical: 'Critical',
  recovered: 'Recovered',
  escalated: 'With agent',
};
