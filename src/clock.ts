import type { Queryable } from './db.js';

// Returns "now" as a timestamptz string with microsecond precision.
// Tests swap this out to land a bid on an exact instant.
export type Clock = (db: Queryable) => Promise<string>;

// One clock for the whole system: the database's. App servers can drift,
// and comparing against end_time needs a single authority.
export const databaseClock: Clock = async (db) => {
  const { rows } = await db.query<{ now: string }>('SELECT clock_timestamp()::text AS now');
  return rows[0]!.now;
};
