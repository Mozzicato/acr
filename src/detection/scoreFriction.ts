/** The fields consumed from a row in the events table. */
export type JourneyEvent = {
  id: string;
  journey_id: string;
  customer_id: string;
  event_type: string;
  occurred_at: string | Date;
  payload: Record<string, unknown>;
  created_at: string | Date;
};

export type FrictionScore = { score: number; reason: string };

const actionFor = (event: JourneyEvent): string | undefined => {
  if (/^payment_/.test(event.event_type)) return 'payment';
  if (/^transfer_/.test(event.event_type)) return 'transfer';
  if (/^delivery_|^shipment_/.test(event.event_type)) return 'delivery';
  const action = event.payload.action;
  return typeof action === 'string' ? action : undefined;
};

const isNegativeSupportMessage = (event: JourneyEvent): boolean => {
  if (event.event_type !== 'support_message_received') return false;
  const text = String(event.payload.text ?? '').toLowerCase();
  return /\b(frustrat(?:ed|ing)|angry|upset|unhappy|waiting|nobody|no one|not helping|terrible|awful|second delay|still not|disappointed)\b/.test(text);
};

/** Purely scores the supplied event history; it performs no I/O. */
export function scoreFriction(events: readonly JourneyEvent[]): FrictionScore {
  const reasons: string[] = [];
  let points = 0;

  for (const event of events) {
    if (event.event_type === 'payment_failed') {
      points += 25;
      reasons.push('failed payment attempt (+25)');
    }

    if (event.event_type === 'delivery_delayed') {
      const delay = Number(event.payload.delayMinutes);
      if (Number.isFinite(delay) && delay > 0) {
        const added = Math.min(delay, 40);
        points += added;
        reasons.push(`delivery delayed ${delay} minutes (+${added})`);
      }
    }

    if (isNegativeSupportMessage(event)) {
      points += 30;
      reasons.push('negative sentiment in support message (+30)');
    }
  }

  const ordered = [...events].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const previousAction = actionFor(previous);
    if (previousAction && previousAction === actionFor(current)) {
      const elapsed = new Date(current.occurred_at).getTime() - new Date(previous.occurred_at).getTime();
      if (elapsed >= 0 && elapsed <= 5 * 60_000 && /retry|attempted|failed/.test(current.event_type)) {
        points += 15;
        reasons.push(`retry on ${previousAction} within 5 minutes (+15)`);
      }
    }
  }

  const score = Math.min(100, points);
  return { score, reason: reasons.length ? reasons.join('; ') : 'No friction signals detected.' };
}
