// All configuration comes from environment variables, validated once at start-up.
// See .env.example for every option. Drivers let the API run locally with no external
// accounts (mock payments, local disk storage, mock AI, log-only notifications).
import { existsSync } from 'node:fs';
import { z } from 'zod';

// Local development: read ./.env if present (real environment variables always win).
if (process.env.NODE_ENV !== 'test' && existsSync('.env')) process.loadEnvFile('.env');

const bool = z.enum(['true', 'false', '1', '0']).transform(v => v === 'true' || v === '1');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_SSL: bool.default(false),

  /** Public URL of the website (the static site in /site). Used for CORS, cookies and redirects. */
  SITE_URL: z.string().url().default('http://localhost:5173'),
  /** Public URL of this API (used for webhook and local-storage links). */
  API_URL: z.string().url().default('http://localhost:8080'),
  /** Public URL of the admin panel (the /admin folder). */
  ADMIN_URL: z.string().url().default('http://localhost:5174'),
  /** Admin sign-in sends a 6-digit code to the staff member's email. Turn off only for local development. */
  ADMIN_2FA: bool.default(true),
  ADMIN_SESSION_HOURS: z.coerce.number().int().positive().default(12),
  /** Extra allowed browser origins, comma separated. */
  CORS_ORIGINS: z.string().default(''),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().optional(),
  /** Use SameSite=None (needed only when site and API are on different sites). */
  COOKIE_CROSS_SITE: bool.default(false),

  // Payments
  PAYMENTS_DRIVER: z.enum(['mock', 'cashfree']).default('mock'),
  CASHFREE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  CASHFREE_CLIENT_ID: z.string().default(''),
  CASHFREE_CLIENT_SECRET: z.string().default(''),
  CASHFREE_API_VERSION: z.string().default('2026-01-01'),

  // Photo storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool.default(false),
  UPLOAD_MAX_MB: z.coerce.number().positive().default(25),
  SIGNED_URL_MINUTES: z.coerce.number().int().positive().default(30),

  // AI photo reading
  AI_DRIVER: z.enum(['mock', 'openai']).default('mock'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-6-astra'),
  AI_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(6),

  /** Unpaid orders are closed after this many days. */
  UNPAID_EXPIRY_DAYS: z.coerce.number().int().min(1).max(60).default(7),
  /** How often the worker re-checks payments and refunds with the gateway. */
  RECONCILE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),

  // Tax & invoices (confirm the GST rate and HSN code with your CA before going live)
  GST_RATE: z.coerce.number().min(0).max(28).default(18),
  /** false: listed prices are before GST and GST is added at checkout (the site says so). */
  PRICES_INCLUDE_GST: bool.default(false),
  INVOICE_PREFIX: z.string().default('TH'),
  INVOICE_HSN: z.string().default('4911'),
  COMPANY_NAME: z.string().default('Pepperistic Studio Pvt Ltd'),
  COMPANY_BRAND: z.string().default('Thulori'),
  COMPANY_ADDRESS: z.string().default(''),
  COMPANY_STATE: z.string().default('Tamil Nadu'),
  COMPANY_GSTIN: z.string().default(''),
  COMPANY_EMAIL: z.string().default('hello@thulori.com'),
  COMPANY_PHONE: z.string().default('+91 97893 90456'),

  // Notifications
  NOTIFY_EMAIL: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.string().default(''),
  EMAIL_FROM: z.string().default('Thulori <hello@thulori.com>'),
  NOTIFY_WHATSAPP: z.enum(['log', 'cloud']).default('log'),
  WA_PHONE_NUMBER_ID: z.string().default(''),
  WA_ACCESS_TOKEN: z.string().default(''),
  WA_GRAPH_VERSION: z.string().default('v23.0'),
  WA_TEMPLATE_LANG: z.string().default('en'),
  WA_VERIFY_TOKEN: z.string().default(''),
  /** Team inbox that receives copies of new-order alerts. */
  TEAM_EMAIL: z.string().default(''),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (c.PAYMENTS_DRIVER === 'mock') missing.push('PAYMENTS_DRIVER=cashfree');
    if (c.PAYMENTS_DRIVER === 'cashfree' && (!c.CASHFREE_CLIENT_ID || !c.CASHFREE_CLIENT_SECRET)) missing.push('CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET');
    if (c.STORAGE_DRIVER === 's3' && (!c.S3_BUCKET || !c.S3_ACCESS_KEY_ID)) missing.push('S3_BUCKET / S3_ACCESS_KEY_ID');
    if (c.AI_DRIVER === 'openai' && !c.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
    if (missing.length) throw new Error(`Production configuration incomplete: ${missing.join(', ')}`);
  }
  return c;
}

let cached: Config | null = null;
export const config = (): Config => (cached ??= loadConfig());
export const setConfigForTests = (c: Config) => { cached = c; };
