// Payment gateway. Cashfree PG (https://www.cashfree.com/docs) in production; a mock driver for
// local development and tests that can act out every outcome (paid, failed, pending at the bank,
// paid twice, refunds that succeed, wait or fail).
import { config } from '../../config.js';
import { hmac, safeEqual } from '../../lib/crypto.js';

export interface CreatePaymentInput {
  orderId: string;          // gateway order id: our order number, plus "-N" for retries (e.g. TH-24817-2)
  amountPaise: number;
  customer: { id: string; name: string; email: string; phone: string };
  returnUrl: string;        // where the browser lands after paying
  notifyUrl: string;        // our webhook
}
export interface CreatedPayment { provider: 'cashfree' | 'mock'; providerOrderId: string; sessionId: string; mode: 'sandbox' | 'production' | 'mock'; }

/** One money movement the gateway knows about for a gateway order. */
export interface GatewayPayment { ref: string; state: 'success' | 'pending' | 'failed'; amountPaise: number; method: string | null; at: string | null }
export interface OrderPayments {
  /** open = can still be paid; closed = expired/terminated; paid = has a successful payment */
  order: 'open' | 'paid' | 'closed';
  payments: GatewayPayment[];
}

export type RefundState = 'pending' | 'succeeded' | 'failed';
export interface RefundResult { state: RefundState; providerRefundId?: string; arn?: string; reason?: string }

export type WebhookEvent =
  | { kind: 'payment'; type: string; providerOrderId: string; payment: GatewayPayment; raw: any }
  | { kind: 'refund'; type: string; providerOrderId: string; refundId: string; result: RefundResult; amountPaise?: number; auto: boolean; raw: any }
  | { kind: 'other'; type: string; raw: any };

export interface Payments {
  create(input: CreatePaymentInput): Promise<CreatedPayment>;
  /** Everything the gateway knows about a gateway order (status + each payment attempt). */
  payments(providerOrderId: string): Promise<OrderPayments>;
  /** Sends money back to the customer's original payment method. Safe to repeat with the same refundId. */
  refund(providerOrderId: string, input: { refundId: string; amountPaise: number; note: string }): Promise<RefundResult>;
  /** Latest state of a refund; null if the gateway has no such refund (so it can be created again). */
  refundStatus(providerOrderId: string, refundId: string): Promise<RefundResult | null>;
  /** Verifies a webhook and returns the parsed event, or null if the signature is wrong. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
}

const rupees = (paise: number) => Math.round(paise) / 100;
const paise = (v: unknown) => { const n = Math.round(Number(v) * 100); return Number.isFinite(n) ? n : 0; };
const phone10 = (p: string) => p.replace(/\D/g, '').slice(-10);
/** Cashfree refund ids: 3–40 letters/digits. Ours are UUIDs, so drop the dashes. */
export const gatewayRefundId = (uuid: string) => uuid.replace(/-/g, '');

const paymentState = (s: string): GatewayPayment['state'] => s === 'SUCCESS' ? 'success' : s === 'PENDING' || s === 'NOT_ATTEMPTED' ? 'pending' : 'failed';
const refundState = (s: string): RefundState => s === 'SUCCESS' ? 'succeeded' : s === 'CANCELLED' || s === 'REJECTED' ? 'failed' : 'pending'; // PENDING, PENDING_APPROVAL, ONHOLD

export class GatewayError extends Error {
  constructor(message: string, public status: number, public body: any) { super(message); }
}

export class Cashfree implements Payments {
  private base = config().CASHFREE_ENV === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  private headers(extra: Record<string, string> = {}) {
    const c = config();
    return { 'x-client-id': c.CASHFREE_CLIENT_ID, 'x-client-secret': c.CASHFREE_CLIENT_SECRET, 'x-api-version': c.CASHFREE_API_VERSION, 'content-type': 'application/json', accept: 'application/json', ...extra };
  }
  private async call(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.base}${path}`, { method, headers: this.headers(headers), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GatewayError(`Cashfree ${method} ${path} failed (${res.status}): ${data?.message ?? 'unknown error'}`, res.status, data);
    return data;
  }
  async create(i: CreatePaymentInput): Promise<CreatedPayment> {
    const body = await this.call('POST', '/orders', {
      order_id: i.orderId,
      order_amount: rupees(i.amountPaise),
      order_currency: 'INR',
      customer_details: { customer_id: i.customer.id.replace(/-/g, '').slice(0, 50), customer_name: i.customer.name.slice(0, 100), customer_email: i.customer.email, customer_phone: phone10(i.customer.phone) },
      order_meta: { return_url: i.returnUrl, notify_url: i.notifyUrl },
      order_note: 'Thulori storybook',
    });
    return { provider: 'cashfree', providerOrderId: body.order_id, sessionId: body.payment_session_id, mode: config().CASHFREE_ENV };
  }
  async payments(id: string): Promise<OrderPayments> {
    const order = await this.call('GET', `/orders/${encodeURIComponent(id)}`);
    const list: any[] = await this.call('GET', `/orders/${encodeURIComponent(id)}/payments`).catch(() => []);
    const s = order.order_status;
    return {
      order: s === 'PAID' ? 'paid' : s === 'EXPIRED' || s === 'TERMINATED' ? 'closed' : 'open',
      payments: (Array.isArray(list) ? list : []).map(p => ({ ref: String(p.cf_payment_id), state: paymentState(p.payment_status), amountPaise: paise(p.payment_amount), method: p.payment_group ?? null, at: p.payment_completion_time ?? p.payment_time ?? null })),
    };
  }
  async refund(id: string, r: { refundId: string; amountPaise: number; note: string }): Promise<RefundResult> {
    const body = await this.call('POST', `/orders/${encodeURIComponent(id)}/refunds`,
      { refund_amount: rupees(r.amountPaise), refund_id: gatewayRefundId(r.refundId), refund_note: r.note.slice(0, 100).padEnd(3, '.') },
      { 'x-idempotency-key': r.refundId });
    return { state: refundState(body.refund_status), providerRefundId: body.cf_refund_id ? String(body.cf_refund_id) : undefined, arn: body.refund_arn || undefined, reason: body.status_description || undefined };
  }
  async refundStatus(id: string, refundId: string): Promise<RefundResult | null> {
    try {
      const body = await this.call('GET', `/orders/${encodeURIComponent(id)}/refunds/${gatewayRefundId(refundId)}`);
      return { state: refundState(body.refund_status), providerRefundId: body.cf_refund_id ? String(body.cf_refund_id) : undefined, arn: body.refund_arn || undefined, reason: body.status_description || undefined };
    } catch (e) { if (e instanceof GatewayError && e.status === 404) return null; throw e; }
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = String(headers['x-webhook-signature'] ?? ''), ts = String(headers['x-webhook-timestamp'] ?? '');
    if (!sig || !ts) return null;
    // Cashfree signs "timestamp + raw body" with the PG secret key (HMAC-SHA256, base64).
    const expected = hmac(config().CASHFREE_CLIENT_SECRET, ts + rawBody, 'base64');
    if (!safeEqual(expected, sig)) return null;
    // Reject replays older than 15 minutes.
    const t = Number(ts); if (Number.isFinite(t) && Math.abs(Date.now() - (t > 1e12 ? t : t * 1000)) > 15 * 60_000) return null;
    const ev = JSON.parse(rawBody), type = String(ev?.type ?? '');
    if (type === 'REFUND_STATUS_WEBHOOK' || type === 'AUTO_REFUND_STATUS_WEBHOOK') {
      const r = ev?.data?.refund ?? ev?.data?.auto_refund ?? {};
      const auto = type === 'AUTO_REFUND_STATUS_WEBHOOK';
      return { kind: 'refund', type, auto, providerOrderId: String(r.order_id ?? ''), refundId: String(auto ? (r.cf_refund_id ?? r.refund_id ?? '') : (r.refund_id ?? '')),
        result: { state: refundState(r.refund_status), providerRefundId: r.cf_refund_id ? String(r.cf_refund_id) : undefined, arn: r.refund_arn || undefined, reason: r.status_description || undefined },
        amountPaise: r.refund_amount != null ? paise(r.refund_amount) : undefined, raw: ev };
    }
    const p = ev?.data?.payment;
    if (p && ev?.data?.order?.order_id) {
      const state = type === 'PAYMENT_SUCCESS_WEBHOOK' ? 'success' : type === 'PAYMENT_FAILED_WEBHOOK' || type === 'PAYMENT_USER_DROPPED_WEBHOOK' ? 'failed' : paymentState(p.payment_status);
      return { kind: 'payment', type, providerOrderId: String(ev.data.order.order_id), raw: ev,
        payment: { ref: String(p.cf_payment_id ?? ''), state, amountPaise: paise(p.payment_amount ?? ev.data.order.order_amount), method: p.payment_group ?? null, at: p.payment_time ?? null } };
    }
    return { kind: 'other', type, raw: ev };
  }
}

/** Mock gateway for development and tests. Orders stay open until something "pays" them:
 *  POST /api/orders/:id/mock-pay, or MockPayments.pay() in tests. Refunds follow MockPayments.refundOutcome. */
export class MockPayments implements Payments {
  static orders = new Map<string, { payments: GatewayPayment[]; closed?: boolean; refunds: Map<string, RefundResult & { amountPaise: number }> }>();
  static refundOutcome: RefundState = 'pending'; // what a new refund answers
  static refundSettlesTo: RefundState = 'succeeded'; // what a pending refund becomes on the next status check
  static failNextRefundCall = false;              // simulate the gateway being unreachable once
  static entry(id: string) { let e = MockPayments.orders.get(id); if (!e) { e = { payments: [], refunds: new Map() }; MockPayments.orders.set(id, e); } return e; }
  /** Records a payment against a gateway order (state success unless told otherwise). */
  static pay(id: string, amountPaise: number, opts: { state?: GatewayPayment['state']; ref?: string; method?: string } = {}) {
    const p: GatewayPayment = { ref: opts.ref ?? `mockpay_${id}_${MockPayments.entry(id).payments.length + 1}`, state: opts.state ?? 'success', amountPaise, method: opts.method ?? 'upi', at: new Date().toISOString() };
    MockPayments.entry(id).payments.push(p); return p;
  }
  static reset() { MockPayments.orders.clear(); MockPayments.refundOutcome = 'pending'; MockPayments.refundSettlesTo = 'succeeded'; MockPayments.failNextRefundCall = false; }
  async create(i: CreatePaymentInput): Promise<CreatedPayment> { MockPayments.entry(i.orderId); return { provider: 'mock', providerOrderId: i.orderId, sessionId: `mock_${i.orderId}`, mode: 'mock' }; }
  async payments(id: string): Promise<OrderPayments> {
    const e = MockPayments.entry(id);
    return { order: e.payments.some(p => p.state === 'success') ? 'paid' : e.closed ? 'closed' : 'open', payments: e.payments.map(p => ({ ...p })) };
  }
  async refund(id: string, r: { refundId: string; amountPaise: number; note: string }): Promise<RefundResult> {
    if (MockPayments.failNextRefundCall) { MockPayments.failNextRefundCall = false; throw new GatewayError('Mock gateway unreachable', 503, {}); }
    const e = MockPayments.entry(id), key = gatewayRefundId(r.refundId);
    const existing = e.refunds.get(key); if (existing) return { ...existing };
    const paid = e.payments.filter(p => p.state === 'success').reduce((t, p) => t + p.amountPaise, 0);
    const done = [...e.refunds.values()].filter(x => x.state !== 'failed').reduce((t, x) => t + x.amountPaise, 0);
    if (r.amountPaise > paid - done) throw new GatewayError('Refund amount exceeds the payment', 400, {});
    const res = { state: MockPayments.refundOutcome, providerRefundId: `mockrf_${e.refunds.size + 1}`, arn: MockPayments.refundOutcome === 'succeeded' ? `ARN${Date.now()}` : undefined, reason: MockPayments.refundOutcome === 'failed' ? 'Bank account closed' : undefined, amountPaise: r.amountPaise };
    e.refunds.set(key, res); return { ...res };
  }
  async refundStatus(id: string, refundId: string): Promise<RefundResult | null> {
    const r = MockPayments.entry(id).refunds.get(gatewayRefundId(refundId)); if (!r) return null;
    if (r.state === 'pending' && MockPayments.refundSettlesTo !== 'pending') { r.state = MockPayments.refundSettlesTo; if (r.state === 'succeeded') r.arn = `ARN${Date.now()}`; else r.reason = 'Bank account closed'; }
    return { ...r };
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    if (headers['x-mock-signature'] !== hmac(config().SESSION_SECRET, rawBody)) return null;
    const ev = JSON.parse(rawBody);
    if (ev.kind === 'refund') return { kind: 'refund', type: 'REFUND_STATUS_WEBHOOK', auto: !!ev.auto, providerOrderId: ev.orderId, refundId: ev.refundId, result: { state: ev.state, arn: ev.arn, reason: ev.reason }, amountPaise: ev.amountPaise, raw: ev };
    return { kind: 'payment', type: ev.type ?? 'PAYMENT_SUCCESS_WEBHOOK', providerOrderId: ev.orderId, raw: ev,
      payment: { ref: ev.ref, state: ev.state === 'paid' ? 'success' : ev.state === 'failed' ? 'failed' : (ev.state ?? 'success'), amountPaise: ev.amountPaise ?? 0, method: ev.method ?? 'upi', at: new Date().toISOString() } };
  }
}

let instance: Payments | null = null;
export const payments = (): Payments => (instance ??= config().PAYMENTS_DRIVER === 'cashfree' ? new Cashfree() : new MockPayments());
