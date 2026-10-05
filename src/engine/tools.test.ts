import { describe, expect, it } from 'vitest';
import { decide } from './policy';
import { seed } from './seed';
import { SimClock } from './systems';
import { PermissionDenied, ToolLayer } from './tools';
import type { AuditEntry, RecoveryOption } from './types';

function setup(level: 0 | 1 | 2 = 2) {
  const { systems } = seed('recoverable');
  systems.rejectRoute('ORD-1292');
  const audit: AuditEntry[] = [];
  const tools = new ToolLayer(systems, new SimClock('2026-10-04T13:00:00+01:00'), audit);
  const option: RecoveryOption = {
    action: 'reassign_courier', label: 'Reassign', successProbability: 94, costNgn: 0, customerImpact: 'low',
    courierId: 'CR-LAGOON', projectedEta: '2026-10-04T16:45:00+01:00',
  };
  const decision = decide('INC-0001', [option], {
    kind: 'courier_rejected',
    order: systems.getOrder('ORD-1292'), paymentConfirmed: true, inventoryReserved: true,
    originalCourierUnavailable: true, candidate: systems.getCourier('CR-LAGOON'),
  }, level);
  return { systems, audit, tools, decision };
}

describe('tool permission layer', () => {
  it('refuses write tools without an authorization and audits the refusal', () => {
    const { tools, audit } = setup();
    expect(() => tools.write('INC-0001', 'reassign_delivery', { orderId: 'ORD-1292', courierId: 'CR-LAGOON' }, null)).toThrow(PermissionDenied);
    expect(audit.at(-1)).toMatchObject({ tool: 'reassign_delivery', ok: false });
  });

  it('refuses a courier other than the one the policy authorized', () => {
    const { tools, decision } = setup();
    expect(() => tools.write('INC-0001', 'reassign_delivery', { orderId: 'ORD-1292', courierId: 'CR-EKO' }, { decision, approvedBy: 'policy-engine' }))
      .toThrow(/differs/);
  });

  it('refuses another incident\'s authorization', () => {
    const { tools, decision } = setup();
    expect(() => tools.write('INC-0002', 'send_notification', { customerId: 'C102', body: 'hi' }, { decision, approvedBy: 'policy-engine' }))
      .toThrow(/another incident/);
  });

  it('requires operator approval below Level 2', () => {
    const { tools, decision } = setup(1);
    const input = { orderId: 'ORD-1292', courierId: 'CR-LAGOON' };
    expect(() => tools.write('INC-0001', 'reassign_delivery', input, { decision, approvedBy: 'policy-engine' })).toThrow(/operator approval/);
    expect(tools.write('INC-0001', 'reassign_delivery', input, { decision, approvedBy: 'operator' })).toMatchObject({ accepted: true });
  });

  it('order replay is idempotent and never duplicates an order', () => {
    const { systems } = setup();
    systems.capturePayment('ORD-1297', '2026-10-04T13:00:00+01:00', true);
    expect(systems.createOrderFromCheckout('ORD-1297', '2026-10-04T13:11:00+01:00')).toEqual({ created: true });
    expect(systems.createOrderFromCheckout('ORD-1297', '2026-10-04T13:12:00+01:00')).toMatchObject({ created: false, reason: 'order already exists' });
    expect(systems.stock.get('AUD-NC9')).toBe(2);
  });

  it('a delivery authorization cannot be used to replay an order', () => {
    const { tools, decision } = setup();
    expect(() => tools.write('INC-0001', 'replay_order_creation', { orderId: 'ORD-1297' }, { decision, approvedBy: 'policy-engine' }))
      .toThrow(/does not authorize/);
  });

  it('policy blocks financial actions outright', () => {
    const { systems } = setup();
    const decision = decide('INC-0001', [
      { action: 'refund', label: 'Refund', successProbability: 100, costNgn: 845_000, customerImpact: 'high' },
      { action: 'human_review', label: 'Escalate', successProbability: 85, costNgn: 0, customerImpact: 'medium' },
    ], { kind: 'courier_rejected', order: systems.getOrder('ORD-1292'), paymentConfirmed: true, inventoryReserved: true, originalCourierUnavailable: true, candidate: null }, 2);
    expect(decision.verdicts[0]).toMatchObject({ policy: 'FINANCIAL-HOLD-01', allowed: false });
    expect(decision.selected.action).toBe('human_review');
  });
});
