import 'dotenv/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { createIngestionApp } from './app';

const { DATABASE_URL, REDIS_URL, PORT } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!REDIS_URL) throw new Error('REDIS_URL is required (for example redis://localhost:6379).');

const pool = new Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL);
const port = Number(PORT ?? 3000);
const server = createIngestionApp({ pool, redis }).listen(port, () => {
  console.log(`Ingestion API listening on port ${port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await Promise.all([pool.end(), redis.quit()]);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
