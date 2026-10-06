// Admin panel sign-in: email + password, then a 6-digit code sent to that email (ADMIN_2FA).
// Admin sessions use their own cookie (thulori_admin) and expire after ADMIN_SESSION_HOURS.
import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { one, q } from '../db.js';
import { checkPassword, endSession, requireStaff, startSession } from '../auth/index.js';
import { parse, zEmail, zUuid } from '../lib/validate.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import { enqueue } from '../lib/jobs.js';

const strict = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } };
const mask = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_m, a, b, d) => a + '•'.repeat(Math.min(6, b.length)) + d);
const staffView = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export async function adminAuthRoutes(app: FastifyInstance) {
  app.post('/login', strict, async (req, reply) => {
    const b = parse(z.object({ email: zEmail, password: z.string().min(1).max(200) }), req.body);
    const u = await one(`SELECT * FROM users WHERE email = $1 AND status = 'active' AND role IN ('staff','admin')`, [b.email]);
    if (!u || !(await checkPassword(u.password_hash, b.password))) throw unauthorized('That email and password don’t match a team account.');
    if (!config().ADMIN_2FA) {
      await startSession(u.id, req, reply, undefined, 'admin');
      await q(`INSERT INTO audit_log(user_id, action) VALUES ($1,'admin_login')`, [u.id]);
      return { user: staffView(u) };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ch = await one(`INSERT INTO admin_challenges(user_id, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes') RETURNING id`, [u.id, sha256(code + u.id)]);
    await enqueue('notify', { template: 'admin_code', to: { email: u.email }, data: { code } }, { maxAttempts: 3 });
    return { challenge: ch.id, sentTo: mask(u.email) };
  });

  app.post('/verify', strict, async (req, reply) => {
    const b = parse(z.object({ challenge: zUuid, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }), req.body);
    const ch = await one(`UPDATE admin_challenges SET attempts = attempts + 1 WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND attempts < 5 RETURNING *`, [b.challenge]);
    if (!ch) throw new HttpError(400, 'code_expired', 'This code has expired. Sign in again to get a new one.');
    if (!sha256(b.code + ch.user_id).equals(ch.code_hash)) throw new HttpError(400, 'bad_code', 'That code isn’t right.');
    await q('UPDATE admin_challenges SET used_at = now() WHERE id = $1', [ch.id]);
    const u = await one(`SELECT * FROM users WHERE id = $1 AND status = 'active' AND role IN ('staff','admin')`, [ch.user_id]);
    if (!u) throw unauthorized();
    await startSession(u.id, req, reply, undefined, 'admin');
    await q(`INSERT INTO audit_log(user_id, action) VALUES ($1,'admin_login')`, [u.id]);
    return { user: staffView(u) };
  });

  app.post('/logout', async (req, reply) => { await endSession(req, reply, 'admin'); return { ok: true }; });
  app.get('/me', { preHandler: requireStaff }, async (req) => ({ user: staffView(req.admin!), company: { gstRate: config().GST_RATE, pricesIncludeGst: config().PRICES_INCLUDE_GST, state: config().COMPANY_STATE, siteUrl: config().SITE_URL } }));
}
