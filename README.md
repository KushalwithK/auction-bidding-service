# Auction bidding service

**Assignment ID:** `v#hdf38%44`

A small Express + TypeScript service with one job: take bids on auctions through `POST /bid` and keep the top bid unambiguous, even when many bids land at once. PostgreSQL stores everything, and a row lock on the auction makes bids on the same auction go one at a time.

## Stack

- Node.js 20+ with TypeScript
- Express 5
- PostgreSQL 17 through `pg`
- Zod for request validation
- Vitest + Supertest for tests (they run against a real Postgres, not mocks)

## Running it

You need Node 20+ and Docker.

```bash
npm install
docker compose up -d        # Postgres on localhost:5433, creates `auction` and `auction_test`
npm run db:migrate          # applies db/schema.sql
npm run db:seed             # 4 users, 4 auctions (see below)
npm run dev                 # http://localhost:3000
```

Using your own Postgres instead of Docker? Create two databases and point the app at them in a `.env` file (see `.env.example`):

```bash
createdb auction && createdb auction_test
echo "DATABASE_URL=postgresql://localhost/auction" >> .env
echo "TEST_DATABASE_URL=postgresql://localhost/auction_test" >> .env
```

### Seed data

User 1 is the seller of every auction. Users 2, 3 and 4 can bid.

| Auction | State after seeding | Min amount |
|---|---|---|
| 1 | live, ends in 7 days | 100.00 |
| 2 | upcoming, starts tomorrow | 50.00 |
| 3 | ended an hour ago | 500.00 |
| 4 | live, ends 2 minutes after seeding | 75.00 |

Auction 4 lets you try bidding before and after a real close.

### Tests

```bash
npm run db:migrate -- --test   # optional, the tests apply the schema themselves
npm test
```

The suite has 30 tests. They cover the bid rules, the exact close instant (down to the microsecond), duplicate requests, and races: 20 users bidding the same amount at once, 30 users firing different amounts at once, and 10 copies of one request arriving together.

## API

### `POST /bid`

```bash
curl -X POST localhost:3000/bid \
  -H 'Content-Type: application/json' \
  -d '{"auction_id": 1, "user_id": 2, "amount": 150}'
```

| Field | Type | Rules |
|---|---|---|
| `auction_id` | integer | positive |
| `user_id` | integer | positive |
| `amount` | number or string | greater than 0, at most 2 decimal places, at most 12 digits before the point |

The service returns amounts as strings (`"150.00"`) so no client parses money into a float by accident.

**Responses**

| Status | When | Body |
|---|---|---|
| `201` | Bid accepted | `{ replayed: false, raised_own_top_bid, bid }` |
| `200` | Same user already has an accepted bid for this amount on this auction (a retry). Nothing new is written. Header `Idempotent-Replayed: true`. | `{ replayed: true, bid }` |
| `400` | Invalid body or malformed JSON | `{ error: { code: "VALIDATION_ERROR" \| "INVALID_JSON", ... } }` |
| `403` | The seller tried to bid on their own auction | `{ error: { code: "SELLER_CANNOT_BID" }, ... }` |
| `404` | Auction or user does not exist | `{ error: { code: "AUCTION_NOT_FOUND" \| "USER_NOT_FOUND" } }` |
| `409` | Bid lost against the auction's rules or state | `{ error: { code }, current_top_amount, min_amount, bid }` |

`409` codes: `AUCTION_NOT_STARTED`, `AUCTION_ENDED`, `BELOW_MIN_AMOUNT`, `BID_NOT_HIGHER`.

The service stores rejected bids too (`status: "rejected"` plus a reason), so every attempt that reached a real auction has a row and an id.

Example accepted response:

```json
{
  "replayed": false,
  "raised_own_top_bid": false,
  "bid": {
    "id": 1,
    "auction_id": 1,
    "user_id": 2,
    "amount": "150.00",
    "status": "accepted",
    "rejection_reason": null,
    "created_at": "2026-09-21T10:55:23.825Z"
  }
}
```

### `GET /auctions/:id`

Returns the auction, its state (`upcoming`, `live` or `ended`), the accepted bid count and the current top bid. Once the state reads `ended`, the top bid is the winner.

### `GET /health`

Returns `{ "status": "ok" }`.

## Data model

The full schema lives in [`db/schema.sql`](db/schema.sql). It has three tables:

- `users`
- `auctions`: what's being sold (`entity_type`, `entity_id`), `min_amount`, `start_time`, `end_time`, and audit columns
- `bids`: an append-only log of every attempt, with `status` (`accepted` / `rejected`) and `rejection_reason`

Constraints the database enforces on its own:

- foreign keys from bids to auctions and users, and from auctions to users
- `min_amount > 0`, `amount > 0`, `end_time > start_time`
- a rejected bid must carry a reason, and an accepted bid must not
- a partial unique index on `(auction_id, amount) WHERE status = 'accepted'`, so two accepted bids on one auction can never tie

## Project layout

```
db/schema.sql         tables, constraints, indexes
src/app.ts            routes, response mapping, error handler
src/bids.ts           the bid transaction (lock, replay check, rules, insert)
src/auctions.ts       GET /auctions/:id
src/clock.ts          the database clock used for every time decision
src/validation.ts     Zod schemas
scripts/              migrate and seed
test/                 integration tests against Postgres
```

## Written answers

### 1. Data model and why I structured it this way

TODO

### 2. How I handled the auction-close boundary

So a bid is only accepted in the open window (start_time <= current_time < end_time), the db clock is used and all the comparison + commit is done in db never in javascript, it has one trade-off though, a bid that arrives at exactly 1ms earlier than end_time but evaluates at or after the end_time is rejected

### 3. How I handled a request to place a new bid, and why

Request starts with Zod validation which validates all the params, body and fields, then inside a single transaction we lock the auction row, bid on the same auction wait in line, validates if the user exist, auction exist and all, check if the user have same bid for the same auction if yes then 200 with same response, then read the db clock as lock is held now, check for everything like end_time, amount, etc, apply the rules and return the response.

### 4. A user bidding on their own current top bid: what I decided and why

A user can override their own bidding, firstly this reduces complication and let user increase their chance of winning by outbidding themselves, this is a very subjective thing and allowing or not both can be work

### 5. One part of this assignment that is wrong, underspecified, or would cause a problem in production

In production we normally have read-replicas or at least a cache, reading and writing bids in a high traffic environment will cause consistency and reliability problems, for production all the bids data can be stored in cache for a auction and be taken as source of truth, persistent db can sync behind, this will allow us to consistently pick the correct bid, apart from that one issue which we solved here was money comparison issue, if we rely on NUMERIC column and compare things in javascript floating number precisions can cause issues in production data, comparing it in database makes more sense here.
