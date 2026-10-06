// The "read my photos" job: look at every new photo (in batches), write one question per
// photo, then look across all photos for things that recur and write theme questions.
// If the AI keeps failing, parents still get a simple question for each photo.
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { photoReader, type PhotoInput } from './ai/index.js';
import { storage } from './storage/index.js';
import { EDITIONS, type Edition } from '../lib/catalog.js';

const AI_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']); // HEIC can't be read by the model
const THEME_MAX: Record<string, number> = { vidhai: 4, thulir: 6, malar: 8 };

const fmtDay = (d: string | null) => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

async function basicCard(bookId: string, p: any, child: string, c?: any) {
  const d = fmtDay(p.taken_on);
  await q(`INSERT INTO cards(book_id, kind, photo_ids, topic, obs, question, options, source) VALUES ($1,'photo',$2,$3,$4,$5,$6,'basic')`,
    [bookId, [p.id], d, d ? `Taken on ${d}.` : 'A photo you added.', 'What’s the story behind this one?',
      JSON.stringify([`One of ${child}’s firsts`, 'A favourite everyday moment', 'A special visit, festival or trip'])], c);
  await q('UPDATE photos SET read_at = now() WHERE id = $1', [p.id], c);
}

async function imageFor(p: any): Promise<string> {
  if (config().STORAGE_DRIVER === 's3') return storage().readUrl(p.storage_key);
  const buf = await storage().get(p.storage_key); // local disk isn't reachable by OpenAI — send inline
  return `data:${p.mime};base64,${buf.toString('base64')}`;
}

export async function readPhotos(payload: { bookId: string; force?: boolean }, log: (m: string) => void = () => {}) {
  const book = await one('SELECT * FROM books WHERE id = $1', [payload.bookId]);
  if (!book || (book.stage !== 0 && !payload.force)) return;
  const child = book.child_name;
  await q(`UPDATE books SET read_status = 'running', read_error = NULL, read_started_at = now() WHERE id = $1`, [book.id]);
  const todo = await q(`SELECT * FROM photos WHERE book_id = $1 AND status = 'uploaded' AND read_at IS NULL ORDER BY position, created_at`, [book.id]);
  const total = todo.length;
  let done = 0, fails = 0, aiOk = 0;
  const progress = () => q(`UPDATE books SET read_progress = $2 WHERE id = $1`, [book.id, { done, total, step: done < total ? 'photos' : 'themes' }]);
  await progress();
  const reader = photoReader();
  const size = Math.max(1, config().AI_BATCH_SIZE);

  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    const readable = batch.filter(p => AI_TYPES.has(p.mime));
    for (const p of batch.filter(p => !AI_TYPES.has(p.mime))) await basicCard(book.id, p, child);
    let readings: Awaited<ReturnType<typeof reader.describe>> = [];
    if (readable.length && fails < 3) {
      try {
        const inputs: PhotoInput[] = await Promise.all(readable.map(async p => ({ id: p.id, image: await imageFor(p) })));
        readings = await reader.describe(child, inputs);
      } catch (e) { fails++; log(`photo reading failed for book ${book.id}: ${(e as Error).message}`); }
    }
    await tx(async c => {
      for (const p of readable) {
        // Skip if the photo was deleted meanwhile or already has a card.
        if (!(await one('SELECT 1 FROM photos WHERE id = $1', [p.id], c))) continue;
        if (await one(`SELECT 1 FROM cards WHERE book_id = $1 AND kind = 'photo' AND photo_ids[1] = $2`, [book.id, p.id], c)) continue;
        const r = readings.find(x => x.id === p.id);
        if (!r) { await basicCard(book.id, p, child, c); continue; }
        aiOk++;
        await q(`UPDATE photos SET analysis = $2, read_at = now() WHERE id = $1`, [p.id, { scene: r.scene, people: r.people, things: r.things, place: r.place, occasion: r.occasion }], c);
        await q(`INSERT INTO cards(book_id, kind, photo_ids, obs, question, options, source) VALUES ($1,'photo',$2,$3,$4,$5,'ai')`,
          [book.id, [p.id], r.obs, r.q, JSON.stringify(r.options.slice(0, 3))], c);
      }
    });
    done += batch.length;
    await progress();
  }

  // Themes across every photo the AI has read. Unanswered old themes are replaced; answered ones kept.
  const read = await q(`SELECT id, analysis FROM photos WHERE book_id = $1 AND analysis IS NOT NULL`, [book.id]);
  let themeError: string | null = null;
  if (read.length >= 2 && (aiOk > 0 || total === 0)) {
    try {
      const kept = await q(`SELECT topic FROM cards WHERE book_id = $1 AND kind = 'theme' AND (pick IS NOT NULL OR answer <> '')`, [book.id]);
      const cards = await reader.themes(child, EDITIONS[book.edition as Edition]?.name ?? book.edition,
        read.map(p => ({ id: p.id, ...p.analysis })), kept.map(k => k.topic), THEME_MAX[book.edition] ?? 4);
      await tx(async c => {
        await q(`DELETE FROM cards WHERE book_id = $1 AND kind = 'theme' AND pick IS NULL AND answer = ''`, [book.id], c);
        for (const t of cards) await q(`INSERT INTO cards(book_id, kind, photo_ids, topic, obs, question, options, source) VALUES ($1,'theme',$2,$3,$4,$5,$6,'ai')`,
          [book.id, t.photos, t.topic, t.obs, t.q, JSON.stringify(t.options.slice(0, 3))], c);
      });
    } catch (e) { themeError = 'We couldn’t look across your photos this time.'; log(`theme reading failed for book ${book.id}: ${(e as Error).message}`); }
  }
  const err = fails >= 1 && aiOk === 0 && total > 0 ? 'Photo reading is busy right now, so there’s a simple question for each photo. Try “Read again” later.' : themeError;
  await q(`UPDATE books SET read_status = 'done', read_error = $2, read_progress = $3 WHERE id = $1`, [book.id, err, { done: total, total, step: 'done' }]);
}
