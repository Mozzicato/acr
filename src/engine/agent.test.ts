import { describe, expect, it } from 'vitest';
import { AcrEngine } from './agent.js';
import { computeMetrics } from './metrics.js';
import { BILLER, DEMO_BILL, DEMO_CUSTOMERS, DEMO_TRANSFER } from './seed.js';
import type { BankHealth, BillerHealth } from './systems.js';
import { supportContext } from './support.js';
import type { AutonomyLevel } from './types.js';

const ADAEZE = DEMO_CUSTOMERS.transfer;
const BOLA = DEMO_CUSTOMERS.bill;

function transfer(status: BankHealth, level: AutonomyLevel = 2, amount = DEMO_TRANSFER.amount) {
  const engine = AcrEngine.create({ level });
  engine.setBankStatus(DEMO_TRANSFER.bank, status);
  const journey = engine.startTransfer(ADAEZE, { ...DEMO_TRANSFER, amount });
  engine.advance(601);
  const [incident] = engine.sweep();
  if (incident) {
    engine.investigate(incident.id);
    engine.conclude(incident.id, null);
  }
  return { engine, journey, id: incident?.id };
}

function bill(status: BillerHealth) {
  const engine = AcrEngine.create();
  engine.setBillerStatus(BILLER, status);
  const journey = engine.startBillPayment(BOLA, DEMO_BILL);
  engine.advance(301);
  const [incident] = engine.sweep();
  if (incident) {
    engine.investigate(incident.id);
    engine.conclude(incident.id, null);
  }
  return { engine, journey, id: incident?.id };
}

const balanceOf = (engine: AcrEngine, customerId: string) =>
  engine.systems.getAccount(engine.systems.getCustomer(customerId).accountNumber).balance;

describe('normal operation', () => {
  it('a transfer to a healthy bank completes and ACR leaves it alone', () => {
    const { engine, journey, id } = transfer('up');
    expect(id).toBeUndefined();
    expect(journey.currentState).toBe('completed');
    expect(balanceOf(engine, ADAEZE)).toBe(497_300 - 85_000);
  });

  it('nothing is flagged before the detection window passes', () => {
    const engine = AcrEngine.create();
    engine.setBankStatus(DEMO_TRANSFER.bank, 'down');
    engine.startTransfer(ADAEZE, DEMO_TRANSFER);
    engine.advance(599);
    expect(engine.sweep()).toHaveLength(0);
    engine.advance(2);
    expect(engine.sweep()).toHaveLength(1);
  });

  it('tells support about an unsettled transfer before the watchdog opens an incident', () => {
    const engine = AcrEngine.create();
    engine.setBankStatus(DEMO_TRANSFER.bank, 'unstable');
    engine.startTransfer(ADAEZE, DEMO_TRANSFER);

    const context = supportContext(engine, ADAEZE);
    expect(context.issue).toMatchObject({ what: expect.stringContaining('Transfer'), status: 'being looked into' });
    expect(context.balanceState).toContain('pending debit of ₦85,000');
  });

  it('validates what the customer enters', () => {
    const engine = AcrEngine.create();
    expect(() => engine.startTransfer(ADAEZE, { ...DEMO_TRANSFER, account: '123' })).toThrow(/10 digits/);
    expect(() => engine.startTransfer(ADAEZE, { ...DEMO_TRANSFER, amount: 10_000_000 })).toThrow(/Insufficient/);
    expect(() => engine.startTransfer(ADAEZE, { ...DEMO_TRANSFER, bank: 'Real Bank' })).toThrow(/bank/);
  });

  it('a new customer can join with a starting balance', () => {
    const engine = AcrEngine.create();
    const c = engine.join('Ada<script>');
    expect(c.name).toBe('Adascript');
    expect(balanceOf(engine, c.id)).toBe(500_000);
  });
});

describe('transfer debited but not credited', () => {
  it('detects the stuck debit with the rule and evidence', () => {
    const { engine } = transfer('down');
    const incident = engine.world.incidents[0];
    expect(incident).toMatchObject({ rule: 'DR-TRANSFER-01', kind: 'transfer_not_credited', risk: 99 });
    expect(incident.signals).toContain('Premier customer');
    const tools = engine.world.audit.map((a) => a.tool);
    expect(tools).toEqual(expect.arrayContaining(['get_transaction', 'get_account', 'nip_status_query', 'get_bank_status', 'get_customer']));
  });

  it('reverses on a final NIP failure, verifies the balance, notifies in-app, and opens no ticket', () => {
    const { engine, id } = transfer('down');
    engine.execute(id!);
    const state = engine.snapshot();
    expect(state.decisions[id!].selected.action).toBe('reverse_transfer');
    expect(state.incidents[0].status).toBe('resolved');
    expect(balanceOf(engine, ADAEZE)).toBe(497_300);
    expect(state.trace.map((t) => t.title)).toEqual(expect.arrayContaining(['Transfer marked reversed', 'Balance restored', 'RECOVERY COMPLETE']));
    expect(state.notifications[0]).toMatchObject({ channel: 'push', title: 'Your ₦85,000 is back' });
    expect(state.recoveries[0]).toMatchObject({ outcome: 'successful', costNgn: 0, complaintAvoided: true, ticketsCreated: 0 });
    expect(computeMetrics(state)).toMatchObject({ arr: 1, her: 0, customerEffort: 0 });
  });

  it('never reverses while the NIP status is still in progress', () => {
    const { engine, id } = transfer('unstable');
    const reversal = engine.world.decisions[id!].verdicts.find((v) => v.action === 'reverse_transfer')!;
    expect(reversal.allowed).toBe(false);
    expect(reversal.reason).toMatch(/not final/);
    expect(engine.world.decisions[id!].selected.action).toBe('human_review');
    expect(engine.world.audit.some((a) => a.tool === 'post_reversal')).toBe(false);
  });

  it('holds reversals over ₦1m for an operator, even at Level 2', () => {
    const engine = AcrEngine.create();
    engine.systems.getAccount(engine.systems.getCustomer(ADAEZE).accountNumber).balance = 5_000_000;
    engine.setBankStatus(DEMO_TRANSFER.bank, 'down');
    engine.startTransfer(ADAEZE, { ...DEMO_TRANSFER, amount: 1_500_000 });
    engine.advance(601);
    engine.runAutomatic('rules');
    expect(engine.world.incidents[0].status).toBe('awaiting_approval');
    expect(engine.world.audit.some((a) => a.tool === 'post_reversal')).toBe(false);
  });
});

describe('electricity token paid but not delivered', () => {
  it('delivers the vended token without moving money', () => {
    const { engine, id } = bill('stuck');
    const before = balanceOf(engine, BOLA);
    engine.execute(id!);
    const w = engine.world;
    expect(w.incidents[0]).toMatchObject({ rule: 'DR-BILL-01', status: 'resolved' });
    expect(w.decisions[id!].selected.action).toBe('redeliver_token');
    expect(w.decisions[id!].verdicts.find((v) => v.action === 'reverse_bill_payment')!.reason).toMatch(/vended a token/);
    expect(balanceOf(engine, BOLA)).toBe(before);
    expect(w.bank.outbox[0].body).toMatch(/\d{4}-\d{4}-\d{4}-\d{4}-\d{4}/);
  });

  it('escalates when the biller does not answer', () => {
    const { engine, id } = bill('down');
    expect(engine.world.decisions[id!].selected.action).toBe('human_review');
    expect(engine.world.audit.some((a) => a.tool === 'deliver_token' || a.tool === 'post_reversal')).toBe(false);
  });
});

describe('autonomy levels', () => {
  it('Level 0 observes only', () => {
    const { engine, id } = transfer('down', 0);
    expect(engine.world.incidents[0].status).toBe('observing');
    expect(() => engine.execute(id!)).toThrow(/not ready/);
  });

  it('Level 1 waits for an operator, then executes as the operator', () => {
    const { engine, id } = transfer('down', 1);
    expect(engine.world.incidents[0].status).toBe('awaiting_approval');
    expect(() => engine.execute(id!)).toThrow(/not ready/);
    engine.execute(id!, 'operator');
    expect(engine.world.incidents[0].status).toBe('resolved');
    expect(engine.world.audit.find((a) => a.tool === 'post_reversal')!.actor).toBe('operator');
  });

  it('Level 1 rejection escalates without acting', () => {
    const { engine, id } = transfer('down', 1);
    engine.reject(id!);
    expect(engine.world.incidents[0].status).toBe('escalated');
    expect(engine.world.audit.some((a) => a.tool === 'post_reversal')).toBe(false);
  });
});

describe('persistence and concurrency', () => {
  it('a world survives a JSON round trip mid-incident', () => {
    const { engine, id } = transfer('down');
    const restored = new AcrEngine(JSON.parse(JSON.stringify(engine.world)));
    restored.execute(id!);
    expect(restored.world.incidents[0].status).toBe('resolved');
    expect(balanceOf(restored, ADAEZE)).toBe(497_300);
  });

  it('two workers cannot both claim the same incident for planning', () => {
    const engine = AcrEngine.create();
    engine.setBankStatus(DEMO_TRANSFER.bank, 'down');
    engine.startTransfer(ADAEZE, DEMO_TRANSFER);
    engine.advance(601);
    const { planning } = engine.runAutomatic('defer');
    expect(planning).toHaveLength(1);
    expect(engine.claim(planning)).toEqual(planning);
    expect(engine.claim(planning)).toEqual([]);
  });

  it('every journey has a unique id', () => {
    const engine = AcrEngine.create();
    for (let i = 0; i < 5; i += 1) engine.startTransfer(ADAEZE, { ...DEMO_TRANSFER, amount: 1_000 });
    const ids = engine.world.journeys.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('LLM advice is bounded by policy', () => {
  function planning() {
    const engine = AcrEngine.create();
    engine.setBankStatus(DEMO_TRANSFER.bank, 'down');
    engine.startTransfer(ADAEZE, DEMO_TRANSFER);
    engine.advance(601);
    const [incident] = engine.sweep();
    return { engine, briefing: engine.investigate(incident.id), id: incident.id };
  }

  it('uses the advised option when policy permits it', () => {
    const { engine, briefing, id } = planning();
    expect(briefing.options.find((o) => o.action === 'reverse_transfer')!.permitted).toBe(true);
    engine.conclude(id, { diagnosis: 'Bank down.', selectedAction: 'human_review', rationale: 'Be careful.', confidence: 0.8 }, 'test-model');
    expect(engine.world.decisions[id].selected.action).toBe('human_review');
    expect(engine.world.incidents[0].assessment?.source).toBe('test-model');
  });

  it('overrides an advised option that policy blocks', () => {
    const { engine, id } = planning();
    engine.conclude(id, { diagnosis: 'x', selectedAction: 'goodwill_credit', rationale: 'Be generous.', confidence: 0.9 });
    expect(engine.world.decisions[id].selected.action).toBe('reverse_transfer');
    expect(engine.world.trace.some((t) => t.title === 'Policy overrode the agent')).toBe(true);
  });
});
