import { describe, expect, it } from 'vitest';
import { decide, type PolicyFacts } from './policy';
import { DEMO_TRANSFER, seed } from './seed';
import { SimClock } from './systems';
import { PermissionDenied, ToolLayer } from './tools';
import type { AuditEntry, RecoveryOption } from './types';

const NOW = '2026-10-04T13:10:00+01:00';

function setup(level: 0 | 1 | 2 = 2, amount = DEMO_TRANSFER.amount) {
  const { systems } = seed('recoverable');
  const account = systems.getCustomer('C201').accountNumber;
  systems.getAccount(account).balance += 5_000_000;
  const tx = systems.sendTransfer(account, amount, DEMO_TRANSFER.beneficiary, NOW);
  const audit: AuditEntry[] = [];
  const tools = new ToolLayer(systems, new SimClock(NOW), audit);
  const option: RecoveryOption = { action: 'reverse_transfer', label: 'Reverse', successProbability: 99, costNgn: 0, customerImpact: 'low', transactionId: tx.id };
  const facts: PolicyFacts = { kind: 'transfer_not_credited', transactionId: tx.id, amount, debitPosted: true, nipFinal: true, nipCode: '91', alreadyReversed: false };
  const decision = decide('INC-0001', [option, { ...option, action: 'human_review' }], facts, level);
  return { systems, audit, tools, decision, tx, account };
}

describe('tool permission layer', () => {
  it('refuses write tools without an authorization and audits the refusal', () => {
    const { tools, audit, tx } = setup();
    expect(() => tools.write('INC-0001', 'post_reversal', { transactionId: tx.id }, null)).toThrow(PermissionDenied);
    expect(audit.at(-1)).toMatchObject({ tool: 'post_reversal', ok: false });
  });

  it('refuses a transaction other than the one the policy authorized', () => {
    const { tools, decision } = setup();
    expect(() => tools.write('INC-0001', 'post_reversal', { transactionId: 'HIS-C201-1' }, { decision, approvedBy: 'policy-engine' })).toThrow(/differs/);
  });

  it('refuses another incident\'s authorization', () => {
    const { tools, decision } = setup();
    expect(() => tools.write('INC-0002', 'send_notification', { customerId: 'C201', title: 't', body: 'b' }, { decision, approvedBy: 'policy-engine' }))
      .toThrow(/another incident/);
  });

  it('a reversal authorization cannot be used to deliver a token', () => {
    const { tools, decision, tx } = setup();
    expect(() => tools.write('INC-0001', 'deliver_token', { transactionId: tx.id }, { decision, approvedBy: 'policy-engine' })).toThrow(/does not authorize/);
  });

  it('requires operator approval below Level 2', () => {
    const { tools, decision, tx } = setup(1);
    const input = { transactionId: tx.id };
    expect(() => tools.write('INC-0001', 'post_reversal', input, { decision, approvedBy: 'policy-engine' })).toThrow(/operator approval/);
    expect(tools.write('INC-0001', 'post_reversal', input, { decision, approvedBy: 'operator' })).toMatchObject({ posted: true });
  });

  it('reversals above ₦1m need an operator even at Level 2', () => {
    const { decision } = setup(2, 1_500_000);
    expect(decision.selectedVerdict).toMatchObject({ allowed: true, autonomous: false });
    expect(decision.selectedVerdict.reason).toMatch(/autonomous limit/);
  });

  it('reversal is idempotent: a transfer is never refunded twice', () => {
    const { systems, tx, account } = setup();
    const before = systems.getAccount(account).balance;
    expect(systems.postReversal(tx.id, NOW)).toMatchObject({ posted: true });
    expect(systems.postReversal(tx.id, NOW)).toMatchObject({ posted: false, reason: 'already reversed' });
    expect(systems.getAccount(account).balance).toBe(before + DEMO_TRANSFER.amount);
  });
});
