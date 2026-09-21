import { createApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';

const pool = createPool(config.databaseUrl);
const app = createApp({ pool });

const server = app.listen(config.port, () => {
  console.log(`Auction service listening on http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
