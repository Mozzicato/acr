import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreFriction, type JourneyEvent } from './scoreFriction';

const journey = (rows: Array<[string, number, Record<string, unknown>]>, journeyId: string): JourneyEvent[] =>
  rows.map(([event_type, minute, payload], index) => ({
    id: `${journeyId}-${index}`,
    journey_id: journeyId,
    customer_id: 'customer-1',
    event_type,
    occurred_at: new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString(),
    payload,
    created_at: new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString()
  }));

// Event rows mirror the simulator's friction scenario event sequences.
const failedPaymentRetry = journey([
  ['payment_attempted', 0, { amount: 27500, provider: 'card', attempt: 1 }],
  ['payment_failed', 1, { reason: 'issuer_declined', attempt: 1 }],
  ['payment_retry_started', 3, { attempt: 2 }],
  ['payment_failed', 4, { reason: 'timeout', attempt: 2 }]
], 'failed-payment-retry');

const growingDelayAndFrustratedMessage = journey([
  ['shipment_created', 0, { trackingId: 'NG-FRICTION-001' }],
  ['delivery_delayed', 90, { expectedAt: '10:00', delayMinutes: 90, reason: 'hub_backlog' }],
  ['delivery_delayed', 210, { expectedAt: '12:00', delayMinutes: 240, reason: 'vehicle_breakdown' }],
  ['support_message_received', 220, { text: 'This is the second delay. I have been waiting all day and nobody is helping me.' }]
], 'growing-delay-frustrated-message');

const cleanJourney = journey([
  ['product_viewed', 0, { productId: 'rice-25kg' }],
  ['checkout_started', 3, { cartValue: 42000, currency: 'NGN' }],
  ['payment_succeeded', 5, { amount: 42000, provider: 'card' }],
  ['order_confirmed', 6, { orderId: 'ord-clean-001' }]
], 'clean');

test('scores a failed payment and its retry highly', () => {
  assert.ok(scoreFriction(failedPaymentRetry).score >= 50);
});

test('scores growing delivery delays and frustrated support highly', () => {
  assert.ok(scoreFriction(growingDelayAndFrustratedMessage).score >= 70);
});

test('scores a clean journey at zero', () => {
  assert.deepEqual(scoreFriction(cleanJourney), { score: 0, reason: 'No friction signals detected.' });
});
