// Mocked business systems (Order, Payment, Inventory, Logistics, CRM, Notification).
// They stand in for real APIs; ACR only reaches them through the tool layer.

import type { Courier, Customer, InventoryRecord, Notification, Order, Payment, Zone } from './types';

export class SimClock {
  private ms: number;
  constructor(start: string) {
    this.ms = Date.parse(start);
  }
  now(): string {
    return new Date(this.ms).toISOString();
  }
  advance(seconds: number): string {
    this.ms += seconds * 1000;
    return this.now();
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}

export const addMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/** A cart at checkout: everything needed to create its order. */
export interface Checkout {
  orderId: string;
  customerId: string;
  item: string;
  sku: string;
  amount: number;
  zone: Zone;
  transitMinutes: number;
}

export interface WebhookDelivery {
  id: string;
  event: 'order.create';
  orderId: string;
  paymentReference: string;
  status: 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
  at: string;
}

export interface SupportContact {
  customerId: string;
  at: string;
  topic: string;
}

export class BusinessSystems {
  readonly customers = new Map<string, Customer>();
  readonly orders = new Map<string, Order>();
  readonly payments = new Map<string, Payment>();
  readonly inventory = new Map<string, InventoryRecord>();
  readonly couriers = new Map<string, Courier>();
  readonly supportHistory: SupportContact[] = [];
  readonly checkouts = new Map<string, Checkout>();
  readonly webhooks: WebhookDelivery[] = [];
  /** Units on hand per SKU. */
  readonly stock = new Map<string, number>();
  readonly outbox: Notification[] = [];
  /** Support tickets opened for customers. ACR's goal is to keep this empty. */
  readonly tickets: string[] = [];

  // Order API
  getOrder(id: string): Order {
    return required(this.orders.get(id), `order ${id}`);
  }

  findOrder(id: string): Order | null {
    return this.orders.get(id) ?? null;
  }

  getCheckout(orderId: string): Checkout {
    return required(this.checkouts.get(orderId), `checkout ${orderId}`);
  }

  /** The customer pays at checkout. If the webhook drops, the order service never hears about it. */
  capturePayment(orderId: string, now: string, webhookFails: boolean): Payment {
    const checkout = this.getCheckout(orderId);
    const payment: Payment = { orderId, status: 'confirmed', amount: checkout.amount, reference: `PAY-${orderId.slice(4)}` };
    this.payments.set(orderId, payment);
    this.webhooks.push({
      id: `WH-${String(this.webhooks.length + 1).padStart(4, '0')}`,
      event: 'order.create',
      orderId,
      paymentReference: payment.reference,
      status: webhookFails ? 'failed' : 'delivered',
      attempts: webhookFails ? 3 : 1,
      lastError: webhookFails ? 'HTTP 504 from order-service after 3 retries' : null,
      at: now,
    });
    if (!webhookFails) this.createOrderFromCheckout(orderId, now);
    return payment;
  }

  /** Creates the order for a paid checkout. Idempotent: an existing order is never duplicated. */
  createOrderFromCheckout(orderId: string, now: string): { created: boolean; reason?: string } {
    if (this.orders.has(orderId)) return { created: false, reason: 'order already exists' };
    const checkout = this.getCheckout(orderId);
    if (this.payments.get(orderId)?.status !== 'confirmed') return { created: false, reason: 'payment not captured' };
    const onHand = this.stock.get(checkout.sku) ?? 0;
    if (onHand < 1) return { created: false, reason: 'out of stock' };
    this.stock.set(checkout.sku, onHand - 1);
    this.inventory.set(orderId, { sku: checkout.sku, orderId, reserved: true, warehouse: 'WH-Lagos-01' });
    this.orders.set(orderId, {
      id: orderId,
      customerId: checkout.customerId,
      item: checkout.item,
      sku: checkout.sku,
      amount: checkout.amount,
      zone: checkout.zone,
      status: 'accepted',
      courierId: null,
      promisedBy: addMinutes(now, 30 * 60),
      eta: addMinutes(now, 26 * 60),
      transitMinutes: checkout.transitMinutes,
    });
    for (const w of this.webhooks.filter((w) => w.orderId === orderId)) w.status = 'delivered';
    return { created: true };
  }

  // Payment API
  getPayment(orderId: string): Payment {
    return required(this.payments.get(orderId), `payment for ${orderId}`);
  }

  // Inventory API
  getInventory(orderId: string): InventoryRecord {
    return required(this.inventory.get(orderId), `inventory for ${orderId}`);
  }

  // CRM API
  getCustomer(id: string): Customer {
    return required(this.customers.get(id), `customer ${id}`);
  }

  searchSupportHistory(customerId: string): SupportContact[] {
    return this.supportHistory.filter((c) => c.customerId === customerId);
  }

  // Logistics API
  getCourier(id: string): Courier {
    return required(this.couriers.get(id), `courier ${id}`);
  }

  couriersInZone(zone: Zone): Courier[] {
    return [...this.couriers.values()].filter((c) => c.zone === zone);
  }

  /** The courier drops the route; the order is left without a courier. */
  rejectRoute(orderId: string): Courier {
    const order = this.getOrder(orderId);
    const courier = this.getCourier(required(order.courierId, `courier on ${orderId}`));
    courier.available = false;
    courier.capacity = 1;
    order.courierId = null;
    order.status = 'accepted';
    return courier;
  }

  /** Offers the route to a courier, who accepts only with spare capacity. */
  assignCourier(orderId: string, courierId: string, now: string): { accepted: boolean; eta: string } {
    const order = this.getOrder(orderId);
    const courier = this.getCourier(courierId);
    if (!courier.available || courier.capacity >= 1 || courier.zone !== order.zone) {
      return { accepted: false, eta: order.eta };
    }
    courier.capacity = Math.min(1, courier.capacity + 0.04);
    order.courierId = courierId;
    order.status = 'courier_assigned';
    order.eta = addMinutes(now, courier.pickupMinutes + order.transitMinutes);
    return { accepted: true, eta: order.eta };
  }

  // Notification API
  send(notification: Notification): Notification {
    this.outbox.push(notification);
    return notification;
  }
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Not found: ${what}`);
  return value;
}
