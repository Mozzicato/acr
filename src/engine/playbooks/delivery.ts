// Courier rejected the route: find an eligible alternate courier and keep the delivery promise.

import { formatDateTime, formatNgn, formatTime } from '../../format';
import { eligibilityProblems } from '../policy';
import { addMinutes } from '../systems';
import type { Courier, Customer, InventoryRecord, Order, Payment, RecoveryOption } from '../types';
import type { Playbook } from './types';

export const deliveryPlaybook: Playbook = {
  kind: 'courier_rejected',
  failure: 'Courier capacity',

  investigate({ incident, journey, tools, systems, now, step }) {
    const id = incident.id;
    step('investigate', 'info', `Investigating order ${journey.orderId}`);
    const order = tools.read(id, 'get_order', { orderId: journey.orderId }) as Order;
    const payment = tools.read(id, 'get_payment', { orderId: order.id }) as Payment;
    step('investigate', payment.status === 'confirmed' ? 'ok' : 'fail',
      payment.status === 'confirmed' ? 'Payment confirmed' : `Payment ${payment.status}`, `${payment.reference} · ${formatNgn(payment.amount)}`);
    const inventory = tools.read(id, 'get_inventory', { orderId: order.id }) as InventoryRecord;
    step('investigate', inventory.reserved ? 'ok' : 'fail',
      inventory.reserved ? 'Inventory available' : 'Inventory not reserved', `${inventory.sku} reserved at ${inventory.warehouse}`);
    const customer = tools.read(id, 'get_customer', { customerId: order.customerId }) as Customer;
    const history = tools.read(id, 'search_support_history', { customerId: customer.id }) as unknown[];
    step('investigate', 'info', `Customer: ${customer.name} (${customer.tier})`,
      history.length ? `${history.length} past support contacts about late deliveries` : 'No past support contacts');

    const pool = tools.read(id, 'find_couriers', { zone: order.zone }) as Courier[];
    const rejected = [...journey.events].reverse().find((e) => e.type === 'courier_rejected_route');
    const original = pool.find((c) => c.id === rejected?.payload.courierId) ?? null;
    if (original) {
      step('investigate', 'fail', `Courier unavailable: ${original.name}`, `Capacity ${Math.round(original.capacity * 100)}%. Route rejected.`);
    }
    let best: { courier: Courier; eta: string } | null = null;
    for (const courier of pool.filter((c) => c.id !== original?.id)) {
      const eta = addMinutes(now(), courier.pickupMinutes + order.transitMinutes);
      const problems = eligibilityProblems(order, courier, eta);
      if (problems.length === 0) {
        step('investigate', 'ok', `Alternate courier found: ${courier.name}`,
          `Capacity ${Math.round(courier.capacity * 100)}% · pickup in ${courier.pickupMinutes} min · ETA ${formatTime(eta)}`);
        if (!best || courier.capacity < best.courier.capacity) best = { courier, eta };
      } else {
        step('investigate', 'warn', `${courier.name} not eligible`, problems.join(', '));
      }
    }

    const cause = original
      ? `${original.name} rejected the route because it exceeded its capacity (${Math.round(original.capacity * 100)}%).`
      : 'The assigned courier rejected the route.';
    const confidence = original && !original.available ? 0.92 : 0.6;

    // Ranked by customer impact, then cost.
    const options: RecoveryOption[] = [
      best
        ? { action: 'reassign_courier', label: `Reassign to ${best.courier.name}`, successProbability: Math.round((1 - best.courier.capacity / 10) * 100), costNgn: 0, customerImpact: 'low', courierId: best.courier.id, projectedEta: best.eta }
        : { action: 'reassign_courier', label: 'Reassign courier (no eligible courier)', successProbability: 0, costNgn: 0, customerImpact: 'low' },
      { action: 'delay_with_credit', label: 'Delay delivery and offer ₦2,000 credit', successProbability: 99, costNgn: 2_000, customerImpact: 'medium' },
      { action: 'refund', label: 'Refund the customer', successProbability: 100, costNgn: order.amount, customerImpact: 'high' },
      { action: 'human_review', label: 'Escalate to a human operator', successProbability: 85, costNgn: 0, customerImpact: 'medium' },
    ];

    return {
      cause,
      confidence,
      options,
      customer,
      situation: `${order.item} order has no courier after the assigned courier rejected the route`,
      promise: `Delivery by ${formatDateTime(order.promisedBy)}`,
      facts: {
        kind: 'courier_rejected',
        order: systems.getOrder(order.id),
        paymentConfirmed: systems.getPayment(order.id).status === 'confirmed',
        inventoryReserved: systems.getInventory(order.id).reserved,
        originalCourierUnavailable: !!original && !systems.getCourier(original.id).available,
        candidate: best ? systems.getCourier(best.courier.id) : null,
      },
    };
  },

  execute({ incident, journey, tools, systems, step }, decision, auth, investigation) {
    const id = incident.id;
    const courierId = decision.selected.courierId!;
    const courierName = systems.getCourier(courierId).name;
    const result = tools.write(id, 'reassign_delivery', { orderId: journey.orderId, courierId }, auth) as { accepted: boolean };
    step('act', result.accepted ? 'ok' : 'fail', result.accepted ? `Courier reassigned to ${courierName}` : `${courierName} declined the reassignment`);

    // Verify: never assume the action worked.
    const status = tools.read(id, 'get_delivery_status', { orderId: journey.orderId }) as { courierId: string | null; courierAccepted: boolean; eta: string; promisedBy: string };
    const accepted = status.courierAccepted && status.courierId === courierId;
    const etaPreserved = Date.parse(status.eta) <= Date.parse(status.promisedBy);
    step('verify', accepted ? 'ok' : 'fail', accepted ? 'Courier accepted' : 'Courier acceptance not confirmed');
    step('verify', etaPreserved ? 'ok' : 'fail', etaPreserved ? 'ETA preserved' : 'ETA misses promised time',
      `New ETA ${formatDateTime(status.eta)} · promised by ${formatDateTime(status.promisedBy)}`);
    if (!accepted || !etaPreserved) return { ok: false, reason: 'Verification failed after reassignment.' };

    const order = systems.getOrder(journey.orderId);
    const firstName = investigation.customer.name.split(' ')[0];
    return {
      ok: true,
      resolution: `Reassigned to ${courierName}. Promised delivery time kept. Customer informed.`,
      notification: `Hi ${firstName}, your order ${order.id} (${order.item}) was at risk of a delay because the original courier couldn't take the route. `
        + `We've reassigned it to ${courierName}, and it will still arrive by ${formatDateTime(order.promisedBy)}. You don't need to do anything.`,
      journeyState: 'courier_assigned',
      events: [{ type: 'courier_reassigned', summary: `ACR reassigned delivery to ${courierName}`, payload: { courierId, eta: status.eta } }],
    };
  },
};
