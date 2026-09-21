import type { Pool, PoolClient } from 'pg';
import type { Clock } from './clock.js';
import { HttpError } from './errors.js';
import type { BidRequest } from './validation.js';

export type RejectionReason =
  | 'SELLER_CANNOT_BID'
  | 'AUCTION_NOT_STARTED'
  | 'AUCTION_ENDED'
  | 'BELOW_MIN_AMOUNT'
  | 'BID_NOT_HIGHER';

export interface Bid {
  id: number;
  auction_id: number;
  user_id: number;
  amount: string;
  status: 'accepted' | 'rejected';
  rejection_reason: RejectionReason | null;
  created_at: string;
}

export type PlaceBidResult =
  | { outcome: 'accepted'; bid: Bid; raisedOwnTopBid: boolean }
  | { outcome: 'replayed'; bid: Bid }
  | { outcome: 'rejected'; bid: Bid; currentTopAmount: string | null; minAmount: string };

interface BidRow {
  id: string;
  auction_id: string;
  user_id: string;
  amount: string;
  status: Bid['status'];
  rejection_reason: RejectionReason | null;
  created_at: Date;
}

interface CheckRow {
  min_amount: string;
  top_amount: string | null;
  top_user_id: string | null;
  not_started: boolean;
  ended: boolean;
  below_min: boolean;
  not_higher: boolean;
}

const BID_COLUMNS = 'id, auction_id, user_id, amount, status, rejection_reason, created_at';

export function toBid(row: BidRow): Bid {
  return {
    id: Number(row.id),
    auction_id: Number(row.auction_id),
    user_id: Number(row.user_id),
    amount: row.amount,
    status: row.status,
    rejection_reason: row.rejection_reason,
    created_at: row.created_at.toISOString(),
  };
}

export async function placeBid(pool: Pool, clock: Clock, request: BidRequest): Promise<PlaceBidResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await placeBidLocked(client, clock, request);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function placeBidLocked(
  client: PoolClient,
  clock: Clock,
  { auction_id: auctionId, user_id: userId, amount }: BidRequest,
): Promise<PlaceBidResult> {
  // Every bid on this auction queues on this row lock until the one ahead of
  // it commits. Between here and COMMIT nobody else can touch this auction's bids.
  const auctionResult = await client.query<{ created_by: string }>(
    'SELECT created_by FROM auctions WHERE id = $1 FOR UPDATE',
    [auctionId],
  );
  const auction = auctionResult.rows[0];
  if (!auction) {
    throw new HttpError(404, 'AUCTION_NOT_FOUND', `Auction ${auctionId} does not exist`);
  }

  const userResult = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (userResult.rowCount === 0) {
    throw new HttpError(404, 'USER_NOT_FOUND', `User ${userId} does not exist`);
  }

  // Retry of a bid we already accepted: hand back the original, place nothing.
  // Accepted amounts rise strictly per auction, so at most one row can match.
  const previous = await client.query<BidRow>(
    `SELECT ${BID_COLUMNS} FROM bids
      WHERE auction_id = $1 AND user_id = $2 AND amount = $3::numeric AND status = 'accepted'`,
    [auctionId, userId, amount],
  );
  if (previous.rows[0]) {
    return { outcome: 'replayed', bid: toBid(previous.rows[0]) };
  }

  // Read the clock after taking the lock, so the timestamp marks the moment
  // this bid got evaluated, not the moment it started waiting.
  const now = await clock(client);

  const checkResult = await client.query<CheckRow>(
    `SELECT a.min_amount,
            top.amount  AS top_amount,
            top.user_id AS top_user_id,
            $2::timestamptz <  a.start_time AS not_started,
            $2::timestamptz >= a.end_time   AS ended,
            $3::numeric < a.min_amount      AS below_min,
            (top.amount IS NOT NULL AND $3::numeric <= top.amount) AS not_higher
       FROM auctions a
       LEFT JOIN LATERAL (
         SELECT amount, user_id FROM bids
          WHERE auction_id = a.id AND status = 'accepted'
          ORDER BY amount DESC
          LIMIT 1
       ) top ON true
      WHERE a.id = $1`,
    [auctionId, now, amount],
  );
  const check = checkResult.rows[0]!;
  const reason = rejectionReason(check, auction.created_by === String(userId));

  const inserted = await client.query<BidRow>(
    `INSERT INTO bids (auction_id, user_id, amount, status, rejection_reason, created_at)
     VALUES ($1, $2, $3::numeric, $4, $5, $6::timestamptz)
     RETURNING ${BID_COLUMNS}`,
    [auctionId, userId, amount, reason ? 'rejected' : 'accepted', reason, now],
  );
  const bid = toBid(inserted.rows[0]!);

  if (reason) {
    return { outcome: 'rejected', bid, currentTopAmount: check.top_amount, minAmount: check.min_amount };
  }
  return { outcome: 'accepted', bid, raisedOwnTopBid: check.top_user_id === String(userId) };
}

function rejectionReason(check: CheckRow, isSeller: boolean): RejectionReason | null {
  if (isSeller) return 'SELLER_CANNOT_BID';
  if (check.not_started) return 'AUCTION_NOT_STARTED';
  if (check.ended) return 'AUCTION_ENDED';
  if (check.below_min) return 'BELOW_MIN_AMOUNT';
  if (check.not_higher) return 'BID_NOT_HIGHER';
  return null;
}
