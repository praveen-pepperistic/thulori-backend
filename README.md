# Thulori API

The backend for thulori.com: accounts, orders and Cashfree payments, photo uploads, AI photo
reading (OpenAI), the proof review loop, and email + WhatsApp alerts.

**Stack:** Node.js 22 · TypeScript · Fastify 5 · PostgreSQL 16 · S3-compatible storage.
A worker process runs the slow jobs (reading photos, sending messages) from a queue kept in PostgreSQL.

The website in `../site` uses this API when `site/js/config.js` sets `apiBase`. If `apiBase` is
empty, the site runs as a demo in the browser and never contacts the API.

## Run it locally

```bash
cd server
cp .env.example .env              # works as is: mock payments, local disk, mock AI, log-only messages
npm install
createdb thulori                  # or: docker compose up db
npm run migrate
npm run dev                       # API on http://localhost:8080 (also runs the worker in development)
```

Serve the website on the `SITE_URL` port, then point it at the API:

```bash
python3 -m http.server 5173 -d ../site
# site/js/config.js →  window.THULORI_CONFIG = { apiBase: 'http://localhost:8080' };
```

To create a team (staff) login: `npm run seed:staff -- team@thulori.com "Team Thulori" 'a-long-password'`.

You can also run the whole stack in Docker: `docker compose up --build` starts Postgres, the API and a worker.

### Tests

```bash
createdb thulori_test
DATABASE_URL=postgres://localhost/thulori_test npm test
```

The test suite runs the whole customer journey against a real database:

1. Sign up.
2. Check out with server prices, then pay with the mock gateway; the webhook is idempotent.
3. Upload photos with signed URLs.
4. Read the photos: one question per photo, plus questions about things that recur.
5. Answer the questions and submit.
6. The team sends a proof; the customer asks for changes; the team sends round 2; the customer approves.
7. Ship and deliver.
8. Change password, deactivate the account, then reactivate it.

It also checks that one customer can't open another customer's book, and that the CSRF origin check works.

## Going live: connect each service

Switch each driver on in `.env` as you connect its service. With `NODE_ENV=production` the API won't start if a required key is missing.

### 1. Database: PostgreSQL

Any managed PostgreSQL 14 or newer works, for example Neon, Supabase, AWS RDS or DigitalOcean.

- Set `DATABASE_URL`, and set `DATABASE_SSL=true` if your provider requires SSL.
- Migrations run automatically when the API starts. To run them by hand: `npm run migrate:prod`.

### 2. Payments: Cashfree

1. In the Cashfree Merchant Dashboard, go to **Developers → API Keys**. Copy the App ID and the Secret Key.
   - Use the sandbox keys first.
2. Set these in `.env`:

   ```
   PAYMENTS_DRIVER=cashfree
   CASHFREE_ENV=sandbox
   CASHFREE_CLIENT_ID=…
   CASHFREE_CLIENT_SECRET=…
   ```

3. Go to **Developers → Webhooks** and add a webhook:
   - URL: `https://<API_URL>/api/webhooks/cashfree`
   - Events: *Payment Success*, *Payment Failed*, *User Dropped*, *Refund status* and *Auto refund status*.
4. Whitelist the domain of your website in Cashfree. Cashfree requires this for the return URL.
5. Test with Cashfree's sandbox cards and UPI IDs. When everything works, switch to the production keys and set `CASHFREE_ENV=production`.

How a payment works:

1. `POST /api/orders` works out the price on the server, saves the order, and creates a Cashfree order.
2. The site opens Cashfree Checkout with the payment session id.
3. Cashfree sends the customer back to `order-confirmation.html?order=TH-…`.
4. The page asks the API for the order status. The API re-checks it with Cashfree.
5. The webhook confirms the payment on its own, even if the customer closes the tab.
6. Both paths are safe to run twice: an order is only ever marked as paid once.

## When things go wrong

Every way of hearing about a payment (webhook, the customer coming back, the background check, a manual entry) goes through one function, and each gateway payment is stored once under a unique index. So nothing is counted twice, and nothing is lost.

A background check runs every minute (`RECONCILE_SECONDS`) inside the worker. Only one worker runs it at a time.

| Situation | What happens |
|---|---|
| The customer paid but the webhook never came and they closed the tab | The background check asks Cashfree about every open payment attempt (every 3 min in the first hour, then less often for 7 days) and marks the order paid. |
| UPI payment still "pending" at the bank | The order page says *your bank is confirming — don't pay again*. Paying again is blocked (`payment_processing`) until the bank decides. |
| Payment failed or was abandoned | The order shows *Payment failed* with *Try payment again*. A retry creates a new Cashfree order (`TH-24817-2`), and the old one is still watched. |
| Paid twice (two tabs, a retry, a second payment) | The second payment is recorded and a **Paid twice** issue appears. The team gets an email at `TEAM_EMAIL`, and the order goes into the *Needs attention* queue with a **Refund this payment** button. |
| Paid after the order was cancelled | Same, as a **Paid after cancelling** issue. |
| Paid a different amount than the total | An **Overpaid / Underpaid** issue. |
| Never paid | After `UNPAID_EXPIRY_DAYS` (7), and after a last check with Cashfree, the order is cancelled and the customer is told. |
| Cashfree is down at checkout | The order is saved and the customer sees *try paying again in a minute*. |
| Photo reading stopped part-way | After 30 minutes it is marked failed so the customer (or team) can press *Read again*. |

## Refunds

Refunds of Cashfree payments go **back to the customer's original UPI, card or bank account** through the Cashfree refunds API. You don't need to log in to the Cashfree dashboard.

1. In the admin panel, choose **Refund…** on the order (or **Refund this payment** on an issue, or **Cancel order** with *refund in full*). Enter the amount and a reason.
2. The refund is saved as **On its way** before Cashfree is called. Each refund has a fixed id, which also serves as Cashfree's idempotency key, so a retried call can never refund twice.
3. Cashfree's refund webhook, or the background check (every 5 minutes on the first day, hourly after that), marks it **Reached customer** with the bank reference (ARN). The customer gets an email with that reference and sees it on their order page.
4. If the bank rejects it, the refund is marked **Failed**, an issue is raised and the team is emailed. **Retry** sends a new refund. You can also send the money another way and record it by hand.
5. If Cashfree was unreachable, the refund stays *On its way* and is sent again automatically. A refund still pending after 10 days emails the team.

Only refunds that have reached the customer count in the payments report, invoices and order totals. A full refund marks the order *Refunded*.

Payments recorded by hand (UPI, bank transfer, cash) can't go back through Cashfree. Send the money yourself, then record the method and reference. Cashfree allows refunds for up to 6 months after a payment.

**Set `TEAM_EMAIL`** in production. Every issue (paid twice, failed refund…) is emailed there with a link to the order.

### 3. Photo storage: S3 or Cloudflare R2

Photos never pass through the API. The browser uploads straight to the bucket using short-lived signed URLs, and reads them back through signed URLs too, so nothing is public.

```
STORAGE_DRIVER=s3
S3_BUCKET=thulori-photos
S3_REGION=auto                                           # AWS: ap-south-1
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com  # AWS: leave empty
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

Keep the bucket **private**. Add a CORS rule so the website can upload to it:

```json
[{ "AllowedOrigins": ["https://www.thulori.com"], "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
```

### 4. AI photo reading: OpenAI

```
AI_DRIVER=openai
OPENAI_API_KEY=sk-…
OPENAI_MODEL=gpt-6-astra      # any vision-capable model on your account
```

When a customer taps **Read my photos**, the worker does two passes:

1. It sends the photos to the model in batches of `AI_BATCH_SIZE`, at low image detail. For each photo it gets back a structured description and one question with three suggested answers.
2. It sends all the descriptions together and asks only about things that **recur** across photos, such as the same toy, person or place.

The answers use strict JSON schemas, so they are always well-formed. If reading fails three times, each photo still gets a simple question, and the customer can tap **Read again** later. HEIC photos are stored for printing, but the model can't read them, so they get the simple question.

### 5. Email

Use any SMTP provider, for example Zoho Mail, Amazon SES, Google Workspace or Resend.

```
NOTIFY_EMAIL=smtp
SMTP_URL=smtps://user:password@smtp.zoho.in:465
EMAIL_FROM="Thulori <hello@thulori.com>"
TEAM_EMAIL=orders@thulori.com     # paid-order copies + alerts: paid twice, failed refunds…
```

Customers get these emails: welcome, order placed (a reminder if they haven't paid after 30 minutes), payment received, stage updates, proof ready, shipped, password reset, and account closed.

### 6. WhatsApp alerts: Meta WhatsApp Cloud API

1. In Meta Business Manager, add a WhatsApp Business number. Create a System User with a permanent token that has the `whatsapp_business_messaging` permission.
2. Create these **utility templates** (English) and wait for them to be approved. Use the same names and parameter order:

   | Template name   | Body (example)                                                                          |
   |-----------------|-----------------------------------------------------------------------------------------|
   | `order_paid`    | Hi {{1}}, payment for order {{2}} ({{3}}) is confirmed. Add photos & stories on thulori.com. |
   | `stage_update`  | Hi {{1}}, {{2}}’s storybook has moved to “{{3}}”.                                        |
   | `proof_ready`   | Hi {{1}}, {{2}}’s proof is ready to review on thulori.com.                               |
   | `order_shipped` | Hi {{1}}, order {{2}} has shipped with {{3}}. Tracking number: {{4}}.                    |

3. Set these in `.env`:

   ```
   NOTIFY_WHATSAPP=cloud
   WA_PHONE_NUMBER_ID=…
   WA_ACCESS_TOKEN=…
   ```

4. Optional: to see customers' replies in the logs, set `WA_VERIFY_TOKEN` and add the webhook URL `https://<API_URL>/api/webhooks/whatsapp`. Your team replies from the WhatsApp Business app.

Customers can turn off WhatsApp updates in **Settings**.

### 7. Hosting

Run two processes from the same build:

- the API: `node dist/server.js`
- one or more workers: `node dist/worker.js`

Any Node host works, for example Render, Railway, Fly.io, AWS (ECS or Lightsail) or a VPS with Docker. The `Dockerfile` builds one image that runs either process.

Recommended setup:

- **Website**: `https://www.thulori.com`. It's a static site, so Cloudflare Pages, Netlify or S3 + CloudFront all work.
- **API**: `https://api.thulori.com`.
  - Set `SITE_URL=https://www.thulori.com`, `API_URL=https://api.thulori.com` and `COOKIE_DOMAIN=.thulori.com`.
  - Because the two are on the same site, the session cookie works with `SameSite=Lax`.
- In `site/js/config.js`, set `apiBase: 'https://api.thulori.com'`.

## Security notes

- **Passwords** are hashed with argon2id.
- **Sessions** are random tokens, and only their SHA-256 hash is stored.
  - The cookie is HttpOnly and Secure in production.
  - Changing your password signs you out on your other devices.
- **CSRF**: every request that changes something must come from an allowed origin. Webhooks are the exception: they are verified by signature instead.
- **Rate limits**: 300 requests a minute in general, and stricter limits on sign-in, sign-up and password routes.
- **Prices** come only from `src/lib/catalog.ts`. The browser sends edition names, never amounts.
- **Ownership**: every book, photo, card, proof and order is checked against the signed-in user.
- **Webhooks**: Cashfree webhooks are checked with HMAC-SHA256 over the timestamp plus the raw body, and anything older than 15 minutes is rejected.
- **Deleting an account** removes photos, answers, letters and addresses, and the photo files themselves. Orders are kept, with contact details removed, because tax law requires invoices to be retained. Deletion is blocked while a book is being made.

## Admin panel and GST

The admin panel is in `../admin`; see its README.

- **Admin sign-in** uses its own cookie (`thulori_admin`) and a 6-digit code sent by email. A website sign-in never opens the admin panel.
- **Roles:** `staff` runs the work. `admin` also sees payments and records money: marking an order paid, refunds and invoices.
- **GST at checkout:** `GST_RATE` is added on top of the listed prices, so a ₹6,999 Thulir becomes ₹8,258.82 at 18%. Cashfree charges this total, and the checkout and order pages show the GST line. Set `PRICES_INCLUDE_GST=true` if your prices already include GST. Confirm the rate and HSN code with your CA.
- **Refunds and issues:** `refunds` tracks each refund from pending to succeeded or failed. `order_issues` holds anything a person must look at. `payment_attempts` lists every Cashfree order created for an order.
- **Ledger:** every payment and every completed refund goes in the `payments` table, whether it came from Cashfree or was recorded by hand. The payments report and invoices are built from it.

## API overview

All routes are under `/api`. Customer routes need the session cookie, and admin routes need a staff or admin account.

| Area | Routes |
|------|--------|
| Auth | `POST /auth/signup` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/password/forgot` · `POST /auth/password/reset` |
| Account | `GET /me/state` · `PATCH /me` · `GET/POST /me/addresses` · `PATCH/DELETE /me/addresses/:id` · `POST /me/addresses/:id/default` · `POST /me/password` · `POST /me/deactivate` · `POST /me/delete` |
| Orders | `POST /orders` · `GET /orders` · `GET /orders/:id` · `POST /orders/:id/pay` · `POST /orders/:id/cancel` · `POST /orders/:id/mock-pay` (development only) |
| Books | `GET/PATCH /books/:id` · `POST /books/:id/photos/uploads` · `POST /books/:id/photos/complete` · `PATCH/DELETE /photos/:id` · `POST/GET /books/:id/read` · `PATCH /cards/:id` · `POST /books/:id/submit` |
| Proof | `GET /books/:id/proof` · `POST /books/:id/proof/notes` · `PATCH/DELETE /proof/notes/:id` · `POST /books/:id/proof/changes` · `POST /books/:id/proof/approve` |
| Admin sign-in | `POST /admin/auth/login` → `POST /admin/auth/verify` (email code) · `POST /admin/auth/logout` · `GET /admin/auth/me` |
| Admin: orders | `GET /admin/summary` · `GET /admin/orders` (filters: q, bucket, status, stage, edition, state, from, to, source) · `GET/PATCH /admin/orders/:id` · `POST /admin/orders` (manual) · `…/notes` · `…/remind` · `…/refresh-payment` · `…/ship` · `…/deliver` · *admin role:* `…/mark-paid` · `…/cancel` (optional full refund) · `GET …/refundable` · `POST …/refund` · `POST /admin/refunds/:id/check` · `POST /admin/refunds/:id/retry` · `POST /admin/issues/:id/resolve` |
| Admin: books | `GET/PATCH /admin/books/:id` · `POST …/stage` · `POST …/photos/uploads` · `POST …/photos/complete` · `DELETE /admin/photos/:id` · `POST …/read` · `PATCH /admin/cards/:id` · `GET …/photos.zip` · `GET …/stories.txt` · `POST …/proof/uploads` · `POST …/proof` · `POST …/proof/decision` |
| Admin: money | `GET /admin/payments` · `GET /admin/payments.csv` · `GET …/invoice-draft` · `POST /admin/orders/:id/invoices` · `POST /admin/invoices/:id/send` · `POST /admin/invoices/:id/void` · `GET /admin/customers` |
| Public | `GET /config` (GST settings for checkout) · `GET /invoices/:token` (customer copy) |
| Webhooks | `POST /webhooks/cashfree` · `GET/POST /webhooks/whatsapp` |

