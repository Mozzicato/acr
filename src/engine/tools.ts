// Tool layer + permission layer (PRD §12). The agent never touches bank systems directly:
// every call goes through here and produces an audit entry.

import type { BankSystems, SimClock } from './systems';
import type { ActionId, Actor, AuditEntry, Notification, PolicyDecision } from './types';

export const READ_TOOLS = [
  'get_customer',
  'get_account',
  'get_transaction',
  'nip_status_query',
  'get_bank_status',
  'biller_requery',
  'search_support_history',
] as const;
export const WRITE_TOOLS = ['post_reversal', 'deliver_token', 'send_notification'] as const;

export type ReadTool = (typeof READ_TOOLS)[number];
export type WriteTool = (typeof WRITE_TOOLS)[number];

/** The recovery actions each write tool may carry out. send_notification follows any executed recovery. */
const TOOL_ACTIONS: Record<Exclude<WriteTool, 'send_notification'>, ActionId[]> = {
  post_reversal: ['reverse_transfer', 'reverse_bill_payment'],
  deliver_token: ['redeliver_token'],
};

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
    private readonly systems: BankSystems,
    private readonly clock: SimClock,
    readonly audit: AuditEntry[],
  ) {}

  read(incidentId: string, tool: ReadTool, input: Record<string, string>): unknown {
    const s = this.systems;
    return this.record(incidentId, tool, 'acr-agent', input, () => {
      switch (tool) {
        case 'get_customer': return { ...s.getCustomer(input.customerId) };
        case 'get_account': return { ...s.getAccount(input.accountNumber) };
        case 'get_transaction': return structuredClone(s.getTransaction(input.transactionId));
        case 'nip_status_query': return s.statusQuery(input.transactionId);
        case 'get_bank_status': return { bank: input.bank, status: s.bankStatus.get(input.bank) ?? 'up' };
        case 'biller_requery': return s.billerRequery(input.transactionId);
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
        case 'post_reversal':
          return s.postReversal(input.transactionId, this.clock.now());
        case 'deliver_token':
          return s.deliverToken(input.transactionId);
        case 'send_notification': {
          const customer = s.getCustomer(input.customerId);
          const channel = customer.preferences.channel;
          const notification: Notification = {
            id: `NTF-${String(s.outbox.length + 1).padStart(4, '0')}`,
            incidentId,
            customerId: customer.id,
            channel,
            to: channel === 'email' ? customer.email : channel === 'sms' ? customer.phone : `${customer.name.split(' ')[0]}'s phone (in-app)`,
            title: input.title,
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
    const action = decision.selected.action;
    const covered = tool === 'send_notification' ? action !== 'human_review' : TOOL_ACTIONS[tool].includes(action);
    if (!verdict.allowed || !covered) {
      throw new PermissionDenied(`Policy ${verdict.policy} does not authorize ${tool}.`);
    }
    if (!verdict.autonomous && approvedBy !== 'operator') {
      throw new PermissionDenied(`Policy ${verdict.policy} requires operator approval.`);
    }
    if (tool !== 'send_notification' && input.transactionId !== decision.selected.transactionId) {
      throw new PermissionDenied('Transaction differs from the one the policy authorized.');
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
