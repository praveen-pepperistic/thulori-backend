import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { authPlugin } from './auth/index.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { orderRoutes } from './routes/orders.js';
import { webhookRoutes } from './routes/webhooks.js';
import { bookRoutes } from './routes/books.js';
import { proofRoutes } from './routes/proof.js';
import { adminRoutes } from './routes/admin.js';
import { adminAuthRoutes } from './routes/admin-auth.js';
import { invoiceHtml } from './services/invoices.js';
import { storageRoutes } from './routes/storage.js';

export function allowedOrigins() {
  const c = config();
  return [c.SITE_URL, c.ADMIN_URL, ...c.CORS_ORIGINS.split(',')].map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: c.LOG_LEVEL, redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-client-secret"]'] },
    trustProxy: (_addr: string, hop: number) => hop < c.TRUST_PROXY, // trust only our own proxy hop(s)
    bodyLimit: 1_000_000,
    routerOptions: { maxParamLength: 2000 }, // signed storage tokens live in the path
  });

  // Keep the raw JSON body (webhook signatures are computed over it).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(new HttpError(400, 'bad_json', 'Invalid JSON body.'), undefined); }
  });
  // Raw uploads for the local storage driver.
  app.addContentTypeParser(/^(image\/|application\/octet-stream)/, { parseAs: 'buffer', bodyLimit: c.UPLOAD_MAX_MB * 1024 * 1024 }, (_req, body, done) => done(null, body));

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  const origins = allowedOrigins();
  await app.register(cors, { origin: (o, cb) => cb(null, !o || origins.includes(o.replace(/\/$/, ''))), credentials: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] });
  await app.register(cookie, { secret: c.SESSION_SECRET });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', keyGenerator: req => req.ip });
  await app.register(authPlugin);

  // CSRF defence: state-changing requests must come from our own site (cookies are SameSite too).
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.url.startsWith('/api/webhooks/') || req.url.startsWith('/api/storage/put/')) return;
    const origin = String(req.headers.origin ?? '').replace(/\/$/, '');
    const referer = String(req.headers.referer ?? '');
    const ok = origin ? origins.includes(origin) : origins.some(o => referer.startsWith(o + '/'));
    if (!ok) throw new HttpError(403, 'bad_origin', 'Request blocked: unknown origin.');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests — please wait a moment.' } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'bad_request', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
  });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(async (api) => {
    await api.register(authRoutes, { prefix: '/auth' });
    await api.register(meRoutes, { prefix: '/me' });
    await api.register(orderRoutes, { prefix: '/orders' });
    await api.register(webhookRoutes, { prefix: '/webhooks' });
    await api.register(bookRoutes);
    await api.register(proofRoutes);
    await api.register(adminAuthRoutes, { prefix: '/admin/auth' });
    await api.register(adminRoutes, { prefix: '/admin' });
    // Public: prices/tax settings for the checkout, and the customer copy of an invoice.
    api.get('/config', async () => ({ gstRate: c.GST_RATE, pricesIncludeGst: c.PRICES_INCLUDE_GST }));
    api.get('/invoices/:token', async (req, reply) => {
      const html = await invoiceHtml(String((req.params as any).token).slice(0, 100));
      if (!html) return reply.status(404).type('text/plain').send('Invoice not found.');
      return reply.type('text/html; charset=utf-8').header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex').send(html);
    });
    await api.register(storageRoutes, { prefix: '/storage' });
  }, { prefix: '/api' });

  return app;
}

// Serverless entry (Vercel picks up src/app's default export): build the app once per instance,
// then hand each request to Fastify. Locally and in Docker, server.ts calls listen() instead.
let serverless: Promise<FastifyInstance> | undefined;
export default async function handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const app = await (serverless ??= buildApp().then(async a => { await a.ready(); return a; }));
  app.server.emit('request', req, res);
}
