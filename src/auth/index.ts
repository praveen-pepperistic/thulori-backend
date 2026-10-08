// Cookie sessions: a random token in an httpOnly cookie, only its SHA-256 stored in the DB,
// so sessions can be listed and revoked (password change, deactivation) instantly.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash, verify } from '@node-rs/argon2';
import { config } from '../config.js';
import { newToken, sha256 } from '../lib/crypto.js';
import { one, q, type Queryable } from '../db.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export const COOKIE = 'thulori_sid';
export const ADMIN_COOKIE = 'thulori_admin';
export type SessionKind = 'customer' | 'admin';
const cookieName = (k: SessionKind) => k === 'admin' ? ADMIN_COOKIE : COOKIE;

export interface SessionUser { id: string; email: string | null; phone: string | null; name: string; role: 'customer' | 'staff' | 'admin'; status: string; sessionId: string; }

declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null; admin: SessionUser | null; rawBody?: string; }
}

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const checkPassword = (stored: string | null, pw: string) => stored ? verify(stored, pw).catch(() => false) : Promise.resolve(false);

function cookieOpts(kind: SessionKind = 'customer', remember = true) {
  const c = config();
  return {
    path: '/', httpOnly: true,
    secure: c.NODE_ENV === 'production' || c.COOKIE_CROSS_SITE,
    sameSite: (c.COOKIE_CROSS_SITE ? 'none' : 'lax') as 'none' | 'lax',
    domain: c.COOKIE_DOMAIN || undefined,
    // "Keep me signed in" unticked: a browser-session cookie (gone when the browser closes), server-side 1 day max.
    maxAge: !remember ? undefined : kind === 'admin' ? c.ADMIN_SESSION_HOURS * 3600 : c.SESSION_DAYS * 86400,
  };
}

export async function startSession(userId: string, req: FastifyRequest, reply: FastifyReply, client?: Queryable, kind: SessionKind = 'customer', remember = true) {
  const token = newToken();
  const life = kind === 'admin' ? `${config().ADMIN_SESSION_HOURS} hours` : remember ? `${config().SESSION_DAYS} days` : '1 day';
  await q(`INSERT INTO sessions(user_id, token_hash, user_agent, ip, expires_at, kind) VALUES ($1,$2,$3,$4, now() + $5::interval, $6)`,
    [userId, sha256(token), String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip, life, kind], client);
  reply.setCookie(cookieName(kind), token, cookieOpts(kind, remember));
}

export async function endSession(req: FastifyRequest, reply: FastifyReply, kind: SessionKind = 'customer') {
  const token = req.cookies[cookieName(kind)];
  if (token) await q('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  reply.clearCookie(cookieName(kind), { ...cookieOpts(kind), maxAge: undefined });
}

/** Ends every session for a user, optionally keeping the current one. */
export const revokeSessions = (userId: string, keepSessionId?: string, client?: Queryable) =>
  q('DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)', [userId, keepSessionId ?? null], client);

async function load(token: string | undefined, kind: SessionKind): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await one(
    `UPDATE sessions s SET last_seen_at = now() FROM users u
      WHERE s.token_hash = $1 AND s.kind = $2 AND s.expires_at > now() AND u.id = s.user_id AND u.status = 'active'
      RETURNING s.id AS session_id, u.id, u.email, u.phone, u.name, u.role, u.status`, [sha256(token), kind]);
  if (!row) return null;
  if (kind === 'admin' && row.role !== 'staff' && row.role !== 'admin') return null;
  return { id: row.id, email: row.email, phone: row.phone, name: row.name, role: row.role, status: row.status, sessionId: row.session_id };
}

export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('admin', null);
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/admin')) req.admin = await load(req.cookies[ADMIN_COOKIE], 'admin');
    else req.user = await load(req.cookies[COOKIE], 'customer');
  });
}

export const requireUser = async (req: FastifyRequest) => { if (!req.user) throw unauthorized(); };
/** Admin panel: a staff or admin account signed in through the admin sign-in (with its email code). */
export const requireStaff = async (req: FastifyRequest) => { if (!req.admin) throw unauthorized('Please sign in to the admin panel.'); };
/** Money: payments, refunds and invoices are for the admin role only. */
export const requireAdmin = async (req: FastifyRequest) => {
  if (!req.admin) throw unauthorized('Please sign in to the admin panel.');
  if (req.admin.role !== 'admin') throw forbidden('Only the account owner (admin role) can do this.');
};
// Apply the session hook to every route (not just this plugin's own scope).
(authPlugin as any)[Symbol.for('skip-override')] = true;
