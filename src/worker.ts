// Background jobs: photo reading and customer notifications.
// Run with `npm run worker` (production) — several workers may run side by side.
import { pathToFileURL } from 'node:url';
import { runOne, type Handler, type JobType } from './lib/jobs.js';
import { deliver } from './services/notify/index.js';
import { readPhotos } from './services/reader.js';
import { closeDb } from './db.js';
import { reconcile } from './services/reconcile.js';
import { config } from './config.js';

type Log = { info: (m: any, ...a: any[]) => void; error: (m: any, ...a: any[]) => void };

export const handlers = (log: Log): Partial<Record<JobType, Handler>> => ({
  read_photos: p => readPhotos(p, m => log.info(m)),
  notify: p => deliver(p, m => log.info(m)),
});

export function startWorker(log: Log, idleMs = 1000) {
  let stopped = false;
  const h = handlers(log);
  let nextCheck = Date.now() + 5_000;
  const loop = (async () => {
    while (!stopped) {
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + config().RECONCILE_SECONDS * 1000;
        try { await reconcile(m => log.info(m)); } catch (e) { log.error(e); }
      }
      try { if (await runOne(h)) continue; } catch (e) { log.error(e); }
      await new Promise(r => setTimeout(r, idleMs));
    }
  })();
  return async () => { stopped = true; await loop; };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const log: Log = { info: (m) => console.log(new Date().toISOString(), typeof m === 'string' ? m : JSON.stringify(m)), error: (m) => console.error(new Date().toISOString(), m) };
  const stop = startWorker(log);
  log.info('worker started');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => { await stop(); await closeDb(); process.exit(0); });
}
