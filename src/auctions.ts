import type { Pool } from 'pg';
import type { Clock } from './clock.js';

interface AuctionRow {
  id: string;
  entity_type: string;
  entity_id: string;
  min_amount: string;
  start_time: Date;
  end_time: Date;
  created_by: string;
  state: 'upcoming' | 'live' | 'ended';
  accepted_bids: string;
  top_bid_id: string | null;
  top_bid_user_id: string | null;
  top_bid_amount: string | null;
  top_bid_created_at: Date | null;
}

export async function getAuction(pool: Pool, clock: Clock, id: number) {
  const now = await clock(pool);
  const { rows } = await pool.query<AuctionRow>(
    `SELECT a.id, a.entity_type, a.entity_id, a.min_amount, a.start_time, a.end_time, a.created_by,
            CASE WHEN $2::timestamptz < a.start_time THEN 'upcoming'
                 WHEN $2::timestamptz < a.end_time   THEN 'live'
                 ELSE 'ended' END AS state,
            (SELECT count(*) FROM bids WHERE auction_id = a.id AND status = 'accepted') AS accepted_bids,
            top.id AS top_bid_id, top.user_id AS top_bid_user_id,
            top.amount AS top_bid_amount, top.created_at AS top_bid_created_at
       FROM auctions a
       LEFT JOIN LATERAL (
         SELECT id, user_id, amount, created_at FROM bids
          WHERE auction_id = a.id AND status = 'accepted'
          ORDER BY amount DESC
          LIMIT 1
       ) top ON true
      WHERE a.id = $1`,
    [id, now],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    min_amount: row.min_amount,
    start_time: row.start_time.toISOString(),
    end_time: row.end_time.toISOString(),
    created_by: Number(row.created_by),
    state: row.state,
    accepted_bids: Number(row.accepted_bids),
    // Once state is "ended", this is the winning bid.
    top_bid: row.top_bid_id
      ? {
          id: Number(row.top_bid_id),
          user_id: Number(row.top_bid_user_id),
          amount: row.top_bid_amount,
          created_at: row.top_bid_created_at!.toISOString(),
        }
      : null,
  };
}
