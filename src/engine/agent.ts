// The ACR agentic loop (PRD §8): detect → investigate → plan → decide → act → verify → notify → learn.
// The planner is deterministic in the MVP; it may only propose actions, which the policy engine must approve.

import { assessDeliveryRisk } from './detection';
import { decide, eligibilityProblems, type PolicyFacts } from './policy';
import { seed, DEMO_START, type Scenario } from './seed';
import { addMinutes, SimClock, type BusinessSystems } from './systems';
import { ToolLayer, type Authorization } from './tools';
import { formatNgn, formatTime, formatDateTime } from '../format';
import type { AgentAdvice, AgentBriefing } from './advisor';
import type {
  Actor, AuditEntry, AutonomyLevel, Courier, Customer, Health, Incident, Journey, Notification, Order, Payment,
  InventoryRecord, Phase, PolicyDecision, RecoveryOption, RecoveryRecord, TraceStep,
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
  couriers: Courier[];
}

interface Investigation {
  order: Order;
  customer: Customer;
  payment: Payment;
  inventory: InventoryRecord;
  original: Courier | null;
  best: { courier: Courier; eta: string } | null;
  facts: PolicyFacts;
}

export class AcrEngine {
  private readonly systems: BusinessSystems;
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

  constructor(readonly scenario: Scenario = 'alternate_available', private level: AutonomyLevel = 2) {
    const seeded = seed(scenario);
    this.systems = seeded.systems;
    this.journeys = seeded.journeys;
    this.tools = new ToolLayer(this.systems, this.clock, this.audit);
  }

  setLevel(level: AutonomyLevel): void {
    this.level = level;
  }

  canTrigger(journeyId: string): boolean {
    const journey = this.journeys.find((j) => j.id === journeyId);
    return !!journey && this.systems.getOrder(journey.orderId).status === 'courier_assigned' && !this.openIncident(journeyId);
  }

  // ── Detect ────────────────────────────────────────────────────────────────
  /** Simulates the logistics system reporting that the courier dropped the route. */
  triggerCourierRejection(journeyId: string): Incident | null {
    if (!this.canTrigger(journeyId)) throw new Error(`Journey ${journeyId} has no active courier assignment to reject.`);
    const journey = this.journey(journeyId);
    const at = this.clock.advance(60);
    const courier = this.systems.rejectRoute(journey.orderId);
    const event = this.addEvent(journey, 'courier_rejected_route', `${courier.name} rejected the route`, {
      courierId: courier.id,
      reason: 'route exceeds courier capacity',
    });
    journey.currentState = 'courier_rejected';

    const order = this.systems.getOrder(journey.orderId);
    const customer = this.systems.getCustomer(journey.customerId);
    const risk = assessDeliveryRisk(journey, order, customer, event);
    if (!risk) {
      journey.healthScore = 70;
      return null;
    }

    const incident: Incident = {
      id: `INC-${String(this.incidents.length + 1).padStart(4, '0')}`,
      journeyId,
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
      detectedAt: at,
      resolvedAt: null,
    };
    this.incidents.push(incident);
    journey.health = risk.severity === 'critical' ? 'critical' : 'at_risk';
    journey.healthScore = 100 - risk.risk;
    this.addEvent(journey, 'incident_opened', `${incident.id} opened: ${risk.severity} delivery risk`, { incidentId: incident.id });

    this.step(incident, 'detect', 'info', `Event received: courier_rejected_route on ${order.id}`, `${courier.name} · ${String(event.payload.reason)}`);
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

    this.step(incident, 'investigate', 'info', `Investigating order ${journey.orderId}`);
    const order = this.tools.read(id, 'get_order', { orderId: journey.orderId }) as Order;
    const payment = this.tools.read(id, 'get_payment', { orderId: order.id }) as Payment;
    this.step(incident, 'investigate', payment.status === 'confirmed' ? 'ok' : 'fail',
      payment.status === 'confirmed' ? 'Payment confirmed' : `Payment ${payment.status}`, `${payment.reference} · ${formatNgn(payment.amount)}`);
    const inventory = this.tools.read(id, 'get_inventory', { orderId: order.id }) as InventoryRecord;
    this.step(incident, 'investigate', inventory.reserved ? 'ok' : 'fail',
      inventory.reserved ? 'Inventory available' : 'Inventory not reserved', `${inventory.sku} reserved at ${inventory.warehouse}`);
    const customer = this.tools.read(id, 'get_customer', { customerId: order.customerId }) as Customer;
    const history = this.tools.read(id, 'search_support_history', { customerId: customer.id }) as unknown[];
    this.step(incident, 'investigate', 'info', `Customer: ${customer.name} (${customer.tier})`,
      history.length ? `${history.length} past support contacts about late deliveries` : 'No past support contacts');

    const pool = this.tools.read(id, 'find_couriers', { zone: order.zone }) as Courier[];
    const rejected = [...journey.events].reverse().find((e) => e.type === 'courier_rejected_route');
    const original = pool.find((c) => c.id === rejected?.payload.courierId) ?? null;
    if (original) {
      this.step(incident, 'investigate', 'fail', `Courier unavailable: ${original.name}`, `Capacity ${Math.round(original.capacity * 100)}%. Route rejected.`);
    }
    let best: Investigation['best'] = null;
    for (const courier of pool.filter((c) => c.id !== original?.id)) {
      const eta = addMinutes(this.clock.now(), courier.pickupMinutes + order.transitMinutes);
      const problems = eligibilityProblems(order, courier, eta);
      if (problems.length === 0) {
        this.step(incident, 'investigate', 'ok', `Alternate courier found: ${courier.name}`,
          `Capacity ${Math.round(courier.capacity * 100)}% · pickup in ${courier.pickupMinutes} min · ETA ${formatTime(eta)}`);
        if (!best || courier.capacity < best.courier.capacity) best = { courier, eta };
      } else {
        this.step(incident, 'investigate', 'warn', `${courier.name} not eligible`, problems.join(', '));
      }
    }

    incident.cause = original
      ? `${original.name} rejected the route because it exceeded its capacity (${Math.round(original.capacity * 100)}%).`
      : 'The assigned courier rejected the route.';
    incident.confidence = original && !original.available ? 0.92 : 0.6;
    this.step(incident, 'investigate', 'info', 'Root cause identified', `${incident.cause} Confidence ${Math.round(incident.confidence * 100)}%.`);

    // Plan: propose options, ranked by customer impact then cost.
    const options: RecoveryOption[] = [
      best
        ? { action: 'reassign_courier', label: `Reassign to ${best.courier.name}`, successProbability: Math.round((1 - best.courier.capacity / 10) * 100), costNgn: 0, customerImpact: 'low', courierId: best.courier.id, projectedEta: best.eta }
        : { action: 'reassign_courier', label: 'Reassign courier (no eligible courier)', successProbability: 0, costNgn: 0, customerImpact: 'low' },
      { action: 'delay_with_credit', label: 'Delay delivery and offer ₦2,000 credit', successProbability: 99, costNgn: 2_000, customerImpact: 'medium' },
      { action: 'refund', label: 'Refund the customer', successProbability: 100, costNgn: order.amount, customerImpact: 'high' },
      { action: 'human_review', label: 'Escalate to a human operator', successProbability: 85, costNgn: 0, customerImpact: 'medium' },
    ];
    this.options[id] = options;
    this.step(incident, 'plan', 'info', `Evaluating ${options.length} recovery options`,
      options.map((o) => `${o.label}: ${o.successProbability}% success, ${formatNgn(o.costNgn)}`).join('\n'));

    // The policy engine checks the facts itself, so the planner sees which options are permitted.
    const facts: PolicyFacts = {
      order,
      paymentConfirmed: payment.status === 'confirmed',
      inventoryReserved: inventory.reserved,
      originalCourierUnavailable: !!original && !original.available,
      candidate: best ? this.systems.getCourier(best.courier.id) : null,
    };
    this.investigations[id] = { order, customer, payment, inventory, original, best, facts };
    const screened = decide(id, options, facts, this.level).verdicts;
    incident.status = 'planning';

    return {
      incidentId: id,
      orderId: order.id,
      item: order.item,
      promisedBy: formatDateTime(order.promisedBy),
      customer: { name: customer.name, tier: customer.tier, previousDelays: customer.history.previousDelays },
      signals: incident.signals,
      evidence: this.trace.filter((t) => t.incidentId === id && t.phase === 'investigate').map((t) => (t.detail ? `${t.title}: ${t.detail}` : t.title)),
      rootCause: incident.cause,
      options: options.map((o, i) => ({
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
    const inv = this.investigations[incidentId];
    const journey = this.journey(incident.journeyId);
    const courierId = decision.selected.courierId!;
    const courierName = this.systems.getCourier(courierId).name;

    const result = this.tools.write(incidentId, 'reassign_delivery', { orderId: inv.order.id, courierId }, auth) as { accepted: boolean };
    this.step(incident, 'act', result.accepted ? 'ok' : 'fail',
      result.accepted ? `Courier reassigned to ${courierName}` : `${courierName} declined the reassignment`);

    // Verify: never assume the action worked.
    const status = this.tools.read(incidentId, 'get_delivery_status', { orderId: inv.order.id }) as { courierId: string | null; courierAccepted: boolean; eta: string; promisedBy: string };
    const accepted = status.courierAccepted && status.courierId === courierId;
    const etaPreserved = Date.parse(status.eta) <= Date.parse(status.promisedBy);
    this.step(incident, 'verify', accepted ? 'ok' : 'fail', accepted ? 'Courier accepted' : 'Courier acceptance not confirmed');
    this.step(incident, 'verify', etaPreserved ? 'ok' : 'fail', etaPreserved ? 'ETA preserved' : 'ETA misses promised time',
      `New ETA ${formatDateTime(status.eta)} · promised by ${formatDateTime(status.promisedBy)}`);
    if (!accepted || !etaPreserved) {
      this.escalate(incident, 'Verification failed after reassignment. Handed to a human operator.', 'failed');
      return incident;
    }
    this.addEvent(journey, 'courier_reassigned', `ACR reassigned delivery to ${courierName}`, { courierId, eta: status.eta });
    journey.currentState = 'courier_assigned';

    const firstName = inv.customer.name.split(' ')[0];
    const body = `Hi ${firstName}, your order ${inv.order.id} (${inv.order.item}) was at risk of a delay because the original courier couldn't take the route. `
      + `We've reassigned it to ${courierName}, and it will still arrive by ${formatDateTime(inv.order.promisedBy)}. You don't need to do anything.`;
    const sent = this.tools.write(incidentId, 'send_notification', { customerId: inv.customer.id, body }, auth) as Notification;
    this.addEvent(journey, 'customer_notified', `Customer informed via ${sent.channel.toUpperCase()}`, { notificationId: sent.id });
    this.step(incident, 'notify', 'ok', `Customer notified via ${sent.channel.toUpperCase()}`, sent.to);

    incident.status = 'resolved';
    incident.resolution = `Reassigned to ${courierName}. Promised delivery time kept. Customer informed.`;
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
      couriers: [...this.systems.couriers.values()],
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────
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
      failure: 'Courier capacity',
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

  private openIncident(journeyId: string): Incident | undefined {
    return this.incidents.find((i) => i.journeyId === journeyId && ['investigating', 'planning', 'awaiting_approval', 'executing'].includes(i.status));
  }
}

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  at_risk: 'At risk',
  critical: 'Critical',
  recovered: 'Recovered',
  escalated: 'With operator',
};
