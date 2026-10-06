import type { FastifyInstance } from 'fastify';
import { one, q, tx } from '../db.js';
import { config } from '../config.js';
import { payments } from '../services/payments/index.js';
import { markAttemptFailed, recordGatewayPayment } from '../lib/orders.js';
import { applyRefundResult } from '../lib/refunds.js';

export async function webhookRoutes(app: FastifyInstance) {
  // Cashfree payment webhooks. Configure in Cashfree dashboard → Developers → Webhooks:
  //   URL  {API_URL}/api/webhooks/cashfree   events: Payment success / failed / user dropped
  // Signature is checked over the raw body; handling is idempotent.
  const handle = async (req: any, reply: any) => {
    const ev = payments().verifyWebhook(req.rawBody ?? '', req.headers);
    if (!ev) { req.log.warn('webhook signature rejected'); return reply.status(401).send({ ok: false }); }
    const provider = config().PAYMENTS_DRIVER;
    if (ev.kind === 'payment') {
      const a = await one(`SELECT order_id FROM payment_attempts WHERE provider_order_id = $1`, [ev.providerOrderId]);
      await q(`INSERT INTO payment_events(provider, event_type, order_id, payload) VALUES ($1,$2,$3,$4)`, [provider, ev.type, a?.order_id ?? null, ev.raw]);
      if (!a) { req.log.warn({ order: ev.providerOrderId }, 'payment webhook for an unknown order'); return { ok: true }; } // acknowledge so the gateway stops retrying
      if (ev.payment.state === 'success') await recordGatewayPayment(provider, ev.providerOrderId, ev.payment);
      else if (ev.payment.state === 'failed') await markAttemptFailed(ev.providerOrderId);
      return { ok: true };
    }
    if (ev.kind === 'refund') {
      const a = await one(`SELECT order_id FROM payment_attempts WHERE provider_order_id = $1`, [ev.providerOrderId]);
      await q(`INSERT INTO payment_events(provider, event_type, order_id, payload) VALUES ($1,$2,$3,$4)`, [provider, ev.type, a?.order_id ?? null, ev.raw]);
      const mine = await one(`SELECT id FROM refunds WHERE replace(id::text, '-', '') = $1 OR provider_refund_id = $1`, [ev.refundId.replace(/-/g, '')]);
      if (mine) await applyRefundResult(mine.id, ev.result);
      else if (ev.auto && a && ev.result.state === 'succeeded' && ev.amountPaise) {
        // Cashfree refunded a payment by itself (e.g. a payment that arrived after the gateway order closed).
        await tx(async c => {
          const r = await one(`INSERT INTO refunds(order_id, provider, provider_order_id, amount_paise, status, reason, provider_refund_id, arn, completed_at)
                               VALUES ($1,$2,$3,$4,'succeeded','Automatic refund by Cashfree',$5,$6,now()) RETURNING *`, [a.order_id, provider, ev.providerOrderId, ev.amountPaise, ev.refundId, ev.result.arn ?? null], c);
          await q(`INSERT INTO payments(order_id, kind, provider, amount_paise, ref, note, provider_order_id) VALUES ($1,'refund',$2,$3,$4,'Automatic refund by Cashfree',$5)`, [a.order_id, provider, ev.amountPaise, ev.result.arn ?? ev.refundId, ev.providerOrderId], c);
          await q(`UPDATE orders SET refunded_paise = refunded_paise + $2, updated_at = now() WHERE id = $1`, [a.order_id, ev.amountPaise], c);
          await q(`INSERT INTO audit_log(action, meta) VALUES ('auto_refund', $1)`, [{ refund: r.id, amount: ev.amountPaise }], c);
        });
      } else req.log.warn({ refund: ev.refundId }, 'refund webhook for an unknown refund');
      return { ok: true };
    }
    await q(`INSERT INTO payment_events(provider, event_type, payload) VALUES ($1,$2,$3)`, [provider, ev.type || 'unknown', ev.raw]);
    return { ok: true };
  };
  app.post('/cashfree', handle);
  app.post('/mock', handle); // only verifies with the mock driver

  // WhatsApp Cloud API webhook verification handshake (Meta app → WhatsApp → Configuration).
  app.get('/whatsapp', async (req, reply) => {
    const qs = req.query as Record<string, string>;
    if (qs['hub.mode'] === 'subscribe' && config().WA_VERIFY_TOKEN && qs['hub.verify_token'] === config().WA_VERIFY_TOKEN) return reply.type('text/plain').send(qs['hub.challenge'] ?? '');
    return reply.status(403).send('forbidden');
  });
  // Incoming WhatsApp messages / delivery statuses: logged for the team; replies happen in WhatsApp Business.
  app.post('/whatsapp', async (req) => {
    const entry = (req.body as any)?.entry?.[0]?.changes?.[0]?.value;
    if (entry?.messages?.length) req.log.info({ from: entry.messages[0].from, type: entry.messages[0].type }, 'whatsapp message received');
    return { ok: true };
  });
}
