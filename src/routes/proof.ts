import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireUser } from '../auth/index.js';
import { parse, zUuid } from '../lib/validate.js';
import { conflict, notFound } from '../lib/errors.js';
import { EDITIONS, STAGE, type Edition } from '../lib/catalog.js';
import { bookState } from '../state.js';
import { enqueue } from '../lib/jobs.js';
import { ownBook } from './books.js';

async function openRound(bookId: string, userId: string) {
  const b = await ownBook(bookId, userId);
  if (b.stage !== STAGE.PROOF) throw conflict('There’s no proof waiting for review right now.', 'no_proof');
  const r = await one(`SELECT * FROM proof_rounds WHERE book_id = $1 ORDER BY round DESC LIMIT 1`, [b.id]);
  if (!r || r.status !== 'ready') throw conflict('This proof has already been answered.', 'no_proof');
  return { b, r };
}

export async function proofRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);
  const idParam = (p: unknown) => parse(z.object({ id: zUuid }), p).id;
  const zNote = z.object({ at: z.number().int().min(0).max(400), page: z.string().trim().max(60), text: z.string().trim().min(1, 'Write a note first.').max(2000) });

  app.get('/books/:id/proof', async (req) => {
    const b = await ownBook(idParam(req.params), req.user!.id);
    const s = await bookState(b);
    const used = await one(`SELECT count(*)::int AS n FROM proof_rounds WHERE book_id = $1 AND status = 'changes_requested'`, [b.id]);
    return { proof: s.proof, stage: b.stage, revisionsLeft: Math.max(0, EDITIONS[b.edition as Edition].revisionRounds - used.n) };
  });

  app.post('/books/:id/proof/notes', async (req, reply) => {
    const { r } = await openRound(idParam(req.params), req.user!.id);
    const n = parse(zNote, req.body);
    const row = await one(`INSERT INTO proof_notes(round_id, page_index, page_label, body) VALUES ($1,$2,$3,$4) RETURNING id`, [r.id, n.at, n.page, n.text]);
    return reply.status(201).send({ id: row.id });
  });

  const ownNote = async (id: string, userId: string) => {
    const n = await one(`SELECT n.*, r.book_id FROM proof_notes n JOIN proof_rounds r ON r.id = n.round_id JOIN books b ON b.id = r.book_id
                         WHERE n.id = $1 AND b.user_id = $2`, [id, userId]);
    if (!n) throw notFound();
    await openRound(n.book_id, userId);
    if (n.sent) throw conflict('This note has already been sent.');
    return n;
  };
  app.patch('/proof/notes/:id', async (req) => {
    const n = await ownNote(idParam(req.params), req.user!.id);
    const b = parse(zNote.pick({ text: true }), req.body);
    await q('UPDATE proof_notes SET body = $2 WHERE id = $1', [n.id, b.text]);
    return { ok: true };
  });
  app.delete('/proof/notes/:id', async (req) => {
    const n = await ownNote(idParam(req.params), req.user!.id);
    await q('DELETE FROM proof_notes WHERE id = $1', [n.id]);
    return { ok: true };
  });

  app.post('/books/:id/proof/changes', async (req) => {
    const { b, r } = await openRound(idParam(req.params), req.user!.id);
    const notes = await one(`SELECT count(*)::int AS n FROM proof_notes WHERE round_id = $1`, [r.id]);
    if (!notes.n) throw conflict('Add at least one note on the pages you’d like changed.');
    const used = await one(`SELECT count(*)::int AS n FROM proof_rounds WHERE book_id = $1 AND status = 'changes_requested'`, [b.id]);
    if (used.n >= EDITIONS[b.edition as Edition].revisionRounds) throw conflict('You’ve used every revision round in this edition. Approve this proof, or message us if something must still change.', 'no_revisions_left');
    const today = new Date().toISOString().slice(0, 10);
    await tx(async c => {
      await q(`UPDATE proof_rounds SET status = 'changes_requested', decided_at = now() WHERE id = $1`, [r.id], c);
      await q(`UPDATE proof_notes SET sent = true WHERE round_id = $1`, [r.id], c);
      await q(`UPDATE books SET stage = $2::int, stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text) WHERE id = $1`, [b.id, STAGE.DESIGN, today], c);
      await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'proof_changes',$2)`, [b.user_id, { book: b.id, round: r.round, notes: notes.n }], c);
    });
    return { book: await bookState(await ownBook(b.id, req.user!.id)) };
  });

  app.post('/books/:id/proof/approve', async (req) => {
    const { b, r } = await openRound(idParam(req.params), req.user!.id);
    const today = new Date().toISOString().slice(0, 10);
    await tx(async c => {
      await q(`UPDATE proof_rounds SET status = 'approved', decided_at = now() WHERE id = $1`, [r.id], c);
      await q(`UPDATE books SET stage = $2::int, stage_dates = stage_dates || jsonb_build_object(($2::int)::text, $3::text) WHERE id = $1`, [b.id, STAGE.PRINTING, today], c);
      await enqueue('notify', { template: 'stage_update', userId: b.user_id, data: { child: b.child_name, stage: 'Printing' } }, {}, c);
      await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'proof_approved',$2)`, [b.user_id, { book: b.id, round: r.round }], c);
    });
    return { book: await bookState(await ownBook(b.id, req.user!.id)) };
  });
}
