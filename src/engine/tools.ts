// Tool layer + permission layer (PRD §12). The agent never touches business systems directly:
// every call goes through here and produces an audit entry.

import type { BusinessSystems, SimClock } from './systems';
import type { Actor, AuditEntry, Notification, PolicyDecision } from './types';

export const READ_TOOLS = [
  'get_customer',
  'get_order',
  'get_payment',
  'get_inventory',
  'get_delivery_status',
  'find_couriers',
  'search_support_history',
] as const;
export const WRITE_TOOLS = ['reassign_delivery', 'send_notification'] as const;

export type ReadTool = (typeof READ_TOOLS)[number];
export type WriteTool = (typeof WRITE_TOOLS)[number];

/** A policy decision plus who cleared it for execution. */
export interface Authorization {
  decision: PolicyDecision;
  approvedBy: Actor;
}

export class PermissionDenied extends Error {}

/** Simulated latency per tool call, in seconds of sim time. */
const CALL_SECONDS = 3;

export class ToolLayer {
  private seq = 0;

  constructor(
    private readonly systems: BusinessSystems,
    private readonly clock: SimClock,
    readonly audit: AuditEntry[],
  ) {}

  read(incidentId: string, tool: ReadTool, input: Record<string, string>): unknown {
    const s = this.systems;
    return this.record(incidentId, tool, 'acr-agent', input, () => {
      switch (tool) {
        case 'get_customer': return { ...s.getCustomer(input.customerId) };
        case 'get_order': return { ...s.getOrder(input.orderId) };
        case 'get_payment': return { ...s.getPayment(input.orderId) };
        case 'get_inventory': return { ...s.getInventory(input.orderId) };
        case 'get_delivery_status': {
          const order = s.getOrder(input.orderId);
          const courier = order.courierId ? s.getCourier(order.courierId) : null;
          return { orderId: order.id, status: order.status, courierId: order.courierId, courierAccepted: courier !== null, eta: order.eta, promisedBy: order.promisedBy };
        }
        case 'find_couriers': return s.couriersInZone(input.zone as never).map((c) => ({ ...c }));
        case 'search_support_history': return s.searchSupportHistory(input.customerId);
      }
    });
  }

  write(incidentId: string, tool: WriteTool, input: Record<string, string>, auth: Authorization | null): unknown {
    const actor: Actor = auth?.approvedBy === 'operator' ? 'operator' : 'acr-agent';
    return this.record(incidentId, tool, actor, input, () => {
      this.authorize(incidentId, tool, input, auth);
      const s = this.systems;
      switch (tool) {
        case 'reassign_delivery':
          return s.assignCourier(input.orderId, input.courierId, this.clock.now());
        case 'send_notification': {
          const customer = s.getCustomer(input.customerId);
          const channel = customer.preferences.channel;
          const notification: Notification = {
            id: `NTF-${String(s.outbox.length + 1).padStart(4, '0')}`,
            incidentId,
            customerId: customer.id,
            channel,
            to: channel === 'sms' ? customer.phone : customer.email,
            body: input.body,
            at: this.clock.now(),
          };
          return { ...s.send(notification) };
        }
      }
    });
  }

  /** Write tools need a permitted policy decision for this incident that a human or Level 2 cleared. */
  private authorize(incidentId: string, tool: WriteTool, input: Record<string, string>, auth: Authorization | null): void {
    if (!auth) throw new PermissionDenied(`${tool} requires a policy authorization.`);
    const { decision, approvedBy } = auth;
    const verdict = decision.selectedVerdict;
    if (decision.incidentId !== incidentId) throw new PermissionDenied('Authorization belongs to another incident.');
    if (!verdict.allowed || decision.selected.action !== 'reassign_courier') {
      throw new PermissionDenied(`Policy ${verdict.policy} does not authorize ${tool}.`);
    }
    if (!verdict.autonomous && approvedBy !== 'operator') {
      throw new PermissionDenied(`Level ${decision.level} requires operator approval.`);
    }
    if (tool === 'reassign_delivery' && input.courierId !== decision.selected.courierId) {
      throw new PermissionDenied('Courier differs from the one the policy authorized.');
    }
  }

  private record(incidentId: string, tool: string, actor: Actor, input: Record<string, unknown>, run: () => unknown): unknown {
    const at = this.clock.advance(CALL_SECONDS);
    const id = `AUD-${String(++this.seq).padStart(4, '0')}`;
    try {
      const output = run();
      this.audit.push({ id, incidentId, tool, actor, input, output, at, ok: true });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.push({ id, incidentId, tool, actor, input, output: { error: message }, at, ok: false });
      throw error;
    }
  }
}
