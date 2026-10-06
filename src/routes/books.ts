import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireUser } from '../auth/index.js';
import { parse, zName, zUuid } from '../lib/validate.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { EDITIONS, MIN_PHOTOS_TO_SUBMIT, MIN_STORIES_TO_SUBMIT, STAGE, type Edition } from '../lib/catalog.js';
import { config } from '../config.js';
import { ALLOWED_IMAGE_TYPES, extFor, storage } from '../services/storage/index.js';
import { bookState } from '../state.js';
import { enqueue } from '../lib/jobs.js';

/** Loads a book the signed-in customer owns (from a paid order). */
export async function ownBook(id: string, userId: string, opts: { open?: boolean } = {}) {
  const b = await one(`SELECT b.*, o.number AS order_number, o.status AS order_status FROM books b JOIN orders o ON o.id = b.order_id
                       WHERE b.id = $1 AND b.user_id = $2`, [id, userId]);
  if (!b) throw notFound('We couldn’t find that storybook.');
  if (b.order_status !== 'paid') throw conflict('This storybook opens once payment is complete.', 'unpaid');
  if (opts.open && b.stage !== STAGE.PHOTOS) throw conflict('Photos and stories are locked — the team is already crafting this book.', 'locked');
  return b;
}

const answered = `(pick IS NOT NULL OR answer <> '')`;

export async function bookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);
  const idParam = (p: unknown) => parse(z.object({ id: zUuid }), p).id;

  app.get('/books/:id', async (req) => ({ book: await bookState(await ownBook(idParam(req.params), req.user!.id)) }));

  app.patch('/books/:id', async (req) => {
    const b = await ownBook(idParam(req.params), req.user!.id, { open: true });
    const body = parse(z.object({ letter: z.string().max(4000).optional(), childName: zName.optional() }), req.body);
    await q(`UPDATE books SET letter = COALESCE($2, letter), child_name = COALESCE($3, child_name) WHERE id = $1`, [b.id, body.letter ?? null, body.childName ?? null]);
    if (body.childName) await q('UPDATE order_items SET child_name = $2 WHERE book_id = $1', [b.id, body.childName]);
    return { ok: true };
  });

  // ---- photos: 1) ask for signed upload URLs  2) browser PUTs each file  3) confirm
  app.post('/books/:id/photos/uploads', async (req) => {
    const b = await ownBook(idParam(req.params), req.user!.id, { open: true });
    const max = config().UPLOAD_MAX_MB * 1024 * 1024;
    const body = parse(z.object({ files: z.array(z.object({
      name: z.string().max(200).default(''),
      type: z.string().refine(t => (ALLOWED_IMAGE_TYPES as readonly string[]).includes(t), 'Photos must be JPG, PNG, WebP or HEIC.'),
      size: z.number().int().positive().max(max, `Each photo can be up to ${config().UPLOAD_MAX_MB} MB.`),
      takenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    })).min(1).max(50) }), req.body);
    const limit = EDITIONS[b.edition as Edition].photos;
    await q(`DELETE FROM photos WHERE book_id = $1 AND status = 'pending' AND created_at < now() - interval '1 day'`, [b.id]);
    const have = await one(`SELECT count(*)::int AS n, COALESCE(max(position), 0) AS pos FROM photos WHERE book_id = $1`, [b.id]);
    if (have.n + body.files.length > limit) throw conflict(`${EDITIONS[b.edition as Edition].name} holds up to ${limit} photos — you can add ${Math.max(0, limit - have.n)} more.`, 'photo_limit');
    const out = [];
    let pos = have.pos;
    for (const f of body.files) {
      const id = randomUUID();
      const key = `books/${b.id}/${id}.${extFor(f.type)}`;
      await q(`INSERT INTO photos(id, book_id, storage_key, file_name, mime, bytes, taken_on, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, b.id, key, f.name.slice(0, 200), f.type, f.size, f.takenOn ?? null, ++pos]);
      out.push({ id, upload: await storage().uploadUrl(key, f.type, f.size) });
    }
    return { uploads: out };
  });

  app.post('/books/:id/photos/complete', async (req) => {
    const b = await ownBook(idParam(req.params), req.user!.id, { open: true });
    const { ids } = parse(z.object({ ids: z.array(zUuid).min(1).max(50) }), req.body);
    const rows = await q(`SELECT * FROM photos WHERE book_id = $1 AND id = ANY($2::uuid[]) AND status = 'pending'`, [b.id, ids]);
    const ok: string[] = [], missing: string[] = [];
    for (const p of rows) {
      const s = await storage().exists(p.storage_key);
      if (s && s.bytes > 0) { await q(`UPDATE photos SET status = 'uploaded', bytes = $2 WHERE id = $1`, [p.id, s.bytes]); ok.push(p.id); }
      else missing.push(p.id);
    }
    return { uploaded: ok, missing, book: await bookState(b) };
  });

  app.patch('/photos/:id', async (req) => {
    const p = await one(`SELECT p.*, b.user_id FROM photos p JOIN books b ON b.id = p.book_id WHERE p.id = $1`, [idParam(req.params)]);
    if (!p || p.user_id !== req.user!.id) throw notFound();
    await ownBook(p.book_id, req.user!.id, { open: true });
    const body = parse(z.object({ fav: z.boolean().optional(), takenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }), req.body);
    await q(`UPDATE photos SET fav = COALESCE($2, fav), taken_on = CASE WHEN $3 THEN $4::date ELSE taken_on END WHERE id = $1`,
      [p.id, body.fav ?? null, body.takenOn !== undefined, body.takenOn ?? null]);
    return { ok: true };
  });

  app.delete('/photos/:id', async (req) => {
    const p = await one(`SELECT p.*, b.user_id FROM photos p JOIN books b ON b.id = p.book_id WHERE p.id = $1`, [idParam(req.params)]);
    if (!p || p.user_id !== req.user!.id) throw notFound();
    await ownBook(p.book_id, req.user!.id, { open: true });
    await tx(async c => {
      await q(`DELETE FROM cards WHERE book_id = $1 AND kind = 'photo' AND photo_ids[1] = $2`, [p.book_id, p.id], c);
      await q(`UPDATE cards SET photo_ids = array_remove(photo_ids, $2) WHERE book_id = $1 AND kind = 'theme' AND $2 = ANY(photo_ids)`, [p.book_id, p.id], c);
      await q(`DELETE FROM cards WHERE book_id = $1 AND kind = 'theme' AND cardinality(photo_ids) < 2 AND NOT ${answered}`, [p.book_id], c);
      await q('DELETE FROM photos WHERE id = $1', [p.id], c);
    });
    await storage().remove(p.storage_key).catch(() => {});
    return { ok: true };
  });

  // ---- photo reading (runs in the worker)
  app.post('/books/:id/read', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const b = await ownBook(idParam(req.params), req.user!.id, { open: true });
    const { again } = parse(z.object({ again: z.boolean().default(false) }), req.body);
    if (b.read_status === 'queued' || b.read_status === 'running') return { read: { status: b.read_status, progress: b.read_progress } };
    if (again) {
      // Re-read photos that only got the simple question (and nothing was answered yet).
      await q(`UPDATE photos SET read_at = NULL WHERE book_id = $1 AND analysis IS NULL AND id IN
                 (SELECT photo_ids[1] FROM cards WHERE book_id = $1 AND kind = 'photo' AND source = 'basic' AND NOT ${answered})`, [b.id]);
      await q(`DELETE FROM cards WHERE book_id = $1 AND kind = 'photo' AND source = 'basic' AND NOT ${answered}
                 AND photo_ids[1] IN (SELECT id FROM photos WHERE book_id = $1 AND read_at IS NULL)`, [b.id]);
    }
    const todo = await one(`SELECT count(*)::int AS n FROM photos WHERE book_id = $1 AND status = 'uploaded' AND read_at IS NULL`, [b.id]);
    if (!todo.n && !again) return { read: { status: 'done', progress: { done: 0, total: 0, step: 'done' } } };
    await tx(async c => {
      await q(`UPDATE books SET read_status = 'queued', read_error = NULL, read_started_at = now(), read_progress = $2 WHERE id = $1`, [b.id, { done: 0, total: todo.n, step: 'queued' }], c);
      await enqueue('read_photos', { bookId: b.id }, { maxAttempts: 2 }, c);
    });
    return { read: { status: 'queued', progress: { done: 0, total: todo.n } } };
  });

  app.get('/books/:id/read', async (req) => {
    const b = await ownBook(idParam(req.params), req.user!.id);
    return { read: { status: b.read_status, progress: b.read_progress, error: b.read_error } };
  });

  // ---- answers
  app.patch('/cards/:id', async (req) => {
    const c = await one(`SELECT c.*, b.user_id FROM cards c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [idParam(req.params)]);
    if (!c || c.user_id !== req.user!.id) throw notFound();
    await ownBook(c.book_id, req.user!.id, { open: true });
    const body = parse(z.object({ pick: z.number().int().min(0).max(2).nullable().optional(), text: z.string().max(4000).optional() }), req.body);
    await q(`UPDATE cards SET pick = CASE WHEN $2 THEN $3::smallint ELSE pick END, answer = COALESCE($4, answer),
               answered_at = CASE WHEN ($3::smallint IS NOT NULL OR COALESCE($4, answer) <> '') THEN now() ELSE answered_at END WHERE id = $1`,
      [c.id, body.pick !== undefined, body.pick ?? null, body.text ?? null]);
    return { ok: true };
  });

  // ---- hand over to the team
  app.post('/books/:id/submit', async (req) => {
    const b = await ownBook(idParam(req.params), req.user!.id, { open: true });
    const n = await one(`SELECT (SELECT count(*)::int FROM photos WHERE book_id = $1 AND status = 'uploaded') AS photos,
                                (SELECT count(*)::int FROM photos WHERE book_id = $1 AND status = 'uploaded' AND read_at IS NULL) AS unread,
                                (SELECT count(*)::int FROM cards WHERE book_id = $1 AND ${answered}) AS stories`, [b.id]);
    if (n.photos < MIN_PHOTOS_TO_SUBMIT) throw badRequest(`Add at least ${MIN_PHOTOS_TO_SUBMIT} photos first.`);
    if (n.unread > 0) throw badRequest('A few photos haven’t been read yet — read them first so each one gets its question.');
    if (n.stories < MIN_STORIES_TO_SUBMIT) throw badRequest(`Answer at least ${MIN_STORIES_TO_SUBMIT} questions first.`);
    const today = new Date().toISOString().slice(0, 10);
    await tx(async c => {
      await q(`UPDATE books SET stage = $2::int, submitted_at = now(), stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text) WHERE id = $1`, [b.id, STAGE.WRITING, today], c);
      await enqueue('notify', { template: 'stage_update', userId: b.user_id, data: { child: b.child_name, stage: 'Writing' } }, {}, c);
      await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'book_submitted',$2)`, [b.user_id, { book: b.id }], c);
    });
    return { book: await bookState({ ...b, stage: STAGE.WRITING, submitted_at: new Date(), stage_dates: { ...b.stage_dates, [STAGE.WRITING]: today } }) };
  });
}
