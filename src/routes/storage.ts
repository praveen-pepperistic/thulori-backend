// Upload/download endpoints for the local storage driver (development). With S3 the browser
// talks to the bucket directly and these routes answer 404.
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { LocalStorage, storage } from '../services/storage/index.js';
import { HttpError, notFound } from '../lib/errors.js';

export async function storageRoutes(app: FastifyInstance) {
  const local = () => { const s = storage(); if (config().STORAGE_DRIVER !== 'local' || !(s instanceof LocalStorage)) throw notFound(); return s; };

  app.put('/put/:token', async (req) => {
    const s = local();
    const t = s.verify('put', (req.params as any).token);
    if (!t) throw new HttpError(403, 'expired', 'This upload link has expired.');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'empty', 'Empty upload.');
    if (t.mime && String(req.headers['content-type'] ?? '').split(';')[0] !== t.mime) throw new HttpError(400, 'bad_type', 'Content type does not match.');
    if (t.bytes && body.length > t.bytes) throw new HttpError(413, 'too_large', 'File is larger than announced.');
    await s.put(t.key, body);
    return { ok: true };
  });

  app.get('/get/:token', async (req, reply) => {
    const s = local();
    const t = s.verify('get', (req.params as any).token);
    if (!t) throw new HttpError(403, 'expired', 'This link has expired.');
    if (!(await s.exists(t.key))) throw notFound();
    const ext = path.extname(t.key).slice(1);
    const type = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' } as Record<string, string>)[ext] ?? 'application/octet-stream';
    reply.header('content-type', type).header('cache-control', 'private, max-age=600');
    if (t.dl) reply.header('content-disposition', `attachment; filename="${t.dl.replace(/[^\w.\- ]/g, '_')}"`);
    return reply.send(createReadStream(path.resolve(s.root, t.key)));
  });
}
