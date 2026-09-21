import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import type { ZodError } from 'zod';
import { getAuction } from './auctions.js';
import { placeBid, type RejectionReason } from './bids.js';
import { databaseClock, type Clock } from './clock.js';
import { HttpError } from './errors.js';
import { bidRequestSchema, idSchema } from './validation.js';

const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  SELLER_CANNOT_BID: 'Sellers cannot bid on their own auction',
  AUCTION_NOT_STARTED: 'This auction has not started yet',
  AUCTION_ENDED: 'This auction has ended',
  BELOW_MIN_AMOUNT: 'Bid is below the minimum amount for this auction',
  BID_NOT_HIGHER: 'Bid must be strictly higher than the current top bid',
};

export function createApp({ pool, clock = databaseClock }: { pool: Pool; clock?: Clock }) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/bid', async (req, res) => {
    const parsed = bidRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }

    const result = await placeBid(pool, clock, parsed.data);

    if (result.outcome === 'accepted') {
      res.status(201).json({
        replayed: false,
        raised_own_top_bid: result.raisedOwnTopBid,
        bid: result.bid,
      });
      return;
    }

    if (result.outcome === 'replayed') {
      res.status(200).set('Idempotent-Replayed', 'true').json({ replayed: true, bid: result.bid });
      return;
    }

    const reason = result.bid.rejection_reason!;
    res.status(reason === 'SELLER_CANNOT_BID' ? 403 : 409).json({
      error: { code: reason, message: REJECTION_MESSAGES[reason] },
      current_top_amount: result.currentTopAmount,
      min_amount: result.minAmount,
      bid: result.bid,
    });
  });

  app.get('/auctions/:id', async (req, res) => {
    const id = idSchema.safeParse(Number(req.params.id));
    if (!id.success) {
      res.status(400).json(validationError(id.error));
      return;
    }
    const auction = await getAuction(pool, clock, id.data);
    if (!auction) {
      throw new HttpError(404, 'AUCTION_NOT_FOUND', `Auction ${id.data} does not exist`);
    }
    res.json(auction);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use(errorHandler);
  return app;
}

function validationError(error: ZodError) {
  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request is invalid',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  };
}

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
    return;
  }
  // The row lock should make this unreachable. If the unique index ever fires,
  // the invariant still held, so answer like any other losing bid and log it.
  if (err?.code === '23505' && err?.constraint === 'bids_one_accepted_per_amount') {
    console.error('Unique index caught a duplicate accepted amount', err);
    res.status(409).json({ error: { code: 'BID_NOT_HIGHER', message: REJECTION_MESSAGES.BID_NOT_HIGHER } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
