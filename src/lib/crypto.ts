import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, URL-safe — used for session and reset tokens. Only the SHA-256 is stored. */
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function hmac(secret: string, data: string, enc: 'hex' | 'base64' | 'base64url' = 'base64url') {
  return createHmac('sha256', secret).update(data).digest(enc);
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Compact signed token: base64url(json).sig — used by the local storage driver. */
export function signPayload(secret: string, payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}
export function verifyPayload<T>(secret: string, token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(hmac(secret, body), sig)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()) as T; } catch { return null; }
}
