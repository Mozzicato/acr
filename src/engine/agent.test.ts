import { describe, expect, it } from 'vitest';
import { AcrEngine } from './agent';
import { computeMetrics } from './metrics';
import { BILL_JOURNEY_ID, DEMO_JOURNEY_ID, type Scenario } from './seed';
import type { AutonomyLevel, FailureKind } from './types';

function run(scenario: Scenario = 'recoverable', level: AutonomyLevel = 2, journeyId = DEMO_JOURNEY_ID, kind: FailureKind = 'transfer_not_credited') {
  const engine = new AcrEngine(scenario, level);
  const incident = engine.trigger(journeyId, kind)!;
  engine.investigate(incident.id);
  engine.conclude(incident.id, null);
  return { engine, id: incident.id };
}

const balanceOf = (engine: AcrEngine, customerId: string) => {
  const state = engine.snapshot();
  const customer = state.customers.find((c) => c.id === customerId)!;
  return state.accounts.find((a) => a.number === customer.accountNumber)!.balance;
};

describe('transfer debited but not credited (MVP acceptance criteria)', () => {
  it('detects the stuck debit with the rule and evidence', () => {
    const engine = new AcrEngine();
    expect(engine.snapshot().journeys.find((j) => j.id === DEMO_JOURNEY_ID)!.health).toBe('healthy');
    const incident = engine.trigger(DEMO_JOURNEY_ID, 'transfer_not_credited')!;
    const journey = engine.snapshot().journeys.find((j) => j.id === DEMO_JOURNEY_ID)!;
    expect(journey.health).toBe('critical');
    expect(incident).toMatchObject({ rule: 'DR-TRANSFER-01', kind: 'transfer_not_credited', risk: 99 });
    expect(incident.signals).toContain('Premier customer');
    expect(balanceOf(engine, 'C201')).toBe(497_300 - 85_000);
  });

  it('investigates through the switch, the account and the beneficiary bank', () => {
    const { engine } = run();
    const tools = engine.snapshot().audit.map((a) => a.tool);
    expect(tools).toEqual(expect.arrayContaining(['get_transaction', 'get_account', 'nip_status_query', 'get_bank_status', 'get_customer']));
  });

  it('reverses on a final NIP failure, verifies the balance, notifies in-app, and opens no ticket', () => {
    const { engine, id } = run();
    engine.execute(id);
    const state = engine.snapshot();
    expect(state.decisions[id].selected.action).toBe('reverse_transfer');
    expect(state.incidents[0].status).toBe('resolved');
    expect(balanceOf(engine, 'C201')).toBe(497_300);
    expect(state.transactions.find((t) => t.reverses)?.amount).toBe(85_000);
    expect(state.trace.map((t) => t.title)).toEqual(expect.arrayContaining(['Transfer marked reversed', 'Balance restored', 'RECOVERY COMPLETE']));
    expect(state.notifications[0]).toMatchObject({ channel: 'push', title: 'Your ₦85,000 is back' });
    expect(state.recoveries[0]).toMatchObject({ outcome: 'successful', costNgn: 0, complaintAvoided: true, ticketsCreated: 0 });
    for (const entry of state.audit) {
      expect(entry).toMatchObject({ incidentId: id, at: expect.any(String), actor: expect.any(String) });
    }
    expect(computeMetrics(state)).toMatchObject({ arr: 1, her: 0, customerEffort: 0 });
  });

  it('never reverses while the NIP status is still in progress', () => {
    const { engine, id } = run('constrained');
    const state = engine.snapshot();
    const reversal = state.decisions[id].verdicts.find((v) => v.action === 'reverse_transfer')!;
    expect(reversal.allowed).toBe(false);
    expect(reversal.reason).toMatch(/not final/);
    expect(state.decisions[id].selected.action).toBe('human_review');
    expect(state.audit.some((a) => a.tool === 'post_reversal')).toBe(false);
    expect(balanceOf(engine, 'C201')).toBe(497_300 - 85_000);
  });

  it('blocks retrying the transfer and goodwill credits', () => {
    const { engine, id } = run();
    const verdicts = engine.snapshot().decisions[id].verdicts;
    expect(verdicts.find((v) => v.action === 'retry_transfer')).toMatchObject({ allowed: false });
    expect(verdicts.find((v) => v.action === 'goodwill_credit')).toMatchObject({ allowed: false, policy: 'FINANCIAL-HOLD-01' });
  });
});

describe('electricity token paid but not delivered', () => {
  it('delivers the vended token without moving money', () => {
    const { engine, id } = run('recoverable', 2, BILL_JOURNEY_ID, 'bill_token_missing');
    const before = balanceOf(engine, 'C207');
    engine.execute(id);
    const state = engine.snapshot();
    expect(state.incidents[0]).toMatchObject({ rule: 'DR-BILL-01', status: 'resolved' });
    expect(state.decisions[id].selected.action).toBe('redeliver_token');
    const reversal = state.decisions[id].verdicts.find((v) => v.action === 'reverse_bill_payment')!;
    expect(reversal.reason).toMatch(/vended a token/);
    expect(balanceOf(engine, 'C207')).toBe(before);
    expect(state.notifications[0].body).toContain('4821-0937-5512-6603-1194');
  });

  it('escalates when the biller status is unknown', () => {
    const { engine, id } = run('constrained', 2, BILL_JOURNEY_ID, 'bill_token_missing');
    const state = engine.snapshot();
    expect(state.decisions[id].selected.action).toBe('human_review');
    expect(state.audit.some((a) => a.tool === 'deliver_token' || a.tool === 'post_reversal')).toBe(false);
  });
});

describe('autonomy levels', () => {
  it('Level 0 observes only', () => {
    const { engine, id } = run('recoverable', 0);
    expect(engine.snapshot().incidents[0].status).toBe('observing');
    expect(() => engine.execute(id)).toThrow(/not ready/);
  });

  it('Level 1 waits for an operator, then executes as the operator', () => {
    const { engine, id } = run('recoverable', 1);
    expect(engine.snapshot().incidents[0].status).toBe('awaiting_approval');
    expect(() => engine.execute(id)).toThrow(/not ready/);
    engine.execute(id, 'operator');
    const state = engine.snapshot();
    expect(state.incidents[0].status).toBe('resolved');
    expect(state.audit.find((a) => a.tool === 'post_reversal')!.actor).toBe('operator');
  });

  it('Level 1 rejection escalates without acting', () => {
    const { engine, id } = run('recoverable', 1);
    engine.reject(id);
    expect(engine.snapshot().incidents[0].status).toBe('escalated');
    expect(engine.snapshot().audit.some((a) => a.tool === 'post_reversal')).toBe(false);
  });

  it('every journey has a unique id', () => {
    const ids = new AcrEngine().snapshot().journeys.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only journeys with a pending demo transaction can be triggered', () => {
    const engine = new AcrEngine();
    expect(engine.availableTriggers('JRN-2052')).toEqual([]);
    expect(engine.availableTriggers(DEMO_JOURNEY_ID)).toEqual(['transfer_not_credited']);
    expect(engine.availableTriggers(BILL_JOURNEY_ID)).toEqual(['bill_token_missing']);
    engine.trigger(DEMO_JOURNEY_ID, 'transfer_not_credited');
    expect(engine.availableTriggers(DEMO_JOURNEY_ID)).toEqual([]);
  });
});

describe('LLM advice is bounded by policy', () => {
  it('uses the advised option when policy permits it', () => {
    const engine = new AcrEngine('recoverable', 2);
    const incident = engine.trigger(DEMO_JOURNEY_ID, 'transfer_not_credited')!;
    const briefing = engine.investigate(incident.id);
    expect(briefing.options.find((o) => o.action === 'reverse_transfer')!.permitted).toBe(true);
    engine.conclude(incident.id, { diagnosis: 'Bank down.', selectedAction: 'human_review', rationale: 'Be careful.', confidence: 0.8 }, 'test-model');
    const state = engine.snapshot();
    expect(state.decisions[incident.id].selected.action).toBe('human_review');
    expect(state.incidents[0].assessment?.source).toBe('test-model');
  });

  it('overrides an advised option that policy blocks', () => {
    const engine = new AcrEngine('recoverable', 2);
    const incident = engine.trigger(DEMO_JOURNEY_ID, 'transfer_not_credited')!;
    engine.investigate(incident.id);
    engine.conclude(incident.id, { diagnosis: 'x', selectedAction: 'goodwill_credit', rationale: 'Be generous.', confidence: 0.9 });
    const state = engine.snapshot();
    expect(state.decisions[incident.id].selected.action).toBe('reverse_transfer');
    expect(state.trace.some((t) => t.title === 'Policy overrode the agent')).toBe(true);
  });
});
