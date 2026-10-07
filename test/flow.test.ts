// End-to-end API flow against a real PostgreSQL (mock payment / AI / notification drivers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { db, closeDb, q, one } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { drain } from '../src/lib/jobs.js';
import { handlers } from '../src/worker.js';
import { hmac } from '../src/lib/crypto.js';
import { hashPassword } from '../src/auth/index.js';

let app: FastifyInstance;
const ORIGIN = 'http://site.test';
const silent = { info: () => {}, error: (e: any) => console.error(e) };
const sent: string[] = [];
export const payloads: any[] = [];
const work = () => drain({ ...handlers(silent), notify: async (p: any) => { sent.push(p.template); payloads.push(p); } });

type Res = { status: number; body: any; cookie?: string };
async function call(method: string, url: string, opts: { body?: any; cookie?: string; origin?: string | null; headers?: Record<string, string>; raw?: Buffer } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  const r = await app.inject({ method: method as any, url, headers, payload: opts.raw ?? opts.body });
  const set = r.cookies.find(c => c.name === 'thulori_sid' || c.name === 'thulori_admin');
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body, cookie: set ? `${set.name}=${set.value}` : undefined };
}

beforeAll(async () => {
  await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  app = await buildApp({ logger: false });
});
afterAll(async () => { await app?.close(); await closeDb(); });

describe('customer journey', () => {
  let cookie = '', orderNo = '', bookId = '';
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

  it('blocks requests from unknown origins', async () => {
    const r = await call('POST', '/api/auth/signup', { origin: 'https://evil.example', body: {} });
    expect(r.status).toBe(403);
  });

  it('signs up and reads state', async () => {
    const r = await call('POST', '/api/auth/signup', { body: { name: 'Aara Amma', email: 'Amma@Example.com', phone: '98765 43210', password: 'little1234', acceptTerms: true } });
    expect(r.status).toBe(201);
    expect(r.body.user.email).toBe('amma@example.com');
    cookie = r.cookie!;
    const dup = await call('POST', '/api/auth/signup', { body: { name: 'X', email: 'amma@example.com', phone: '9000000000', password: 'little1234', acceptTerms: true } });
    expect(dup.status).toBe(409);
    const s = await call('GET', '/api/me/state', { cookie });
    expect(s.body).toMatchObject({ v: 2, remote: true, books: [], orders: [] });
  });

  it('rejects a wrong password and signs in by phone', async () => {
    expect((await call('POST', '/api/auth/login', { body: { id: 'amma@example.com', password: 'nope' } })).status).toBe(401);
    const r = await call('POST', '/api/auth/login', { body: { id: '+91 98765 43210', password: 'little1234' } });
    expect(r.status).toBe(200);
  });

  it('needs sign-in to check out', async () => {
    expect((await call('POST', '/api/orders', { body: {} })).status).toBe(401);
  });

  it('creates an order with server-side prices', async () => {
    const r = await call('POST', '/api/orders', { cookie, body: {
      items: [{ edition: 'thulir', childName: 'Aara' }], giftNote: 'For Aara',
      address: { to: 'Aara Amma', line1: '12 Lake Road', city: 'Chennai', state: 'Tamil Nadu', pin: '600017' },
      contact: { name: 'Aara Amma', email: 'amma@example.com', phone: '9876543210' },
    } });
    expect(r.status).toBe(201);
    expect(r.body.order.subtotal).toBe(6999);
    expect(r.body.order.total).toBe(8258.82); // + 18% GST
    expect(r.body.order.status).toBe('pending_payment');
    expect(r.body.payment).toMatchObject({ provider: 'mock', mode: 'mock' });
    orderNo = r.body.order.id;
    const s = await call('GET', '/api/me/state', { cookie });
    expect(s.body.addresses).toHaveLength(1);
    bookId = s.body.books[0].id;
    expect((await call('GET', `/api/books/${bookId}`, { cookie })).status).toBe(409); // unpaid
  });

  it('pays (mock) and is idempotent with the webhook', async () => {
    const r = await call('POST', `/api/orders/${orderNo}/mock-pay`, { cookie });
    expect(r.body.order.status).toBe('paid');
    const raw = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', orderId: orderNo, state: 'paid', ref: `mockpay_${orderNo}_1`, amountPaise: 825882 });
    const bad = await call('POST', '/api/webhooks/mock', { origin: null, raw: Buffer.from(raw), headers: { 'content-type': 'application/json', 'x-mock-signature': 'wrong' } });
    expect(bad.status).toBe(401);
    const ok = await call('POST', '/api/webhooks/mock', { origin: null, raw: Buffer.from(raw), headers: { 'content-type': 'application/json', 'x-mock-signature': hmac('test-secret-test-secret-test-secret-123', raw) } });
    expect(ok.status).toBe(200);
    await work();
    expect(sent.filter(t => t === 'order_paid')).toHaveLength(1);
  });

  it('uploads photos through signed URLs', async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `IMG_${i}.png`, type: 'image/png', size: png.length, takenOn: '2025-01-0' + ((i % 9) + 1) }));
    const bad = await call('POST', `/api/books/${bookId}/photos/uploads`, { cookie, body: { files: [{ name: 'a.gif', type: 'image/gif', size: 10 }] } });
    expect(bad.status).toBe(400);
    const r = await call('POST', `/api/books/${bookId}/photos/uploads`, { cookie, body: { files } });
    expect(r.status).toBe(200);
    for (const u of r.body.uploads) {
      const path = new URL(u.upload.url).pathname;
      const put = await call('PUT', path, { origin: null, raw: png, headers: { 'content-type': 'image/png' } });
      expect(put.status).toBe(200);
    }
    const done = await call('POST', `/api/books/${bookId}/photos/complete`, { cookie, body: { ids: r.body.uploads.map((u: any) => u.id) } });
    expect(done.body.uploaded).toHaveLength(12);
    expect(done.body.book.photos).toHaveLength(12);
    const img = await call('GET', new URL(done.body.book.photos[0].url).pathname, { origin: null });
    expect(img.status).toBe(200);
  });

  it('reads photos into one card per photo plus themes', async () => {
    const r = await call('POST', `/api/books/${bookId}/read`, { cookie, body: {} });
    expect(r.body.read.status).toBe('queued');
    await work();
    const b = (await call('GET', `/api/books/${bookId}`, { cookie })).body.book;
    expect(b.read.status).toBe('done');
    expect(b.cards.filter((c: any) => c.kind === 'photo')).toHaveLength(12);
    expect(b.cards.filter((c: any) => c.kind === 'theme').length).toBeGreaterThan(0);
  });

  it('keeps another customer out', async () => {
    const other = await call('POST', '/api/auth/signup', { body: { name: 'Someone', email: 'other@example.com', phone: '9123456780', password: 'other12345', acceptTerms: true } });
    expect((await call('GET', `/api/books/${bookId}`, { cookie: other.cookie })).status).toBe(404);
    expect((await call('GET', `/api/orders/${orderNo}`, { cookie: other.cookie })).status).toBe(404);
  });

  it('answers questions and submits', async () => {
    expect((await call('POST', `/api/books/${bookId}/submit`, { cookie })).status).toBe(400);
    const b = (await call('GET', `/api/books/${bookId}`, { cookie })).body.book;
    for (const c of b.cards.slice(0, 5)) expect((await call('PATCH', `/api/cards/${c.id}`, { cookie, body: { pick: 1, text: 'She loved it.' } })).status).toBe(200);
    const s = await call('POST', `/api/books/${bookId}/submit`, { cookie });
    expect(s.body.book.stage).toBe(1);
    expect((await call('DELETE', `/api/photos/${b.photos[0].id}`, { cookie })).status).toBe(409); // locked
    expect((await call('POST', '/api/me/delete', { cookie, body: { confirm: 'DELETE' } })).status).toBe(409);
  });

  it('runs the proof loop with the team', async () => {
    await q(`INSERT INTO users(email, name, password_hash, role) VALUES ('team@thulori.in','Team',$1,'staff')`, [await hashPassword('team-password-1')]);
    expect((await call('POST', '/api/admin/auth/login', { body: { email: 'amma@example.com', password: 'little1234' } })).status).toBe(401); // customers can't
    const ch = await call('POST', '/api/admin/auth/login', { body: { email: 'team@thulori.in', password: 'team-password-1' } });
    expect(ch.body.challenge).toBeTruthy();
    await work();
    const code = payloads.filter(p => p.template === 'admin_code').at(-1).data.code;
    expect((await call('POST', '/api/admin/auth/verify', { body: { challenge: ch.body.challenge, code: code === '000000' ? '111111' : '000000' } })).status).toBe(400);
    const v = await call('POST', '/api/admin/auth/verify', { body: { challenge: ch.body.challenge, code } });
    const staff = v.cookie!;
    expect(staff.startsWith('thulori_admin=')).toBe(true);
    expect((await call('GET', '/api/admin/summary', { cookie })).status).toBe(401); // a customer session is not an admin session
    const detail = await call('GET', `/api/admin/books/${bookId}`, { cookie: staff });
    expect(detail.body.photos).toHaveLength(12);
    expect(detail.body.cards.filter((c: any) => c.pick != null || c.text).length).toBe(5);

    const sendProof = async () => {
      const up = await call('POST', `/api/admin/books/${bookId}/proof/uploads`, { cookie: staff, body: { files: [{ type: 'image/png', size: png.length }, { type: 'image/png', size: png.length }] } });
      for (const u of up.body.uploads) await call('PUT', new URL(u.upload.url).pathname, { origin: null, raw: png, headers: { 'content-type': 'image/png' } });
      return call('POST', `/api/admin/books/${bookId}/proof`, { cookie: staff, body: { keys: up.body.uploads.map((u: any) => u.key) } });
    };
    expect((await sendProof()).body.round).toBe(1);
    let p = (await call('GET', `/api/books/${bookId}/proof`, { cookie })).body;
    expect(p.proof.pages).toHaveLength(2);
    expect(p.revisionsLeft).toBe(2);
    expect((await call('POST', `/api/books/${bookId}/proof/changes`, { cookie })).status).toBe(409); // no notes
    await call('POST', `/api/books/${bookId}/proof/notes`, { cookie, body: { at: 1, page: 'Page 1', text: 'Spell Paati with two a’s' } });
    expect((await call('POST', `/api/books/${bookId}/proof/changes`, { cookie })).body.book.stage).toBe(2);
    expect((await sendProof()).body.round).toBe(2);
    expect((await call('POST', `/api/books/${bookId}/proof/approve`, { cookie })).body.book.stage).toBe(4);

    const o = await one('SELECT id FROM orders WHERE number = $1', [orderNo]);
    expect((await call('POST', `/api/admin/orders/${o.id}/ship`, { cookie: staff, body: { courier: 'Blue Dart', awb: 'BD123456', trackingUrl: 'http://not-https.example' } })).status).toBe(400);
    expect((await call('POST', `/api/admin/orders/${o.id}/ship`, { cookie: staff, body: { courier: 'Blue Dart', awb: 'BD123456', trackingUrl: 'https://track.example/BD123456' } })).status).toBe(200);
    expect((await call('POST', `/api/admin/orders/${o.id}/deliver`, { cookie: staff })).status).toBe(200);
    const s = (await call('GET', '/api/me/state', { cookie })).body;
    expect(s.books[0].stage).toBe(6);
    expect(s.orders[0].shipping).toMatchObject({ courier: 'Blue Dart', awb: 'BD123456', url: 'https://track.example/BD123456' });
    expect(s.orders[0].shipping.delivered).toBeTruthy();
    await work();
    expect(sent).toEqual(expect.arrayContaining(['proof_ready', 'shipped', 'stage_update']));
  });

  it('changes password, signs out other sessions, deactivates and comes back', async () => {
    const second = (await call('POST', '/api/auth/login', { body: { id: 'amma@example.com', password: 'little1234' } })).cookie!;
    expect((await call('POST', '/api/me/password', { cookie, body: { current: 'little1234', next: 'newpass99' } })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { cookie: second })).status).toBe(401);
    expect((await call('POST', '/api/me/deactivate', { cookie, body: { confirm: 'DEACTIVATE' } })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { cookie })).status).toBe(401);
    const back = await call('POST', '/api/auth/login', { body: { id: 'amma@example.com', password: 'newpass99' } });
    expect(back.body.reactivated).toBe(true);
  });
});
