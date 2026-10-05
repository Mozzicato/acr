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
  readonly outbox: Notification[] = [];
  /** Support tickets opened for customers. ACR's goal is to keep this empty. */
  readonly tickets: string[] = [];

  // Order API
  getOrder(id: string): Order {
    return required(this.orders.get(id), `order ${id}`);
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
