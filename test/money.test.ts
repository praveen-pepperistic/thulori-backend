// Money safety: payments counted once whatever path reports them, problems become issues for the
// team, and refunds go back through the gateway (pending → succeeded / failed, retried, re-sent).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closeDb, db, one, q } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { drain } from '../src/lib/jobs.js';
import { handlers } from '../src/worker.js';
import { hashPassword } from '../src/auth/index.js';
import { hmac } from '../src/lib/crypto.js';
import { MockPayments } from '../src/services/payments/index.js';
import { reconcile } from '../src/services/reconcile.js';

let app: FastifyInstance;
const ORIGIN = 'http://site.test';
const sent: any[] = [];
const work = () => drain({ ...handlers({ info: () => {}, error: console.error }), notify: async (p: any) => { sent.push(p); } });
async function call(method: string, url: string, o: { body?: any; cookie?: string; raw?: Buffer; headers?: Record<string, string>; origin?: string | null } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.cookie = o.cookie;
  const r = await app.inject({ method: method as any, url, headers, payload: o.raw ?? o.body });
  const set = r.cookies.find(c => c.name === 'thulori_admin' || c.name === 'thulori_sid');
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body, cookie: set ? `${set.name}=${set.value}` : undefined };
}
async function adminLogin(email: string, password: string) {
  const ch = await call('POST', '/api/admin/auth/login', { body: { email, password } });
  await work();
  const code = sent.filter(p => p.template === 'admin_code' && p.to.email === email).at(-1).data.code;
  return (await call('POST', '/api/admin/auth/verify', { body: { challenge: ch.body.challenge, code } })).cookie!;
}
const webhook = (ev: object) => { const raw = JSON.stringify(ev); return call('POST', '/api/webhooks/mock', { origin: null, raw: Buffer.from(raw), headers: { 'content-type': 'application/json', 'x-mock-signature': hmac('test-secret-test-secret-test-secret-123', raw) } }); };
// Make everything due for the background check (it skips attempts younger than 2 minutes and recently checked items).
const due = async () => {
  await q(`UPDATE payment_attempts SET created_at = created_at - interval '5 minutes', last_checked_at = NULL`);
  await q(`UPDATE refunds SET last_checked_at = NULL`);
};
const tick = async () => { await due(); const r = await reconcile(); await work(); return r; };
const templates = (t: string) => sent.filter(p => p.template === t);

let owner = '', cust = '';
const address = { to: 'Kavya', line1: '4 Temple St', city: 'Madurai', state: 'Tamil Nadu', pin: '625001' };
const contact = { name: 'Kavya R', email: 'kavya@example.com', phone: '9876500011' };
async function newOrder() {
  const r = await call('POST', '/api/orders', { cookie: cust, body: { items: [{ edition: 'thulir', childName: 'Mira' }], address, contact } });
  expect(r.status).toBe(201);
  const o = await one('SELECT * FROM orders WHERE number = $1', [r.body.order.id]);
  return { number: o.number as string, id: o.id as string, total: o.total_paise as number };
}
const order = (n: string) => one('SELECT * FROM orders WHERE number = $1', [n]);
const detail = async (n: string) => (await call('GET', `/api/admin/orders/${n}`, { cookie: owner })).body;

beforeAll(async () => {
  await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  MockPayments.reset();
  app = await buildApp({ logger: false });
  await q(`INSERT INTO users(email, name, password_hash, role) VALUES ('owner@thulori.in','Praveen',$1,'admin')`, [await hashPassword('owner-password-1')]);
  owner = await adminLogin('owner@thulori.in', 'owner-password-1');
  cust = (await call('POST', '/api/auth/signup', { body: { ...contact, password: 'little1234', acceptTerms: true } })).cookie!;
});
afterAll(async () => { await app?.close(); await closeDb(); });

describe('payments that go wrong', () => {
  it('a lost webhook is caught by the background check, and counted once', async () => {
    const o = await newOrder();
    MockPayments.pay(o.number, o.total); // customer paid; the webhook never arrives and the tab was closed
    expect((await order(o.number)).status).toBe('pending_payment');
    await tick();
    expect((await order(o.number)).status).toBe('paid');
    await tick(); // and again — nothing doubles
    await webhook({ orderId: o.number, ref: `mockpay_${o.number}_1`, state: 'paid', amountPaise: o.total }); // late webhook
    await work();
    expect((await one(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1`, [o.id])).n).toBe(1);
    expect(templates('order_paid').filter(p => p.data.number === o.number)).toHaveLength(1);
  });

  it('a payment still at the bank blocks paying again, then completes', async () => {
    const o = await newOrder();
    MockPayments.pay(o.number, o.total, { state: 'pending' });
    const g = await call('GET', `/api/orders/${o.number}`, { cookie: cust });
    expect(g.body.order.processing).toBe(true);
    const again = await call('POST', `/api/orders/${o.number}/pay`, { cookie: cust });
    expect(again.status).toBe(409);
    expect(again.body.code ?? again.body.error?.code).toBe('payment_processing');
    expect((await call('POST', `/api/orders/${o.number}/cancel`, { cookie: cust })).status).toBe(409);
    MockPayments.entry(o.number).payments[0]!.state = 'success'; // the bank confirms
    const done = await call('GET', `/api/orders/${o.number}`, { cookie: cust });
    expect(done.body.order).toMatchObject({ status: 'paid', processing: false });
  });

  let dupOrder = '', dupPayment = '';
  it('paying twice (two attempts) raises a duplicate-payment issue for the team', async () => {
    const o = await newOrder(); dupOrder = o.number;
    MockPayments.pay(o.number, o.total, { state: 'failed' });
    expect((await call('GET', `/api/orders/${o.number}`, { cookie: cust })).body.order.status).toBe('failed');
    const retry = await call('POST', `/api/orders/${o.number}/pay`, { cookie: cust });
    expect(retry.status).toBe(200);
    expect((await order(o.number)).provider_order_id).toBe(`${o.number}-2`);
    // the first payment page was still open in another tab and went through too
    MockPayments.pay(o.number, o.total);
    MockPayments.pay(`${o.number}-2`, o.total);
    await tick();
    const d = await detail(o.number);
    expect(d.order.status).toBe('paid');
    expect(d.payments.filter((p: any) => p.kind === 'payment')).toHaveLength(2);
    expect(d.issues).toHaveLength(1);
    expect(d.issues[0]).toMatchObject({ kind: 'duplicate_payment', status: 'open', amount: o.total / 100 });
    dupPayment = d.issues[0].paymentId;
    expect(templates('team_alert').some(p => p.data.number === o.number && p.data.kind === 'duplicate_payment')).toBe(true);
    const s = await call('GET', '/api/admin/summary', { cookie: owner });
    expect(s.body.buckets.attention.count).toBeGreaterThanOrEqual(1);
  });

  it('refunding the extra payment goes through the gateway: pending → succeeded', async () => {
    const r = await call('POST', `/api/admin/orders/${dupOrder}/refund`, { cookie: owner, body: { amount: 8258.82, reason: 'Paid twice', paymentId: dupPayment } });
    expect(r.status).toBe(200);
    expect(r.body.refunds[0]).toMatchObject({ status: 'pending', provider: 'mock', amount: 8258.82 });
    await work();
    expect(templates('refund_started').some(p => p.data.number === dupOrder)).toBe(true);
    // can't refund the same money twice while it's on its way
    expect((await call('POST', `/api/admin/orders/${dupOrder}/refund`, { cookie: owner, body: { amount: 1, reason: 'again', paymentId: dupPayment } })).status).toBe(400);
    await tick(); // background check asks the gateway → settled
    const d = await detail(dupOrder);
    expect(d.refunds[0]).toMatchObject({ status: 'succeeded' });
    expect(d.refunds[0].arn).toMatch(/^ARN/);
    expect(d.issues[0].status).toBe('resolved');
    expect(d.order).toMatchObject({ status: 'paid', paid: 8258.82, refunded: 8258.82 });
    expect(templates('refund').find(p => p.data.number === dupOrder).data.ref).toMatch(/^ARN/);
    // the customer can see it on their order
    const st = await call('GET', '/api/me/state', { cookie: cust });
    expect(st.body.orders.find((x: any) => x.id === dupOrder).refunds[0]).toMatchObject({ status: 'succeeded', amount: 8258.82 });
  });

  it('a payment after cancelling becomes an issue; a full refund marks the order refunded', async () => {
    const o = await newOrder();
    expect((await call('POST', `/api/orders/${o.number}/cancel`, { cookie: cust })).status).toBe(200);
    MockPayments.pay(o.number, o.total); // they paid on the still-open payment page
    await tick();
    let d = await detail(o.number);
    expect(d.order.status).toBe('cancelled');
    expect(d.issues[0]).toMatchObject({ kind: 'paid_after_cancel', status: 'open' });
    MockPayments.refundOutcome = 'succeeded';
    const r = await call('POST', `/api/admin/orders/${o.number}/refund`, { cookie: owner, body: { amount: o.total / 100, reason: 'Order was cancelled' } });
    MockPayments.refundOutcome = 'pending';
    expect(r.body.refunds[0].status).toBe('succeeded');
    d = await detail(o.number);
    expect(d.order.status).toBe('refunded');
    expect(d.issues[0].status).toBe('resolved');
    const st = await call('GET', '/api/me/state', { cookie: cust });
    expect(st.body.orders.find((x: any) => x.id === o.number)).toMatchObject({ status: 'refunded' }); // still visible to the customer
  });
});

describe('refunds that go wrong', () => {
  let num = '', total = 0;
  beforeAll(async () => {
    const o = await newOrder(); num = o.number; total = o.total;
    MockPayments.pay(o.number, o.total);
    await call('GET', `/api/orders/${o.number}`, { cookie: cust }); // customer returns from the gateway → paid
  });

  it('the refund webhook settles a pending refund', async () => {
    const r = await call('POST', `/api/admin/orders/${num}/refund`, { cookie: owner, body: { amount: 100, reason: 'Goodwill' } });
    const id = r.body.refunds[0].id as string;
    expect((await webhook({ kind: 'refund', orderId: num, refundId: id.replace(/-/g, ''), state: 'succeeded', arn: 'ARN-WEBHOOK-1' })).status).toBe(200);
    await webhook({ kind: 'refund', orderId: num, refundId: id.replace(/-/g, ''), state: 'succeeded', arn: 'ARN-WEBHOOK-1' }); // duplicate delivery
    const d = await detail(num);
    expect(d.refunds[0]).toMatchObject({ status: 'succeeded', arn: 'ARN-WEBHOOK-1' });
    expect(d.payments.filter((p: any) => p.kind === 'refund')).toHaveLength(1);
    expect(d.order.refunded).toBe(100);
  });

  it('a declined refund raises an issue and can be retried', async () => {
    MockPayments.refundOutcome = 'failed';
    const r = await call('POST', `/api/admin/orders/${num}/refund`, { cookie: owner, body: { amount: 200, reason: 'Late delivery' } });
    MockPayments.refundOutcome = 'pending';
    expect(r.body.refunds[0]).toMatchObject({ status: 'failed', failure: 'Bank account closed' });
    let d = await detail(num);
    expect(d.issues.find((i: any) => i.kind === 'refund_failed' && i.status === 'open')).toBeTruthy();
    expect(d.refundable).toBe((total - 10000) / 100); // a failed refund doesn't use up the payment
    MockPayments.refundOutcome = 'succeeded';
    const again = await call('POST', `/api/admin/refunds/${r.body.refunds[0].id}/retry`, { cookie: owner });
    MockPayments.refundOutcome = 'pending';
    expect(again.body.refunds[0].status).toBe('succeeded');
    d = await detail(num);
    expect(d.issues.filter((i: any) => i.status === 'open')).toHaveLength(0);
    expect(d.order.refunded).toBe(300);
    expect((await call('POST', `/api/admin/refunds/${again.body.refunds[0].id}/retry`, { cookie: owner })).status).toBe(409);
  });

  it('a refund sent while the gateway is down is re-sent by the background check', async () => {
    MockPayments.failNextRefundCall = true;
    const r = await call('POST', `/api/admin/orders/${num}/refund`, { cookie: owner, body: { amount: 50, reason: 'Gift wrap missing' } });
    expect(r.body.refunds[0]).toMatchObject({ status: 'pending' });
    expect(r.body.refunds[0].lastError).toMatch(/unreachable/);
    await tick(); // gateway never got it → sent again (pending)
    await tick(); // → settled
    const row = await one('SELECT * FROM refunds WHERE id = $1', [r.body.refunds[0].id]);
    expect(row.status).toBe('succeeded');
    expect((await detail(num)).order.refunded).toBe(350);
  });

  it('an admin can check a refund and resolve an issue by hand', async () => {
    const r = await call('POST', `/api/admin/orders/${num}/refund`, { cookie: owner, body: { amount: 10, reason: 'Check me' } });
    const c = await call('POST', `/api/admin/refunds/${r.body.refunds[0].id}/check`, { cookie: owner });
    expect(c.body.refund.status).toBe('succeeded');
    const iss = await one(`INSERT INTO order_issues(order_id, kind, detail) SELECT id, 'overpaid', 'test' FROM orders WHERE number = $1 RETURNING id`, [num]);
    expect((await call('POST', `/api/admin/issues/${iss.id}/resolve`, { cookie: owner, body: { note: 'x' } })).status).toBe(400);
    expect((await call('POST', `/api/admin/issues/${iss.id}/resolve`, { cookie: owner, body: { note: 'Spoke to the customer' } })).status).toBe(200);
    expect((await call('POST', `/api/admin/issues/${iss.id}/resolve`, { cookie: owner, body: { note: 'Spoke to the customer' } })).status).toBe(404);
  });

  it('cancelling a paid order can refund everything that is left', async () => {
    MockPayments.refundOutcome = 'succeeded';
    const r = await call('POST', `/api/admin/orders/${num}/cancel`, { cookie: owner, body: { reason: 'Family emergency', refund: true } });
    MockPayments.refundOutcome = 'pending';
    expect(r.status).toBe(200);
    expect(r.body.refundDue).toBe(0);
    expect(r.body.refunds.reduce((t: number, x: any) => t + x.amount, 0)).toBeCloseTo((total - 36000) / 100, 2);
    const d = await detail(num);
    expect(d.order).toMatchObject({ status: 'refunded', paid: 0 });
  });
});

describe('housekeeping', () => {
  it('closes orders never paid after a week', async () => {
    const o = await newOrder();
    await q(`UPDATE orders SET created_at = now() - interval '8 days' WHERE id = $1`, [o.id]);
    await tick();
    const row = await order(o.number);
    expect(row).toMatchObject({ status: 'cancelled', cancel_reason: 'Payment was not completed' });
    expect(templates('order_cancelled').some(p => p.data.number === o.number)).toBe(true);
  });

  it('does not close an old order that was paid in the meantime', async () => {
    const o = await newOrder();
    await q(`UPDATE orders SET created_at = now() - interval '8 days' WHERE id = $1`, [o.id]);
    MockPayments.pay(o.number, o.total);
    await tick();
    expect((await order(o.number)).status).toBe('paid');
  });

  it('marks photo reading that stopped part-way as failed so it can be retried', async () => {
    const b = await one(`SELECT b.id FROM books b JOIN orders o ON o.id = b.order_id WHERE o.status = 'paid' LIMIT 1`);
    await q(`UPDATE books SET read_status = 'running', read_started_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);
    await tick();
    expect((await one('SELECT read_status FROM books WHERE id = $1', [b.id])).read_status).toBe('failed');
  });
});
