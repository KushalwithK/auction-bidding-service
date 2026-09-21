import { config } from '../src/config.js';
import { createPool } from '../src/db.js';

const pool = createPool(config.databaseUrl);

await pool.query('TRUNCATE bids, auctions, users RESTART IDENTITY CASCADE');
await pool.query(`INSERT INTO users (name) VALUES ('Asha (seller)'), ('Bilal'), ('Chen'), ('Diya')`);

// Seller is user 1. Users 2 to 4 are bidders.
await pool.query(`
  INSERT INTO auctions (entity_type, entity_id, min_amount, start_time, end_time, created_by) VALUES
    ('car',   'honda-city-2019',  100.00, now() - interval '1 hour', now() + interval '7 days',  1),
    ('bike',  'royal-enfield-350', 50.00, now() + interval '1 day',  now() + interval '8 days',  1),
    ('house', 'flat-4b-pune',     500.00, now() - interval '2 days', now() - interval '1 hour',  1),
    ('truck', 'tata-407',          75.00, now() - interval '1 hour', now() + interval '2 minutes', 1)
`);

console.log(`Seeded users 1-4 (1 is the seller) and auctions:
  1  live, ends in 7 days, min 100.00
  2  upcoming, starts tomorrow
  3  ended an hour ago
  4  live, ends 2 minutes after seeding (try bidding across the close)`);

await pool.end();
