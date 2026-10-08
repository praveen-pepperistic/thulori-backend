import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { checkPassword, endSession, hashPassword, requireUser, revokeSessions } from '../auth/index.js';
import { parse, zEmail, zName, zPassword, zPhone, zUuid } from '../lib/validate.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { INDIAN_STATES, STAGE } from '../lib/catalog.js';
import { accountState, addressList } from '../state.js';
import { enqueue } from '../lib/jobs.js';
import { storage } from '../services/storage/index.js';

export const zAddress = z.object({
  label: z.string().trim().max(30).default('Home'),
  to: zName,
  line1: z.string().trim().min(1, 'Please add the house and street.').max(200),
  line2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(1, 'Please add the city.').max(80),
  state: z.string().refine(s => INDIAN_STATES.includes(s), 'Please choose a state.'),
  pin: z.string().trim().regex(/^\d{6}$/, 'PIN codes have 6 digits.'),
  phone: zPhone.optional().or(z.literal('').transform(() => undefined)),
  def: z.boolean().default(false),
});

export async function meRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/state', async (req) => accountState(req.user!.id));

  app.patch('/', async (req) => {
    const b = parse(z.object({ name: zName.optional(), email: zEmail.optional(), phone: zPhone.optional(), waUpdates: z.boolean().optional(), password: z.string().max(200).optional() }), req.body);
    const cur = await one('SELECT email, password_hash FROM users WHERE id = $1', [req.user!.id]);
    const emailChange = !!b.email && b.email !== cur.email;
    // Changing the sign-in email needs the current password, and the old address is told about it.
    if (emailChange && cur.password_hash && !(b.password && await checkPassword(cur.password_hash, b.password)))
      throw badRequest('Enter your current password to change your email.', { fields: { password: 'Enter your current password to change your email.' } });
    if (b.email || b.phone) {
      const clash = await one(`SELECT 1 FROM users WHERE id <> $1 AND status <> 'deleted' AND (email = $2 OR phone = $3)`, [req.user!.id, b.email ?? null, b.phone ?? null]);
      if (clash) throw conflict('That email or phone is already used by another account.');
    }
    await q(`UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email), phone = COALESCE($4, phone),
               wa_updates = COALESCE($5, wa_updates), updated_at = now() WHERE id = $1`,
      [req.user!.id, b.name ?? null, b.email ?? null, b.phone ?? null, b.waUpdates ?? null]);
    if (emailChange && cur.email) await enqueue('notify', { template: 'email_changed', userId: req.user!.id, to: { email: cur.email }, data: { newEmail: b.email } });
    return { ok: true };
  });

  // ---- addresses
  app.get('/addresses', async (req) => ({ addresses: await addressList(req.user!.id) }));
  app.post('/addresses', async (req, reply) => {
    const a = parse(zAddress, req.body);
    await tx(async c => {
      const n = await one('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1', [req.user!.id], c);
      const def = a.def || n.n === 0;
      if (def) await q('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user!.id], c);
      await q(`INSERT INTO addresses(user_id,label,recipient,line1,line2,city,state,pin,phone,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.user!.id, a.label || 'Address', a.to, a.line1, a.line2, a.city, a.state, a.pin, a.phone ?? null, def], c);
    });
    return reply.status(201).send({ addresses: await addressList(req.user!.id) });
  });
  app.patch('/addresses/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const a = parse(zAddress, req.body);
    await tx(async c => {
      const row = await one('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [id, req.user!.id], c);
      if (!row) throw notFound();
      if (a.def) await q('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user!.id], c);
      await q(`UPDATE addresses SET label=$3, recipient=$4, line1=$5, line2=$6, city=$7, state=$8, pin=$9, phone=$10, is_default = is_default OR $11 WHERE id=$1 AND user_id=$2`,
        [id, req.user!.id, a.label || 'Address', a.to, a.line1, a.line2, a.city, a.state, a.pin, a.phone ?? null, a.def], c);
    });
    return { addresses: await addressList(req.user!.id) };
  });
  app.post('/addresses/:id/default', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await tx(async c => {
      if (!(await one('SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2', [id, req.user!.id], c))) throw notFound();
      await q('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user!.id], c);
      await q('UPDATE addresses SET is_default = true WHERE id = $1', [id], c);
    });
    return { addresses: await addressList(req.user!.id) };
  });
  app.delete('/addresses/:id', async (req) => {
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await tx(async c => {
      const row = await one('DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING is_default', [id, req.user!.id], c);
      if (!row) throw notFound();
      if (row.is_default) await q(`UPDATE addresses SET is_default = true WHERE id = (SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at LIMIT 1)`, [req.user!.id], c);
    });
    return { addresses: await addressList(req.user!.id) };
  });

  // ---- password
  app.post('/password', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const b = parse(z.object({ current: z.string().optional(), next: zPassword }), req.body);
    const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (u.password_hash) {
      if (!b.current || !(await checkPassword(u.password_hash, b.current))) throw badRequest('That isn’t your current password.', { fields: { current: 'That isn’t your current password.' } });
      if (await checkPassword(u.password_hash, b.next)) throw badRequest('Choose a password you haven’t used here.', { fields: { next: 'Choose a password you haven’t used here.' } });
    }
    await q('UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1', [req.user!.id, await hashPassword(b.next)]);
    await revokeSessions(req.user!.id, req.user!.sessionId); // signed out everywhere else
    await enqueue('notify', { template: 'password_changed', userId: req.user!.id });
    return { ok: true };
  });

  // ---- close account
  app.post('/deactivate', async (req, reply) => {
    const b = parse(z.object({ reason: z.string().max(200).optional(), confirm: z.literal('DEACTIVATE') }), req.body);
    await tx(async c => {
      await q(`UPDATE users SET status='deactivated', deactivated_at=now(), close_reason=$2, updated_at=now() WHERE id=$1`, [req.user!.id, b.reason ?? null], c);
      await revokeSessions(req.user!.id, undefined, c);
      await enqueue('notify', { template: 'account_closed', userId: req.user!.id, data: { deleted: false } }, {}, c);
    });
    await endSession(req, reply);
    return { ok: true };
  });

  app.post('/delete', async (req, reply) => {
    const b = parse(z.object({ reason: z.string().max(200).optional(), confirm: z.literal('DELETE') }), req.body);
    const busy = await q(`SELECT child_name FROM books WHERE user_id = $1 AND stage BETWEEN $2 AND $3`, [req.user!.id, STAGE.WRITING, STAGE.SHIPPED]);
    if (busy.length) throw conflict(`We can’t delete your data while ${busy.map(r => r.child_name).join(' and ')}’s book is being crafted. Deactivate instead, or message us to cancel first.`, 'books_in_progress');
    const keys = (await q(`SELECT p.storage_key FROM photos p JOIN books b ON b.id = p.book_id WHERE b.user_id = $1
                           UNION ALL SELECT jsonb_array_elements_text(r.pages) FROM proof_rounds r JOIN books b ON b.id = r.book_id WHERE b.user_id = $1`, [req.user!.id])).map(r => r.storage_key);
    const u = await one('SELECT email, phone, name FROM users WHERE id = $1', [req.user!.id]);
    await tx(async c => {
      // Photos, answers, letters and addresses are removed; orders/invoices are kept (tax law) with the contact details redacted.
      await q('DELETE FROM photos WHERE book_id IN (SELECT id FROM books WHERE user_id = $1)', [req.user!.id], c);
      await q('DELETE FROM cards WHERE book_id IN (SELECT id FROM books WHERE user_id = $1)', [req.user!.id], c);
      await q('DELETE FROM proof_rounds WHERE book_id IN (SELECT id FROM books WHERE user_id = $1)', [req.user!.id], c);
      await q(`UPDATE books SET letter = '', child_name = 'Deleted', read_progress = '{}' WHERE user_id = $1`, [req.user!.id], c);
      await q('DELETE FROM addresses WHERE user_id = $1', [req.user!.id], c);
      await q(`UPDATE orders SET contact = jsonb_build_object('name','Deleted customer'), gift_note = NULL WHERE user_id = $1`, [req.user!.id], c);
      await q(`UPDATE users SET status='deleted', email=NULL, phone=NULL, name='Deleted customer', password_hash=NULL, close_reason=$2, updated_at=now() WHERE id=$1`, [req.user!.id, b.reason ?? null], c);
      await revokeSessions(req.user!.id, undefined, c);
      await enqueue('notify', { template: 'account_closed', to: { email: u.email ?? undefined }, data: { deleted: true, first: String(u.name).split(' ')[0] } }, {}, c);
    });
    await Promise.allSettled(keys.map(k => storage().remove(k)));
    await endSession(req, reply);
    return { ok: true };
  });
}
