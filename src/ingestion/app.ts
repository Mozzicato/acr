import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { scoreFriction, type FrictionScore, type JourneyEvent } from '../detection/scoreFriction';

const CACHE_TTL_SECONDS = 60 * 60;
const cacheKey = (journeyId: string) => `journey:${journeyId}:state`;

type CachedState = { events: JourneyEvent[]; score: FrictionScore };
type Dependencies = { pool: Pick<Pool, 'query'>; redis: Pick<Redis, 'get' | 'setex'> };

function parseCachedState(value: string | null): CachedState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CachedState;
    return Array.isArray(parsed.events) && parsed.score ? parsed : null;
  } catch {
    return null;
  }
}

async function loadEvents(pool: Dependencies['pool'], journeyId: string): Promise<JourneyEvent[]> {
  const result = await pool.query<JourneyEvent>(
    'select id, journey_id, customer_id, event_type, occurred_at, payload, created_at from events where journey_id = $1 order by occurred_at asc, created_at asc',
    [journeyId]
  );
  return result.rows;
}

export function createIngestionApp({ pool, redis }: Dependencies): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/journeys', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query<{
        journey_id: string;
        customer_id: string;
        score: string | number | null;
        factors: unknown;
        created_at: string | Date;
      }>(
        `select j.id as journey_id, j.customer_id, latest.score, latest.factors,
                j.started_at as created_at
         from journeys j
         left join lateral (
           select fs.score, fs.factors
           from friction_scores fs
           where fs.journey_id = j.id
           order by fs.created_at desc
           limit 1
         ) latest on true
         order by latest.score desc nulls last, j.started_at desc`
      );
      const journeys = result.rows.map((row) => {
        const factors = typeof row.factors === 'string'
          ? JSON.parse(row.factors) as Record<string, unknown>
          : row.factors as Record<string, unknown> | null;
        return {
          journey_id: row.journey_id,
          customer_id: row.customer_id,
          score: row.score === null ? null : Number(row.score),
          reason: typeof factors?.reason === 'string' ? factors.reason : null,
          created_at: row.created_at
        };
      });
      res.json(journeys);
    } catch (error) {
      console.error('GET /journeys failed', error);
      res.status(500).json({ error: 'Unable to load journeys.' });
    }
  });

  app.post('/events', async (req: Request, res: Response) => {
    const { journey_id, event_type, payload, occurred_at } = req.body ?? {};
    if (typeof journey_id !== 'string' || !journey_id || typeof event_type !== 'string' || !event_type ||
        !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof occurred_at !== 'string' || !Number.isFinite(Date.parse(occurred_at))) {
      res.status(400).json({ error: 'Expected journey_id, event_type, object payload, and valid occurred_at.' });
      return;
    }

    try {
      const inserted = await pool.query<JourneyEvent>(
        `insert into events (journey_id, customer_id, event_type, occurred_at, payload)
         select j.id, j.customer_id, $2, $3, $4 from journeys j where j.id = $1
         returning id, journey_id, customer_id, event_type, occurred_at, payload, created_at`,
        [journey_id, event_type, occurred_at, payload]
      );
      if (!inserted.rows[0]) {
        res.status(404).json({ error: 'Journey not found.' });
        return;
      }

      const cached = parseCachedState(await redis.get(cacheKey(journey_id)));
      const events = cached ? [...cached.events, inserted.rows[0]] : await loadEvents(pool, journey_id);
      events.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
      const score = scoreFriction(events);
      await pool.query('insert into friction_scores (journey_id, score, factors) values ($1, $2, $3)',
        [journey_id, score.score, JSON.stringify({ reason: score.reason })]);
      await redis.setex(cacheKey(journey_id), CACHE_TTL_SECONDS, JSON.stringify({ events, score } satisfies CachedState));
      res.status(201).json({ journey_id, ...score });
    } catch (error) {
      console.error('POST /events failed', error);
      res.status(500).json({ error: 'Unable to ingest event.' });
    }
  });

  app.get('/journeys/:id/status', async (req: Request, res: Response) => {
    try {
      const journeyId = String(req.params.id);
      const cached = parseCachedState(await redis.get(cacheKey(journeyId)));
      if (cached) {
        res.json({ journey_id: journeyId, ...cached.score, events: cached.events });
        return;
      }

      const events = await loadEvents(pool, journeyId);
      const scoreResult = await pool.query<{ score: string | number; factors: unknown }>(
        'select score, factors from friction_scores where journey_id = $1 order by created_at desc limit 1', [journeyId]
      );
      if (!events.length && !scoreResult.rows.length) {
        res.status(404).json({ error: 'Journey not found or has no events.' });
        return;
      }
      const factors = scoreResult.rows[0]?.factors;
      const factorObject = typeof factors === 'string' ? JSON.parse(factors) as Record<string, unknown> : factors as Record<string, unknown> | null;
      const score: FrictionScore = scoreResult.rows[0]
        ? { score: Number(scoreResult.rows[0].score), reason: typeof factorObject?.reason === 'string' ? factorObject.reason : 'Previously scored journey.' }
        : scoreFriction(events);
      await redis.setex(cacheKey(journeyId), CACHE_TTL_SECONDS, JSON.stringify({ events, score } satisfies CachedState));
      res.json({ journey_id: journeyId, ...score, events });
    } catch (error) {
      console.error('GET /journeys/:id/status failed', error);
      res.status(500).json({ error: 'Unable to load journey status.' });
    }
  });

  return app;
}
