import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { createPool } from '../src/db.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const urls = process.argv.includes('--test') ? [config.testDatabaseUrl] : [config.databaseUrl];

for (const url of urls) {
  const pool = createPool(url);
  await pool.query(schema);
  await pool.end();
  console.log(`Schema applied to ${new URL(url).pathname.slice(1)}`);
}
