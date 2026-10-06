// Background safety net, run by the worker every minute (one worker at a time, via a Postgres
// advisory lock). It catches whatever a lost webhook or a closed browser tab would otherwise miss.
import { one, q, db } from '../db.js';
import { config } from '../config.js';
import { checkAttempt, inr } from '../lib/orders.js';
import { syncRefund } from '../lib/refunds.js';
import { enqueue } from '../lib/jobs.js';

const LOCK = 727_001;

export async function reconcile(log: (m: string) => void = () => {}) {
  const c = await db().connect();
  try {
    const got = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
    if (!got.rows[0].ok) return { skipped: true };
    try { return await run(log); }
    finally { await c.query('SELECT pg_advisory_unlock($1)', [LOCK]); }
  } finally { c.release(); }
}

async function run(log: (m: string) => void) {
  const out = { attempts: 0, refunds: 0, expired: 0, stuckReads: 0 };
  const cfg = config();

  // 1. Payment attempts still open: ask the gateway (payment made but webhook lost, customer closed the tab,
  //    a second payment on an order already paid, a payment after cancelling…). Newer attempts are checked more often.
  const attempts = await q(`SELECT * FROM payment_attempts WHERE status = 'open' AND provider <> 'manual'
      AND created_at < now() - interval '2 minutes' AND created_at > now() - interval '7 days'
      AND (last_checked_at IS NULL OR last_checked_at < now() - CASE WHEN created_at > now() - interval '1 hour' THEN interval '3 minutes'
                                                                     WHEN created_at > now() - interval '1 day' THEN interval '20 minutes' ELSE interval '3 hours' END)
      ORDER BY created_at DESC LIMIT 50`);
  for (const a of attempts) {
    try { await checkAttempt(a); out.attempts++; } catch (e) { log(`payment check failed for ${a.provider_order_id}: ${(e as Error).message}`); await q('UPDATE payment_attempts SET last_checked_at = now() WHERE id = $1', [a.id]); }
  }
  // Attempts older than a week can no longer be paid on Cashfree; stop checking them.
  await q(`UPDATE payment_attempts SET status = 'closed' WHERE status = 'open' AND created_at < now() - interval '7 days'`);

  // 2. Refunds waiting on the gateway (pending at the bank, or never acknowledged because the gateway was down).
  const refunds = await q(`SELECT * FROM refunds WHERE status = 'pending' AND provider <> 'manual'
      AND (last_checked_at IS NULL OR last_checked_at < now() - CASE WHEN created_at > now() - interval '1 day' THEN interval '5 minutes' ELSE interval '1 hour' END)
      ORDER BY created_at LIMIT 50`);
  for (const r of refunds) { await syncRefund(r); out.refunds++; }
  // A refund pending for over 10 days needs a person.
  const late = await q(`SELECT r.*, o.number FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.status = 'pending' AND r.created_at < now() - interval '10 days'
      AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'refund_late' AND a.meta->>'refund' = r.id::text)`);
  for (const r of late) {
    await q(`INSERT INTO audit_log(action, meta) VALUES ('refund_late', $1)`, [{ refund: r.id, number: r.number }]);
    await enqueue('notify', { template: 'team_alert', orderId: r.order_id, data: { number: r.number, kind: 'refund_late', detail: `A refund of ${inr(r.amount_paise)} has been pending for over 10 days. Check it in the Cashfree dashboard.` } });
  }

  // 3. Orders never paid: close them after UNPAID_EXPIRY_DAYS (after one last check with the gateway above).
  const stale = await q(`SELECT o.* FROM orders o WHERE o.status IN ('pending_payment','failed') AND o.created_at < now() - ($1 || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.order_id = o.id AND a.status = 'open' AND (a.last_checked_at IS NULL OR a.last_checked_at < now() - interval '10 minutes') AND a.provider <> 'manual')
      LIMIT 50`, [String(cfg.UNPAID_EXPIRY_DAYS)]);
  for (const o of stale) {
    const r = await one(`UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment was not completed', updated_at = now()
                         WHERE id = $1 AND status IN ('pending_payment','failed') RETURNING id`, [o.id]);
    if (!r) continue;
    await q(`INSERT INTO audit_log(action, meta) VALUES ('order_expired', $1)`, [{ number: o.number }]);
    await enqueue('notify', { template: 'order_cancelled', userId: o.user_id, orderId: o.id, data: { number: o.number, reason: 'We closed it because payment wasn’t completed. You can order again any time.' } });
    out.expired++;
  }

  // 4. Photo reading that stopped part-way (the worker restarted, the AI kept failing…).
  const stuck = await q(`UPDATE books b SET read_status = 'failed', read_error = 'Reading stopped part-way. Tap “Read again” to finish.'
      WHERE read_status IN ('queued','running') AND COALESCE(read_started_at, created_at) < now() - interval '30 minutes'
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'read_photos' AND j.payload->>'bookId' = b.id::text AND j.done_at IS NULL AND j.attempts < j.max_attempts)
      RETURNING id`);
  out.stuckReads = stuck.length;
  if (out.attempts || out.refunds || out.expired || out.stuckReads) log(`reconcile: ${JSON.stringify(out)}`);
  return out;
}
