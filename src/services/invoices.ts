// GST tax invoices: numbering per financial year, CGST/SGST vs IGST by place of supply,
// and a printable HTML copy the customer opens from an unguessable link.
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { newToken } from '../lib/crypto.js';
import { EDITIONS, type Edition } from '../lib/catalog.js';
import { finYear, inr, orderAmounts, splitTax } from '../lib/money.js';
import { badRequest, notFound } from '../lib/errors.js';

export interface Line { desc: string; hsn: string; qty: number; unit_paise: number; amount_paise: number }

/** Suggested lines for an order: one per storybook. */
export async function draftLines(orderId: string): Promise<Line[]> {
  const o = await one('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o) throw notFound();
  const items = await q('SELECT * FROM order_items WHERE order_id = $1 ORDER BY child_name', [orderId]);
  const hsn = config().INVOICE_HSN;
  const lines: Line[] = items.map(i => ({ desc: `${EDITIONS[i.edition as Edition]?.name ?? i.edition} edition storybook — ${i.child_name}`, hsn, qty: 1, unit_paise: i.unit_price_paise, amount_paise: i.unit_price_paise }));
  return lines;
}

export async function paidSoFar(orderId: string, c?: any) {
  const r = await one(`SELECT COALESCE(sum(CASE WHEN kind = 'payment' THEN amount_paise ELSE -amount_paise END), 0)::int AS n FROM payments WHERE order_id = $1`, [orderId], c);
  return r.n as number;
}

export async function createInvoice(orderId: string, input: { desc: string; hsn?: string; qty: number; unit_paise: number }[], byUser: string) {
  const o = await one('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!o) throw notFound();
  const lines: Line[] = input.filter(l => l.qty > 0 && l.unit_paise > 0).map(l => ({ desc: l.desc.trim(), hsn: (l.hsn || config().INVOICE_HSN).trim(), qty: l.qty, unit_paise: Math.round(l.unit_paise), amount_paise: Math.round(l.unit_paise * l.qty) }));
  if (!lines.length) throw badRequest('Add at least one line with a price.');
  const gross = lines.reduce((t, l) => t + l.amount_paise, 0);
  const rate = Number(o.gst_rate) || config().GST_RATE;
  const amt = orderAmounts(gross, rate);
  const tax = splitTax(amt.tax, o.address?.state, rate);
  const billTo = { name: o.contact?.name, email: o.contact?.email, phone: o.contact?.phone, address: o.address };
  return tx(async c => {
    const fy = finYear();
    const n = await one(`INSERT INTO invoice_counters(fy, n) VALUES ($1, 1) ON CONFLICT (fy) DO UPDATE SET n = invoice_counters.n + 1 RETURNING n`, [fy], c);
    const number = `${config().INVOICE_PREFIX}/${fy}/${String(n.n).padStart(4, '0')}`;
    const inv = await one(`INSERT INTO invoices(order_id, number, bill_to, lines, subtotal_paise, tax, total_paise, paid_paise, token, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [orderId, number, billTo, JSON.stringify(lines), amt.subtotal, tax, amt.total, await paidSoFar(orderId, c), newToken(), byUser], c);
    await q(`INSERT INTO audit_log(user_id, action, meta) VALUES ($1,'invoice_created',$2)`, [byUser, { number: o.number, invoice: number }], c);
    return inv;
  });
}

export const invoiceUrl = (token: string) => `${config().API_URL.replace(/\/$/, '')}/api/invoices/${token}`;

// ---- amount in words (Indian numbering)
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function two(n: number) { return n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`; }
function three(n: number) { const h = Math.floor(n / 100), r = n % 100; return [h ? `${ONES[h]} Hundred` : '', r ? two(r) : ''].filter(Boolean).join(' '); }
export function inWords(paise: number) {
  let r = Math.floor(paise / 100); const p = paise % 100;
  if (r === 0 && p === 0) return 'Zero Rupees Only';
  const parts: string[] = [];
  const cr = Math.floor(r / 1e7); r %= 1e7; const lk = Math.floor(r / 1e5); r %= 1e5; const th = Math.floor(r / 1000); r %= 1000;
  if (cr) parts.push(`${two(cr)} Crore`); if (lk) parts.push(`${two(lk)} Lakh`); if (th) parts.push(`${two(th)} Thousand`); if (r) parts.push(three(r));
  return `${parts.join(' ') || 'Zero'} Rupees${p ? ` and ${two(p)} Paise` : ''} Only`;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const money = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function invoiceHtml(token: string) {
  const inv = await one(`SELECT i.*, o.number AS order_number FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.token = $1`, [token]);
  if (!inv) return null;
  const c = config(), b = inv.bill_to, a = b.address || {}, t = inv.tax;
  const lines = inv.lines as Line[];
  const half = Number(t.rate) / 2;
  const balance = inv.total_paise - inv.paid_paise;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${esc(inv.number)} — ${esc(c.COMPANY_BRAND)}</title>
<style>
:root{--ink:#45151B;--mute:#7a5d61;--line:#e6d9cf;--bg:#fff;--paper:#F6F1EA}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,"Segoe UI",Roboto,"DM Sans",sans-serif;padding:24px 16px}
.sheet{max-width:820px;margin:0 auto;background:var(--bg);border-radius:12px;padding:40px;box-shadow:0 10px 30px rgba(69,21,27,.08)}
.top{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;border-bottom:2px solid var(--ink);padding-bottom:20px}
.brand{font-size:28px;font-weight:800;letter-spacing:-.5px}.muted{color:var(--mute)}h1{font-size:18px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.08em}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;margin:24px 0}.lbl{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--mute);margin-bottom:4px}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
td.n,th.n{text-align:right;white-space:nowrap}.tot{margin-left:auto;max-width:340px;margin-top:16px}.tot div{display:flex;justify-content:space-between;padding:6px 0}.tot .grand{border-top:2px solid var(--ink);font-weight:800;font-size:16px;margin-top:6px;padding-top:10px}
.words{margin-top:16px;font-style:italic}.foot{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--mute);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.void{color:#a12a1b;font-weight:800;border:2px solid #a12a1b;display:inline-block;padding:4px 10px;border-radius:6px;margin-bottom:12px}
.bar{max-width:820px;margin:0 auto 16px;display:flex;justify-content:flex-end}.bar button{font:inherit;font-weight:700;background:var(--ink);color:#FFDE21;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
@media print{body{background:#fff;padding:0}.sheet{box-shadow:none;padding:0}.bar{display:none}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div>
<main class="sheet">
${inv.status === 'void' ? '<p class="void">VOID — this invoice has been cancelled</p>' : ''}
<div class="top"><div><div class="brand">${esc(c.COMPANY_BRAND)}</div><div>${esc(c.COMPANY_NAME)}</div><div class="muted">${esc(c.COMPANY_ADDRESS || 'Registered address to be added')}</div><div class="muted">GSTIN: ${esc(c.COMPANY_GSTIN || 'to be added')} · State: ${esc(c.COMPANY_STATE)}</div><div class="muted">${esc(c.COMPANY_EMAIL)} · ${esc(c.COMPANY_PHONE)}</div></div>
<div style="text-align:right"><h1>Tax invoice</h1><div><strong>${esc(inv.number)}</strong></div><div class="muted">Date: ${esc(new Date(inv.issued_on + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }))}</div><div class="muted">Order: ${esc(inv.order_number)}</div><div class="muted">Original for recipient</div></div></div>
<div class="grid"><div><div class="lbl">Billed to</div><strong>${esc(b.name)}</strong><br>${esc(a.line1)}${a.line2 ? '<br>' + esc(a.line2) : ''}<br>${esc(a.city)}, ${esc(a.state)} ${esc(a.pin)}<br><span class="muted">${esc(b.phone)} · ${esc(b.email)}</span></div>
<div><div class="lbl">Place of supply</div>${esc(a.state)}<div class="lbl" style="margin-top:12px">Tax</div>${t.intra ? `CGST ${half}% + SGST ${half}%` : `IGST ${esc(t.rate)}%`}</div></div>
<div class="tbl"><table><thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th class="n">Qty</th><th class="n">Rate (₹)</th><th class="n">Taxable value (₹)</th></tr></thead><tbody>
${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.desc)}</td><td>${esc(l.hsn)}</td><td class="n">${l.qty}</td><td class="n">${money(l.unit_paise)}</td><td class="n">${money(l.amount_paise)}</td></tr>`).join('')}
</tbody></table></div>
<div class="tot"><div><span>Taxable value</span><span>₹${money(inv.subtotal_paise)}</span></div>
${t.intra ? `<div><span>CGST @ ${half}%</span><span>₹${money(t.cgst)}</span></div><div><span>SGST @ ${half}%</span><span>₹${money(t.sgst)}</span></div>` : `<div><span>IGST @ ${esc(t.rate)}%</span><span>₹${money(t.igst)}</span></div>`}
<div class="grand"><span>Total</span><span>₹${money(inv.total_paise)}</span></div>
<div><span class="muted">Paid</span><span>₹${money(Math.min(inv.paid_paise, inv.total_paise))}</span></div>
${balance > 0 ? `<div><strong>Balance due</strong><strong>₹${money(balance)}</strong></div>` : ''}</div>
<p class="words">${esc(inWords(inv.total_paise))}</p>
<div class="foot"><span>This is a computer-generated invoice and needs no signature.</span><span>Thank you for trusting us with their story.</span></div>
</main></body></html>`;
}

export const invoiceSummary = (i: any) => ({ id: i.id, number: i.number, date: i.issued_on, total: i.total_paise / 100, paid: i.paid_paise / 100, status: i.status, sentAt: i.sent_at, sentTo: i.sent_to, url: invoiceUrl(i.token) });
export { inr };
