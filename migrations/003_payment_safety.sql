-- Payment safety: every gateway attempt is tracked, every payment is recorded once, refunds go
-- back to the source through the gateway, and anything unusual becomes an issue for the team.

-- Each Cashfree order we create for an order (the first payment and every retry).
CREATE TABLE payment_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  provider_order_id text NOT NULL UNIQUE,
  amount_paise      integer NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','closed')),
  last_checked_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_attempts_open ON payment_attempts(created_at) WHERE status = 'open';
INSERT INTO payment_attempts(order_id, provider, provider_order_id, amount_paise, status)
  SELECT id, payment_provider, provider_order_id, total_paise, CASE WHEN status = 'paid' THEN 'paid' ELSE 'open' END
  FROM orders WHERE provider_order_id IS NOT NULL;

-- Which gateway order a payment came through; a gateway payment is recorded only once.
ALTER TABLE payments ADD COLUMN provider_order_id text;
UPDATE payments p SET provider_order_id = o.provider_order_id FROM orders o WHERE o.id = p.order_id AND p.provider NOT IN ('manual');
CREATE UNIQUE INDEX payments_gateway_ref ON payments(provider, ref) WHERE kind = 'payment' AND ref IS NOT NULL AND provider <> 'manual';

-- Refunds and their journey: pending → succeeded / failed.
CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id         uuid REFERENCES payments(id) ON DELETE SET NULL,  -- the payment being refunded
  provider           text NOT NULL,                                    -- cashfree | mock | manual
  provider_order_id  text,
  amount_paise       integer NOT NULL CHECK (amount_paise > 0),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  method             text,                                             -- manual refunds: upi | bank_transfer | cash …
  reason             text,
  provider_refund_id text,
  arn                text,                                             -- bank reference the customer can quote
  failure            text,
  last_error         text,
  last_checked_at    timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX refunds_order ON refunds(order_id);
CREATE INDEX refunds_pending ON refunds(created_at) WHERE status = 'pending';
-- Refunds recorded before this migration were manual and already done.
INSERT INTO refunds(order_id, provider, amount_paise, status, method, reason, arn, created_by, created_at, completed_at)
  SELECT order_id, 'manual', amount_paise, 'succeeded', method, note, ref, recorded_by, at, at FROM payments WHERE kind = 'refund';

-- Things the team must look at: double payments, payments on cancelled orders, failed refunds…
CREATE TABLE order_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('duplicate_payment','paid_after_cancel','refund_failed','overpaid','underpaid')),
  payment_id  uuid REFERENCES payments(id) ON DELETE SET NULL,
  refund_id   uuid REFERENCES refunds(id) ON DELETE SET NULL,
  amount_paise integer,
  detail      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution  text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX order_issues_open ON order_issues(order_id) WHERE status = 'open';

-- Photo reading that stopped part-way is noticed and marked so it can be retried.
ALTER TABLE books ADD COLUMN read_started_at timestamptz;
