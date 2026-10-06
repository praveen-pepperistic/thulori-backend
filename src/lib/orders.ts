// Money coming in. Every path that learns about a payment — the Cashfree webhook, the customer
// returning from the payment page, the background check, a manual entry — goes through here, so a
// payment is counted exactly once and anything unusual (paid twice, paid after cancelling) becomes
// an issue for the team instead of silently disappearing.
import { one, q, tx, type Queryable } from '../db.js';
import { enqueue } from './jobs.js';
import { EDITIONS, type Edition } from './catalog.js';
import { payments, type GatewayPayment } from '../services/payments/index.js';
import { inr } from './money.js';

export { inr };
export type IssueKind = 'duplicate_payment' | 'paid_after_cancel' | 'refund_failed' | 'overpaid' | 'underpaid';

export interface PaidBy { provider?: string; method?: string | null; amountPaise?: number; note?: string | null; recordedBy?: string | null; at?: Date; notify?: boolean; providerOrderId?: string | null }

/** Received money for an order that was waiting for it. Returns false if the order wasn't waiting. */
export async function markPaid(orderId: string, ref?: string, by: PaidBy = {}) {
  return tx(async c => {
    const o = await one(`UPDATE orders SET status = 'paid', paid_at = COALESCE($3::timestamptz, now()), payment_ref = COALESCE($2, payment_ref), updated_at = now()
                         WHERE id = $1 AND status IN ('pending_payment','failed') RETURNING *`, [orderId, ref ?? null, by.at ?? null], c);
    if (!o) return false;
    const day = new Date(o.paid_at).toISOString().slice(0, 10);
    await q(`UPDATE books SET stage_dates = jsonb_build_object('0', $2::text) WHERE order_id = $1`, [orderId, day], c);
    await q(`INSERT INTO payments(order_id, provider, method, amount_paise, ref, note, recorded_by, at, provider_order_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orderId, by.provider ?? o.payment_provider, by.method ?? null, by.amountPaise ?? o.total_paise, ref ?? null, by.note ?? null, by.recordedBy ?? null, o.paid_at, by.providerOrderId ?? null], c);
    if (by.providerOrderId) await q(`UPDATE payment_attempts SET status = 'paid' WHERE provider_order_id = $1`, [by.providerOrderId], c);
    if (by.amountPaise != null && by.amountPaise !== o.total_paise)
      await raiseIssue(c, orderId, by.amountPaise > o.total_paise ? 'overpaid' : 'underpaid', `Received ${inr(by.amountPaise)} but the order total is ${inr(o.total_paise)}.`, { amountPaise: Math.abs(by.amountPaise - o.total_paise) });
    const items = await q('SELECT edition, child_name FROM order_items WHERE order_id = $1', [orderId], c);
    if (by.notify !== false) await enqueue('notify', {
      template: 'order_paid', userId: o.user_id, orderId,
      data: { number: o.number, total: inr(by.amountPaise ?? o.total_paise), items: items.map(i => `${EDITIONS[i.edition as Edition]?.name ?? i.edition} — ${i.child_name}`).join('\n') },
    }, {}, c);
    await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'order_paid',$2)`, [by.recordedBy ?? o.user_id, { number: o.number, ref, provider: by.provider ?? o.payment_provider }], c);
    return true;
  });
}

/** Something the team must look at. Also emails the team inbox. */
export async function raiseIssue(c: Queryable, orderId: string, kind: IssueKind, detail: string, extra: { paymentId?: string; refundId?: string; amountPaise?: number } = {}) {
  const dup = await one(`SELECT 1 FROM order_issues WHERE order_id = $1 AND kind = $2 AND status = 'open' AND payment_id IS NOT DISTINCT FROM $3 AND refund_id IS NOT DISTINCT FROM $4`, [orderId, kind, extra.paymentId ?? null, extra.refundId ?? null], c);
  if (dup) return;
  await q(`INSERT INTO order_issues(order_id, kind, payment_id, refund_id, amount_paise, detail) VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, kind, extra.paymentId ?? null, extra.refundId ?? null, extra.amountPaise ?? null, detail], c);
  const o = await one('SELECT number FROM orders WHERE id = $1', [orderId], c);
  await q(`INSERT INTO audit_log(action, meta) VALUES ('issue_raised', $1)`, [{ number: o.number, kind, detail }], c);
  await enqueue('notify', { template: 'team_alert', orderId, data: { number: o.number, kind, detail } }, {}, c);
}

export type RecordResult = 'paid' | 'already_recorded' | 'issue' | 'unknown_order';

/** A successful gateway payment. Safe to call any number of times for the same payment. */
export async function recordGatewayPayment(provider: string, providerOrderId: string, p: GatewayPayment): Promise<RecordResult> {
  const attempt = await one(`SELECT a.*, o.status AS order_status, o.number FROM payment_attempts a JOIN orders o ON o.id = a.order_id WHERE a.provider_order_id = $1`, [providerOrderId]);
  if (!attempt) return 'unknown_order';
  const ref = p.ref || `${providerOrderId}:payment`;
  if (await one(`SELECT 1 FROM payments WHERE provider = $1 AND ref = $2 AND kind = 'payment'`, [provider, ref])) return 'already_recorded';
  const amount = p.amountPaise > 0 ? p.amountPaise : attempt.amount_paise;
  if (attempt.order_status === 'pending_payment' || attempt.order_status === 'failed') {
    try {
      const ok = await markPaid(attempt.order_id, ref, { provider, method: p.method, amountPaise: amount, at: p.at ? new Date(p.at) : undefined, providerOrderId });
      if (ok) return 'paid';
    } catch (e: any) { if (e?.code === '23505') return 'already_recorded'; throw e; } // another path recorded it a moment ago
  }
  // The order isn't waiting for money: it was already paid (a second payment) or cancelled.
  return tx(async c => {
    const o = await one('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [attempt.order_id], c);
    let pay;
    try {
      pay = await one(`INSERT INTO payments(order_id, provider, method, amount_paise, ref, note, at, provider_order_id) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()),$8) RETURNING id`,
        [o.id, provider, p.method, amount, ref, o.status === 'paid' ? 'Second payment for an order already paid' : 'Payment received after the order was cancelled', p.at, providerOrderId], c);
    } catch (e: any) { if (e?.code === '23505') return 'already_recorded' as const; throw e; }
    await q(`UPDATE payment_attempts SET status = 'paid' WHERE provider_order_id = $1`, [providerOrderId], c);
    const kind = o.status === 'paid' ? 'duplicate_payment' : 'paid_after_cancel';
    await raiseIssue(c, o.id, kind, kind === 'duplicate_payment'
      ? `The customer paid ${inr(amount)} again (payment ${ref}) for an order that was already paid. Refund the extra payment.`
      : `The customer paid ${inr(amount)} (payment ${ref}) after the order was cancelled. Refund it, or reopen the order.`, { paymentId: pay.id, amountPaise: amount });
    return 'issue' as const;
  });
}

/** A gateway attempt failed. The order is only marked failed if it's still waiting and this was its latest attempt. */
export async function markAttemptFailed(providerOrderId: string) {
  await q(`UPDATE orders o SET status = 'failed', updated_at = now() FROM payment_attempts a
           WHERE a.provider_order_id = $1 AND o.id = a.order_id AND o.status = 'pending_payment' AND o.provider_order_id = $1`, [providerOrderId]);
}

/** Asks the gateway about one attempt and applies what it says. Returns whether a payment is still in progress at the bank. */
export async function checkAttempt(a: { provider: string; provider_order_id: string; status?: string }) {
  if (a.provider === 'manual') return { processing: false };
  const r = await payments().payments(a.provider_order_id);
  for (const p of r.payments.filter(x => x.state === 'success')) await recordGatewayPayment(a.provider, a.provider_order_id, p);
  const processing = r.payments.some(p => p.state === 'pending') && !r.payments.some(p => p.state === 'success');
  if (r.order === 'closed') await q(`UPDATE payment_attempts SET status = 'closed' WHERE provider_order_id = $1 AND status = 'open'`, [a.provider_order_id]);
  if (r.order !== 'paid' && !processing && r.payments.length && r.payments.every(p => p.state === 'failed')) await markAttemptFailed(a.provider_order_id);
  await q(`UPDATE payment_attempts SET last_checked_at = now() WHERE provider_order_id = $1`, [a.provider_order_id]);
  return { processing };
}

/** Re-checks every open attempt of an order with the gateway. Never throws if the gateway is down. */
export async function refreshPayment(o: any): Promise<any> {
  if (o.payment_provider === 'manual') return o;
  const attempts = await q(`SELECT * FROM payment_attempts WHERE order_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 5`, [o.id]);
  let processing = false;
  for (const a of attempts) {
    try { processing = (await checkAttempt(a)).processing || processing; } catch { /* gateway unreachable — webhook or the background check will catch up */ }
  }
  const fresh = await one('SELECT * FROM orders WHERE id = $1', [o.id]);
  return Object.assign(fresh, { processing });
}

/** Money received minus money refunded (refunds count once they've succeeded). */
export async function paidSoFar(orderId: string, c?: Queryable) {
  const r = await one(`SELECT COALESCE(sum(CASE WHEN kind = 'payment' THEN amount_paise ELSE -amount_paise END), 0)::int AS n FROM payments WHERE order_id = $1`, [orderId], c);
  return r.n as number;
}
