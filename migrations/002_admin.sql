-- Admin panel: separate admin sessions with an email code, payment ledger, internal notes,
-- GST invoices, manual (off-platform) checkpoints and a notification log.

-- Sessions: customer sessions (website) and admin sessions (admin panel) never mix.
ALTER TABLE sessions ADD COLUMN kind text NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer','admin'));

CREATE TABLE admin_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Orders: GST and the amount actually charged; where the order came from; cancellations/refunds.
ALTER TABLE orders ADD COLUMN tax_paise integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN total_paise integer;
UPDATE orders SET total_paise = subtotal_paise + tax_paise;
ALTER TABLE orders ALTER COLUMN total_paise SET NOT NULL;
ALTER TABLE orders ADD COLUMN gst_rate numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web','admin'));
ALTER TABLE orders ADD COLUMN refunded_paise integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN cancelled_at timestamptz;
ALTER TABLE orders ADD COLUMN cancel_reason text;
CREATE INDEX orders_status ON orders(status, created_at DESC);
CREATE INDEX orders_state ON orders((address->>'state'));

-- Every money movement: gateway payments, manual (UPI/bank/cash) payments and refunds.
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
  provider     text NOT NULL,                 -- cashfree | mock | manual
  method       text,                          -- upi | card | netbanking | bank_transfer | cash | other
  amount_paise integer NOT NULL CHECK (amount_paise > 0),
  ref          text,
  note         text,
  recorded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_at ON payments(at DESC);
CREATE INDEX payments_order ON payments(order_id);
INSERT INTO payments(order_id, provider, method, amount_paise, ref, at)
  SELECT id, payment_provider, NULL, total_paise, payment_ref, paid_at FROM orders WHERE paid_at IS NOT NULL;

CREATE TABLE order_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  book_id    uuid REFERENCES books(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_notes_order ON order_notes(order_id, created_at);

-- Tax invoices. Numbers run per Indian financial year: TH/2026-27/0001.
CREATE TABLE invoice_counters (fy text PRIMARY KEY, n integer NOT NULL DEFAULT 0);
CREATE TABLE invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  number         text NOT NULL UNIQUE,
  issued_on      date NOT NULL DEFAULT CURRENT_DATE,
  bill_to        jsonb NOT NULL,
  lines          jsonb NOT NULL,              -- [{desc, hsn, qty, unit_paise, amount_paise}]
  subtotal_paise integer NOT NULL,
  tax            jsonb NOT NULL,              -- {rate, cgst, sgst, igst}
  total_paise    integer NOT NULL,
  paid_paise     integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  token          text NOT NULL UNIQUE,        -- unguessable link for the customer copy
  sent_at        timestamptz,
  sent_to        text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_order ON invoices(order_id);

-- What was sent to whom (shown on the order timeline; failures can be resent).
CREATE TABLE notification_log (
  id        bigserial PRIMARY KEY,
  user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  order_id  uuid REFERENCES orders(id) ON DELETE SET NULL,
  template  text NOT NULL,
  channel   text NOT NULL,                    -- email | whatsapp
  recipient text,
  status    text NOT NULL,                    -- sent | logged | failed | skipped
  error     text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_log_order ON notification_log(order_id, at);

-- Manual checkpoints: who moved a book and why.
ALTER TABLE books ADD COLUMN stage_log jsonb NOT NULL DEFAULT '[]';
