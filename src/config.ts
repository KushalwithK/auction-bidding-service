import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

// Defaults match docker-compose.yml. Override with env vars or a .env file.
export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/auction',
  testDatabaseUrl:
    process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/auction_test',
  port: Number(process.env.PORT ?? 3000),
};
