import { describe, expect, it } from 'vitest';
import { AcrEngine } from './agent';
import { computeMetrics } from './metrics';
import { DEMO_JOURNEY_ID, ORDER_SYNC_JOURNEY_ID } from './seed';

function runDemo(engine: AcrEngine) {
  const incident = engine.triggerCourierRejection(DEMO_JOURNEY_ID)!;
  engine.investigate(incident.id);
  engine.conclude(incident.id, null);
  return incident.id;
}

describe('MVP acceptance criteria (PRD §10)', () => {
  it('1–2: courier rejection moves the journey from healthy to at risk with rule and evidence', () => {
    const engine = new AcrEngine();
    expect(engine.snapshot().journeys.find((j) => j.id === DEMO_JOURNEY_ID)!.health).toBe('healthy');

    const incident = engine.triggerCourierRejection(DEMO_JOURNEY_ID)!;
    const state = engine.snapshot();
    expect(state.journeys.find((j) => j.id === DEMO_JOURNEY_ID)!.health).toBe('at_risk');
    expect(incident.rule).toBe('DR-DELIVERY-01');
    expect(incident.risk).toBe(91);
    expect(incident.signals).toContain('No replacement courier assigned');
  });

  it('3: the investigation reads order, payment, inventory and courier availability', () => {
    const engine = new AcrEngine();
    runDemo(engine);
    const tools = engine.snapshot().audit.map((a) => a.tool);
    expect(tools).toEqual(expect.arrayContaining(['get_order', 'get_payment', 'get_inventory', 'find_couriers']));
  });

  it('4: policy authorizes reassignment only when an eligible alternate courier exists', () => {
    const ok = new AcrEngine('recoverable');
    const okId = runDemo(ok);
    const okDecision = ok.snapshot().decisions[okId];
    expect(okDecision.selected.action).toBe('reassign_courier');
    expect(okDecision.selected.courierId).toBe('CR-LAGOON');

    const saturated = new AcrEngine('constrained');
    const id = runDemo(saturated);
    const state = saturated.snapshot();
    expect(state.decisions[id].selected.action).toBe('human_review');
    expect(state.decisions[id].verdicts[0]).toMatchObject({ action: 'reassign_courier', allowed: false });
    expect(state.incidents[0].status).toBe('escalated');
    expect(state.audit.some((a) => a.tool === 'reassign_delivery')).toBe(false);
    expect(state.notifications).toHaveLength(0);
  });

  it('5–6: Level 2 reassigns, verifies, notifies, records the outcome, and opens no ticket', () => {
    const engine = new AcrEngine('recoverable', 2);
    const id = runDemo(engine);
    engine.execute(id);
    const state = engine.snapshot();

    expect(state.incidents[0].status).toBe('resolved');
    expect(state.journeys.find((j) => j.id === DEMO_JOURNEY_ID)!.health).toBe('recovered');
    expect(state.trace.map((t) => t.title)).toEqual(expect.arrayContaining(['Courier accepted', 'ETA preserved', 'RECOVERY COMPLETE']));
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].body).toContain('Lagoon Express');
    expect(state.recoveries[0]).toMatchObject({ outcome: 'successful', costNgn: 0, complaintAvoided: true, ticketsCreated: 0 });
    expect(state.tickets).toHaveLength(0);
    for (const entry of state.audit) {
      expect(entry).toMatchObject({ incidentId: id, at: expect.any(String), actor: expect.any(String) });
      expect(entry.input).toBeDefined();
      expect(entry.output).toBeDefined();
    }
    const metrics = computeMetrics(state);
    expect(metrics.arr).toBe(1);
    expect(metrics.her).toBe(0);
    expect(metrics.customerEffort).toBe(0);
  });
});

describe('autonomy levels and permissions', () => {
  it('Level 0 observes only', () => {
    const engine = new AcrEngine('recoverable', 0);
    const id = runDemo(engine);
    const state = engine.snapshot();
    expect(state.incidents[0].status).toBe('observing');
    expect(() => engine.execute(id)).toThrow(/not ready/);
    expect(state.notifications).toHaveLength(0);
  });

  it('Level 1 waits for an operator, then executes as the operator', () => {
    const engine = new AcrEngine('recoverable', 1);
    const id = runDemo(engine);
    expect(engine.snapshot().incidents[0].status).toBe('awaiting_approval');
    expect(() => engine.execute(id)).toThrow(/not ready/);
    engine.execute(id, 'operator');
    const state = engine.snapshot();
    expect(state.incidents[0].status).toBe('resolved');
    expect(state.audit.find((a) => a.tool === 'reassign_delivery')!.actor).toBe('operator');
  });

  it('Level 1 rejection escalates without acting', () => {
    const engine = new AcrEngine('recoverable', 1);
    const id = runDemo(engine);
    engine.reject(id);
    const state = engine.snapshot();
    expect(state.incidents[0].status).toBe('escalated');
    expect(state.audit.some((a) => a.tool === 'reassign_delivery')).toBe(false);
  });

  it('only journeys with an active courier assignment can be triggered', () => {
    const engine = new AcrEngine();
    expect(engine.availableTriggers('JRN-1287')).toEqual([]); // already in transit
    expect(engine.availableTriggers(DEMO_JOURNEY_ID)).toEqual(['courier_rejected']);
    engine.triggerCourierRejection(DEMO_JOURNEY_ID);
    expect(engine.availableTriggers(DEMO_JOURNEY_ID)).toEqual([]); // incident open
  });
});

describe('LLM advice is bounded by policy', () => {
  it('uses the advised option when policy permits it', () => {
    const engine = new AcrEngine('recoverable', 2);
    const incident = engine.triggerCourierRejection(DEMO_JOURNEY_ID)!;
    const briefing = engine.investigate(incident.id);
    expect(briefing.options.find((o) => o.action === 'reassign_courier')!.permitted).toBe(true);
    engine.conclude(incident.id, { diagnosis: 'Courier over capacity.', selectedAction: 'human_review', rationale: 'Be careful.', confidence: 0.8 }, 'test-model');
    const state = engine.snapshot();
    expect(state.decisions[incident.id].selected.action).toBe('human_review');
    expect(state.incidents[0].assessment?.source).toBe('test-model');
  });

  it('overrides an advised option that policy blocks', () => {
    const engine = new AcrEngine('recoverable', 2);
    const incident = engine.triggerCourierRejection(DEMO_JOURNEY_ID)!;
    engine.investigate(incident.id);
    engine.conclude(incident.id, { diagnosis: 'x', selectedAction: 'refund', rationale: 'Refund them.', confidence: 0.9 });
    const state = engine.snapshot();
    expect(state.decisions[incident.id].selected.action).toBe('reassign_courier');
    expect(state.trace.some((t) => t.title === 'Policy overrode the agent')).toBe(true);
  });
});

describe('order sync playbook: payment captured, order webhook dropped', () => {
  function runOrderSync(scenario: 'recoverable' | 'constrained', level: 0 | 1 | 2 = 2) {
    const engine = new AcrEngine(scenario, level);
    expect(engine.availableTriggers(ORDER_SYNC_JOURNEY_ID)).toEqual(['order_not_created']);
    const incident = engine.trigger(ORDER_SYNC_JOURNEY_ID, 'order_not_created')!;
    engine.investigate(incident.id);
    engine.conclude(incident.id, null);
    return { engine, id: incident.id };
  }

  it('detects a charged customer with no order and diagnoses the dropped webhook', () => {
    const { engine } = runOrderSync('recoverable', 1);
    const incident = engine.snapshot().incidents[0];
    expect(incident).toMatchObject({ kind: 'order_not_created', rule: 'DR-ORDER-01', risk: 92 });
    expect(incident.cause).toMatch(/webhook/);
    const tools = engine.snapshot().audit.map((a) => a.tool);
    expect(tools).toEqual(expect.arrayContaining(['get_payment', 'get_order', 'get_checkout', 'get_webhook_log', 'check_stock']));
  });

  it('recreates the order once, verifies it, and notifies by email', () => {
    const { engine, id } = runOrderSync('recoverable');
    engine.execute(id);
    const state = engine.snapshot();
    expect(state.decisions[id].selected).toMatchObject({ action: 'recreate_order', orderId: 'ORD-1297' });
    expect(state.incidents[0].status).toBe('resolved');
    expect(state.journeys.find((j) => j.id === ORDER_SYNC_JOURNEY_ID)).toMatchObject({ health: 'recovered', currentState: 'order_confirmed' });
    expect(state.trace.map((t) => t.title)).toEqual(expect.arrayContaining(['Order confirmed in order system', 'Stock reserved']));
    expect(state.notifications[0]).toMatchObject({ channel: 'email', to: 'bola@example.com' });
    expect(state.notifications[0].body).toContain("don't need to pay again");
    expect(state.recoveries[0]).toMatchObject({ failure: 'Dropped order webhook', outcome: 'successful' });
  });

  it('escalates when the item is out of stock instead of refunding', () => {
    const { engine, id } = runOrderSync('constrained');
    const state = engine.snapshot();
    expect(state.decisions[id].verdicts.find((v) => v.action === 'recreate_order')).toMatchObject({ allowed: false });
    expect(state.decisions[id].verdicts.find((v) => v.action === 'refund')).toMatchObject({ allowed: false });
    expect(state.decisions[id].selected.action).toBe('human_review');
    expect(state.audit.some((a) => a.tool === 'replay_order_creation')).toBe(false);
  });
});
