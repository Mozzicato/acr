// Payment captured, but the order.create webhook failed, so the customer was charged and has no order.
// Recovery: replay order creation from the paid checkout. The replay is idempotent.

import { formatDateTime, formatNgn } from '../../format';
import type { Checkout, WebhookDelivery } from '../systems';
import type { Customer, InventoryRecord, Order, Payment, RecoveryOption } from '../types';
import type { Playbook } from './types';

export const orderSyncPlaybook: Playbook = {
  kind: 'order_not_created',
  failure: 'Dropped order webhook',

  investigate({ incident, journey, tools, systems, step }) {
    const id = incident.id;
    const orderId = journey.orderId;
    step('investigate', 'info', `Investigating paid checkout ${orderId}`);
    const payment = tools.read(id, 'get_payment', { orderId }) as Payment;
    step('investigate', payment.status === 'confirmed' ? 'ok' : 'fail',
      payment.status === 'confirmed' ? 'Payment captured' : `Payment ${payment.status}`, `${payment.reference} · ${formatNgn(payment.amount)}`);
    const order = tools.read(id, 'get_order', { orderId }) as Order | null;
    step('investigate', order ? 'ok' : 'fail', order ? `Order ${orderId} exists` : 'No order in the order system', order ? order.status : `Nothing found for ${payment.reference}`);
    const checkout = tools.read(id, 'get_checkout', { orderId }) as Checkout;
    const amountsMatch = checkout.amount === payment.amount;
    step('investigate', amountsMatch ? 'ok' : 'fail', amountsMatch ? 'Captured amount matches cart' : 'Captured amount differs from cart',
      `${checkout.item} · cart ${formatNgn(checkout.amount)} · captured ${formatNgn(payment.amount)}`);
    const webhooks = tools.read(id, 'get_webhook_log', { orderId }) as WebhookDelivery[];
    const failed = webhooks.find((w) => w.status === 'failed');
    step('investigate', failed ? 'fail' : 'info', failed ? 'order.create webhook failed' : 'No failed webhook found',
      failed ? `${failed.id} · ${failed.attempts} attempts · ${failed.lastError}` : undefined);
    const stock = tools.read(id, 'check_stock', { sku: checkout.sku }) as { onHand: number };
    step('investigate', stock.onHand > 0 ? 'ok' : 'fail', stock.onHand > 0 ? 'Stock available' : 'Out of stock', `${checkout.sku} · ${stock.onHand} on hand`);
    const customer = tools.read(id, 'get_customer', { customerId: checkout.customerId }) as Customer;
    const history = tools.read(id, 'search_support_history', { customerId: customer.id }) as Array<{ topic: string }>;
    step('investigate', 'info', `Customer: ${customer.name} (${customer.tier})`,
      history.length ? `${history.length} past contact: "${history[0].topic}"` : 'No past support contacts');

    const cause = failed
      ? `The order.create webhook from payments to the order service failed (${failed.lastError}), so the order was never created.`
      : 'The order was not created after payment. Cause unknown.';
    const confidence = failed ? 0.95 : 0.5;

    const options: RecoveryOption[] = [
      { action: 'recreate_order', label: `Recreate order ${orderId} from the paid checkout`, successProbability: 97, costNgn: 0, customerImpact: 'low', orderId },
      { action: 'refund', label: 'Refund the customer', successProbability: 100, costNgn: payment.amount, customerImpact: 'high' },
      { action: 'human_review', label: 'Escalate to a human operator', successProbability: 85, costNgn: 0, customerImpact: 'medium' },
    ];

    return {
      cause,
      confidence,
      options,
      customer,
      situation: `Customer was charged ${formatNgn(payment.amount)} for ${checkout.item} but has no order and no confirmation`,
      promise: 'Order confirmation within 5 minutes of payment',
      facts: {
        kind: 'order_not_created',
        orderId,
        paymentCaptured: systems.getPayment(orderId).status === 'confirmed',
        capturedAmount: systems.getPayment(orderId).amount,
        cartAmount: systems.getCheckout(orderId).amount,
        orderExists: systems.findOrder(orderId) !== null,
        webhookFailed: systems.webhooks.some((w) => w.orderId === orderId && w.status === 'failed'),
        stockOnHand: systems.stock.get(checkout.sku) ?? 0,
      },
    };
  },

  execute({ incident, tools, step }, decision, auth, investigation) {
    const id = incident.id;
    const orderId = decision.selected.orderId!;
    const result = tools.write(id, 'replay_order_creation', { orderId }, auth) as { created: boolean; reason?: string };
    step('act', result.created ? 'ok' : 'fail', result.created ? `Order ${orderId} recreated from the paid checkout` : `Replay refused: ${result.reason}`);

    // Verify: the order exists, matches the payment, and stock is held for it.
    const order = tools.read(id, 'get_order', { orderId }) as Order | null;
    const payment = tools.read(id, 'get_payment', { orderId }) as Payment;
    const linked = !!order && order.status === 'accepted' && order.amount === payment.amount;
    step('verify', linked ? 'ok' : 'fail', linked ? 'Order confirmed in order system' : 'Order not found after replay',
      order ? `${order.id} · ${order.status} · ${formatNgn(order.amount)} linked to ${payment.reference}` : undefined);
    const inventory = order ? (tools.read(id, 'get_inventory', { orderId }) as InventoryRecord) : null;
    step('verify', inventory?.reserved ? 'ok' : 'fail', inventory?.reserved ? 'Stock reserved' : 'Stock not reserved',
      inventory ? `${inventory.sku} at ${inventory.warehouse}` : undefined);
    if (!linked || !inventory?.reserved || !order) return { ok: false, reason: 'Verification failed after order replay.' };

    const firstName = investigation.customer.name.split(' ')[0];
    return {
      ok: true,
      resolution: `Order ${orderId} recreated from the captured payment. Stock reserved. Customer informed. No double charge.`,
      notification: `Hi ${firstName}, your payment of ${formatNgn(payment.amount)} for ${order.item} went through, but your order confirmation got stuck between our systems. `
        + `We've created your order ${order.id}, and it will arrive by ${formatDateTime(order.promisedBy)}. You don't need to pay again or contact us.`,
      journeyState: 'order_confirmed',
      events: [{ type: 'order_recreated', summary: `ACR recreated order ${orderId} from the paid checkout`, payload: { orderId } }],
    };
  },
};
