// Transfer debited but not credited: the most common bank complaint. If the NIP switch confirms a
// final failure, the money never left, so ACR returns it at once. If the status is still "in
// progress", the money may yet land, so a reversal could pay twice and ACR must not act alone.

import { formatNgn } from '../../format';
import { assessTransferRisk } from '../detection';
import { DEMO_TRANSFER } from '../seed';
import type { NipStatus, SupportContact } from '../systems';
import type { Account, Customer, RecoveryOption, Transaction } from '../types';
import type { Playbook } from './types';

export const transferPlaybook: Playbook = {
  kind: 'transfer_not_credited',
  failure: 'Transfer debited, not credited',
  trigger: 'nip_transfer_failed',

  canTrigger: (journey) => journey.currentState === 'composing_transfer',

  simulate({ journey, customer, systems, clock, addEvent }) {
    const { amount, beneficiary } = DEMO_TRANSFER;
    const debitedAt = clock.advance(60);
    const tx = systems.sendTransfer(customer.accountNumber, amount, beneficiary, debitedAt);
    journey.transactionId = tx.id;
    addEvent('transfer_submitted', `Sent ${formatNgn(amount)} to ${beneficiary.name} (${beneficiary.bank})`, { transactionId: tx.id });
    addEvent('account_debited', `Debited ${formatNgn(amount)}. Balance ${formatNgn(systems.getAccount(customer.accountNumber).balance)}`, { transactionId: tx.id });
    journey.currentState = 'debited_awaiting_credit';

    // The transfer watchdog sweeps 10 minutes later.
    clock.advance(10 * 60);
    const nip = systems.statusQuery(tx.id);
    addEvent('credit_overdue', 'Watchdog: transfer not confirmed 10 min after debit', { responseCode: nip.responseCode });
    return {
      received: [`Watchdog: ${tx.id} not confirmed after 10 min`, `${formatNgn(amount)} to ${beneficiary.bank} · NIP ${nip.responseCode} ${nip.message}`],
      risk: assessTransferRisk(customer, amount, debitedAt, clock.now(), nip.responseCode),
    };
  },

  investigate({ incident, journey, tools, systems, step }) {
    const id = incident.id;
    const txId = journey.transactionId;
    step('investigate', 'info', `Investigating transfer ${txId}`);
    const tx = tools.read(id, 'get_transaction', { transactionId: txId }) as Transaction;
    const b = tx.beneficiary!;
    step('investigate', 'info', `${formatNgn(tx.amount)} to ${b.name}`, `${b.bank} ${b.account} · status ${tx.status}`);
    const account = tools.read(id, 'get_account', { accountNumber: tx.accountNumber }) as Account;
    step('investigate', 'ok', 'Debit posted', `Account ${account.number} · balance now ${formatNgn(account.balance)}`);
    const nip = tools.read(id, 'nip_status_query', { transactionId: txId }) as NipStatus;
    step('investigate', nip.final ? 'fail' : 'warn', `NIP status query: ${nip.responseCode} ${nip.message}`,
      nip.final ? 'Final. The transfer failed, so the money never reached the other bank.' : 'Not final. The money may still land at the other bank.');
    const bank = tools.read(id, 'get_bank_status', { bank: b.bank }) as { status: string };
    step('investigate', bank.status === 'up' ? 'ok' : 'warn', `${b.bank} is ${bank.status}`, 'From the NIP participant status feed');
    const customer = tools.read(id, 'get_customer', { customerId: journey.customerId }) as Customer;
    const history = tools.read(id, 'search_support_history', { customerId: customer.id }) as SupportContact[];
    step('investigate', 'info', `Customer: ${customer.name} (${customer.tier})`,
      history.length ? `${history.length} past complaints: "${history[0].topic}"` : 'No past complaints');

    const cause = nip.final
      ? `${b.bank} was ${bank.status}, so NIP rejected the transfer (code ${nip.responseCode}) after the debit posted. The money is still with us, but the customer's balance shows it as gone.`
      : `NIP has not settled the transfer (code ${nip.responseCode}, in progress) while ${b.bank} is ${bank.status}. Whether the money landed is unknown.`;
    const firstName = customer.name.split(' ')[0];

    const options: RecoveryOption[] = [
      { action: 'reverse_transfer', label: `Reverse ${formatNgn(tx.amount)} to ${firstName}'s account`, successProbability: nip.final ? 99 : 60, costNgn: 0, customerImpact: 'low', transactionId: txId },
      { action: 'retry_transfer', label: `Resend to ${b.name} when ${b.bank} recovers`, successProbability: 70, costNgn: 0, customerImpact: 'medium', transactionId: txId },
      { action: 'goodwill_credit', label: 'Add a ₦1,000 goodwill credit', successProbability: 100, costNgn: 1_000, customerImpact: 'low', transactionId: txId },
      { action: 'human_review', label: 'Escalate to a human agent', successProbability: 85, costNgn: 0, customerImpact: 'medium', transactionId: txId },
    ];
    const live = systems.getTransaction(txId);
    const liveNip = systems.statusQuery(txId);
    return {
      cause,
      confidence: nip.final ? 0.96 : 0.55,
      options,
      customer,
      situation: `${customer.name} was debited ${formatNgn(tx.amount)} for a transfer to ${b.name} at ${b.bank} that has not been credited`,
      promise: 'Transfers land in seconds, or the money comes back',
      facts: {
        kind: 'transfer_not_credited',
        transactionId: txId,
        amount: live.amount,
        debitPosted: live.direction === 'debit',
        nipFinal: liveNip.final,
        nipCode: liveNip.responseCode,
        alreadyReversed: live.status === 'reversed' || systems.reversalOf(txId) !== null,
      },
    };
  },

  execute({ incident, tools, step }, decision, auth, investigation) {
    const id = incident.id;
    const txId = decision.selected.transactionId!;
    const before = tools.read(id, 'get_transaction', { transactionId: txId }) as Transaction;
    const accountBefore = tools.read(id, 'get_account', { accountNumber: before.accountNumber }) as Account;
    const result = tools.write(id, 'post_reversal', { transactionId: txId }, auth) as { posted: boolean; reversalId?: string; reason?: string };
    step('act', result.posted ? 'ok' : 'fail', result.posted ? `${formatNgn(before.amount)} reversed to ${before.accountNumber}` : `Reversal refused: ${result.reason}`,
      result.reversalId);

    // Verify: never assume the action worked.
    const after = tools.read(id, 'get_transaction', { transactionId: txId }) as Transaction;
    const account = tools.read(id, 'get_account', { accountNumber: before.accountNumber }) as Account;
    const marked = after.status === 'reversed';
    const restored = account.balance === accountBefore.balance + before.amount;
    step('verify', marked ? 'ok' : 'fail', marked ? 'Transfer marked reversed' : 'Transfer not marked reversed');
    step('verify', restored ? 'ok' : 'fail', restored ? 'Balance restored' : 'Balance not restored',
      `${formatNgn(accountBefore.balance)} → ${formatNgn(account.balance)}`);
    if (!result.posted || !marked || !restored) return { ok: false, reason: 'Verification failed after the reversal.' };

    const b = before.beneficiary!;
    const firstName = investigation.customer.name.split(' ')[0];
    return {
      ok: true,
      resolution: `Reversed ${formatNgn(before.amount)} to the customer's account. Balance restored. Customer informed in-app.`,
      notification: {
        title: `Your ${formatNgn(before.amount)} is back`,
        body: `Hi ${firstName}, your transfer of ${formatNgn(before.amount)} to ${b.name} (${b.bank}) didn't go through because ${b.bank} was unavailable. `
          + `We've returned the full amount to your account. Your balance is ${formatNgn(account.balance)}. You can send it again once ${b.bank} is back. You don't need to contact us.`,
      },
      journeyState: 'reversed',
      events: [{ type: 'transfer_reversed', summary: `ACR reversed ${formatNgn(before.amount)} to the customer`, payload: { transactionId: txId, reversalId: result.reversalId } }],
    };
  },
};
