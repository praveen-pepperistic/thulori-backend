import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { config, setConfigForTests } from '../src/config.js';
import { Cashfree } from '../src/services/payments/index.js';

describe('Cashfree webhook signature', () => {
  setConfigForTests({ ...config(), CASHFREE_CLIENT_SECRET: 'cf_test_secret' });
  const cf = new Cashfree();
  const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'TH-24817' }, payment: { cf_payment_id: 991, payment_status: 'SUCCESS' } } });
  const ts = String(Date.now());
  const sig = createHmac('sha256', 'cf_test_secret').update(ts + body).digest('base64');

  it('accepts a correctly signed event', () => {
    expect(cf.verifyWebhook(body, { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts })).toMatchObject({ kind: 'payment', providerOrderId: 'TH-24817', payment: { state: 'success', ref: '991', amountPaise: 0 } });
  });
  it('rejects a tampered body or old timestamp', () => {
    expect(cf.verifyWebhook(body.replace('24817', '24818'), { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts })).toBeNull();
    const old = String(Date.now() - 60 * 60_000);
    expect(cf.verifyWebhook(body, { 'x-webhook-signature': createHmac('sha256', 'cf_test_secret').update(old + body).digest('base64'), 'x-webhook-timestamp': old })).toBeNull();
  });
});
