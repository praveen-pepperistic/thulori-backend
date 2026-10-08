import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { checkPassword, endSession, hashPassword, requireUser, revokeSessions, startSession } from '../auth/index.js';
import { parse, zEmail, zName, zPassword, zPhone } from '../lib/validate.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { enqueue } from '../lib/jobs.js';

export const publicUser = (u: any) => ({ id: u.id, name: u.name, first: String(u.name || '').split(' ')[0], email: u.email, phone: u.phone, role: u.role, waUpdates: u.wa_updates, hasPassword: !!u.password_hash });

const strict = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } };

export async function authRoutes(app: FastifyInstance) {
  app.post('/signup', strict, async (req, reply) => {
    const b = parse(z.object({ name: zName, email: zEmail, phone: zPhone, password: zPassword, child: z.string().trim().max(80).optional(), acceptTerms: z.literal(true, { error: 'Please accept the terms to continue.' }) }), req.body);
    const existing = await one(`SELECT id, status FROM users WHERE (email = $1 OR phone = $2) AND status <> 'deleted'`, [b.email, b.phone]);
    if (existing) throw conflict('An account with this email or phone already exists — please sign in.', 'account_exists');
    const user = await tx(async c => {
      const u = await one(`INSERT INTO users(name, email, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING *`, [b.name, b.email, b.phone, await hashPassword(b.password)], c);
      await startSession(u.id, req, reply, c);
      await enqueue('notify', { template: 'welcome', userId: u.id }, {}, c);
      await q(`INSERT INTO audit_log(user_id, action) VALUES ($1,'signup')`, [u.id], c);
      return u;
    });
    return reply.status(201).send({ user: publicUser(user) });
  });

  app.post('/login', strict, async (req, reply) => {
    const b = parse(z.object({ id: z.string().trim().min(3).max(254), password: z.string().min(1).max(200), remember: z.boolean().default(true) }), req.body);
    const id = b.id.toLowerCase();
    const digits = id.replace(/\D/g, '');
    const u = await one(`SELECT * FROM users WHERE status <> 'deleted' AND (email = $1 OR ($2 <> '' AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = right($2, 10))) LIMIT 1`, [id, digits.length >= 10 ? digits : '']);
    if (!u || !(await checkPassword(u.password_hash, b.password))) throw unauthorized('That email/phone and password don’t match.');
    let reactivated = false;
    if (u.status === 'deactivated') { await q(`UPDATE users SET status='active', deactivated_at=NULL, updated_at=now() WHERE id=$1`, [u.id]); reactivated = true; }
    await startSession(u.id, req, reply, undefined, 'customer', b.remember);
    await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'login',$2)`, [u.id, { reactivated }]);
    return { user: publicUser({ ...u, status: 'active' }), reactivated };
  });

  app.post('/logout', async (req, reply) => { await endSession(req, reply); return { ok: true }; });

  app.get('/me', { preHandler: requireUser }, async (req) => {
    const u = await one('SELECT * FROM users WHERE id = $1', [req.user!.id]);
    return { user: publicUser(u) };
  });

  app.post('/password/forgot', strict, async (req) => {
    const b = parse(z.object({ email: zEmail }), req.body);
    const u = await one(`SELECT id FROM users WHERE email = $1 AND status <> 'deleted'`, [b.email]);
    if (u) {
      const token = newToken();
      await q(`INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [sha256(token), u.id]);
      await enqueue('notify', { template: 'password_reset', userId: u.id, data: { token } });
    }
    return { ok: true }; // same answer either way — don't reveal which emails have accounts
  });

  app.post('/password/reset', strict, async (req, reply) => {
    const b = parse(z.object({ token: z.string().min(20), password: zPassword }), req.body);
    const r = await one(`SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256(b.token)]);
    if (!r) throw badRequest('This reset link has expired. Please ask for a new one.');
    await tx(async c => {
      await q(`UPDATE password_resets SET used_at = now() WHERE token_hash = $1`, [sha256(b.token)], c);
      await q(`UPDATE users SET password_hash = $2, password_changed_at = now(), status = CASE WHEN status='deactivated' THEN 'active' ELSE status END WHERE id = $1`, [r.user_id, await hashPassword(b.password)], c);
      await revokeSessions(r.user_id, undefined, c);
      await startSession(r.user_id, req, reply, c);
      await enqueue('notify', { template: 'password_changed', userId: r.user_id }, {}, c);
    });
    return { ok: true };
  });
}
