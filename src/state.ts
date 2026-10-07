// Builds the account snapshot the website renders (same shape as the browser demo data,
// so the pages work identically against the API). Photo and proof URLs are short-lived
// signed links.
import { one, q } from './db.js';
import { storage } from './services/storage/index.js';
import { EDITIONS, type Edition } from './lib/catalog.js';
import { config } from './config.js';

const day = (d: Date | string | null | undefined) => d ? new Date(d).toISOString().slice(0, 10) : null;

export async function addressList(userId: string) {
  const rows = await q('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at', [userId]);
  return rows.map(a => ({ id: a.id, label: a.label, to: a.recipient, line1: a.line1, line2: a.line2, city: a.city, state: a.state, pin: a.pin, phone: a.phone, def: a.is_default }));
}

export async function bookState(b: any) {
  const st = storage();
  const photos = await q(`SELECT * FROM photos WHERE book_id = $1 AND status = 'uploaded' ORDER BY position, created_at`, [b.id]);
  const cards = await q('SELECT * FROM cards WHERE book_id = $1 ORDER BY created_at', [b.id]);
  const round = await one('SELECT * FROM proof_rounds WHERE book_id = $1 ORDER BY round DESC LIMIT 1', [b.id]);
  const notes = round ? await q('SELECT * FROM proof_notes WHERE round_id = $1 ORDER BY created_at', [round.id]) : [];
  const stageDates: Record<string, string> = b.stage_dates || {};
  const dates: (string | null)[] = []; for (let i = 0; i <= 6; i++) dates[i] = stageDates[i] ?? null;
  if (!dates[0]) dates[0] = day(b.created_at);
  return {
    id: b.id, child: b.child_name, ed: b.edition, order: b.order_number, stage: b.stage, dates,
    rounds: EDITIONS[b.edition as Edition]?.revisionRounds ?? 1,
    letter: b.letter, submitted: !!b.submitted_at,
    read: { status: b.read_status, progress: b.read_progress, error: b.read_error },
    photos: await Promise.all(photos.map(async p => ({
      id: p.id, url: await st.readUrl(p.storage_key), name: p.file_name, day: p.taken_on, fav: p.fav,
      read: !!p.read_at, scene: p.analysis?.scene ?? '',
    }))),
    cards: cards.map(c => ({
      id: c.id, kind: c.kind, photos: c.photo_ids, topic: c.topic, obs: c.obs, q: c.question, options: c.options,
      pick: c.pick, text: c.answer, basic: c.source === 'basic',
    })),
    proof: round ? {
      id: round.id, round: round.round, status: round.status,
      sent: round.status === 'changes_requested', approved: round.status === 'approved',
      pages: await Promise.all((round.pages as string[]).map(k => st.readUrl(k))),
      notes: notes.map(n => ({ id: n.id, at: n.page_index, page: n.page_label, text: n.body, sent: n.sent })),
    } : { round: 1, status: 'none', sent: false, approved: false, pages: [], notes: [] },
  };
}

export async function orderState(o: any) {
  const items = await q('SELECT * FROM order_items WHERE order_id = $1 ORDER BY child_name', [o.id]);
  return {
    id: o.number, uuid: o.id, status: o.status, date: day(o.created_at), paid: day(o.paid_at),
    items: items.map(i => ({ book: i.book_id, ed: i.edition, qty: 1, child: i.child_name, price: i.unit_price_paise / 100 })),
    gift: o.gift_note || '', address: o.address,
    subtotal: o.subtotal_paise / 100, tax: o.tax_paise / 100, gstRate: Number(o.gst_rate), total: o.total_paise / 100, refunded: o.refunded_paise / 100,
    invoices: (await q(`SELECT number, issued_on, total_paise, token FROM invoices WHERE order_id = $1 AND status = 'issued' ORDER BY created_at`, [o.id]))
      .map(i => ({ number: i.number, date: i.issued_on, total: i.total_paise / 100, url: `${config().API_URL.replace(/\/$/, '')}/api/invoices/${i.token}` })),
    shipping: o.shipped_at ? { courier: o.courier, awb: o.awb, url: o.tracking_url || null, at: day(o.shipped_at), delivered: day(o.delivered_at) } : null,
    payment: { provider: o.payment_provider, sessionId: o.status === 'pending_payment' ? o.payment_session_id : null },
    cancelled: o.cancelled_at ? { at: day(o.cancelled_at), reason: o.cancel_reason } : null,
    // Refunds the customer can follow: in progress → back on your account (with the bank reference) / failed (we'll sort it out).
    refunds: (await q(`SELECT amount_paise, status, arn, provider, method, created_at, completed_at FROM refunds WHERE order_id = $1 ORDER BY created_at`, [o.id]))
      .map(r => ({ amount: r.amount_paise / 100, status: r.status, ref: r.arn, manual: r.provider === 'manual', method: r.method, date: day(r.created_at), done: day(r.completed_at) })),
  };
}

export async function accountState(userId: string) {
  const u = await one('SELECT * FROM users WHERE id = $1', [userId]);
  const addresses = await addressList(userId);
  const books = await q(`SELECT b.*, o.number AS order_number FROM books b JOIN orders o ON o.id = b.order_id
                          WHERE b.user_id = $1 AND o.status IN ('paid','pending_payment') ORDER BY b.created_at`, [userId]);
  // Cancelled orders stay hidden unless money moved on them (so the customer can see the refund).
  const orders = await q(`SELECT * FROM orders o WHERE o.user_id = $1 AND (o.status <> 'cancelled' OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id) OR EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id)) ORDER BY o.created_at`, [userId]);
  const def = addresses.find(a => a.def) ?? null;
  return {
    v: 2, remote: true,
    user: { name: u.name, first: String(u.name || '').split(' ')[0], email: u.email, phone: u.phone },
    prefs: { wa: u.wa_updates }, pw: !!u.password_hash,
    address: def ? { line1: def.line1, line2: def.line2, city: def.city, state: def.state, pin: def.pin } : null,
    addresses,
    books: await Promise.all(books.map(bookState)),
    orders: await Promise.all(orders.map(orderState)),
  };
}
