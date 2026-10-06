-- Thulori schema v1
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext UNIQUE,
  phone          text,
  name           text NOT NULL DEFAULT '',
  password_hash  text,
  role           text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','admin')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated','deleted')),
  wa_updates     boolean NOT NULL DEFAULT true,
  close_reason   text,
  deactivated_at timestamptz,
  password_changed_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_phone_key ON users (phone) WHERE phone IS NOT NULL AND status <> 'deleted';

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE password_resets (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT 'Home',
  recipient   text NOT NULL,
  line1       text NOT NULL,
  line2       text NOT NULL DEFAULT '',
  city        text NOT NULL,
  state       text NOT NULL,
  pin         text NOT NULL CHECK (pin ~ '^[0-9]{6}$'),
  phone       text,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user ON addresses(user_id);
CREATE UNIQUE INDEX addresses_one_default ON addresses(user_id) WHERE is_default;

CREATE SEQUENCE order_number_seq START 24817;

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE DEFAULT ('TH-' || nextval('order_number_seq')),
  user_id            uuid NOT NULL REFERENCES users(id),
  status             text NOT NULL DEFAULT 'pending_payment'
                     CHECK (status IN ('pending_payment','paid','failed','cancelled','refunded')),
  subtotal_paise     integer NOT NULL CHECK (subtotal_paise >= 0),
  currency           text NOT NULL DEFAULT 'INR',
  gift_note          text,
  address            jsonb NOT NULL,
  contact            jsonb NOT NULL,
  payment_provider   text NOT NULL,
  provider_order_id  text,
  payment_session_id text,
  payment_ref        text,
  paid_at            timestamptz,
  shipped_at         timestamptz,
  courier            text,
  awb                text,
  delivered_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user ON orders(user_id, created_at DESC);

CREATE TABLE books (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  child_name    text NOT NULL,
  edition       text NOT NULL CHECK (edition IN ('vidhai','thulir','malar')),
  stage         smallint NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 6),
  stage_dates   jsonb NOT NULL DEFAULT '{}',
  letter        text NOT NULL DEFAULT '',
  submitted_at  timestamptz,
  read_status   text NOT NULL DEFAULT 'idle' CHECK (read_status IN ('idle','queued','running','done','failed')),
  read_progress jsonb NOT NULL DEFAULT '{}',
  read_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX books_user ON books(user_id);
CREATE INDEX books_stage ON books(stage);

CREATE TABLE order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  edition          text NOT NULL,
  unit_price_paise integer NOT NULL,
  child_name       text NOT NULL,
  book_id          uuid REFERENCES books(id) ON DELETE SET NULL
);

CREATE TABLE photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id      uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  storage_key  text NOT NULL UNIQUE,
  file_name    text NOT NULL DEFAULT '',
  mime         text NOT NULL,
  bytes        integer NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded')),
  taken_on     date,
  fav          boolean NOT NULL DEFAULT false,
  analysis     jsonb,
  read_at      timestamptz,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photos_book ON photos(book_id, position);

CREATE TABLE cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id     uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('photo','theme')),
  photo_ids   uuid[] NOT NULL,
  topic       text NOT NULL DEFAULT '',
  obs         text NOT NULL,
  question    text NOT NULL,
  options     jsonb NOT NULL DEFAULT '[]',
  pick        smallint,
  answer      text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','basic')),
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cards_book ON cards(book_id);

CREATE TABLE proof_rounds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id     uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  round       integer NOT NULL,
  pages       jsonb NOT NULL,            -- ordered storage keys
  status      text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','changes_requested','approved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  UNIQUE (book_id, round)
);

CREATE TABLE proof_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id    uuid NOT NULL REFERENCES proof_rounds(id) ON DELETE CASCADE,
  page_index  integer NOT NULL,
  page_label  text NOT NULL,
  body        text NOT NULL,
  sent        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Durable job queue (polled with FOR UPDATE SKIP LOCKED by the worker)
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  done_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs(run_at) WHERE done_at IS NULL;

CREATE TABLE payment_events (
  id          bigserial PRIMARY KEY,
  provider    text NOT NULL,
  event_type  text NOT NULL,
  order_id    uuid REFERENCES orders(id) ON DELETE SET NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id       bigserial PRIMARY KEY,
  user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  action   text NOT NULL,
  meta     jsonb NOT NULL DEFAULT '{}',
  at       timestamptz NOT NULL DEFAULT now()
);
