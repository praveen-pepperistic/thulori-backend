// A small durable job queue on PostgreSQL. Producers call enqueue() (optionally inside a
// transaction so the job only exists if the change commits). The worker claims jobs with
// FOR UPDATE SKIP LOCKED, so several workers can run safely side by side.
import { hostname } from 'node:os';
import { db, q, type Queryable } from '../db.js';

export type JobType = 'read_photos' | 'notify';

export async function enqueue(type: JobType, payload: object, opts: { runAt?: Date; maxAttempts?: number } = {}, client: Queryable = db()) {
  await q('INSERT INTO jobs(type, payload, run_at, max_attempts) VALUES ($1,$2,$3,$4)',
    [type, payload, opts.runAt ?? new Date(), opts.maxAttempts ?? 5], client);
}

export type Handler = (payload: any) => Promise<void>;

const WORKER_ID = `${hostname()}:${process.pid}`;

/** Claims and runs one job. Returns false when the queue is empty. */
export async function runOne(handlers: Partial<Record<JobType, Handler>>): Promise<boolean> {
  const c = await db().connect();
  let job: any;
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `SELECT * FROM jobs WHERE done_at IS NULL AND run_at <= now() AND attempts < max_attempts
         AND (locked_at IS NULL OR locked_at < now() - interval '10 minutes')
       ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    job = r.rows[0];
    if (!job) { await c.query('COMMIT'); return false; }
    await c.query('UPDATE jobs SET locked_at = now(), locked_by = $2, attempts = attempts + 1 WHERE id = $1', [job.id, WORKER_ID]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }

  const handler = handlers[job.type as JobType];
  try {
    if (!handler) throw new Error(`no handler for ${job.type}`);
    await handler(job.payload);
    await q('UPDATE jobs SET done_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1', [job.id]);
  } catch (e) {
    const attempts = job.attempts + 1;
    const backoff = Math.min(60 * 60, 15 * 2 ** attempts); // 30s, 60s, 2m … capped at 1h
    await q(`UPDATE jobs SET locked_at = NULL, last_error = $2, run_at = now() + ($3 || ' seconds')::interval WHERE id = $1`,
      [job.id, String((e as Error).stack || e).slice(0, 4000), String(backoff)]);
  }
  return true;
}

/** Drains the queue (used by tests and by the in-process worker in development). */
export async function drain(handlers: Partial<Record<JobType, Handler>>, max = 100) {
  for (let i = 0; i < max; i++) if (!(await runOne(handlers))) return;
}
