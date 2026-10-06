import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireUser } from '../auth/index.js';
import { parse, zEmail, zName, zPhone } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { insertItems, priceItems, zItems } from '../lib/basket.js';
import { config } from '../config.js';
import { MockPayments, payments } from '../services/payments/index.js';
import { orderState } from '../state.js';
import { inr, recordGatewayPayment, refreshPayment } from '../lib/orders.js';
import { orderAmounts } from '../lib/money.js';
import { zAddress } from './me.js';
import { enqueue } from '../lib/jobs.js';

const zCheckout = z.object({
  items: zItems, // one entry per storybook
  giftNote: z.string().trim().max(300).optional(),
  address: zAddress.omit({ def: true, label: true }).extend({ save: z.boolean().default(true) }),
  contact: z.object({ name: zName, email: zEmail, phone: zPhone }),
});

const byNumberOrId = (id: string) => /^TH-\d+$/i.test(id) ? 'number = upper($1)' : 'id::text = $1';

export async function orderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  async function startPayment(o: any) {
    const c = config();
    const p = await payments().create({
      orderId: o.attempt ? `${o.number}-${o.attempt}` : o.number,
      amountPaise: o.total_paise,
      customer: { id: o.user_id, name: o.contact.name, email: o.contact.email, phone: o.contact.phone },
      returnUrl: `${c.SITE_URL.replace(/\/$/, '')}/order-confirmation.html?order=${encodeURIComponent(o.number)}`,
      notifyUrl: `${c.API_URL.replace(/\/$/, '')}/api/webhooks/cashfree`,
    });
    await q(`UPDATE orders SET payment_provider = $2, provider_order_id = $3, payment_session_id = $4, updated_at = now() WHERE id = $1`, [o.id, p.provider, p.providerOrderId, p.sessionId]);
    await q(`INSERT INTO payment_attempts(order_id, provider, provider_order_id, amount_paise) VALUES ($1,$2,$3,$4) ON CONFLICT (provider_order_id) DO NOTHING`, [o.id, p.provider, p.providerOrderId, o.total_paise]);
    return { provider: p.provider, sessionId: p.sessionId, mode: p.mode };
  }

  // Create an order from the cart. Prices come from the catalog, never from the browser.
  app.post('/', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = parse(zCheckout, req.body);
    const uid = req.user!.id;
    const basket = priceItems(b.items);
    const amt = orderAmounts(basket.subtotalPaise);
    const subtotal = amt.subtotal;
    const addr = { to: b.address.to, line1: b.address.line1, line2: b.address.line2, city: b.address.city, state: b.address.state, pin: b.address.pin, phone: b.address.phone ?? b.contact.phone };
    const order = await tx(async c => {
      const o = await one(`INSERT INTO orders(user_id, subtotal_paise, tax_paise, total_paise, gst_rate, gift_note, address, contact, payment_provider)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [uid, subtotal, amt.tax, amt.total, amt.rate, b.giftNote || null, addr, b.contact, config().PAYMENTS_DRIVER], c);
      await insertItems(c, o.id, uid, basket.priced);
      if (b.address.save) {
        const same = await one(`SELECT 1 FROM addresses WHERE user_id = $1 AND line1 = $2 AND pin = $3`, [uid, addr.line1, addr.pin], c);
        if (!same) {
          const n = await one('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1', [uid], c);
          await q(`INSERT INTO addresses(user_id,label,recipient,line1,line2,city,state,pin,phone,is_default) VALUES ($1,'Home',$2,$3,$4,$5,$6,$7,$8,$9)`,
            [uid, addr.to, addr.line1, addr.line2, addr.city, addr.state, addr.pin, addr.phone, n.n === 0], c);
        }
      }
      await q(`UPDATE users SET phone = COALESCE(phone, $2) WHERE id = $1`, [uid, b.contact.phone], c).catch(() => {});
      await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'order_created',$2)`, [uid, { number: o.number, total: amt.total }], c);
      return o;
    });
    let payment;
    try { payment = await startPayment(order); }
    catch (e) {
      req.log.error(e);
      throw conflict('We couldn’t reach the payment gateway. Your order is saved — please try paying again in a minute.', 'gateway_unavailable');
    }
    await enqueue('notify', { template: 'order_placed', userId: uid, orderId: order.id, data: { number: order.number, total: inr(amt.total) } }, { runAt: new Date(Date.now() + 30 * 60_000) });
    return reply.status(201).send({ order: await orderState(await one('SELECT * FROM orders WHERE id = $1', [order.id])), payment });
  });

  app.get('/', async (req) => {
    const rows = await q(`SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC`, [req.user!.id]);
    return { orders: await Promise.all(rows.map(orderState)) };
  });

  // Also used by the confirmation page after the gateway redirect: re-checks with the gateway.
  app.get('/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().max(60) }), req.params);
    let o = await one(`SELECT * FROM orders WHERE ${byNumberOrId(id)} AND user_id = $2`, [id, req.user!.id]);
    if (!o) throw notFound('We couldn’t find that order.');
    o = await refreshPayment(o);
    // processing: the bank hasn't confirmed yet (common with UPI) — the page tells the customer not to pay again
    return { order: { ...(await orderState(o)), processing: !!o.processing } };
  });

  // Retry payment for an unpaid order (new gateway order id, fresh session).
  app.post('/:id/pay', async (req) => {
    const { id } = parse(z.object({ id: z.string().max(60) }), req.params);
    let o = await one(`SELECT * FROM orders WHERE ${byNumberOrId(id)} AND user_id = $2`, [id, req.user!.id]);
    if (!o) throw notFound('We couldn’t find that order.');
    o = await refreshPayment(o);
    if (o.status === 'paid') return { order: await orderState(o), payment: null };
    if (o.status !== 'pending_payment' && o.status !== 'failed') throw conflict('This order can’t be paid any more.');
    // A payment still waiting at the bank must not be paid again — that is how customers get charged twice.
    if (o.processing) throw conflict('Your last payment is still being confirmed by your bank. Please wait a few minutes before trying again — you won’t be charged twice.', 'payment_processing');
    const attempt = await one(`SELECT count(*)::int AS n FROM payment_attempts WHERE order_id = $1`, [o.id]);
    await q(`UPDATE orders SET status = 'pending_payment' WHERE id = $1`, [o.id]);
    let payment;
    try { payment = await startPayment({ ...o, attempt: attempt.n + 1 }); }
    catch (e) { req.log.error(e); throw conflict('We couldn’t reach the payment gateway. Please try again in a minute.', 'gateway_unavailable'); }
    return { order: await orderState(await one('SELECT * FROM orders WHERE id = $1', [o.id])), payment };
  });

  app.post('/:id/cancel', async (req) => {
    const { id } = parse(z.object({ id: z.string().max(60) }), req.params);
    const found = await one(`SELECT * FROM orders WHERE ${byNumberOrId(id)} AND user_id = $2`, [id, req.user!.id]);
    if (!found) throw notFound('We couldn’t find that order.');
    const fresh = await refreshPayment(found); // they may have paid a moment ago
    if (fresh.processing) throw conflict('Your payment is still being confirmed by your bank. Please wait a few minutes.', 'payment_processing');
    const o = await one(`UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by the customer', updated_at = now()
                         WHERE id = $1 AND status IN ('pending_payment','failed') RETURNING number`, [found.id]);
    if (!o) throw conflict('Only unpaid orders can be cancelled here. For paid orders, message us.');
    await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'order_cancelled_by_customer',$2)`, [req.user!.id, { number: o.number }]);
    return { ok: true };
  });

  // Development / demo only: complete a mock payment.
  app.post('/:id/mock-pay', async (req) => {
    if (config().NODE_ENV === 'production' || config().PAYMENTS_DRIVER !== 'mock') throw forbidden('Mock payments are disabled.');
    const { id } = parse(z.object({ id: z.string().max(60) }), req.params);
    const o = await one(`SELECT * FROM orders WHERE ${byNumberOrId(id)} AND user_id = $2`, [id, req.user!.id]);
    if (!o) throw notFound();
    if (!o.provider_order_id) throw badRequest('No payment started for this order.');
    await recordGatewayPayment('mock', o.provider_order_id, MockPayments.pay(o.provider_order_id, o.total_paise));
    return { order: await orderState(await one('SELECT * FROM orders WHERE id = $1', [o.id])) };
  });
}
