import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { closeDb } from './db.js';
import { startWorker } from './worker.js';

const c = config();
if (process.env.MIGRATE_ON_START !== 'false') await migrate();
const app = await buildApp();
// In development the job worker runs inside the API process; in production run `npm run worker` separately.
const stopWorker = c.NODE_ENV !== 'production' && process.env.INLINE_WORKER !== 'false' ? startWorker(app.log) : null;
await app.listen({ port: c.PORT, host: c.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => {
  app.log.info(`${sig} — shutting down`);
  await stopWorker?.();
  await app.close();
  await closeDb();
  process.exit(0);
});
