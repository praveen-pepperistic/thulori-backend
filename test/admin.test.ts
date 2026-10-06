// Admin panel: manual orders and payments, checkpoints set by hand, payments report, invoices.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closeDb, db, one, q } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { drain } from '../src/lib/jobs.js';
import { handlers } from '../src/worker.js';
import { hashPassword } from '../src/auth/index.js';

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
  return { status: r.statusCode, body, raw: r.rawPayload, headers: r.headers, cookie: set ? `${set.name}=${set.value}` : undefined };
}
async function adminLogin(email: string, password: string) {
  const ch = await call('POST', '/api/admin/auth/login', { body: { email, password } });
  await work();
  const code = sent.filter(p => p.template === 'admin_code' && p.to.email === email).at(-1).data.code;
  return (await call('POST', '/api/admin/auth/verify', { body: { challenge: ch.body.challenge, code } })).cookie!;
}

let owner = '', staff = '';
beforeAll(async () => {
  await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  app = await buildApp({ logger: false });
  await q(`INSERT INTO users(email, name, password_hash, role) VALUES ('owner@thulori.in','Praveen',$1,'admin'), ('team@thulori.in','Writer',$1,'staff')`, [await hashPassword('owner-password-1')]);
  owner = await adminLogin('owner@thulori.in', 'owner-password-1');
  staff = await adminLogin('team@thulori.in', 'owner-password-1');
});
afterAll(async () => { await app?.close(); await closeDb(); });

describe('admin panel', () => {
  let orderNo = '', orderId = '', bookId = '';
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

  it('needs an admin session', async () => {
    expect((await call('GET', '/api/admin/orders')).status).toBe(401);
    expect((await call('GET', '/api/admin/auth/me', { cookie: owner })).body.user.role).toBe('admin');
  });

  it('creates a WhatsApp order by hand, with a new customer account', async () => {
    const r = await call('POST', '/api/admin/orders', { cookie: owner, body: {
      customer: { name: 'Meena Iyer', email: 'meena@example.com', phone: '9840012345' },
      items: [{ edition: 'malar', childName: 'Ishaan' }],
      address: { to: 'Meena Iyer', line1: '22 MG Road', city: 'Bengaluru', state: 'Karnataka', pin: '560001' },
      payment: { status: 'unpaid' },
    } });
    expect(r.status).toBe(201);
    expect(r.body.accountCreated).toBe(true);
    orderNo = r.body.number; orderId = r.body.id;
    await work();
    const welcome = sent.find(p => p.template === 'account_created');
    expect(welcome.data.token).toBeTruthy();
    // the customer sets a password from the emailed link and sees the order
    const reset = await call('POST', '/api/auth/password/reset', { body: { token: welcome.data.token, password: 'meena12345' } });
    expect(reset.status).toBe(200);
    const st = await call('GET', '/api/me/state', { cookie: reset.cookie });
    expect(st.body.orders[0]).toMatchObject({ id: orderNo, total: 11798.82 }); // 9999 × 1.18
  });

  it('filters orders', async () => {
    const all = await call('GET', '/api/admin/orders', { cookie: staff });
    expect(all.body.total).toBe(1);
    expect((await call('GET', '/api/admin/orders?bucket=unpaid&state=Karnataka&edition=malar', { cookie: staff })).body.total).toBe(1);
    expect((await call('GET', '/api/admin/orders?edition=vidhai', { cookie: staff })).body.total).toBe(0);
    expect((await call('GET', '/api/admin/orders?q=ishaan', { cookie: staff })).body.total).toBe(1);
    expect((await call('GET', '/api/admin/orders?q=40012', { cookie: staff })).body.total).toBe(1);
    const sum = await call('GET', '/api/admin/summary', { cookie: staff });
    expect(sum.body.buckets.unpaid.count).toBe(1);
  });

  it('only the owner can record money', async () => {
    expect((await call('POST', `/api/admin/orders/${orderNo}/mark-paid`, { cookie: staff, body: { method: 'upi', ref: 'UPI123' } })).status).toBe(403);
    const r = await call('POST', `/api/admin/orders/${orderNo}/mark-paid`, { cookie: owner, body: { method: 'upi', ref: 'UPI-4455', paidOn: '2026-10-04' } });
    expect(r.status).toBe(200);
    expect((await call('POST', `/api/admin/orders/${orderNo}/mark-paid`, { cookie: owner, body: { method: 'upi' } })).status).toBe(409);
    const d = await call('GET', `/api/admin/orders/${orderNo}`, { cookie: owner });
    expect(d.body.order.status).toBe('paid');
    expect(d.body.payments[0]).toMatchObject({ provider: 'manual', method: 'upi', ref: 'UPI-4455', amount: 11798.82, by: 'Praveen' });
    bookId = d.body.books[0].id;
  });

  it('reports payments with filters', async () => {
    const p = await call('GET', '/api/admin/payments?from=2026-10-01&to=2026-10-31&state=Karnataka&edition=malar', { cookie: owner });
    expect(p.body.totals).toMatchObject({ gross: 11798.82, count: 1, net: 11798.82, gst: 1799.82 });
    expect(p.body.byEdition[0]).toMatchObject({ key: 'malar', amount: 11798.82 });
    expect(p.body.byState[0]).toMatchObject({ key: 'Karnataka' });
    expect((await call('GET', '/api/admin/payments?state=Kerala', { cookie: owner })).body.totals.count).toBe(0);
    const csv = await call('GET', '/api/admin/payments.csv', { cookie: owner });
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.raw.toString()).toContain(orderNo);
    expect((await call('GET', '/api/admin/payments', { cookie: staff })).status).toBe(403);
  });

  it('takes photos received on WhatsApp and moves the book by hand', async () => {
    const up = await call('POST', `/api/admin/books/${bookId}/photos/uploads`, { cookie: staff, body: { files: [1, 2, 3].map(i => ({ name: `wa-${i}.png`, type: 'image/png', size: png.length })) } });
    for (const u of up.body.uploads) await call('PUT', new URL(u.upload.url).pathname, { origin: null, raw: png, headers: { 'content-type': 'image/png' } });
    expect((await call('POST', `/api/admin/books/${bookId}/photos/complete`, { cookie: staff, body: { ids: up.body.uploads.map((u: any) => u.id) } })).body.uploaded).toBe(3);
    const zip = await call('GET', `/api/admin/books/${bookId}/photos.zip`, { cookie: staff });
    expect(zip.status).toBe(200);
    expect(zip.raw.subarray(0, 2).toString()).toBe('PK');
    const txt = await call('GET', `/api/admin/books/${bookId}/stories.txt`, { cookie: staff });
    expect(txt.raw.toString()).toContain('Ishaan');
    const mv = await call('POST', `/api/admin/books/${bookId}/stage`, { cookie: staff, body: { stage: 1, note: 'Stories received on WhatsApp voice notes' } });
    expect(mv.status).toBe(200);
    const b = await call('GET', `/api/admin/books/${bookId}`, { cookie: staff });
    expect(b.body.book.stage).toBe(1);
    expect(b.body.book.log.at(-1)).toMatchObject({ from: 0, to: 1, by: 'Writer', manual: true });
  });

  it('records a proof decision made outside the site', async () => {
    const up = await call('POST', `/api/admin/books/${bookId}/proof/uploads`, { cookie: staff, body: { files: [{ type: 'image/png', size: png.length }] } });
    await call('PUT', new URL(up.body.uploads[0].upload.url).pathname, { origin: null, raw: png, headers: { 'content-type': 'image/png' } });
    expect((await call('POST', `/api/admin/books/${bookId}/proof`, { cookie: staff, body: { keys: [up.body.uploads[0].key] } })).body.round).toBe(1);
    expect((await call('POST', `/api/admin/books/${bookId}/proof/decision`, { cookie: staff, body: { decision: 'changes' } })).status).toBe(400);
    expect((await call('POST', `/api/admin/books/${bookId}/proof/decision`, { cookie: staff, body: { decision: 'approved', note: 'Approved on a call' } })).status).toBe(200);
    expect((await call('GET', `/api/admin/books/${bookId}`, { cookie: staff })).body.book.stage).toBe(4);
    expect((await call('GET', '/api/admin/orders?bucket=to_print', { cookie: staff })).body.total).toBe(1);
  });

  it('issues and emails a GST invoice the customer can open', async () => {
    const draft = await call('GET', `/api/admin/orders/${orderNo}/invoice-draft`, { cookie: owner });
    expect(draft.body.lines).toEqual([{ desc: 'Malar edition storybook — Ishaan', hsn: '4911', qty: 1, unit: 9999 }]);
    const lines = [...draft.body.lines, { desc: 'Gift wrap', qty: 1, unit: 500 }];
    const r = await call('POST', `/api/admin/orders/${orderNo}/invoices`, { cookie: owner, body: { lines, send: true } });
    expect(r.status).toBe(201);
    expect(r.body.invoice.number).toMatch(/^TH\/\d{4}-\d{2}\/0001$/);
    expect(r.body.invoice.total).toBe(12388.82); // (9999 + 500) × 1.18
    await work();
    expect(sent.find(p => p.template === 'invoice').to.email).toBe('meena@example.com');
    const html = await call('GET', new URL(r.body.invoice.url).pathname, { origin: null });
    expect(html.raw.toString()).toContain('IGST @ 18%'); // Karnataka ≠ Tamil Nadu
    expect(html.raw.toString()).toContain('Balance due');
    expect((await call('GET', '/api/invoices/not-a-real-token', { origin: null })).status).toBe(404);
  });

  it('ships, delivers, refunds and keeps a timeline', async () => {
    expect((await call('POST', `/api/admin/orders/${orderNo}/ship`, { cookie: staff, body: { courier: 'Delhivery', awb: 'DL998877' } })).status).toBe(200);
    expect((await call('POST', `/api/admin/orders/${orderNo}/deliver`, { cookie: staff, body: {} })).status).toBe(200);
    expect((await call('POST', `/api/admin/orders/${orderNo}/refund`, { cookie: owner, body: { amount: 99999, reason: 'Too much', manual: { method: 'upi' } } })).status).toBe(400);
    // a payment taken by hand can't go back through the gateway — the refund must say how it was sent
    expect((await call('POST', `/api/admin/orders/${orderNo}/refund`, { cookie: owner, body: { amount: 500, reason: 'Late delivery' } })).status).toBe(400);
    expect((await call('POST', `/api/admin/orders/${orderNo}/refund`, { cookie: owner, body: { amount: 500, reason: 'Late delivery', manual: { method: 'upi', ref: 'RF1' } } })).status).toBe(200);
    await call('POST', `/api/admin/orders/${orderNo}/notes`, { cookie: staff, body: { text: 'Customer loved it' } });
    const d = await call('GET', `/api/admin/orders/${orderNo}`, { cookie: owner });
    expect(d.body.order.paid).toBe(11298.82);
    expect(d.body.notes[0].text).toBe('Customer loved it');
    expect(d.body.activity.map((a: any) => a.action)).toEqual(expect.arrayContaining(['admin_ship', 'refund_started', 'refund_succeeded', 'admin_proof_decision', 'order_paid']));
    const p = await call('GET', '/api/admin/payments', { cookie: owner });
    expect(p.body.totals).toMatchObject({ refunds: 500, net: 11298.82 });
  });
});
