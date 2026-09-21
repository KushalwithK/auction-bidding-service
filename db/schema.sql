-- Money is NUMERIC(14,2): exact decimal, two places, single currency.
-- Postgres does every amount comparison, so JavaScript floats never touch money.

CREATE TABLE IF NOT EXISTS users (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auctions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- What is being sold (a car, a bike, a house). Polymorphic, so no foreign key.
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  min_amount   NUMERIC(14, 2) NOT NULL CHECK (min_amount > 0),
  -- The auction is open for start_time <= t < end_time. No status column:
  -- these two timestamps are the only source of truth for open/closed.
  start_time   TIMESTAMPTZ NOT NULL,
  end_time     TIMESTAMPTZ NOT NULL,
  created_by   BIGINT NOT NULL REFERENCES users (id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT REFERENCES users (id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auction_window_valid CHECK (end_time > start_time)
);

-- Append-only log of every bid attempt that reached a real auction,
-- accepted or rejected. The current top bid is the highest accepted row.
CREATE TABLE IF NOT EXISTS bids (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auction_id        BIGINT NOT NULL REFERENCES auctions (id),
  user_id           BIGINT NOT NULL REFERENCES users (id),
  amount            NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  status            TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  rejection_reason  TEXT CHECK (rejection_reason IN (
                      'SELLER_CANNOT_BID',
                      'AUCTION_NOT_STARTED',
                      'AUCTION_ENDED',
                      'BELOW_MIN_AMOUNT',
                      'BID_NOT_HIGHER'
                    )),
  -- Database clock at the moment the bid was evaluated under the auction lock.
  created_at        TIMESTAMPTZ NOT NULL,
  CONSTRAINT rejection_reason_matches_status
    CHECK ((status = 'accepted') = (rejection_reason IS NULL))
);

-- Backstop: two accepted bids on one auction can never share an amount,
-- so the top bid can never be a tie. Also serves the top-bid lookup.
CREATE UNIQUE INDEX IF NOT EXISTS bids_one_accepted_per_amount
  ON bids (auction_id, amount DESC)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS bids_auction_created
  ON bids (auction_id, created_at);
