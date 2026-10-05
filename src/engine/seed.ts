// Demo scenario (PRD §10): a laptop order in Lekki whose courier rejects the route at 13:00.

import { BusinessSystems } from './systems';
import type { Courier, Journey, JourneyEvent, Zone } from './types';

export const DEMO_JOURNEY_ID = 'JRN-1292';
export const DEMO_START = '2026-10-04T12:59:00+01:00';

export type Scenario = 'alternate_available' | 'network_saturated';

interface OrderSeed {
  orderId: string;
  customer: { id: string; name: string; tier: 'standard' | 'priority'; channel: 'sms' | 'email'; previousDelays: number };
  item: string;
  sku: string;
  amount: number;
  zone: Zone;
  courierId: string;
  status: 'courier_assigned' | 'in_transit';
  orderedAt: string;
  promisedBy: string;
  transitMinutes: number;
}

const ORDERS: OrderSeed[] = [
  {
    orderId: 'ORD-1292',
    customer: { id: 'C102', name: 'Adaeze Okafor', tier: 'priority', channel: 'sms', previousDelays: 2 },
    item: 'ThinkBook 14 laptop',
    sku: 'LAP-TB14-16G',
    amount: 845_000,
    zone: 'Lekki',
    courierId: 'CR-SWIFT',
    status: 'courier_assigned',
    orderedAt: '2026-10-04T09:00:00+01:00',
    promisedBy: '2026-10-05T12:00:00+01:00',
    transitMinutes: 180,
  },
  order('ORD-1287', 'C097', 'Chinedu Bello', 'Air fryer 5L', 'KIT-AF5', 89_500, 'Yaba', 'CR-MAIN', 'in_transit', '07:42', 'standard'),
  order('ORD-1288', 'C098', 'Fatima Yusuf', 'Running shoes', 'SHO-RN42', 54_000, 'Ikeja', 'CR-IKJ', 'courier_assigned', '08:15', 'standard'),
  order('ORD-1289', 'C099', 'Emeka Nwosu', 'Office chair', 'FUR-OC2', 132_000, 'Lekki', 'CR-LAGOON', 'in_transit', '08:31', 'priority'),
  order('ORD-1290', 'C100', 'Zainab Ibrahim', 'Blender', 'KIT-BL1', 38_700, 'Yaba', 'CR-YABA', 'courier_assigned', '08:47', 'standard'),
  order('ORD-1291', 'C101', 'Tunde Adeyemi', 'Smartwatch', 'WRB-SW3', 112_000, 'Ikeja', 'CR-ALAUSA', 'in_transit', '08:52', 'standard'),
  order('ORD-1293', 'C103', 'Ngozi Eze', 'Rice cooker', 'KIT-RC2', 46_200, 'Lekki', 'CR-EKO', 'courier_assigned', '09:20', 'standard'),
  order('ORD-1294', 'C104', 'Ibrahim Musa', 'Bluetooth speaker', 'AUD-BS7', 61_900, 'Ikeja', 'CR-IKJ', 'courier_assigned', '10:05', 'standard'),
  order('ORD-1295', 'C105', 'Kemi Alade', 'Phone case bundle', 'ACC-PC4', 12_500, 'Yaba', 'CR-MAIN', 'courier_assigned', '10:40', 'standard'),
  order('ORD-1296', 'C106', 'Segun Bakare', 'Gaming monitor', 'MON-G27', 298_000, 'Lekki', 'CR-LAGOON', 'courier_assigned', '11:12', 'priority'),
];

function order(
  orderId: string, customerId: string, name: string, item: string, sku: string, amount: number,
  zone: Zone, courierId: string, status: OrderSeed['status'], hhmm: string, tier: 'standard' | 'priority',
): OrderSeed {
  return {
    orderId,
    customer: { id: customerId, name, tier, channel: tier === 'priority' ? 'sms' : 'email', previousDelays: 0 },
    item, sku, amount, zone, courierId, status,
    orderedAt: `2026-10-04T${hhmm}:00+01:00`,
    promisedBy: '2026-10-05T18:00:00+01:00',
    transitMinutes: 150,
  };
}

function couriers(scenario: Scenario): Courier[] {
  // A saturated network leaves no Lekki courier with room for another route.
  const saturated = scenario === 'network_saturated';
  return [
    { id: 'CR-SWIFT', name: 'Swift Dispatch', zone: 'Lekki', capacity: 0.97, available: true, pickupMinutes: 40 },
    { id: 'CR-LAGOON', name: 'Lagoon Express', zone: 'Lekki', capacity: saturated ? 0.98 : 0.62, available: !saturated, pickupMinutes: 45 },
    { id: 'CR-EKO', name: 'Eko Riders', zone: 'Lekki', capacity: 0.93, available: true, pickupMinutes: 30 },
    { id: 'CR-MAIN', name: 'Mainland Couriers', zone: 'Yaba', capacity: 0.7, available: true, pickupMinutes: 35 },
    { id: 'CR-YABA', name: 'Yaba Bikes', zone: 'Yaba', capacity: 0.55, available: true, pickupMinutes: 25 },
    { id: 'CR-IKJ', name: 'Ikeja Express', zone: 'Ikeja', capacity: 0.8, available: true, pickupMinutes: 40 },
    { id: 'CR-ALAUSA', name: 'Alausa Dispatch', zone: 'Ikeja', capacity: 0.5, available: true, pickupMinutes: 30 },
  ];
}

const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export function seed(scenario: Scenario): { systems: BusinessSystems; journeys: Journey[] } {
  const systems = new BusinessSystems();
  for (const c of couriers(scenario)) systems.couriers.set(c.id, c);

  const journeys = ORDERS.map((o, index): Journey => {
    const slug = o.customer.name.split(' ')[0].toLowerCase();
    systems.customers.set(o.customer.id, {
      id: o.customer.id,
      name: o.customer.name,
      email: `${slug}@example.com`,
      phone: `+23480100000${String(index).padStart(2, '0')}`,
      tier: o.customer.tier,
      preferences: { channel: o.customer.channel },
      history: { previousDelays: o.customer.previousDelays, supportContacts: o.customer.previousDelays },
    });
    const courier = systems.getCourier(o.courierId);
    const assignedAt = plus(o.orderedAt, 60);
    systems.orders.set(o.orderId, {
      id: o.orderId,
      customerId: o.customer.id,
      item: o.item,
      sku: o.sku,
      amount: o.amount,
      zone: o.zone,
      status: o.status,
      courierId: o.courierId,
      promisedBy: o.promisedBy,
      eta: plus(assignedAt, courier.pickupMinutes + o.transitMinutes),
      transitMinutes: o.transitMinutes,
    });
    systems.payments.set(o.orderId, { orderId: o.orderId, status: 'confirmed', amount: o.amount, reference: `PAY-${o.orderId.slice(4)}` });
    systems.inventory.set(o.orderId, { sku: o.sku, orderId: o.orderId, reserved: true, warehouse: 'WH-Lagos-01' });
    for (let d = 0; d < o.customer.previousDelays; d += 1) {
      systems.supportHistory.push({ customerId: o.customer.id, at: `2026-0${7 + d}-1${d}T10:00:00+01:00`, topic: 'Late delivery' });
    }

    const journeyId = `JRN-${o.orderId.slice(4)}`;
    const ev = (minutes: number, type: string, summary: string, payload: Record<string, unknown> = {}): JourneyEvent => ({
      id: `${journeyId}-E${minutes}`,
      journeyId,
      at: plus(o.orderedAt, minutes),
      type,
      summary,
      payload,
    });
    const events = [
      ev(0, 'order_placed', `Ordered ${o.item}`, { amount: o.amount }),
      ev(1, 'payment_confirmed', 'Payment confirmed', { reference: `PAY-${o.orderId.slice(4)}` }),
      ev(3, 'order_accepted', 'Order accepted, stock reserved', { warehouse: 'WH-Lagos-01' }),
      ev(60, 'courier_assigned', `Courier assigned: ${courier.name}`, { courierId: courier.id }),
    ];
    if (o.status === 'in_transit') events.push(ev(110, 'parcel_collected', 'Parcel collected by courier'));

    return {
      id: journeyId,
      customerId: o.customer.id,
      orderId: o.orderId,
      objective: `Deliver ${o.item} by promised time`,
      currentState: o.status,
      expectedState: 'delivered',
      deadline: o.promisedBy,
      health: 'healthy',
      healthScore: 96 - (index % 4),
      events,
    };
  });

  return { systems, journeys };
}
