import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { createIngestionApp } from './app';
import type { JourneyEvent } from '../detection/scoreFriction';

test('POSTs failed payment retry events and returns the scored journey from status', async (context) => {
  const events: JourneyEvent[] = [];
  let latestScore: { score: number; factors: unknown } | undefined;
  const fakePool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('insert into events')) {
        const [journey_id, event_type, occurred_at, payload] = params as [string, string, string, Record<string, unknown>];
        const row: JourneyEvent = {
          id: `event-${events.length + 1}`, journey_id, customer_id: 'customer-test', event_type,
          occurred_at, payload, created_at: occurred_at
        };
        events.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('from events')) return { rows: [...events], rowCount: events.length };
      if (sql.includes('insert into friction_scores')) {
        latestScore = { score: Number(params[1]), factors: JSON.parse(String(params[2])) };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('from friction_scores')) return { rows: latestScore ? [latestScore] : [], rowCount: latestScore ? 1 : 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const cache = new Map<string, string>();
  const fakeRedis = {
    async get(key: string) { return cache.get(key) ?? null; },
    async setex(key: string, _ttl: number, value: string) { cache.set(key, value); return 'OK'; }
  };

  const server = createIngestionApp({ pool: fakePool as unknown as Pick<Pool, 'query'>, redis: fakeRedis as unknown as Pick<Redis, 'get' | 'setex'> })
    .listen(0);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sequence: Array<[string, number, Record<string, unknown>]> = [
    ['payment_attempted', 0, { amount: 27500, provider: 'card', attempt: 1 }],
    ['payment_failed', 1, { reason: 'issuer_declined', attempt: 1 }],
    ['payment_retry_started', 3, { attempt: 2 }],
    ['payment_failed', 4, { reason: 'timeout', attempt: 2 }]
  ];
  for (const [event_type, minute, payload] of sequence) {
    const response = await fetch(`${baseUrl}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ journey_id: 'journey-test', event_type, payload, occurred_at: new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString() })
    });
    assert.equal(response.status, 201);
  }

  const statusResponse = await fetch(`${baseUrl}/journeys/journey-test/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json() as { score: number; reason: string; events: unknown[] };
  assert.equal(status.score, 95);
  assert.match(status.reason, /failed payment/);
  assert.equal(status.events.length, 4);
});
