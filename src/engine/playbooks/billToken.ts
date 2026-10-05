// Electricity token paid for but never delivered. If the biller confirms it vended a token, the
// customer already owns it, so ACR delivers it: no money moves. If the biller's status is unknown,
// neither redelivery nor a reversal is safe, so a human takes over.

import { formatNgn } from '../../format';
import { assessBillRisk } from '../detection';
import { DEMO_BILL } from '../seed';
import type { SupportContact, VendStatus } from '../systems';
import type { Account, Customer, RecoveryOption, Transaction } from '../types';
import type { Playbook } from './types';

export const billTokenPlaybook: Playbook = {
  kind: 'bill_token_missing',
  failure: 'Bill paid, token not delivered',
  trigger: 'token_vend_timeout',

  canTrigger: (journey) => journey.currentState === 'composing_bill',

  simulate({ journey, customer, systems, clock, addEvent }) {
    const { amount, biller, meter } = DEMO_BILL;
    const debitedAt = clock.advance(60);
    const tx = systems.buyToken(customer.accountNumber, amount, biller, meter, debitedAt);
    journey.transactionId = tx.id;
    addEvent('bill_paid', `Paid ${formatNgn(amount)} for a ${biller} token (meter ${meter})`, { transactionId: tx.id });
    addEvent('vend_timeout', `${biller} did not respond. No token shown`, { transactionId: tx.id });
    journey.currentState = 'debited_awaiting_token';

    // The bills watchdog sweeps 5 minutes later.
    clock.advance(5 * 60);
    addEvent('token_overdue', 'Watchdog: no token 5 min after debit', { transactionId: tx.id });
    return {
      received: [`Watchdog: ${tx.id} has no token after 5 min`, `${formatNgn(amount)} ${biller} · meter ${meter}`],
      risk: assessBillRisk(customer, amount, debitedAt, clock.now(), tx.bill!.delivered),
    };
  },

  investigate({ incident, journey, tools, systems, step }) {
    const id = incident.id;
    const txId = journey.transactionId;
    step('investigate', 'info', `Investigating bill payment ${txId}`);
    const tx = tools.read(id, 'get_transaction', { transactionId: txId }) as Transaction;
    const bill = tx.bill!;
    const account = tools.read(id, 'get_account', { accountNumber: tx.accountNumber }) as Account;
    step('investigate', 'ok', 'Debit posted', `${formatNgn(tx.amount)} · balance now ${formatNgn(account.balance)}`);
    step('investigate', bill.delivered ? 'ok' : 'fail', bill.delivered ? 'Token delivered' : 'No token reached the customer', `${bill.biller} · meter ${bill.meter}`);
    const vend = tools.read(id, 'biller_requery', { transactionId: txId }) as VendStatus;
    step('investigate', vend.status === 'successful' ? 'ok' : vend.status === 'failed' ? 'fail' : 'warn',
      vend.status === 'successful' ? `${bill.biller} confirms a token was vended` : vend.status === 'failed' ? `${bill.biller} confirms the vend failed` : `${bill.biller} status unknown`,
      vend.status === 'successful' ? `${vend.units} · token on record` : vend.status === 'unknown' ? 'Requery timed out. A token may or may not exist.' : undefined);
    const customer = tools.read(id, 'get_customer', { customerId: journey.customerId }) as Customer;
    const history = tools.read(id, 'search_support_history', { customerId: customer.id }) as SupportContact[];
    step('investigate', 'info', `Customer: ${customer.name} (${customer.tier})`, history.length ? `${history.length} past complaints` : 'No past complaints');

    const cause = vend.status === 'successful'
      ? `${bill.biller} generated the token, but its response timed out before reaching us, so the token was never shown or sent.`
      : vend.status === 'failed'
        ? `${bill.biller} failed to vend the token after the debit posted.`
        : `${bill.biller} did not answer the requery. It is unknown whether a token was generated.`;

    const options: RecoveryOption[] = [
      { action: 'redeliver_token', label: 'Deliver the vended token in-app and by SMS', successProbability: vend.status === 'successful' ? 98 : 0, costNgn: 0, customerImpact: 'low', transactionId: txId },
      { action: 'reverse_bill_payment', label: `Reverse ${formatNgn(tx.amount)}`, successProbability: 95, costNgn: 0, customerImpact: 'medium', transactionId: txId },
      { action: 'human_review', label: 'Escalate to a human agent', successProbability: 85, costNgn: 0, customerImpact: 'medium', transactionId: txId },
    ];
    const live = systems.getTransaction(txId);
    const liveVend = systems.billerRequery(txId);
    return {
      cause,
      confidence: vend.status === 'unknown' ? 0.5 : 0.95,
      options,
      customer,
      situation: `${customer.name} paid ${formatNgn(tx.amount)} for electricity and has no token, so may have no power`,
      promise: 'Token delivered within 5 minutes of payment',
      facts: {
        kind: 'bill_token_missing',
        transactionId: txId,
        amount: live.amount,
        debitPosted: live.direction === 'debit',
        vendStatus: liveVend.status,
        tokenAvailable: !!liveVend.token,
        delivered: !!live.bill?.delivered,
        alreadyReversed: live.status === 'reversed' || systems.reversalOf(txId) !== null,
      },
    };
  },

  execute({ incident, tools, step }, decision, auth, investigation) {
    const id = incident.id;
    const txId = decision.selected.transactionId!;
    const result = tools.write(id, 'deliver_token', { transactionId: txId }, auth) as { delivered: boolean; reason?: string };
    step('act', result.delivered ? 'ok' : 'fail', result.delivered ? 'Token delivered to the app' : `Delivery refused: ${result.reason}`);

    // Verify: the customer can see the token, and it matches the biller's record.
    const tx = tools.read(id, 'get_transaction', { transactionId: txId }) as Transaction;
    const vend = tools.read(id, 'biller_requery', { transactionId: txId }) as VendStatus;
    const visible = !!tx.bill?.delivered && !!tx.bill.token;
    const matches = visible && tx.bill!.token === vend.token;
    step('verify', visible ? 'ok' : 'fail', visible ? 'Token visible in the app' : 'Token not visible');
    step('verify', matches ? 'ok' : 'fail', matches ? 'Token matches biller record' : 'Token mismatch', vend.units ?? undefined);
    if (!visible || !matches) return { ok: false, reason: 'Verification failed after token delivery.' };

    const bill = tx.bill!;
    const firstName = investigation.customer.name.split(' ')[0];
    return {
      ok: true,
      resolution: `Delivered the ${bill.biller} token the customer already paid for. No money moved. Customer informed in-app.`,
      notification: {
        title: 'Your electricity token is ready',
        body: `Hi ${firstName}, your ${formatNgn(tx.amount)} ${bill.biller} payment went through, but the token got stuck on its way to you. `
          + `Here it is: ${bill.token} (${vend.units}) for meter ${bill.meter}. You were charged only once, and you don't need to contact us.`,
      },
      journeyState: 'token_delivered',
      events: [{ type: 'token_redelivered', summary: `ACR delivered the ${bill.biller} token`, payload: { transactionId: txId } }],
    };
  },
};
