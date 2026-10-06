// Customer messages by email (SMTP — works with SES, Zoho, Gmail Workspace, Resend SMTP…)
// and WhatsApp (Meta WhatsApp Cloud API, approved templates). Sent from the job queue so a
// slow provider never blocks a request, and failures are retried with back-off.
import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { one, q } from '../../db.js';

export type Template = 'welcome' | 'order_placed' | 'order_paid' | 'stage_update' | 'proof_ready' | 'shipped' | 'password_reset' | 'account_closed'
  | 'account_created' | 'invoice' | 'order_cancelled' | 'refund' | 'refund_started' | 'team_alert' | 'admin_code';

interface Rendered { subject: string; text: string; wa?: { name: string; params: string[] } }

const site = () => config().SITE_URL.replace(/\/$/, '');

/** Message copy. WhatsApp templates must be created and approved in Meta Business Manager
 *  with the same names and parameter order (see server/README.md). */
export function render(t: Template, d: Record<string, any>): Rendered {
  const name = d.first || 'there';
  switch (t) {
    case 'welcome': return { subject: 'Welcome to Thulori', text: `Hi ${name},\n\nYour Thulori account is ready. Whenever you’re ready, choose an edition and we’ll start on your child’s storybook.\n\n${site()}/packages.html\n\n— Team Thulori` };
    case 'order_placed': return { subject: `Order ${d.number} received`, text: `Hi ${name},\n\nWe’ve received order ${d.number} (${d.total}). Complete payment here if you haven’t yet: ${site()}/order.html\n\n— Team Thulori` };
    case 'order_paid': return {
      subject: `Payment received — order ${d.number}`,
      text: `Hi ${name},\n\nThank you! Payment for order ${d.number} (${d.total}) is confirmed.\n\nNext: add photos and tell us the stories behind them:\n${site()}/stories.html\n\n— Team Thulori`,
      wa: { name: 'order_paid', params: [name, d.number, d.total] },
    };
    case 'stage_update': return {
      subject: `${d.child}’s storybook: ${d.stage}`,
      text: `Hi ${name},\n\n${d.child}’s storybook has moved to “${d.stage}”.\n\nSee where it is: ${site()}/account.html\n\n— Team Thulori`,
      wa: { name: 'stage_update', params: [name, d.child, d.stage] },
    };
    case 'proof_ready': return {
      subject: `${d.child}’s proof is ready to review`,
      text: `Hi ${name},\n\n${d.child}’s proof (round ${d.round}) is ready. Turn every page, leave notes, and approve it when you’re happy:\n${site()}/proof.html\n\n— Team Thulori`,
      wa: { name: 'proof_ready', params: [name, d.child] },
    };
    case 'shipped': return {
      subject: `Order ${d.number} is on its way`,
      text: `Hi ${name},\n\nOrder ${d.number} has shipped with ${d.courier}. Tracking number: ${d.awb}.\n\n— Team Thulori`,
      wa: { name: 'order_shipped', params: [name, d.number, d.courier, d.awb] },
    };
    case 'password_reset': return { subject: 'Reset your Thulori password', text: `Hi ${name},\n\nUse this link within 1 hour to choose a new password:\n${site()}/signin.html#reset-${d.token}\n\nIf you didn’t ask for this, ignore this email.\n\n— Team Thulori` };
    case 'account_created': return { subject: 'Your Thulori account is ready', text: `Hi ${name},\n\nWe’ve set up your Thulori account for order ${d.number}. Choose a password here (the link works for 7 days):\n${site()}/signin.html#reset-${d.token}\n\nThen you can add photos, answer the questions and review your proof online.\n\n— Team Thulori` };
    case 'invoice': return { subject: `Tax invoice ${d.invoice} — order ${d.number}`, text: `Hi ${name},\n\nYour tax invoice ${d.invoice} for order ${d.number} (${d.total}) is ready:\n${d.url}\n\nOpen it and use Print → Save as PDF to keep a copy.\n\n— Team Thulori` };
    case 'order_cancelled': return { subject: `Order ${d.number} cancelled`, text: `Hi ${name},\n\nOrder ${d.number} has been cancelled.${d.reason ? ' ' + d.reason : ''}\n\nQuestions? Just reply to this email or message us on WhatsApp.\n\n— Team Thulori` };
    case 'refund_started': return { subject: `Refund started for order ${d.number}`, text: `Hi ${name},\n\nWe’ve started a refund of ${d.amount} for order ${d.number}. It goes back to the card, UPI or bank account you paid with — you don’t need to do anything.\n\nBanks usually take a few working days to show it. We’ll email you again when it’s complete, with a bank reference number.\n\n— Team Thulori` };
    case 'refund': return { subject: `Refund complete — order ${d.number}`, text: d.manual
      ? `Hi ${name},\n\nWe’ve refunded ${d.amount} for order ${d.number}${d.method ? ' by ' + String(d.method).replace('_', ' ') : ''}${d.ref ? ' (reference ' + d.ref + ')' : ''}.\n\nIf you don’t see it in a few days, reply to this email and we’ll help.\n\n— Team Thulori`
      : `Hi ${name},\n\nYour refund of ${d.amount} for order ${d.number} is complete and has been sent back to the account you paid with.${d.ref ? '\n\nBank reference (ARN): ' + d.ref + ' — your bank can trace the refund with this number if it hasn’t appeared yet.' : ''}\n\n— Team Thulori` };
    case 'team_alert': return { subject: `Action needed — ${d.number}: ${String(d.kind).replace(/_/g, ' ')}`, text: `${d.detail}\n\nOpen the order in the admin panel: ${config().ADMIN_URL.replace(/\/$/, '')}/#/order/${d.number}` };
    case 'admin_code': return { subject: `${d.code} is your Thulori admin code`, text: `Your Thulori admin sign-in code is ${d.code}. It works for 10 minutes.\n\nIf you didn’t try to sign in, change your password.` };
    case 'account_closed': return { subject: d.deleted ? 'Your Thulori account has been deleted' : 'Your Thulori account is deactivated', text: d.deleted ? `Hi ${name},\n\nYour account, photos and answers have been deleted. Order and invoice records are kept as the law requires.\n\n— Team Thulori` : `Hi ${name},\n\nYour account is deactivated. Sign in again any time to bring everything back.\n\n— Team Thulori` };
  }
}

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
async function sendEmail(to: string, subject: string, text: string, log: (m: string) => void) {
  const c = config();
  if (c.NOTIFY_EMAIL === 'log' || !c.SMTP_URL) { log(`[email → ${to}] ${subject}`); return; }
  transport ??= nodemailer.createTransport(c.SMTP_URL);
  await transport.sendMail({ from: c.EMAIL_FROM, to, subject, text });
}

async function sendWhatsApp(phone: string, tpl: { name: string; params: string[] }, log: (m: string) => void) {
  const c = config();
  const to = phone.replace(/\D/g, '');
  const msisdn = to.length === 10 ? `91${to}` : to;
  if (c.NOTIFY_WHATSAPP === 'log' || !c.WA_ACCESS_TOKEN) { log(`[whatsapp → ${msisdn}] ${tpl.name}(${tpl.params.join(', ')})`); return; }
  const res = await fetch(`https://graph.facebook.com/${c.WA_GRAPH_VERSION}/${c.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.WA_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: msisdn, type: 'template',
      template: { name: tpl.name, language: { code: c.WA_TEMPLATE_LANG }, components: [{ type: 'body', parameters: tpl.params.map(text => ({ type: 'text', text: String(text).slice(0, 1000) })) }] },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp send failed (${res.status}): ${await res.text()}`);
}

async function logSend(p: { userId?: string; orderId?: string; template: string }, channel: string, recipient: string, status: string, error?: string) {
  await q(`INSERT INTO notification_log(user_id, order_id, template, channel, recipient, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.userId ?? null, p.orderId ?? null, p.template, channel, recipient, status, error ?? null]).catch(() => {});
}

/** Job handler: payload { template, userId?, orderId?, to?: {email, phone}, data } */
export async function deliver(p: { template: Template; userId?: string; orderId?: string; to?: { email?: string; phone?: string }; data?: Record<string, any> }, log: (m: string) => void = console.log) {
  if (p.template === 'team_alert') {
    const to = config().TEAM_EMAIL; const r = render('team_alert', p.data ?? {});
    if (!to) { log(`[team alert — set TEAM_EMAIL to receive these] ${r.subject}`); await logSend(p, 'email', 'team', 'logged'); return; }
    await sendEmail(to, r.subject, r.text, log); await logSend(p, 'email', to, config().NOTIFY_EMAIL === 'log' || !config().SMTP_URL ? 'logged' : 'sent'); return;
  }
  let email = p.to?.email, phone = p.to?.phone, wa = true, first = p.data?.first;
  if (p.userId) {
    const u = await one('SELECT email, phone, name, wa_updates, status FROM users WHERE id = $1', [p.userId]);
    if (!u || u.status === 'deleted' && p.template !== 'account_closed') return;
    email ??= u.email ?? undefined; phone ??= u.phone ?? undefined; wa = u.wa_updates; first ??= String(u.name || '').split(' ')[0];
  }
  const r = render(p.template, { ...p.data, first });
  const c = config();
  if (email) {
    try { await sendEmail(email, r.subject, r.text, log); await logSend(p, 'email', email, c.NOTIFY_EMAIL === 'log' || !c.SMTP_URL ? 'logged' : 'sent'); }
    catch (e) { await logSend(p, 'email', email, 'failed', (e as Error).message); throw e; }
  }
  if (r.wa && phone && wa) {
    try { await sendWhatsApp(phone, r.wa, log); await logSend(p, 'whatsapp', phone, c.NOTIFY_WHATSAPP === 'log' || !c.WA_ACCESS_TOKEN ? 'logged' : 'sent'); }
    catch (e) { await logSend(p, 'whatsapp', phone, 'failed', (e as Error).message); log(`whatsapp failed: ${(e as Error).message}`); } // shown in the admin log; email already went
  }
  if (p.template === 'order_paid' && c.TEAM_EMAIL) await sendEmail(c.TEAM_EMAIL, `New paid order ${p.data?.number}`, `${p.data?.number} — ${p.data?.total}\n${p.data?.items ?? ''}`, log);
}
