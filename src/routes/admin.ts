// Admin panel API (staff/admin roles, admin sessions only). Every action is audited, and every
// checkpoint can also be set by hand for things that happened outside the website
// (payment by UPI/bank transfer, photos sent on WhatsApp, a proof approved on a call…).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireAdmin, requireStaff } from '../auth/index.js';
import { parse, zEmail, zName, zPhone, zUuid } from '../lib/validate.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { EDITIONS, EDITION_KEYS, INDIAN_STATES, STAGE, STAGES, type Edition } from '../lib/catalog.js';
import { insertItems, priceItems, zItems } from '../lib/basket.js';
import { ALLOWED_IMAGE_TYPES, ALLOWED_PROOF_TYPES, extFor, storage } from '../services/storage/index.js';
import { enqueue } from '../lib/jobs.js';
import { markPaid, refreshPayment } from '../lib/orders.js';
import { refundable, refundView, retryRefund, startRefund, syncRefund } from '../lib/refunds.js';
import { inr, orderAmounts } from '../lib/money.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { createInvoice, draftLines, invoiceSummary, invoiceUrl, paidSoFar } from '../services/invoices.js';

const today = () => new Date().toISOString().slice(0, 10);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zStateName = z.string().refine(s => INDIAN_STATES.includes(s), 'Choose a state.');
const zAddr = z.object({
  to: zName, line1: z.string().trim().min(1, 'Add the house and street.').max(200), line2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(1, 'Add the city.').max(80), state: zStateName, pin: z.string().trim().regex(/^\d{6}$/, 'PIN codes have 6 digits.'),
  phone: z.string().trim().max(20).optional(),
});
const METHODS = ['upi', 'card', 'netbanking', 'bank_transfer', 'cash', 'cashfree', 'other'] as const;

// Work queues shown on the dashboard. Each is a WHERE clause on orders o.
const BUCKETS: Record<string, { label: string; where: string }> = {
  attention:         { label: 'Needs attention',              where: `EXISTS (SELECT 1 FROM order_issues i WHERE i.order_id = o.id AND i.status = 'open') OR EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.status = 'pending' AND r.created_at < now() - interval '3 days')` },
  refunding:         { label: 'Refunds in progress',          where: `EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.status = 'pending')` },
  unpaid:            { label: 'Awaiting payment',             where: `o.status IN ('pending_payment','failed')` },
  awaiting_photos:   { label: 'Waiting for photos & stories', where: `o.status = 'paid' AND EXISTS (SELECT 1 FROM books b WHERE b.order_id = o.id AND b.stage = 0)` },
  to_write:          { label: 'Ready to write',               where: `o.status = 'paid' AND EXISTS (SELECT 1 FROM books b WHERE b.order_id = o.id AND b.stage = 1)` },
  changes_requested: { label: 'Customer asked for changes',   where: `o.status = 'paid' AND EXISTS (SELECT 1 FROM books b WHERE b.order_id = o.id AND b.stage = 2 AND (SELECT r.status FROM proof_rounds r WHERE r.book_id = b.id ORDER BY r.round DESC LIMIT 1) = 'changes_requested')` },
  in_design:         { label: 'In design',                    where: `o.status = 'paid' AND EXISTS (SELECT 1 FROM books b WHERE b.order_id = o.id AND b.stage = 2)` },
  proof_out:         { label: 'Proof with customer',          where: `o.status = 'paid' AND EXISTS (SELECT 1 FROM books b WHERE b.order_id = o.id AND b.stage = 3)` },
  to_print:          { label: 'Approved — to print & ship',   where: `o.status = 'paid' AND o.shipped_at IS NULL AND NOT EXISTS (SELECT 1 FROM books b WHERE b.order_id = o.id AND b.stage < 4)` },
  shipped:           { label: 'Shipped',                      where: `o.shipped_at IS NOT NULL AND o.delivered_at IS NULL AND o.status = 'paid'` },
  delivered:         { label: 'Delivered',                    where: `o.delivered_at IS NOT NULL` },
  cancelled:         { label: 'Cancelled / refunded',         where: `o.status IN ('cancelled','refunded')` },
};

function orderFilters(f: any) {
  const where: string[] = [], args: unknown[] = [];
  const p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (f.bucket && BUCKETS[f.bucket]) where.push(BUCKETS[f.bucket]!.where);
  if (f.status) where.push(`o.status = ${p(f.status)}`);
  if (f.stage !== undefined) where.push(`EXISTS (SELECT 1 FROM books b WHERE b.order_id = o.id AND b.stage = ${p(f.stage)})`);
  if (f.edition) where.push(`EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.edition = ${p(f.edition)})`);
  if (f.state) where.push(`o.address->>'state' = ${p(f.state)}`);
  if (f.source) where.push(`o.source = ${p(f.source)}`);
  if (f.from) where.push(`o.created_at >= ${p(f.from)}::date`);
  if (f.to) where.push(`o.created_at < ${p(f.to)}::date + 1`);
  if (f.q) {
    const t = p(`%${f.q.trim()}%`), digits = f.q.replace(/\D/g, '');
    where.push(`(o.number ILIKE ${t} OR u.name ILIKE ${t} OR u.email ILIKE ${t} OR o.contact->>'name' ILIKE ${t}
      OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.child_name ILIKE ${t})
      ${digits.length >= 4 ? `OR regexp_replace(COALESCE(u.phone, o.contact->>'phone',''), '\\D', '', 'g') LIKE ${p('%' + digits + '%')}` : ''})`);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

async function orderRow(o: any) {
  const books = await q(`SELECT b.id, b.child_name, b.edition, b.stage,
      (SELECT r.status FROM proof_rounds r WHERE r.book_id = b.id ORDER BY r.round DESC LIMIT 1) AS proof_status
    FROM books b WHERE b.order_id = $1 ORDER BY b.created_at`, [o.id]);
  return {
    id: o.id, number: o.number, createdAt: o.created_at, status: o.status, source: o.source,
    customer: { name: o.customer_name ?? o.contact?.name, email: o.customer_email ?? o.contact?.email, phone: o.customer_phone ?? o.contact?.phone },
    city: o.address?.city, state: o.address?.state, total: o.total_paise / 100, paidAt: o.paid_at, shippedAt: o.shipped_at, deliveredAt: o.delivered_at,
    books: books.map(b => ({ id: b.id, child: b.child_name, edition: b.edition, stage: b.stage, stageName: STAGES[b.stage], proofStatus: b.proof_status })),
  };
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireStaff);
  const idParam = (p: unknown) => parse(z.object({ id: zUuid }), p).id;
  const me = (req: any) => req.admin!.id as string;
  const audit = (userId: string, action: string, meta: object, c?: any) => q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,$2,$3)`, [userId, action, meta], c);
  const loadOrder = async (id: string) => { const o = await one(`SELECT * FROM orders WHERE ${/^TH-\d+$/i.test(id) ? 'number = upper($1)' : 'id::text = $1'}`, [id]); if (!o) throw notFound('No such order.'); return o; };
  const orderParam = (p: unknown) => parse(z.object({ id: z.string().max(60) }), p).id;
  const logStage = (b: any, to: number, by: any, note?: string | null, manual = true) =>
    JSON.stringify([...(b.stage_log || []), { from: b.stage, to, by: by.name || by.email, at: new Date().toISOString(), note: note || null, manual }]);

  // ================= dashboard =================
  app.get('/summary', async () => {
    const counts: Record<string, { label: string; count: number }> = {};
    for (const [k, b] of Object.entries(BUCKETS)) {
      const r = await one(`SELECT count(*)::int AS n FROM orders o ${'WHERE ' + b.where}`);
      counts[k] = { label: b.label, count: r.n };
    }
    const money = await one(`SELECT
        COALESCE(sum(CASE WHEN kind='payment' THEN amount_paise ELSE -amount_paise END) FILTER (WHERE at >= date_trunc('day', now())), 0)::int AS today,
        COALESCE(sum(CASE WHEN kind='payment' THEN amount_paise ELSE -amount_paise END) FILTER (WHERE at >= date_trunc('month', now())), 0)::int AS month,
        count(*) FILTER (WHERE kind='payment' AND at >= date_trunc('month', now()))::int AS month_count
      FROM payments`);
    const failed = await one(`SELECT count(*)::int AS n FROM notification_log WHERE status = 'failed' AND at > now() - interval '7 days'`);
    return { buckets: counts, money: { today: money.today / 100, month: money.month / 100, monthCount: money.month_count }, failedMessages: failed.n,
      editions: EDITION_KEYS.map(k => ({ key: k, name: EDITIONS[k].name, price: EDITIONS[k].pricePaise / 100 })), states: INDIAN_STATES, stages: STAGES };
  });

  // ================= orders =================
  const zOrderFilter = z.object({
    q: z.string().max(100).optional(), status: z.enum(['pending_payment', 'paid', 'failed', 'cancelled', 'refunded']).optional(),
    bucket: z.string().optional(), stage: z.coerce.number().int().min(0).max(6).optional(), edition: z.enum(EDITION_KEYS as [Edition, ...Edition[]]).optional(),
    state: z.string().max(60).optional(), source: z.enum(['web', 'admin']).optional(), from: zDate.optional(), to: zDate.optional(),
    sort: z.enum(['new', 'old', 'total']).default('new'), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(200).default(25),
  });
  app.get('/orders', async (req) => {
    const f = parse(zOrderFilter, req.query);
    const { sql, args } = orderFilters(f);
    const base = `FROM orders o JOIN users u ON u.id = o.user_id ${sql}`;
    const total = await one(`SELECT count(*)::int AS n, COALESCE(sum(o.total_paise),0)::bigint AS value ${base}`, args);
    const order = f.sort === 'old' ? 'o.created_at ASC' : f.sort === 'total' ? 'o.total_paise DESC' : 'o.created_at DESC';
    const rows = await q(`SELECT o.*, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone ${base} ORDER BY ${order} LIMIT ${f.size} OFFSET ${(f.page - 1) * f.size}`, args);
    return { orders: await Promise.all(rows.map(orderRow)), total: total.n, value: Number(total.value) / 100, page: f.page, size: f.size };
  });

  app.get('/orders/:id', async (req) => {
    let o = await loadOrder(orderParam(req.params));
    // Unpaid orders are re-checked with the gateway on open (never fails if the gateway is down).
    if (o.status === 'pending_payment' || o.status === 'failed') o = await refreshPayment(o);
    const u = await one('SELECT id, name, email, phone, status, wa_updates, created_at, password_hash IS NOT NULL AS has_password FROM users WHERE id = $1', [o.user_id]);
    const books = await q(`SELECT b.*, (SELECT count(*)::int FROM photos p WHERE p.book_id = b.id AND p.status = 'uploaded') AS photos,
        (SELECT count(*)::int FROM photos p WHERE p.book_id = b.id AND p.status = 'uploaded' AND p.read_at IS NULL) AS unread,
        (SELECT count(*)::int FROM cards c WHERE c.book_id = b.id) AS cards,
        (SELECT count(*)::int FROM cards c WHERE c.book_id = b.id AND (c.pick IS NOT NULL OR c.answer <> '')) AS stories
      FROM books b WHERE b.order_id = $1 ORDER BY b.created_at`, [o.id]);
    const items = await q('SELECT * FROM order_items WHERE order_id = $1', [o.id]);
    const pays = await q(`SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.order_id = $1 ORDER BY p.at`, [o.id]);
    const invoices = await q('SELECT * FROM invoices WHERE order_id = $1 ORDER BY created_at', [o.id]);
    const refunds = await q(`SELECT r.*, u.name AS by_name FROM refunds r LEFT JOIN users u ON u.id = r.created_by WHERE r.order_id = $1 ORDER BY r.created_at`, [o.id]);
    const issues = await q(`SELECT i.*, u.name AS by_name FROM order_issues i LEFT JOIN users u ON u.id = i.resolved_by WHERE i.order_id = $1 ORDER BY i.status, i.created_at DESC`, [o.id]);
    const attempts = await q(`SELECT * FROM payment_attempts WHERE order_id = $1 ORDER BY created_at`, [o.id]);
    const left = (await refundable(o.id)).reduce((t, p) => t + p.leftPaise, 0);
    const notes = await q(`SELECT n.*, u.name AS author FROM order_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.order_id = $1 ORDER BY n.created_at`, [o.id]);
    const msgs = await q(`SELECT * FROM notification_log WHERE order_id = $1 OR (user_id = $2 AND template IN ('stage_update','proof_ready','shipped','account_created')) ORDER BY at DESC LIMIT 50`, [o.id, o.user_id]);
    const bookIds = books.map(b => b.id);
    const activity = await q(`SELECT a.*, u.name AS who, u.role FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.meta->>'number' = $1 OR a.meta->>'order' = $1 OR a.meta->>'book' = ANY($2::text[]) ORDER BY a.at DESC LIMIT 100`, [o.number, bookIds]);
    return {
      order: {
        id: o.id, number: o.number, status: o.status, source: o.source, createdAt: o.created_at, paidAt: o.paid_at,
        subtotal: o.subtotal_paise / 100, tax: o.tax_paise / 100, gstRate: Number(o.gst_rate), total: o.total_paise / 100, refunded: o.refunded_paise / 100,
        paid: (await paidSoFar(o.id)) / 100, giftNote: o.gift_note,
        address: o.address, contact: o.contact, provider: o.payment_provider, providerOrderId: o.provider_order_id, paymentRef: o.payment_ref,
        shipping: o.shipped_at ? { courier: o.courier, awb: o.awb, url: o.tracking_url, at: o.shipped_at, deliveredAt: o.delivered_at } : null,
        cancelledAt: o.cancelled_at, cancelReason: o.cancel_reason,
      },
      customer: u && { id: u.id, name: u.name, email: u.email, phone: u.phone, status: u.status, waUpdates: u.wa_updates, since: u.created_at, hasPassword: u.has_password },
      items: items.map(i => ({ edition: i.edition, child: i.child_name, price: i.unit_price_paise / 100, book: i.book_id })),
      books: books.map(b => ({ id: b.id, child: b.child_name, edition: b.edition, stage: b.stage, stageName: STAGES[b.stage], dates: b.stage_dates, log: b.stage_log,
        photos: b.photos, unread: b.unread, cards: b.cards, stories: b.stories, letter: !!b.letter, submittedAt: b.submitted_at, read: b.read_status })),
      payments: pays.map(p => ({ id: p.id, kind: p.kind, provider: p.provider, method: p.method, amount: p.amount_paise / 100, ref: p.ref, note: p.note, by: p.by_name, at: p.at })),
      invoices: invoices.map(invoiceSummary),
      refunds: refunds.map(r => ({ ...refundView(r), by: r.by_name })),
      refundable: left / 100, processing: !!o.processing,
      issues: issues.map(i => ({ id: i.id, kind: i.kind, status: i.status, detail: i.detail, amount: i.amount_paise != null ? i.amount_paise / 100 : null, paymentId: i.payment_id, refundId: i.refund_id, resolution: i.resolution, resolvedBy: i.by_name, resolvedAt: i.resolved_at, at: i.created_at })),
      attempts: attempts.map(a => ({ id: a.provider_order_id, provider: a.provider, amount: a.amount_paise / 100, status: a.status, checkedAt: a.last_checked_at, at: a.created_at })),
      notes: notes.map(n => ({ id: n.id, book: n.book_id, text: n.body, author: n.author, at: n.created_at })),
      messages: msgs.map(m => ({ template: m.template, channel: m.channel, to: m.recipient, status: m.status, error: m.error, at: m.at })),
      activity: activity.map(a => ({ action: a.action, who: a.who, role: a.role, meta: a.meta, at: a.at })),
    };
  });

  // Create an order by hand (WhatsApp / phone / walk-in). Creates the customer account if needed.
  app.post('/orders', async (req, reply) => {
    const b = parse(z.object({
      customer: z.object({ name: zName, email: zEmail, phone: zPhone }),
      items: zItems,
      giftNote: z.string().trim().max(300).optional(), address: zAddr,
      payment: z.object({ status: z.enum(['paid', 'unpaid']), method: z.enum(METHODS).optional(), ref: z.string().trim().max(120).optional(), paidOn: zDate.optional() }),
      notify: z.boolean().default(true),
    }), req.body);
    const basket = priceItems(b.items);
    const amt = orderAmounts(basket.subtotalPaise);
    const res = await tx(async c => {
      let u = await one(`SELECT * FROM users WHERE status <> 'deleted' AND (email = $1 OR phone = $2) LIMIT 1`, [b.customer.email, b.customer.phone], c);
      let created = false, token: string | null = null;
      if (!u) {
        u = await one(`INSERT INTO users(name, email, phone) VALUES ($1,$2,$3) RETURNING *`, [b.customer.name, b.customer.email, b.customer.phone], c);
        created = true; token = newToken();
        await q(`INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '7 days')`, [sha256(token), u.id], c);
      }
      const addr = { ...b.address, line2: b.address.line2 ?? '', phone: b.address.phone || b.customer.phone };
      const o = await one(`INSERT INTO orders(user_id, subtotal_paise, tax_paise, total_paise, gst_rate, gift_note, address, contact, payment_provider, source)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual','admin') RETURNING *`,
        [u.id, amt.subtotal, amt.tax, amt.total, amt.rate, b.giftNote || null, addr, b.customer], c);
      await insertItems(c, o.id, u.id, basket.priced);
      if (!(await one('SELECT 1 FROM addresses WHERE user_id = $1 AND line1 = $2 AND pin = $3', [u.id, addr.line1, addr.pin], c))) {
        const n = await one('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1', [u.id], c);
        await q(`INSERT INTO addresses(user_id,label,recipient,line1,line2,city,state,pin,phone,is_default) VALUES ($1,'Home',$2,$3,$4,$5,$6,$7,$8,$9)`,
          [u.id, addr.to, addr.line1, addr.line2, addr.city, addr.state, addr.pin, addr.phone, n.n === 0], c);
      }
      await audit(me(req), 'admin_order_created', { number: o.number, customer: u.email, created }, c);
      if (b.notify && created) await enqueue('notify', { template: 'account_created', userId: u.id, orderId: o.id, data: { number: o.number, token } }, {}, c);
      else if (b.notify && b.payment.status === 'unpaid') await enqueue('notify', { template: 'order_placed', userId: u.id, orderId: o.id, data: { number: o.number, total: inr(amt.total) } }, {}, c);
      return { o, created };
    });
    if (b.payment.status === 'paid') await markPaid(res.o.id, b.payment.ref, { provider: 'manual', method: b.payment.method ?? 'other', recordedBy: me(req), at: b.payment.paidOn ? new Date(b.payment.paidOn + 'T12:00:00+05:30') : undefined, notify: b.notify });
    return reply.status(201).send({ number: res.o.number, id: res.o.id, accountCreated: res.created });
  });

  app.patch('/orders/:id', async (req) => {
    const o = await loadOrder(orderParam(req.params));
    const b = parse(z.object({ address: zAddr.optional(), contact: z.object({ name: zName, email: zEmail, phone: zPhone }).optional(), giftNote: z.string().trim().max(300).nullable().optional() }), req.body);
    if (b.address && o.shipped_at) throw conflict('This order has already shipped.');
    await q(`UPDATE orders SET address = COALESCE($2, address), contact = COALESCE($3, contact), gift_note = CASE WHEN $4 THEN $5 ELSE gift_note END, updated_at = now() WHERE id = $1`,
      [o.id, b.address ? { ...b.address, line2: b.address.line2 ?? '' } : null, b.contact ?? null, b.giftNote !== undefined, b.giftNote ?? null]);
    await audit(me(req), 'admin_order_edit', { number: o.number, fields: Object.keys(b) });
    return { ok: true };
  });

  app.post('/orders/:id/notes', async (req, reply) => {
    const o = await loadOrder(orderParam(req.params));
    const b = parse(z.object({ text: z.string().trim().min(1).max(4000), bookId: zUuid.optional() }), req.body);
    await q(`INSERT INTO order_notes(order_id, book_id, author_id, body) VALUES ($1,$2,$3,$4)`, [o.id, b.bookId ?? null, me(req), b.text]);
    return reply.status(201).send({ ok: true });
  });

  app.post('/orders/:id/refresh-payment', async (req) => {
    const o = await refreshPayment(await loadOrder(orderParam(req.params)));
    return { status: o.status };
  });

  app.post('/orders/:id/remind', async (req) => {
    const o = await loadOrder(orderParam(req.params));
    if (o.status !== 'pending_payment' && o.status !== 'failed') throw conflict('This order is not waiting for payment.');
    await enqueue('notify', { template: 'order_placed', userId: o.user_id, orderId: o.id, data: { number: o.number, total: inr(o.total_paise) } });
    await audit(me(req), 'admin_payment_reminder', { number: o.number });
    return { ok: true };
  });

  // ---- money (admin role)
  app.post('/orders/:id/mark-paid', { preHandler: requireAdmin }, async (req) => {
    const o = await loadOrder(orderParam(req.params));
    const b = parse(z.object({ method: z.enum(METHODS), ref: z.string().trim().max(120).optional(), amount: z.number().positive().optional(), paidOn: zDate.optional(), note: z.string().trim().max(500).optional(), notify: z.boolean().default(true) }), req.body);
    if (o.status === 'paid') throw conflict('This order is already paid.');
    if (o.status === 'cancelled' || o.status === 'refunded') throw conflict('This order was cancelled.');
    await markPaid(o.id, b.ref, { provider: 'manual', method: b.method, amountPaise: b.amount ? Math.round(b.amount * 100) : undefined, note: b.note, recordedBy: me(req), at: b.paidOn ? new Date(b.paidOn + 'T12:00:00+05:30') : undefined, notify: b.notify });
    return { ok: true };
  });

  // Cancel. A paid order can be cancelled with a full refund in the same step.
  app.post('/orders/:id/cancel', { preHandler: requireAdmin }, async (req) => {
    const o = await loadOrder(orderParam(req.params));
    const b = parse(z.object({ reason: z.string().trim().max(300).optional(), notify: z.boolean().default(true), refund: z.boolean().default(false),
      manual: z.object({ method: z.enum(METHODS), ref: z.string().trim().max(120).optional() }).optional() }), req.body);
    if (o.status === 'cancelled' || o.status === 'refunded') throw conflict('Already cancelled.');
    if (o.shipped_at) throw conflict('This order has shipped — refund it instead of cancelling.');
    await tx(async c => {
      await q(`UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() WHERE id = $1`, [o.id, b.reason ?? null], c);
      // Open gateway attempts stay watched: if the customer still pays in another tab, it shows up as an issue to refund.
      await audit(me(req), 'admin_cancel', { number: o.number, reason: b.reason, wasPaid: o.status === 'paid' }, c);
      if (b.notify) await enqueue('notify', { template: 'order_cancelled', userId: o.user_id, orderId: o.id, data: { number: o.number, reason: b.reason } }, {}, c);
    });
    const left = (await refundable(o.id)).reduce((t, p) => t + p.leftPaise, 0);
    let refunds: any[] = [];
    if (b.refund && left > 0) refunds = await startRefund(o.id, { amountPaise: left, reason: b.reason ? `Order cancelled — ${b.reason}` : 'Order cancelled', by: me(req), notify: b.notify, manual: b.manual });
    return { ok: true, refundDue: (left - refunds.reduce((t, r) => t + r.amount_paise, 0)) / 100, refunds: refunds.map(refundView) };
  });

  // Refund. Gateway payments go back to the customer's original UPI/card/bank through Cashfree;
  // payments taken by hand are refunded by hand and recorded with how they were sent.
  app.get('/orders/:id/refundable', { preHandler: requireAdmin }, async (req) => {
    const o = await loadOrder(orderParam(req.params));
    const list = await refundable(o.id);
    return { payments: list.map(p => ({ id: p.id, provider: p.provider, method: p.method, ref: p.ref, amount: p.amountPaise / 100, left: p.leftPaise / 100, gateway: p.gateway, at: p.at })), total: list.reduce((t, p) => t + p.leftPaise, 0) / 100 };
  });
  app.post('/orders/:id/refund', { preHandler: requireAdmin }, async (req) => {
    const o = await loadOrder(orderParam(req.params));
    const b = parse(z.object({ amount: z.number().positive(), reason: z.string().trim().min(3, 'Add a short reason.').max(300), paymentId: zUuid.optional(), notify: z.boolean().default(true),
      manual: z.object({ method: z.enum(METHODS), ref: z.string().trim().max(120).optional() }).optional() }), req.body);
    const rows = await startRefund(o.id, { amountPaise: Math.round(b.amount * 100), reason: b.reason, paymentId: b.paymentId, by: me(req), notify: b.notify, manual: b.manual });
    return { refunds: rows.map(refundView) };
  });
  app.post('/refunds/:id/check', { preHandler: requireAdmin }, async (req) => {
    const r = await one('SELECT * FROM refunds WHERE id = $1', [idParam(req.params)]);
    if (!r) throw notFound();
    if (r.status === 'pending') await syncRefund(r);
    return { refund: refundView(await one('SELECT * FROM refunds WHERE id = $1', [r.id])) };
  });
  app.post('/refunds/:id/retry', { preHandler: requireAdmin }, async (req) => {
    const rows = await retryRefund(idParam(req.params), me(req));
    return { refunds: rows.map(refundView) };
  });

  // Issues: double payments, payments on cancelled orders, failed refunds…
  app.post('/issues/:id/resolve', { preHandler: requireAdmin }, async (req) => {
    const { note } = parse(z.object({ note: z.string().trim().min(3, 'Say how it was resolved.').max(500) }), req.body);
    const i = await one(`UPDATE order_issues SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *`, [idParam(req.params), note, me(req)]);
    if (!i) throw notFound('That issue is already resolved.');
    const o = await one('SELECT number FROM orders WHERE id = $1', [i.order_id]);
    await audit(me(req), 'issue_resolved', { number: o.number, kind: i.kind, note });
    return { ok: true };
  });

  // ---- invoices (admin role)
  app.get('/orders/:id/invoice-draft', { preHandler: requireAdmin }, async (req) => {
    const o = await loadOrder(orderParam(req.params));
    return { lines: (await draftLines(o.id)).map(l => ({ desc: l.desc, hsn: l.hsn, qty: l.qty, unit: l.unit_paise / 100 })), gstRate: Number(o.gst_rate) || config().GST_RATE, pricesIncludeGst: config().PRICES_INCLUDE_GST, state: o.address?.state, companyState: config().COMPANY_STATE, email: o.contact?.email };
  });
  app.post('/orders/:id/invoices', { preHandler: requireAdmin }, async (req, reply) => {
    const o = await loadOrder(orderParam(req.params));
    const b = parse(z.object({ lines: z.array(z.object({ desc: z.string().trim().min(1).max(200), hsn: z.string().trim().max(12).optional(), qty: z.number().int().min(1).max(100), unit: z.number().min(0) })).min(1).max(30), send: z.boolean().default(true), to: zEmail.optional() }), req.body);
    const inv = await createInvoice(o.id, b.lines.map(l => ({ desc: l.desc, hsn: l.hsn, qty: l.qty, unit_paise: Math.round(l.unit * 100) })), me(req));
    if (b.send) await sendInvoice(inv, o, b.to, me(req));
    return reply.status(201).send({ invoice: invoiceSummary(await one('SELECT * FROM invoices WHERE id = $1', [inv.id])) });
  });
  async function sendInvoice(inv: any, o: any, to: string | undefined, by: string) {
    const email = to || o.contact?.email;
    if (!email) throw badRequest('No email address for this customer.');
    await enqueue('notify', { template: 'invoice', userId: o.user_id, orderId: o.id, to: { email }, data: { number: o.number, invoice: inv.number, total: inr(inv.total_paise), url: invoiceUrl(inv.token) } });
    await q(`UPDATE invoices SET sent_at = now(), sent_to = $2 WHERE id = $1`, [inv.id, email]);
    await audit(by, 'invoice_sent', { number: o.number, invoice: inv.number, to: email });
  }
  app.post('/invoices/:id/send', { preHandler: requireAdmin }, async (req) => {
    const inv = await one('SELECT * FROM invoices WHERE id = $1', [idParam(req.params)]);
    if (!inv) throw notFound();
    if (inv.status === 'void') throw conflict('This invoice is void.');
    const b = parse(z.object({ to: zEmail.optional() }), req.body);
    await sendInvoice(inv, await one('SELECT * FROM orders WHERE id = $1', [inv.order_id]), b.to, me(req));
    return { ok: true };
  });
  app.post('/invoices/:id/void', { preHandler: requireAdmin }, async (req) => {
    const inv = await one(`UPDATE invoices SET status = 'void' WHERE id = $1 AND status = 'issued' RETURNING *`, [idParam(req.params)]);
    if (!inv) throw notFound();
    const o = await one('SELECT number FROM orders WHERE id = $1', [inv.order_id]);
    await audit(me(req), 'invoice_void', { number: o.number, invoice: inv.number });
    return { ok: true };
  });

  // ---- shipping
  app.post('/orders/:id/ship', async (req) => {
    const o0 = await loadOrder(orderParam(req.params));
    const { courier, awb, trackingUrl, notify, force } = parse(z.object({ courier: z.string().trim().min(2).max(60), awb: z.string().trim().min(4).max(60), trackingUrl: z.string().trim().max(500).regex(/^https:\/\/\S+$/, 'Paste the full tracking link, starting with https://').optional().or(z.literal('').transform(() => undefined)), notify: z.boolean().default(true), force: z.boolean().default(false) }), req.body);
    await tx(async c => {
      const o = await one(`UPDATE orders SET shipped_at = now(), courier = $2, awb = $3, tracking_url = $4, updated_at = now() WHERE id = $1 AND status = 'paid' RETURNING *`, [o0.id, courier, awb, trackingUrl ?? null], c);
      if (!o) throw conflict('Only paid orders can ship.');
      const notReady = await one(`SELECT child_name FROM books WHERE order_id = $1 AND stage < $2`, [o.id, STAGE.PRINTING], c);
      if (notReady && !force) throw conflict(`${notReady.child_name}’s book hasn’t been approved for printing yet. Approve it first, or ship anyway.`, 'not_approved');
      const books = await q('SELECT * FROM books WHERE order_id = $1', [o.id], c);
      for (const b of books) await q(`UPDATE books SET stage = $2::int, stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text), stage_log = $4 WHERE id = $1`, [b.id, STAGE.SHIPPED, today(), logStage(b, STAGE.SHIPPED, req.admin, `${courier} ${awb}`, false)], c);
      if (notify) await enqueue('notify', { template: 'shipped', userId: o.user_id, orderId: o.id, data: { number: o.number, courier, awb, url: trackingUrl } }, {}, c);
      await audit(me(req), 'admin_ship', { number: o.number, courier, awb }, c);
    });
    return { ok: true };
  });

  app.post('/orders/:id/deliver', async (req) => {
    const o0 = await loadOrder(orderParam(req.params));
    const { notify } = parse(z.object({ notify: z.boolean().default(true) }), req.body);
    await tx(async c => {
      const o = await one(`UPDATE orders SET delivered_at = now(), updated_at = now() WHERE id = $1 AND shipped_at IS NOT NULL RETURNING *`, [o0.id], c);
      if (!o) throw conflict('Ship the order first.');
      const books = await q('SELECT * FROM books WHERE order_id = $1', [o.id], c);
      for (const b of books) {
        await q(`UPDATE books SET stage = $2::int, stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text), stage_log = $4 WHERE id = $1`, [b.id, STAGE.DELIVERED, today(), logStage(b, STAGE.DELIVERED, req.admin, null, false)], c);
        if (notify) await enqueue('notify', { template: 'stage_update', userId: o.user_id, orderId: o.id, data: { child: b.child_name, stage: 'Delivered' } }, {}, c);
      }
      await audit(me(req), 'admin_deliver', { number: o.number }, c);
    });
    return { ok: true };
  });

  // ================= payments (admin role) =================
  const zPayFilter = z.object({
    from: zDate.optional(), to: zDate.optional(), edition: z.enum(EDITION_KEYS as [Edition, ...Edition[]]).optional(), state: z.string().max(60).optional(),
    method: z.string().max(30).optional(), provider: z.string().max(30).optional(), kind: z.enum(['payment', 'refund']).optional(),
  });
  function payWhere(f: z.infer<typeof zPayFilter>) {
    const w: string[] = [], a: unknown[] = []; const p = (v: unknown) => { a.push(v); return `$${a.length}`; };
    if (f.from) w.push(`p.at >= (${p(f.from)}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
    if (f.to) w.push(`p.at < (${p(f.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
    if (f.edition) w.push(`EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.edition = ${p(f.edition)})`);
    if (f.state) w.push(`o.address->>'state' = ${p(f.state)}`);
    if (f.method) w.push(`p.method = ${p(f.method)}`);
    if (f.provider) w.push(`p.provider = ${p(f.provider)}`);
    if (f.kind) w.push(`p.kind = ${p(f.kind)}`);
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
  }
  const signed = `CASE WHEN p.kind = 'payment' THEN p.amount_paise ELSE -p.amount_paise END`;
  app.get('/payments', { preHandler: requireAdmin }, async (req) => {
    const f = parse(zPayFilter, req.query);
    const { sql, args } = payWhere(f);
    const from = `FROM payments p JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id ${sql}`;
    const rows = await q(`SELECT p.*, o.number, o.address->>'state' AS state, o.address->>'city' AS city, o.contact->>'name' AS customer, o.tax_paise, o.total_paise,
        (SELECT string_agg(DISTINCT i.edition, ',') FROM order_items i WHERE i.order_id = o.id) AS editions ${from} ORDER BY p.at DESC LIMIT 1000`, args);
    const tot = await one(`SELECT COALESCE(sum(p.amount_paise) FILTER (WHERE p.kind='payment'),0)::bigint AS gross, COALESCE(sum(p.amount_paise) FILTER (WHERE p.kind='refund'),0)::bigint AS refunds,
        count(*) FILTER (WHERE p.kind='payment')::int AS count,
        COALESCE(sum(round(p.amount_paise::numeric * o.tax_paise / NULLIF(o.total_paise,0))) FILTER (WHERE p.kind='payment'),0)::bigint AS gst ${from}`, args);
    const group = async (expr: string) => (await q(`SELECT ${expr} AS k, count(*) FILTER (WHERE p.kind='payment')::int AS n, COALESCE(sum(${signed}),0)::bigint AS amount ${from} GROUP BY 1 ORDER BY 3 DESC`, args))
      .map(r => ({ key: r.k ?? '—', count: r.n, amount: Number(r.amount) / 100 }));
    // Revenue by edition: each payment split across the editions in its order by list price.
    const byEdition = (await q(`SELECT i.edition AS k, count(DISTINCT p.id) FILTER (WHERE p.kind='payment')::int AS n,
        COALESCE(sum(${signed}::numeric * i.unit_price_paise / NULLIF(o.subtotal_paise,0)),0)::bigint AS amount
        FROM payments p JOIN orders o ON o.id = p.order_id JOIN order_items i ON i.order_id = o.id ${sql} GROUP BY 1 ORDER BY 3 DESC`, args))
      .map(r => ({ key: r.k, name: EDITIONS[r.k as Edition]?.name ?? r.k, count: r.n, amount: Number(r.amount) / 100 }));
    return {
      payments: rows.map(p => ({ id: p.id, kind: p.kind, at: p.at, order: p.number, orderId: p.order_id, customer: p.customer, state: p.state, city: p.city,
        editions: String(p.editions || '').split(',').filter(Boolean), provider: p.provider, method: p.method, ref: p.ref, amount: p.amount_paise / 100, note: p.note })),
      totals: { gross: Number(tot.gross) / 100, refunds: Number(tot.refunds) / 100, net: (Number(tot.gross) - Number(tot.refunds)) / 100, count: tot.count, gst: Number(tot.gst) / 100 },
      byEdition, byState: await group(`o.address->>'state'`), byMethod: await group(`COALESCE(p.method, p.provider)`),
      byDay: await group(`to_char(p.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`).then(r => r.sort((a, b) => a.key.localeCompare(b.key))),
    };
  });
  app.get('/payments.csv', { preHandler: requireAdmin }, async (req, reply) => {
    const f = parse(zPayFilter, req.query);
    const { sql, args } = payWhere(f);
    const rows = await q(`SELECT p.*, o.number, o.address->>'state' AS state, o.address->>'city' AS city, o.contact->>'name' AS customer, o.contact->>'email' AS email,
        (SELECT string_agg(DISTINCT i.edition, ' ') FROM order_items i WHERE i.order_id = o.id) AS editions
      FROM payments p JOIN orders o ON o.id = p.order_id ${sql} ORDER BY p.at`, args);
    const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [['Date (IST)', 'Type', 'Order', 'Customer', 'Email', 'City', 'State', 'Editions', 'Provider', 'Method', 'Reference', 'Amount (INR)', 'Note'].join(',')]
      .concat(rows.map(p => [new Date(p.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), p.kind, p.number, p.customer, p.email, p.city, p.state, p.editions, p.provider, p.method, p.ref,
        (p.kind === 'refund' ? -1 : 1) * p.amount_paise / 100, p.note].map(cell).join(','))).join('\n');
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="thulori-payments-${today()}.csv"`).send('﻿' + csv);
  });

  // ================= books =================
  const loadBook = async (id: string) => { const b = await one(`SELECT b.*, o.number, o.status AS order_status, o.user_id AS owner FROM books b JOIN orders o ON o.id = b.order_id WHERE b.id = $1`, [id]); if (!b) throw notFound(); return b; };

  app.get('/books/:id', async (req) => {
    const b = await loadBook(idParam(req.params));
    const photos = await q(`SELECT * FROM photos WHERE book_id = $1 AND status = 'uploaded' ORDER BY position, created_at`, [b.id]);
    const cards = await q(`SELECT * FROM cards WHERE book_id = $1 ORDER BY kind, created_at`, [b.id]);
    const rounds = await q(`SELECT * FROM proof_rounds WHERE book_id = $1 ORDER BY round`, [b.id]);
    const notes = await q(`SELECT n.* FROM proof_notes n JOIN proof_rounds r ON r.id = n.round_id WHERE r.book_id = $1 ORDER BY n.page_index, n.created_at`, [b.id]);
    const idx = new Map(photos.map((p, i) => [p.id, i + 1]));
    const st = storage();
    return {
      book: { id: b.id, order: b.number, orderId: b.order_id, child: b.child_name, edition: b.edition, editionName: EDITIONS[b.edition as Edition]?.name, maxPhotos: EDITIONS[b.edition as Edition]?.photos,
        revisionRounds: EDITIONS[b.edition as Edition]?.revisionRounds, stage: b.stage, stageName: STAGES[b.stage], dates: b.stage_dates, log: b.stage_log, letter: b.letter, submittedAt: b.submitted_at, read: { status: b.read_status, progress: b.read_progress, error: b.read_error } },
      photos: await Promise.all(photos.map(async (p, i) => ({ n: i + 1, id: p.id, name: p.file_name, mime: p.mime, bytes: p.bytes, takenOn: p.taken_on, fav: p.fav, scene: p.analysis?.scene ?? null,
        view: await st.readUrl(p.storage_key), download: await st.readUrl(p.storage_key, { download: `${String(i + 1).padStart(3, '0')}-${p.file_name || p.id}` }) }))),
      cards: cards.map(c => ({ id: c.id, kind: c.kind, photos: (c.photo_ids as string[]).map(id => idx.get(id)).filter(Boolean), topic: c.topic, obs: c.obs, q: c.question, options: c.options, pick: c.pick, text: c.answer, source: c.source })),
      rounds: await Promise.all(rounds.map(async r => ({ id: r.id, round: r.round, status: r.status, sentAt: r.created_at, decidedAt: r.decided_at,
        pages: await Promise.all((r.pages as string[]).map(k => st.readUrl(k))),
        notes: notes.filter(n => n.round_id === r.id).map(n => ({ page: n.page_label, at: n.page_index, text: n.body, sent: n.sent })) }))),
    };
  });

  // Manual checkpoint: move a book to any stage, with a reason (shown on the timeline).
  app.post('/books/:id/stage', async (req) => {
    const b = await loadBook(idParam(req.params));
    const { stage, note, notify } = parse(z.object({ stage: z.number().int().min(0).max(6), note: z.string().trim().max(500).optional(), notify: z.boolean().default(true) }), req.body);
    if (b.order_status !== 'paid') throw conflict('Mark the order as paid first.');
    if (stage === STAGE.PROOF) throw badRequest('To send a proof, upload the pages. If the customer approved a proof outside the site, use “Record customer’s decision”.');
    if (stage === STAGE.SHIPPED) throw badRequest('Use “Ship order” with the courier and tracking number.');
    if (stage === b.stage) throw badRequest('The book is already at that stage.');
    await tx(async c => {
      await q(`UPDATE books SET stage = $2::int, stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text), stage_log = $4,
                 submitted_at = CASE WHEN $2::int >= 1 THEN COALESCE(submitted_at, now()) ELSE NULL END WHERE id = $1`, [b.id, stage, today(), logStage(b, stage, req.admin, note)], c);
      if (notify && stage > 0) await enqueue('notify', { template: 'stage_update', userId: b.owner, orderId: b.order_id, data: { child: b.child_name, stage: STAGES[stage] } }, {}, c);
      await audit(me(req), 'admin_stage', { book: b.id, number: b.number, from: b.stage, to: stage, note }, c);
    });
    return { ok: true };
  });

  // Photos received outside the site (WhatsApp, Drive, email): upload them on the customer's behalf.
  app.post('/books/:id/photos/uploads', async (req) => {
    const b = await loadBook(idParam(req.params));
    const body = parse(z.object({ files: z.array(z.object({ name: z.string().max(200).default(''), type: z.string().refine(t => (ALLOWED_IMAGE_TYPES as readonly string[]).includes(t), 'JPG, PNG, WebP or HEIC only.'), size: z.number().int().positive().max(60 * 1024 * 1024), takenOn: zDate.nullable().optional() })).min(1).max(50) }), req.body);
    const max = await one(`SELECT count(*)::int AS n, COALESCE(max(position),0) AS pos FROM photos WHERE book_id = $1`, [b.id]);
    let pos = max.pos; const out = [];
    for (const f of body.files) {
      const id = randomUUID(), key = `books/${b.id}/${id}.${extFor(f.type)}`;
      await q(`INSERT INTO photos(id, book_id, storage_key, file_name, mime, bytes, taken_on, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, b.id, key, f.name, f.type, f.size, f.takenOn ?? null, ++pos]);
      out.push({ id, upload: await storage().uploadUrl(key, f.type, f.size) });
    }
    return { uploads: out };
  });
  app.post('/books/:id/photos/complete', async (req) => {
    const b = await loadBook(idParam(req.params));
    const { ids } = parse(z.object({ ids: z.array(zUuid).min(1).max(50) }), req.body);
    const rows = await q(`SELECT * FROM photos WHERE book_id = $1 AND id = ANY($2::uuid[]) AND status = 'pending'`, [b.id, ids]);
    let n = 0;
    for (const p of rows) { const s = await storage().exists(p.storage_key); if (s) { await q(`UPDATE photos SET status = 'uploaded', bytes = $2 WHERE id = $1`, [p.id, s.bytes]); n++; } }
    await audit(me(req), 'admin_photos_added', { book: b.id, number: b.number, count: n });
    return { uploaded: n };
  });
  app.delete('/photos/:id', async (req) => {
    const p = await one('SELECT * FROM photos WHERE id = $1', [idParam(req.params)]);
    if (!p) throw notFound();
    await tx(async c => {
      await q(`DELETE FROM cards WHERE book_id = $1 AND kind = 'photo' AND photo_ids[1] = $2`, [p.book_id, p.id], c);
      await q(`UPDATE cards SET photo_ids = array_remove(photo_ids, $2) WHERE book_id = $1 AND $2 = ANY(photo_ids)`, [p.book_id, p.id], c);
      await q('DELETE FROM photos WHERE id = $1', [p.id], c);
    });
    await storage().remove(p.storage_key).catch(() => {});
    await audit(me(req), 'admin_photo_removed', { book: p.book_id });
    return { ok: true };
  });
  app.post('/books/:id/read', async (req) => {
    const b = await loadBook(idParam(req.params));
    await tx(async c => {
      await q(`UPDATE books SET read_status = 'queued', read_error = NULL, read_started_at = now() WHERE id = $1`, [b.id], c);
      await enqueue('read_photos', { bookId: b.id, force: true }, { maxAttempts: 2 }, c);
    });
    return { ok: true };
  });

  // Answers or a letter received outside the site.
  app.patch('/cards/:id', async (req) => {
    const c0 = await one('SELECT c.*, b.order_id FROM cards c JOIN books b ON b.id = c.book_id WHERE c.id = $1', [idParam(req.params)]);
    if (!c0) throw notFound();
    const b = parse(z.object({ pick: z.number().int().min(0).max(2).nullable().optional(), text: z.string().max(4000).optional() }), req.body);
    await q(`UPDATE cards SET pick = CASE WHEN $2 THEN $3::smallint ELSE pick END, answer = COALESCE($4, answer), answered_at = now() WHERE id = $1`, [c0.id, b.pick !== undefined, b.pick ?? null, b.text ?? null]);
    return { ok: true };
  });
  app.patch('/books/:id', async (req) => {
    const b = await loadBook(idParam(req.params));
    const body = parse(z.object({ letter: z.string().max(4000).optional(), childName: zName.optional() }), req.body);
    await q(`UPDATE books SET letter = COALESCE($2, letter), child_name = COALESCE($3, child_name) WHERE id = $1`, [b.id, body.letter ?? null, body.childName ?? null]);
    if (body.childName) await q('UPDATE order_items SET child_name = $2 WHERE book_id = $1', [b.id, body.childName]);
    await audit(me(req), 'admin_book_edit', { book: b.id, number: b.number, fields: Object.keys(body) });
    return { ok: true };
  });

  // Downloads for the writer / designer.
  app.get('/books/:id/photos.zip', async (req, reply: FastifyReply) => {
    const b = await loadBook(idParam(req.params));
    const photos = await q(`SELECT * FROM photos WHERE book_id = $1 AND status = 'uploaded' ORDER BY position, created_at`, [b.id]);
    const zip = archiver('zip', { store: true });
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${b.number}-${b.child_name.replace(/[^\w-]+/g, '_')}-photos.zip"`);
    (async () => {
      try {
        for (const [i, p] of photos.entries()) zip.append(await storage().get(p.storage_key), { name: `${String(i + 1).padStart(3, '0')}${p.fav ? '-fav' : ''}-${(p.file_name || p.id).replace(/[^\w.\- ]+/g, '_')}` });
        await zip.finalize();
      } catch (e) { zip.abort(); req.log.error(e); }
    })();
    return reply.send(zip);
  });
  app.get('/books/:id/stories.txt', async (req, reply) => {
    const b = await loadBook(idParam(req.params));
    const photos = await q(`SELECT id, file_name, taken_on, fav, analysis FROM photos WHERE book_id = $1 AND status = 'uploaded' ORDER BY position, created_at`, [b.id]);
    const idx = new Map(photos.map((p, i) => [p.id, i + 1]));
    const cards = await q(`SELECT * FROM cards WHERE book_id = $1 ORDER BY kind DESC, created_at`, [b.id]);
    const ans = (c: any) => [c.pick != null ? (c.options as string[])[c.pick] : null, c.answer || null].filter(Boolean).join(' — ');
    const out = [`${b.child_name}’s storybook — ${EDITIONS[b.edition as Edition]?.name} edition — order ${b.number}`, `Exported ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, ''];
    out.push('== Photo by photo ==', '');
    for (const c of cards.filter(c => c.kind === 'photo').sort((x, y) => (idx.get(x.photo_ids[0]) ?? 0) - (idx.get(y.photo_ids[0]) ?? 0))) {
      const p = photos.find(x => x.id === c.photo_ids[0]);
      out.push(`Photo ${idx.get(c.photo_ids[0]) ?? '?'}${p?.file_name ? ` (${p.file_name})` : ''}${p?.taken_on ? ` · ${p.taken_on}` : ''}${p?.fav ? ' · ★ favourite' : ''}`);
      if (p?.analysis?.scene) out.push(`  Seen: ${p.analysis.scene}`);
      out.push(`  Q: ${c.question}`, `  A: ${ans(c) || '(not answered)'}`, '');
    }
    out.push('== Things that keep showing up ==', '');
    for (const c of cards.filter(c => c.kind === 'theme')) out.push(`${c.topic || 'Theme'} — photos ${(c.photo_ids as string[]).map(id => idx.get(id)).filter(Boolean).join(', ')}`, `  ${c.obs}`, `  Q: ${c.question}`, `  A: ${ans(c) || '(not answered)'}`, '');
    out.push('== Letter to the future ==', '', b.letter || '(none)', '');
    return reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="${b.number}-${b.child_name.replace(/[^\w-]+/g, '_')}-stories.txt"`).send(out.join('\n'));
  });

  // ---- proof: 1) upload URLs for the page images (in order)  2) PUT them  3) send the round
  app.post('/books/:id/proof/uploads', async (req) => {
    const id = idParam(req.params);
    const { files } = parse(z.object({ files: z.array(z.object({ type: z.enum(ALLOWED_PROOF_TYPES as unknown as [string, ...string[]]), size: z.number().int().positive().max(40 * 1024 * 1024) })).min(1).max(200) }), req.body);
    await loadBook(id);
    const r = await one('SELECT COALESCE(max(round), 0) + 1 AS n FROM proof_rounds WHERE book_id = $1', [id]);
    const stamp = Date.now();
    return { uploads: await Promise.all(files.map(async (f, i) => {
      const key = `proofs/${id}/r${r.n}-${stamp}/${String(i + 1).padStart(3, '0')}.${extFor(f.type)}`;
      return { key, upload: await storage().uploadUrl(key, f.type, f.size) };
    })) };
  });
  app.post('/books/:id/proof', async (req) => {
    const id = idParam(req.params);
    const { keys, notify } = parse(z.object({ keys: z.array(z.string().startsWith(`proofs/${id}/`)).min(1).max(200), notify: z.boolean().default(true) }), req.body);
    for (const k of keys) if (!(await storage().exists(k))) throw badRequest('Some pages didn’t finish uploading — try again.');
    const b = await loadBook(id);
    if (b.order_status !== 'paid') throw conflict('Mark the order as paid first.');
    if (b.stage < STAGE.WRITING || b.stage > STAGE.PROOF) throw conflict('Proofs can be sent while the book is being written or designed.');
    const round = await tx(async c => {
      if (await one(`SELECT 1 FROM proof_rounds WHERE book_id = $1 AND status = 'ready'`, [id], c)) throw conflict('The customer hasn’t answered the current proof yet. Record their decision first.');
      const r = await one(`INSERT INTO proof_rounds(book_id, round, pages) VALUES ($1, (SELECT COALESCE(max(round),0)+1 FROM proof_rounds WHERE book_id = $1), $2) RETURNING round`, [id, JSON.stringify(keys)], c);
      await q(`UPDATE books SET stage = $2::int, stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text), stage_log = $4 WHERE id = $1`, [id, STAGE.PROOF, today(), logStage(b, STAGE.PROOF, req.admin, `Proof round ${r.round} sent (${keys.length} pages)`, false)], c);
      if (notify) await enqueue('notify', { template: 'proof_ready', userId: b.owner, orderId: b.order_id, data: { child: b.child_name, round: r.round } }, {}, c);
      await audit(me(req), 'admin_proof', { book: id, number: b.number, round: r.round, pages: keys.length }, c);
      return r.round;
    });
    return { round };
  });

  // The customer answered the proof outside the site (WhatsApp, call): record it for them.
  app.post('/books/:id/proof/decision', async (req) => {
    const b = await loadBook(idParam(req.params));
    const { decision, notes, note, notify } = parse(z.object({ decision: z.enum(['approved', 'changes']), notes: z.string().trim().max(4000).optional(), note: z.string().trim().max(500).optional(), notify: z.boolean().default(true) }), req.body);
    if (b.order_status !== 'paid') throw conflict('Mark the order as paid first.');
    if (decision === 'changes' && !notes) throw badRequest('Write down the changes the customer asked for.');
    const to = decision === 'approved' ? STAGE.PRINTING : STAGE.DESIGN;
    await tx(async c => {
      let r = await one(`SELECT * FROM proof_rounds WHERE book_id = $1 AND status = 'ready' ORDER BY round DESC LIMIT 1`, [b.id], c);
      if (!r) r = await one(`INSERT INTO proof_rounds(book_id, round, pages) VALUES ($1, (SELECT COALESCE(max(round),0)+1 FROM proof_rounds WHERE book_id = $1), '[]') RETURNING *`, [b.id], c);
      await q(`UPDATE proof_rounds SET status = $2, decided_at = now() WHERE id = $1`, [r.id, decision === 'approved' ? 'approved' : 'changes_requested'], c);
      if (notes) await q(`INSERT INTO proof_notes(round_id, page_index, page_label, body, sent) VALUES ($1, 0, 'Recorded by the team', $2, true)`, [r.id, notes], c);
      await q(`UPDATE books SET stage = $2::int, stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text), stage_log = $4 WHERE id = $1`,
        [b.id, to, today(), logStage(b, to, req.admin, `Customer ${decision === 'approved' ? 'approved' : 'asked for changes to'} proof round ${r.round} outside the site${note ? ' — ' + note : ''}`)], c);
      if (notify && decision === 'approved') await enqueue('notify', { template: 'stage_update', userId: b.owner, orderId: b.order_id, data: { child: b.child_name, stage: 'Printing' } }, {}, c);
      await audit(me(req), 'admin_proof_decision', { book: b.id, number: b.number, round: r.round, decision, note }, c);
    });
    return { ok: true };
  });

  // ================= customers & messages =================
  app.get('/customers', async (req) => {
    const { q: term } = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const t = `%${term ?? ''}%`;
    const rows = await q(`SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at, count(o.id)::int AS orders, COALESCE(sum(o.total_paise) FILTER (WHERE o.status = 'paid'),0)::bigint AS spent
      FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.role = 'customer' AND u.status <> 'deleted' AND (u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1)
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`, [t]);
    return { customers: rows.map(r => ({ ...r, spent: Number(r.spent) / 100 })) };
  });
}
