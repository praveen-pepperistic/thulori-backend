// Photo and proof file storage. Browsers upload directly to storage with short-lived
// signed URLs and read through signed URLs too, so files are never public.
//  - s3:    any S3-compatible bucket (AWS S3, Cloudflare R2, Wasabi, MinIO)
//  - local: files on this server's disk, signed with SESSION_SECRET (development only)
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';
import { signPayload, verifyPayload } from '../../lib/crypto.js';

export interface SignedUpload { url: string; method: 'PUT'; headers: Record<string, string>; }
export interface Storage {
  uploadUrl(key: string, mime: string, bytes: number): Promise<SignedUpload>;
  readUrl(key: string, opts?: { download?: string }): Promise<string>;
  exists(key: string): Promise<{ bytes: number } | null>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, mime: string): Promise<void>;
  remove(key: string): Promise<void>;
}

class S3Storage implements Storage {
  private s3: S3Client;
  private bucket: string;
  private ttl: number;
  constructor() {
    const c = config();
    this.bucket = c.S3_BUCKET;
    this.ttl = c.SIGNED_URL_MINUTES * 60;
    this.s3 = new S3Client({
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT || undefined,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY },
    });
  }
  async uploadUrl(key: string, mime: string, bytes: number) {
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mime, ContentLength: bytes }), { expiresIn: 15 * 60 });
    return { url, method: 'PUT' as const, headers: { 'Content-Type': mime } };
  }
  readUrl(key: string, opts: { download?: string } = {}) {
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentDisposition: opts.download ? `attachment; filename="${opts.download.replace(/"/g, '')}"` : undefined,
    }), { expiresIn: this.ttl });
  }
  async exists(key: string) {
    try { const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return { bytes: Number(h.ContentLength ?? 0) }; }
    catch (e: any) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null; throw e; }
  }
  async get(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async put(key: string, body: Buffer, mime: string) { await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime })); }
  async remove(key: string) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

/** Development driver: stores under STORAGE_LOCAL_DIR and serves via /api/storage/* routes. */
export class LocalStorage implements Storage {
  root = path.resolve(config().STORAGE_LOCAL_DIR);
  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('bad key');
    return p;
  }
  private token(op: 'put' | 'get', key: string, extra: object = {}) {
    return signPayload(config().SESSION_SECRET, { op, key, exp: Date.now() + config().SIGNED_URL_MINUTES * 60_000, ...extra });
  }
  verify(op: 'put' | 'get', token: string) {
    const p = verifyPayload<{ op: string; key: string; exp: number; mime?: string; bytes?: number; dl?: string }>(config().SESSION_SECRET, token);
    return p && p.op === op && p.exp > Date.now() ? p : null;
  }
  async uploadUrl(key: string, mime: string, bytes: number) {
    return { url: `${config().API_URL}/api/storage/put/${this.token('put', key, { mime, bytes })}`, method: 'PUT' as const, headers: { 'Content-Type': mime } };
  }
  async readUrl(key: string, opts: { download?: string } = {}) { return `${config().API_URL}/api/storage/get/${this.token('get', key, { dl: opts.download })}`; }
  async exists(key: string) { try { const s = await stat(this.file(key)); return { bytes: s.size }; } catch { return null; } }
  get(key: string) { return readFile(this.file(key)); }
  async put(key: string, body: Buffer) { const f = this.file(key); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, body); }
  async remove(key: string) { await rm(this.file(key), { force: true }); }
}

let instance: Storage | null = null;
export const storage = (): Storage => (instance ??= config().STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage());

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export const ALLOWED_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const extFor = (mime: string) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' } as Record<string, string>)[mime] ?? 'bin';
