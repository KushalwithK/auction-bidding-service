import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { config } from '../src/config.js';
import { createPool } from '../src/db.js';

export function createTestPool(): Pool {
  return createPool(config.testDatabaseUrl);
}

export async function resetDatabase(pool: Pool) {
  await pool.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await pool.query('TRUNCATE bids, auctions, users RESTART IDENTITY CASCADE');
}

export async function createUser(pool: Pool, name: string): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (name) VALUES ($1) RETURNING id',
    [name],
  );
  return Number(rows[0]!.id);
}

export async function createAuction(
  pool: Pool,
  opts: { sellerId: number; minAmount?: string; startTime?: string; endTime?: string },
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO auctions (entity_type, entity_id, min_amount, start_time, end_time, created_by)
     VALUES ('car', 'test-car', $1, COALESCE($2::timestamptz, now() - interval '1 hour'),
             COALESCE($3::timestamptz, now() + interval '1 hour'), $4)
     RETURNING id`,
    [opts.minAmount ?? '100.00', opts.startTime ?? null, opts.endTime ?? null, opts.sellerId],
  );
  return Number(rows[0]!.id);
}

export async function bidsFor(pool: Pool, auctionId: number) {
  const { rows } = await pool.query<{ id: string; user_id: string; amount: string; status: string }>(
    'SELECT id, user_id, amount, status FROM bids WHERE auction_id = $1 ORDER BY id',
    [auctionId],
  );
  return rows;
}
