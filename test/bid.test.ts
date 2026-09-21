import request from 'supertest';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bidsFor, createAuction, createTestPool, createUser, resetDatabase } from './helpers.js';

let pool: Pool;
let app: ReturnType<typeof createApp>;
let seller: number;
let bob: number;
let carol: number;
let auction: number;

beforeAll(() => {
  pool = createTestPool();
  app = createApp({ pool });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase(pool);
  seller = await createUser(pool, 'seller');
  bob = await createUser(pool, 'bob');
  carol = await createUser(pool, 'carol');
  auction = await createAuction(pool, { sellerId: seller, minAmount: '100.00' });
});

const bid = (body: object, target = app) => request(target).post('/bid').send(body);

describe('placing bids', () => {
  it('accepts a first bid equal to min_amount', async () => {
    const res = await bid({ auction_id: auction, user_id: bob, amount: 100 });
    expect(res.status).toBe(201);
    expect(res.body.bid).toMatchObject({ amount: '100.00', status: 'accepted', user_id: bob });
    expect(res.body.replayed).toBe(false);
  });

  it('rejects a first bid below min_amount and stores the attempt', async () => {
    const res = await bid({ auction_id: auction, user_id: bob, amount: '99.99' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BELOW_MIN_AMOUNT');
    expect(res.body.min_amount).toBe('100.00');
    expect(await bidsFor(pool, auction)).toMatchObject([{ status: 'rejected', amount: '99.99' }]);
  });

  it('accepts only strictly higher bids', async () => {
    expect((await bid({ auction_id: auction, user_id: bob, amount: 150 })).status).toBe(201);

    const equal = await bid({ auction_id: auction, user_id: carol, amount: '150.00' });
    expect(equal.status).toBe(409);
    expect(equal.body.error.code).toBe('BID_NOT_HIGHER');
    expect(equal.body.current_top_amount).toBe('150.00');

    const lower = await bid({ auction_id: auction, user_id: carol, amount: 149.99 });
    expect(lower.body.error.code).toBe('BID_NOT_HIGHER');

    const higher = await bid({ auction_id: auction, user_id: carol, amount: 150.01 });
    expect(higher.status).toBe(201);

    const state = await request(app).get(`/auctions/${auction}`);
    expect(state.body.top_bid).toMatchObject({ user_id: carol, amount: '150.01' });
  });

  it('lets the current top bidder raise their own bid and flags it', async () => {
    await bid({ auction_id: auction, user_id: bob, amount: 100 });
    const res = await bid({ auction_id: auction, user_id: bob, amount: 110 });
    expect(res.status).toBe(201);
    expect(res.body.raised_own_top_bid).toBe(true);
  });

  it('stops the seller from bidding on their own auction', async () => {
    const res = await bid({ auction_id: auction, user_id: seller, amount: 500 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELLER_CANNOT_BID');
  });

  it('returns 404 for an unknown auction or user', async () => {
    const noAuction = await bid({ auction_id: 999, user_id: bob, amount: 200 });
    expect(noAuction.status).toBe(404);
    expect(noAuction.body.error.code).toBe('AUCTION_NOT_FOUND');

    const noUser = await bid({ auction_id: auction, user_id: 999, amount: 200 });
    expect(noUser.status).toBe(404);
    expect(noUser.body.error.code).toBe('USER_NOT_FOUND');
  });

  it.each([
    ['missing amount', { auction_id: 1, user_id: 2 }],
    ['text amount', { auction_id: 1, user_id: 2, amount: 'abc' }],
    ['negative amount', { auction_id: 1, user_id: 2, amount: -5 }],
    ['zero amount', { auction_id: 1, user_id: 2, amount: '0.00' }],
    ['three decimals', { auction_id: 1, user_id: 2, amount: 100.999 }],
    ['float artefact', { auction_id: 1, user_id: 2, amount: 0.1 + 0.2 }],
    ['exponent', { auction_id: 1, user_id: 2, amount: 1e21 }],
    ['too many digits', { auction_id: 1, user_id: 2, amount: '1000000000000.00' }],
    ['null auction_id', { auction_id: null, user_id: 2, amount: 100 }],
    ['string user_id', { auction_id: 1, user_id: '2', amount: 100 }],
    ['fractional id', { auction_id: 1.5, user_id: 2, amount: 100 }],
  ])('rejects invalid input: %s', async (_name, body) => {
    const res = await bid(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed JSON', async () => {
    const res = await request(app).post('/bid').set('Content-Type', 'application/json').send('{"amount":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('auction close boundary', () => {
  const START = '2030-01-01T10:00:00.000000Z';
  const END = '2030-01-01T12:00:00.000000Z';

  function appAt(now: string) {
    return createApp({ pool, clock: async () => now });
  }

  beforeEach(async () => {
    auction = await createAuction(pool, { sellerId: seller, startTime: START, endTime: END });
  });

  it('rejects a bid landing exactly on end_time', async () => {
    const res = await bid({ auction_id: auction, user_id: bob, amount: 100 }, appAt(END));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUCTION_ENDED');
  });

  it('accepts a bid one microsecond before end_time', async () => {
    const res = await bid({ auction_id: auction, user_id: bob, amount: 100 }, appAt('2030-01-01T11:59:59.999999Z'));
    expect(res.status).toBe(201);
  });

  it('accepts a bid exactly on start_time and rejects one a microsecond earlier', async () => {
    const early = await bid({ auction_id: auction, user_id: bob, amount: 100 }, appAt('2030-01-01T09:59:59.999999Z'));
    expect(early.body.error.code).toBe('AUCTION_NOT_STARTED');

    const onTime = await bid({ auction_id: auction, user_id: bob, amount: 100 }, appAt(START));
    expect(onTime.status).toBe(201);
  });

  it('stamps the bid with the same instant used for the decision', async () => {
    const res = await bid({ auction_id: auction, user_id: bob, amount: 100 }, appAt('2030-01-01T11:00:00.000000Z'));
    expect(res.body.bid.created_at).toBe('2030-01-01T11:00:00.000Z');
  });
});

describe('duplicate requests', () => {
  it('replays an accepted bid instead of placing it twice', async () => {
    const first = await bid({ auction_id: auction, user_id: bob, amount: 150 });
    const retry = await bid({ auction_id: auction, user_id: bob, amount: '150.00' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toMatchObject({ replayed: true, bid: { id: first.body.bid.id } });
    expect(await bidsFor(pool, auction)).toHaveLength(1);
  });

  it('replays the original bid even after someone outbid it', async () => {
    const first = await bid({ auction_id: auction, user_id: bob, amount: 150 });
    await bid({ auction_id: auction, user_id: carol, amount: 200 });

    const retry = await bid({ auction_id: auction, user_id: bob, amount: 150 });
    expect(retry.status).toBe(200);
    expect(retry.body.bid.id).toBe(first.body.bid.id);
  });

  it('replays an accepted bid when the retry arrives after the close', async () => {
    const END = '2030-01-01T12:00:00.000000Z';
    const closing = await createAuction(pool, {
      sellerId: seller,
      startTime: '2030-01-01T10:00:00Z',
      endTime: END,
    });
    let now = '2030-01-01T11:59:59Z';
    const clockApp = createApp({ pool, clock: async () => now });

    const first = await bid({ auction_id: closing, user_id: bob, amount: 150 }, clockApp);
    expect(first.status).toBe(201);

    now = '2030-01-01T12:00:05Z';
    const retry = await bid({ auction_id: closing, user_id: bob, amount: 150 }, clockApp);
    expect(retry.status).toBe(200);
    expect(retry.body.bid.id).toBe(first.body.bid.id);
  });

  it('evaluates a rejected bid again on retry', async () => {
    const later = await createAuction(pool, {
      sellerId: seller,
      startTime: '2030-01-01T10:00:00Z',
      endTime: '2030-01-01T12:00:00Z',
    });
    let now = '2030-01-01T09:59:00Z';
    const clockApp = createApp({ pool, clock: async () => now });

    const early = await bid({ auction_id: later, user_id: bob, amount: 150 }, clockApp);
    expect(early.body.error.code).toBe('AUCTION_NOT_STARTED');

    now = '2030-01-01T10:01:00Z';
    const retry = await bid({ auction_id: later, user_id: bob, amount: 150 }, clockApp);
    expect(retry.status).toBe(201);
    expect((await bidsFor(pool, later)).map((b) => b.status)).toEqual(['rejected', 'accepted']);
  });

  it('places one bid when the same request arrives 10 times at once', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => bid({ auction_id: auction, user_id: bob, amount: 175 })),
    );

    const created = responses.filter((r) => r.status === 201);
    const replayed = responses.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(9);
    expect(new Set(responses.map((r) => r.body.bid.id)).size).toBe(1);
    expect(await bidsFor(pool, auction)).toHaveLength(1);
  });
});

describe('concurrent bidding', () => {
  it('accepts exactly one of 20 simultaneous equal bids', async () => {
    const users = await Promise.all(Array.from({ length: 20 }, (_, i) => createUser(pool, `racer-${i}`)));
    const responses = await Promise.all(
      users.map((userId) => bid({ auction_id: auction, user_id: userId, amount: 250 })),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.body.error?.code === 'BID_NOT_HIGHER')).toHaveLength(19);
  });

  it('keeps accepted amounts strictly increasing under a burst of different bids', async () => {
    const users = await Promise.all(Array.from({ length: 30 }, (_, i) => createUser(pool, `burst-${i}`)));
    const amounts = users.map((_, i) => (100 + ((i * 37) % 30) * 10).toFixed(2));
    await Promise.all(users.map((userId, i) => bid({ auction_id: auction, user_id: userId, amount: amounts[i] })));

    const accepted = (await bidsFor(pool, auction)).filter((b) => b.status === 'accepted');
    const acceptedAmounts = accepted.map((b) => Number(b.amount));
    for (let i = 1; i < acceptedAmounts.length; i++) {
      expect(acceptedAmounts[i]).toBeGreaterThan(acceptedAmounts[i - 1]!);
    }

    const top = await request(app).get(`/auctions/${auction}`);
    expect(top.body.top_bid.amount).toBe(Math.max(...amounts.map(Number)).toFixed(2));
  });

  it('has a database backstop against two accepted bids with the same amount', async () => {
    const insert = `INSERT INTO bids (auction_id, user_id, amount, status, created_at)
                    VALUES ($1, $2, 300, 'accepted', now())`;
    await pool.query(insert, [auction, bob]);
    await expect(pool.query(insert, [auction, carol])).rejects.toMatchObject({ code: '23505' });
  });
});
