import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';

type JourneyType = 'ecommerce' | 'fintech' | 'logistics';

type EventInput = {
  type: string;
  payload: Record<string, unknown>;
  gapMinutes: number;
};

type CustomerSeed = {
  externalId: string;
  name: string;
  email: string;
  phone: string;
};

const liveMode = process.argv.includes('--live') || process.env.SIMULATOR_LIVE === 'true';
const liveDelayMultiplier = Number(process.env.SIMULATOR_DELAY_MULTIPLIER ?? 1);

const customerSeeds: CustomerSeed[] = [
  { externalId: 'cust-adaeze', name: 'Adaeze Okafor', email: 'adaeze@example.com', phone: '+2348010000001' },
  { externalId: 'cust-chinedu', name: 'Chinedu Bello', email: 'chinedu@example.com', phone: '+2348010000002' },
  { externalId: 'cust-fatima', name: 'Fatima Yusuf', email: 'fatima@example.com', phone: '+2348010000003' },
  { externalId: 'cust-emeka', name: 'Emeka Nwosu', email: 'emeka@example.com', phone: '+2348010000004' },
  { externalId: 'cust-zainab', name: 'Zainab Ibrahim', email: 'zainab@example.com', phone: '+2348010000005' }
];

const journeySeeds: Array<{ customerIndex: number; type: JourneyType; friction: boolean; events: EventInput[] }> = [
  {
    customerIndex: 0,
    type: 'ecommerce',
    friction: false,
    events: [
      { type: 'product_viewed', payload: { productId: 'rice-25kg' }, gapMinutes: 0 },
      { type: 'checkout_started', payload: { cartValue: 42000, currency: 'NGN' }, gapMinutes: 3 },
      { type: 'payment_succeeded', payload: { amount: 42000, provider: 'card' }, gapMinutes: 2 },
      { type: 'order_confirmed', payload: { orderId: 'ord-clean-001' }, gapMinutes: 1 }
    ]
  },
  {
    customerIndex: 1,
    type: 'fintech',
    friction: false,
    events: [
      { type: 'transfer_started', payload: { amount: 15000, beneficiary: 'Kemi Stores' }, gapMinutes: 0 },
      { type: 'transfer_processing', payload: { provider: 'bank_rail' }, gapMinutes: 2 },
      { type: 'transfer_succeeded', payload: { reference: 'trf-clean-001' }, gapMinutes: 3 }
    ]
  },
  {
    customerIndex: 2,
    type: 'logistics',
    friction: false,
    events: [
      { type: 'shipment_created', payload: { trackingId: 'NG-CLEAN-001' }, gapMinutes: 0 },
      { type: 'shipment_picked_up', payload: { hub: 'Lagos' }, gapMinutes: 15 },
      { type: 'shipment_delivered', payload: { deliveredTo: 'customer' }, gapMinutes: 30 }
    ]
  },
  {
    customerIndex: 3,
    type: 'fintech',
    friction: true,
    events: [
      { type: 'payment_attempted', payload: { amount: 27500, provider: 'card', attempt: 1 }, gapMinutes: 0 },
      { type: 'payment_failed', payload: { reason: 'issuer_declined', attempt: 1 }, gapMinutes: 1 },
      { type: 'payment_retry_started', payload: { attempt: 2 }, gapMinutes: 2 },
      { type: 'payment_failed', payload: { reason: 'timeout', attempt: 2 }, gapMinutes: 1 }
    ]
  },
  {
    customerIndex: 4,
    type: 'logistics',
    friction: true,
    events: [
      { type: 'shipment_created', payload: { trackingId: 'NG-FRICTION-001' }, gapMinutes: 0 },
      { type: 'delivery_delayed', payload: { expectedAt: '10:00', delayMinutes: 90, reason: 'hub_backlog' }, gapMinutes: 90 },
      { type: 'delivery_delayed', payload: { expectedAt: '12:00', delayMinutes: 240, reason: 'vehicle_breakdown' }, gapMinutes: 120 },
      { type: 'support_message_received', payload: { text: 'This is the second delay. I have been waiting all day and nobody is helping me.' }, gapMinutes: 10 }
    ]
  }
];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function insertCustomer(client: PoolClient, seed: CustomerSeed): Promise<string> {
  const newId = randomUUID();
  await client.query(
    `insert into customers (id, external_id, name, email, phone)
     values ($1, $2, $3, $4, $5)
     on conflict (external_id) do update set name = excluded.name, email = excluded.email, phone = excluded.phone`,
    [newId, seed.externalId, seed.name, seed.email, seed.phone]
  );

  const result = await client.query<{ id: string }>('select id from customers where external_id = $1', [seed.externalId]);
  return result.rows[0].id;
}

async function playJourney(client: PoolClient, customerId: string, seed: typeof journeySeeds[number]): Promise<void> {
  const journeyId = randomUUID();
  const startedAt = new Date();
  let occurredAt = new Date(startedAt);

  await client.query(
    `insert into journeys (id, customer_id, journey_type, status, started_at, metadata)
     values ($1, $2, $3, 'active', $4, $5)`,
    [journeyId, customerId, seed.type, startedAt, { simulated: true, frictionScenario: seed.friction }]
  );

  for (const event of seed.events) {
    occurredAt = new Date(occurredAt.getTime() + event.gapMinutes * 60_000);
    if (liveMode && event.gapMinutes > 0) {
      await sleep(event.gapMinutes * 60_000 * liveDelayMultiplier);
    }

    await client.query(
      `insert into events (id, journey_id, customer_id, event_type, occurred_at, payload)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), journeyId, customerId, event.type, occurredAt, event.payload]
    );
    console.log(`  ${seed.type.padEnd(10)} ${event.type}`);
  }

  if (!seed.friction) {
    await client.query(`update journeys set status = 'resolved', resolved_at = $1 where id = $2`, [occurredAt, journeyId]);
    console.log(`  journey ${journeyId} resolved`);
  } else {
    console.log(`  journey ${journeyId} left active (friction scenario)`);
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env and set the Supabase connection string.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('begin');
    const customerIds = new Map<number, string>();
    for (const [index, seed] of customerSeeds.entries()) {
      customerIds.set(index, await insertCustomer(client, seed));
    }

    console.log(`Simulating ${journeySeeds.length} journeys (${liveMode ? 'live timing' : 'instant timing'})...`);
    for (const seed of journeySeeds) {
      await playJourney(client, customerIds.get(seed.customerIndex)!, seed);
    }
    await client.query('commit');
    console.log('Simulation complete. No scoring or resolution records were created.');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});