// Money going back. A refund of a gateway payment is sent through the gateway, so it lands on the
// customer's original UPI / card / bank account. It starts "pending" and becomes "succeeded" or
// "failed" when the gateway says so (webhook, or the background check). Only succeeded refunds
// count in the ledger and reports. Payments taken by hand (UPI, bank, cash) are refunded by hand
// and recorded here as already succeeded.
import { one, q, tx, type Queryable } from '../db.js';
import { enqueue } from './jobs.js';
import { inr, raiseIssue } from './orders.js';
import { GatewayError, payments } from '../services/payments/index.js';
import { badRequest, conflict } from './errors.js';

const GATEWAYS = new Set(['cashfree', 'mock']);

/** Every payment on an order and how much of it can still be refunded. */
export async function refundable(orderId: string, c?: Queryable) {
  const rows = await q(`SELECT p.*, COALESCE((SELECT sum(r.amount_paise) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('pending','succeeded')), 0)::int AS taken
                        FROM payments p WHERE p.order_id = $1 AND p.kind = 'payment' ORDER BY p.at DESC`, [orderId], c);
  // Refunds recorded before refunds were linked to payments
  const loose = await one(`SELECT COALESCE(sum(amount_paise),0)::int AS n FROM refunds WHERE order_id = $1 AND payment_id IS NULL AND status IN ('pending','succeeded')`, [orderId], c);
  let unlinked = loose.n;
  return rows.map(p => {
    let left = p.amount_paise - p.taken;
    const use = Math.min(left, unlinked); left -= use; unlinked -= use;
    return { id: p.id as string, provider: p.provider as string, method: p.method as string | null, ref: p.ref as string | null, providerOrderId: p.provider_order_id as string | null, amountPaise: p.amount_paise as number, leftPaise: left, gateway: GATEWAYS.has(p.provider) && !!p.provider_order_id, at: p.at };
  });
}

export interface RefundRequest {
  amountPaise: number; reason?: string; by: string; notify?: boolean;
  paymentId?: string;                          // which payment to refund (default: newest first)
  manual?: { method: string; ref?: string };   // refund sent outside the gateway (needed for UPI/bank/cash payments)
}

/** Starts a refund. Splits across payments if needed. Returns the refund rows created. */
export async function startRefund(orderId: string, r: RefundRequest) {
  if (!(r.amountPaise > 0)) throw badRequest('Enter an amount to refund.');
  const plan = await tx(async c => {
    await q('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId], c); // one refund at a time per order
    let list = await refundable(orderId, c);
    if (r.paymentId) list = list.filter(p => p.id === r.paymentId);
    const total = list.reduce((t, p) => t + p.leftPaise, 0);
    if (r.amountPaise > total) throw badRequest(`You can refund up to ${inr(total)}${r.paymentId ? ' from that payment' : ''}.`);
    const rows: any[] = [];
    let left = r.amountPaise;
    for (const p of list) {
      if (!left) break;
      const amt = Math.min(left, p.leftPaise); if (amt <= 0) continue;
      const viaGateway = p.gateway && !r.manual;
      if (!viaGateway && !r.manual) throw badRequest(`Payment ${p.ref ?? ''} was received by ${p.method ?? 'hand'}, so it can’t go back through Cashfree. Send it yourself, then record how you refunded it.`);
      const row = await one(`INSERT INTO refunds(order_id, payment_id, provider, provider_order_id, amount_paise, status, method, reason, arn, created_by, completed_at)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [orderId, p.id, viaGateway ? p.provider : 'manual', viaGateway ? p.providerOrderId : null, amt, viaGateway ? 'pending' : 'succeeded',
         r.manual?.method ?? null, r.reason ?? null, r.manual?.ref ?? null, r.by, viaGateway ? null : new Date()], c);
      rows.push(row); left -= amt;
    }
    const o = await one('SELECT * FROM orders WHERE id = $1', [orderId], c);
    await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'refund_started',$2)`, [r.by, { number: o.number, amount: r.amountPaise, reason: r.reason, manual: !!r.manual }], c);
    for (const row of rows.filter(x => x.status === 'succeeded')) await settle(c, row, o, r.notify !== false);
    if (r.notify !== false && rows.some(x => x.status === 'pending'))
      await enqueue('notify', { template: 'refund_started', userId: o.user_id, orderId, data: { number: o.number, amount: inr(rows.filter(x => x.status === 'pending').reduce((t, x) => t + x.amount_paise, 0)) } }, {}, c);
    return rows;
  });
  // Talk to the gateway after the refund rows are safely saved.
  for (const row of plan.filter(x => x.status === 'pending')) await sendRefund(row);
  return q(`SELECT * FROM refunds WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [plan.map(x => x.id)]);
}

/** Sends (or re-sends — it's idempotent) a pending refund to the gateway. Never throws. */
export async function sendRefund(row: any) {
  try {
    const res = await payments().refund(row.provider_order_id, { refundId: row.id, amountPaise: row.amount_paise, note: row.reason || 'Thulori refund' });
    await applyRefundResult(row.id, res);
  } catch (e) {
    const msg = e instanceof GatewayError ? e.message : String((e as Error).message ?? e);
    // A clear "no" from the gateway (bad request) fails the refund; anything else is retried by the background check.
    if (e instanceof GatewayError && e.status >= 400 && e.status < 500 && e.status !== 404 && e.status !== 409 && e.status !== 429) await applyRefundResult(row.id, { state: 'failed', reason: e.body?.message ?? msg });
    else await q(`UPDATE refunds SET last_error = $2, last_checked_at = now() WHERE id = $1`, [row.id, msg.slice(0, 500)]);
  }
}

/** Asks the gateway where a pending refund is; re-sends it if the gateway never got it. */
export async function syncRefund(row: any) {
  try {
    const res = await payments().refundStatus(row.provider_order_id, row.id);
    if (!res) { await sendRefund(row); return; }
    await applyRefundResult(row.id, res);
  } catch (e) { await q(`UPDATE refunds SET last_error = $2, last_checked_at = now() WHERE id = $1`, [row.id, String((e as Error).message).slice(0, 500)]); }
}

/** Applies a gateway answer about a refund. Safe to call repeatedly. */
export async function applyRefundResult(refundId: string, res: { state: string; providerRefundId?: string; arn?: string; reason?: string }) {
  await tx(async c => {
    const row = await one('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId], c);
    if (!row) return;
    await q(`UPDATE refunds SET provider_refund_id = COALESCE($2, provider_refund_id), arn = COALESCE($3, arn), last_checked_at = now(), last_error = NULL WHERE id = $1`, [refundId, res.providerRefundId ?? null, res.arn ?? null], c);
    if (row.status !== 'pending' || res.state === 'pending') return;
    const o = await one('SELECT * FROM orders WHERE id = $1', [row.order_id], c);
    if (res.state === 'succeeded') {
      const done = await one(`UPDATE refunds SET status = 'succeeded', completed_at = now() WHERE id = $1 RETURNING *`, [refundId], c);
      await settle(c, { ...done, arn: res.arn ?? done.arn }, o, true);
    } else {
      await q(`UPDATE refunds SET status = 'failed', failure = $2, completed_at = now() WHERE id = $1`, [refundId, res.reason ?? 'The payment gateway declined the refund.'], c);
      await raiseIssue(c, o.id, 'refund_failed', `A refund of ${inr(row.amount_paise)} failed: ${res.reason ?? 'declined by the gateway'}. Try again, or refund the customer another way and record it.`, { refundId, amountPaise: row.amount_paise });
      await q(`INSERT INTO audit_log(action, meta) VALUES ('refund_failed',$1)`, [{ number: o.number, amount: row.amount_paise, reason: res.reason }], c);
    }
  });
}

/** A refund has really gone back: book it, update the order, tell the customer, close related issues. */
async function settle(c: Queryable, row: any, o: any, notify: boolean) {
  await q(`INSERT INTO payments(order_id, kind, provider, method, amount_paise, ref, note, recorded_by, provider_order_id) VALUES ($1,'refund',$2,$3,$4,$5,$6,$7,$8)`,
    [o.id, row.provider, row.method, row.amount_paise, row.arn ?? row.provider_refund_id ?? null, row.reason ?? null, row.created_by, row.provider_order_id], c);
  const net = await one(`SELECT COALESCE(sum(CASE WHEN kind = 'payment' THEN amount_paise ELSE -amount_paise END), 0)::int AS n,
                                COALESCE(sum(amount_paise) FILTER (WHERE kind = 'refund'), 0)::int AS refunded FROM payments WHERE order_id = $1`, [o.id], c);
  await q(`UPDATE orders SET refunded_paise = $2, status = CASE WHEN $3 AND status IN ('paid','cancelled') THEN 'refunded' ELSE status END, updated_at = now() WHERE id = $1`, [o.id, net.refunded, net.n <= 0], c);
  if (row.payment_id) {
    const p = await one(`SELECT p.amount_paise - COALESCE((SELECT sum(amount_paise) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'succeeded'),0) AS left FROM payments p WHERE p.id = $1`, [row.payment_id], c);
    if (p && p.left <= 0) await q(`UPDATE order_issues SET status = 'resolved', resolution = 'Refunded', resolved_at = now() WHERE payment_id = $1 AND status = 'open'`, [row.payment_id], c);
  }
  await q(`UPDATE order_issues SET status = 'resolved', resolution = 'Refunded another way', resolved_at = now() WHERE order_id = $1 AND kind = 'refund_failed' AND status = 'open' AND $2`, [o.id, row.provider === 'manual'], c);
  await q(`INSERT INTO audit_log(action, meta) VALUES ('refund_succeeded',$1)`, [{ number: o.number, amount: row.amount_paise, arn: row.arn }], c);
  if (notify) await enqueue('notify', { template: 'refund', userId: o.user_id, orderId: o.id, data: { number: o.number, amount: inr(row.amount_paise), ref: row.arn ?? undefined, manual: row.provider === 'manual', method: row.method } }, {}, c);
}

/** Retries a failed gateway refund (new refund id). */
export async function retryRefund(refundId: string, by: string) {
  const row = await one('SELECT * FROM refunds WHERE id = $1', [refundId]);
  if (!row || row.status !== 'failed') throw conflict('Only failed refunds can be retried.');
  await q(`UPDATE order_issues SET status = 'resolved', resolution = 'Retried', resolved_by = $2, resolved_at = now() WHERE refund_id = $1 AND status = 'open'`, [refundId, by]);
  return startRefund(row.order_id, { amountPaise: row.amount_paise, reason: row.reason ?? 'Refund (retry)', by, paymentId: row.payment_id ?? undefined, notify: false });
}

export const refundView = (r: any) => ({ id: r.id, amount: r.amount_paise / 100, status: r.status, provider: r.provider, method: r.method, reason: r.reason, arn: r.arn, failure: r.failure, lastError: r.last_error, createdAt: r.created_at, completedAt: r.completed_at });
