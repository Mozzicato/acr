// The ACR agentic loop (PRD §8): detect → investigate → plan → decide → act → verify → notify → learn.
// Failure-specific work lives in playbooks; this engine owns the loop, the policy decision,
// escalation and learning. The planner (LLM or rules) may only propose; policy decides.

import { decide } from './policy';
import { billTokenPlaybook } from './playbooks/billToken';
import { transferPlaybook } from './playbooks/transfer';
import type { Investigation, Playbook, PlaybookContext } from './playbooks/types';
import { seed, DEMO_START, type Scenario } from './seed';
import { SimClock, type BankSystems } from './systems';
import { ToolLayer, type Authorization } from './tools';
import { formatNgn } from '../format';
import type { AgentAdvice, AgentBriefing } from './advisor';
import type {
  Account, Actor, AuditEntry, AutonomyLevel, Customer, FailureKind, Health, Incident, Journey, Notification, Phase,
  PolicyDecision, RecoveryOption, RecoveryRecord, TraceStep, Transaction,
} from './types';

export interface EngineState {
  scenario: Scenario;
  level: AutonomyLevel;
  now: string;
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

const PLAYBOOKS: Record<FailureKind, Playbook> = {
  transfer_not_credited: transferPlaybook,
  bill_token_missing: billTokenPlaybook,
};

export const FAILURES: Record<FailureKind, { trigger: string; label: string }> = {
  transfer_not_credited: { trigger: transferPlaybook.trigger, label: transferPlaybook.failure },
  bill_token_missing: { trigger: billTokenPlaybook.trigger, label: billTokenPlaybook.failure },
};

const OPEN: Incident['status'][] = ['investigating', 'planning', 'awaiting_approval', 'executing'];

export class AcrEngine {
  private readonly systems: BankSystems;
  private readonly clock = new SimClock(DEMO_START);
  private readonly tools: ToolLayer;
  private readonly journeys: Journey[];
  private readonly incidents: Incident[] = [];
  private readonly options: Record<string, RecoveryOption[]> = {};
  private readonly decisions: Record<string, PolicyDecision> = {};
  private readonly investigations: Record<string, Investigation> = {};
  private readonly trace: TraceStep[] = [];
  private readonly audit: AuditEntry[] = [];
  private readonly recoveries: RecoveryRecord[] = [];
  private seq = 0;

  constructor(readonly scenario: Scenario = 'recoverable', private level: AutonomyLevel = 2) {
    const seeded = seed(scenario);
    this.systems = seeded.systems;
    this.journeys = seeded.journeys;
    this.tools = new ToolLayer(this.systems, this.clock, this.audit);
  }

  setLevel(level: AutonomyLevel): void {
    this.level = level;
  }

  /** Failures that can be simulated on this journey right now. */
  availableTriggers(journeyId: string): FailureKind[] {
    const journey = this.journeys.find((j) => j.id === journeyId);
    if (!journey || this.incidents.some((i) => i.journeyId === journeyId && OPEN.includes(i.status))) return [];
    return Object.values(PLAYBOOKS).filter((p) => p.canTrigger(journey)).map((p) => p.kind);
  }

  // ── Detect ────────────────────────────────────────────────────────────────
  /** Simulates the failure in the business systems, then runs ACR's detection rules. */
  trigger(journeyId: string, kind: FailureKind): Incident | null {
    if (!this.availableTriggers(journeyId).includes(kind)) throw new Error(`Cannot simulate ${kind} on ${journeyId} right now.`);
    const journey = this.journey(journeyId);
    const { received, risk } = PLAYBOOKS[kind].simulate({
      journey,
      customer: this.systems.getCustomer(journey.customerId),
      systems: this.systems,
      clock: this.clock,
      addEvent: (type, summary, payload = {}) => void this.addEvent(journey, type, summary, payload),
    });

    if (!risk) {
      journey.healthScore = 70;
      return null;
    }
    const incident: Incident = {
      id: `INC-${String(this.incidents.length + 1).padStart(4, '0')}`,
      journeyId,
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
      detectedAt: this.clock.now(),
      resolvedAt: null,
    };
    this.incidents.push(incident);
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
    this.investigations[id] = inv;
    this.options[id] = inv.options;
    this.step(incident, 'plan', 'info', `Evaluating ${inv.options.length} recovery options`,
      inv.options.map((o) => `${o.label}: ${o.successProbability}% success, ${formatNgn(o.costNgn)}`).join('\n'));

    // The policy engine screens options up front so the planner knows which are permitted.
    const screened = decide(id, inv.options, inv.facts, this.level).verdicts;
    incident.status = 'planning';

    return {
      incidentId: id,
      failureType: PLAYBOOKS[incident.kind].failure,
      situation: inv.situation,
      promise: inv.promise,
      reference: journey.transactionId,
      activity: journey.title,
      customer: { name: inv.customer.name, tier: inv.customer.tier, pastFailedTransactions: inv.customer.history.failedTransactions },
      signals: incident.signals,
      evidence: this.trace.filter((t) => t.incidentId === id && t.phase === 'investigate').map((t) => (t.detail ? `${t.title}: ${t.detail}` : t.title)),
      rootCause: incident.cause,
      options: inv.options.map((o, i) => ({
        action: o.action, label: o.label, successProbability: o.successProbability, costNgn: o.costNgn, customerImpact: o.customerImpact,
        policy: screened[i].policy, permitted: screened[i].allowed, policyReason: screened[i].reason,
      })),
    };
  }

  /**
   * Chooses the recovery. The planner's advice (LLM) only reorders the options; the policy
   * engine still selects the first permitted one. Without advice, the default ranking is used.
   */
  conclude(incidentId: string, advice: AgentAdvice | null, plannerNote?: string): Incident {
    const incident = this.incident(incidentId);
    if (incident.status !== 'planning') throw new Error(`${incidentId} is not ready for a decision.`);
    const id = incident.id;
    const options = this.options[id];
    const { facts } = this.investigations[id];

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
    const decision = decide(id, ranked, facts, this.level);
    this.decisions[id] = decision;
    for (const v of decision.verdicts.filter((v) => !v.allowed)) {
      this.step(incident, 'decide', 'warn', `${v.policy} blocked ${v.action}`, v.reason);
    }
    const { selected, selectedVerdict } = decision;
    if (advice && selected.action !== advice.selectedAction) {
      this.step(incident, 'decide', 'warn', 'Policy overrode the agent', `Agent chose ${advice.selectedAction}, but policy does not permit it. Using ${selected.action}.`);
    }
    this.audit.push({
      id: `AUD-P${id.slice(4)}`, incidentId: id, tool: 'policy.evaluate', actor: 'policy-engine',
      input: { level: this.level, proposed: ranked.map((o) => o.action), agentChoice: advice?.selectedAction ?? null },
      output: { selected: selected.action, policy: selectedVerdict.policy, autonomous: selectedVerdict.autonomous },
      at: this.clock.now(), ok: true,
    });

    if (this.level === 0) {
      incident.status = 'observing';
      this.step(incident, 'decide', 'info', `Level 0 (Observe): recommending "${selected.label}"`, 'No action taken. An operator must act manually.');
      this.finish(incident, selected.action, null, 'observed', 'medium', false);
    } else if (selected.action === 'human_review') {
      this.escalate(incident, 'No autonomous recovery is authorized. Handed to a human operator with the full investigation.');
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
  /** Runs the authorized recovery. At Level 1 the operator's approval is the authorization. */
  execute(incidentId: string, approvedBy: Actor = 'policy-engine'): Incident {
    const incident = this.incident(incidentId);
    const decision = this.decisions[incidentId];
    if (incident.status === 'awaiting_approval' && approvedBy === 'operator') {
      this.clock.advance(90);
      this.step(incident, 'decide', 'ok', 'ACTION APPROVED by operator', decision.selected.label);
    } else if (incident.status !== 'executing') {
      throw new Error(`${incidentId} is not ready to execute (status: ${incident.status}).`);
    }
    incident.status = 'executing';
    const auth: Authorization = { decision, approvedBy };
    const investigation = this.investigations[incidentId];
    const journey = this.journey(incident.journeyId);

    const result = PLAYBOOKS[incident.kind].execute(this.context(incident), decision, auth, investigation);
    if (!result.ok) {
      this.escalate(incident, `${result.reason} Handed to a human operator.`, 'failed');
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

  /** Operator declines the recommendation at Level 1. */
  reject(incidentId: string): Incident {
    const incident = this.incident(incidentId);
    if (incident.status !== 'awaiting_approval') throw new Error(`${incidentId} is not awaiting approval.`);
    this.clock.advance(60);
    this.escalate(incident, 'Operator rejected the recommendation. The incident stays with the operator.');
    return incident;
  }

  snapshot(): EngineState {
    return structuredClone({
      scenario: this.scenario,
      level: this.level,
      now: this.clock.now(),
      journeys: this.journeys,
      incidents: this.incidents,
      options: this.options,
      decisions: this.decisions,
      trace: this.trace,
      audit: this.audit,
      notifications: this.systems.outbox,
      recoveries: this.recoveries,
      tickets: this.systems.tickets,
      customers: [...this.systems.customers.values()],
      accounts: [...this.systems.accounts.values()],
      transactions: [...this.systems.transactions.values()],
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private context(incident: Incident): PlaybookContext {
    return {
      incident,
      journey: this.journey(incident.journeyId),
      tools: this.tools,
      systems: this.systems,
      now: () => this.clock.now(),
      step: (phase, status, title, detail) => this.step(incident, phase, status, title, detail),
    };
  }

  private escalate(incident: Incident, reason: string, outcome: 'escalated' | 'failed' = 'escalated'): void {
    incident.status = 'escalated';
    incident.resolution = reason;
    const journey = this.journey(incident.journeyId);
    journey.health = 'escalated';
    this.addEvent(journey, 'escalated_to_human', 'Handed to a human operator', { incidentId: incident.id });
    this.step(incident, 'decide', 'warn', 'ESCALATED TO HUMAN', `${reason} Customer not contacted yet.`);
    this.finish(incident, this.decisions[incident.id]?.selected.action ?? 'human_review', null, outcome, 'medium', false);
  }

  private finish(
    incident: Incident, proposed: RecoveryRecord['proposedAction'], actual: RecoveryRecord['actualAction'],
    outcome: RecoveryRecord['outcome'], impact: RecoveryRecord['customerImpact'], complaintAvoided: boolean,
  ): void {
    const now = this.clock.now();
    incident.resolvedAt = outcome === 'successful' ? now : null;
    const record: RecoveryRecord = {
      incidentId: incident.id,
      journeyId: incident.journeyId,
      failure: PLAYBOOKS[incident.kind].failure,
      proposedAction: proposed,
      actualAction: actual,
      costNgn: actual ? (this.decisions[incident.id]?.selected.costNgn ?? 0) : 0,
      outcome,
      customerImpact: impact,
      complaintAvoided,
      ticketsCreated: this.systems.tickets.length,
      customerActionsRequired: 0,
      recoverySeconds: outcome === 'successful' ? (Date.parse(now) - Date.parse(incident.detectedAt)) / 1000 : null,
    };
    this.recoveries.push(record);
    this.step(incident, 'learn', outcome === 'successful' ? 'ok' : 'info', 'Outcome recorded',
      `Failure: ${record.failure} · Action: ${actual ?? 'none'} · Outcome: ${outcome} · Cost: ${formatNgn(record.costNgn)} · Complaint avoided: ${complaintAvoided ? 'yes' : 'not yet'}`);
    if (outcome === 'successful') this.step(incident, 'learn', 'ok', 'RECOVERY COMPLETE');
  }

  private step(incident: Incident, phase: Phase, status: TraceStep['status'], title: string, detail?: string): void {
    this.trace.push({ id: `TR-${String(++this.seq).padStart(4, '0')}`, incidentId: incident.id, journeyId: incident.journeyId, phase, status, title, detail, at: this.clock.now() });
  }

  private addEvent(journey: Journey, type: string, summary: string, payload: Record<string, unknown>) {
    const event = { id: `${journey.id}-X${++this.seq}`, journeyId: journey.id, at: this.clock.now(), type, summary, payload };
    journey.events.push(event);
    return event;
  }

  private journey(id: string): Journey {
    const journey = this.journeys.find((j) => j.id === id);
    if (!journey) throw new Error(`Unknown journey ${id}`);
    return journey;
  }

  private incident(id: string): Incident {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) throw new Error(`Unknown incident ${id}`);
    return incident;
  }
}

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  at_risk: 'At risk',
  critical: 'Critical',
  recovered: 'Recovered',
  escalated: 'With operator',
};
