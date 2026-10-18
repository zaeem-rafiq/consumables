// Payment providers. The store talks to one of these and never to a card
// network directly.
//
// - MockPayments: Stripe-style test tokens, no network. Default.
// - StripePayments: real Stripe over its REST API (no SDK). Cards are saved
//   by the human through a Stripe Checkout "setup" link, or attached from
//   Stripe test tokens in test mode, then charged off-session on each order.
//
// Bank payments (US ACH debits) are slower than cards: a charge starts as
// 'pending' and only clears, or bounces, a few business days later. The store
// polls checkCharge until it settles.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, badRequest } from './errors.js';

const MOCK_CARDS = {
  pm_card_visa: { brand: 'visa', last4: '4242' },
  pm_card_mastercard: { brand: 'mastercard', last4: '4444' },
  pm_card_declined: { brand: 'visa', last4: '0002', fail: 'card_declined' },
  pm_card_insufficient_funds: { brand: 'visa', last4: '9995', fail: 'insufficient_funds' },
};

// Stripe's ACH test payment methods. A bounce shows up at settlement, not at charge time.
const MOCK_BANKS = {
  pm_usBankAccount_success: { brand: 'STRIPE TEST BANK', last4: '6789' },
  pm_usBankAccount_insufficientFunds: { brand: 'STRIPE TEST BANK', last4: '6789', fail: 'insufficient_funds' },
  pm_usBankAccount_accountClosed: { brand: 'STRIPE TEST BANK', last4: '6789', fail: 'account_closed' },
};

/** Business days a bank debit takes to clear. Weekends don't count; bank holidays are ignored. */
export const BANK_CLEARING_BUSINESS_DAYS = 4;

export function addBusinessDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0;) {
    d.setUTCDate(d.getUTCDate() + step);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export class MockPayments {
  name = 'mock';
  supportsSetupLinks = false;

  async ensureCustomer() {
    return null;
  }

  async attachToken(_customerRef, token) {
    const card = MOCK_CARDS[token];
    const bank = MOCK_BANKS[token];
    if (!card && !bank) {
      throw badRequest('invalid_payment_token', `Unknown payment token '${token}'.`, {
        param: 'token', hint: `Sandbox tokens: ${[...Object.keys(MOCK_CARDS), ...Object.keys(MOCK_BANKS)].join(', ')}.`,
      });
    }
    const x = card ?? bank;
    return { ref: token, type: card ? 'card' : 'bank', brand: x.brand, last4: x.last4 };
  }

  async charge({ pmRef, orderId, attempt }) {
    if (MOCK_BANKS[pmRef]) return { status: 'pending', failure_code: null, ref: `mock_ach_${orderId}_${attempt}` };
    const card = MOCK_CARDS[pmRef];
    return card?.fail ? { status: 'failed', failure_code: card.fail, ref: null } : { status: 'succeeded', failure_code: null, ref: null };
  }

  async refund({ orderId, n }) {
    return { status: 'succeeded', ref: `mock_re_${orderId}_${n}` };
  }

  /** Mock bank debits settle after the clearing window, on the account's clock. */
  async checkCharge({ pmRef, chargedOn, today }) {
    if (today < addBusinessDays(chargedOn, BANK_CLEARING_BUSINESS_DAYS)) return { status: 'pending', failure_code: null };
    const fail = MOCK_BANKS[pmRef]?.fail;
    return fail ? { status: 'failed', failure_code: fail } : { status: 'succeeded', failure_code: null };
  }
}

export class StripePayments {
  name = 'stripe';
  supportsSetupLinks = true;

  constructor({ secretKey, publicUrl, fetch = globalThis.fetch, apiBase = 'https://api.stripe.com' }) {
    if (!secretKey) throw new Error('StripePayments needs a secret key.');
    this.secretKey = secretKey;
    this.publicUrl = publicUrl;
    this.fetch = fetch;
    this.apiBase = apiBase;
    this.livemode = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  }

  async #request(method, path, params, idempotencyKey) {
    const headers = { authorization: `Bearer ${this.secretKey}` };
    let url = `${this.apiBase}${path}`;
    let body;
    if (params && method === 'GET') url += `?${encode(params)}`;
    else if (params) {
      body = encode(params);
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await this.fetch(url, { method, headers, body });
    const json = await res.json();
    if (!res.ok) {
      const e = json.error ?? {};
      const err = new Error(e.message ?? `Stripe error ${res.status}`);
      err.stripe = { status: res.status, type: e.type, code: e.code, decline_code: e.decline_code, payment_intent: e.payment_intent };
      throw err;
    }
    return json;
  }

  async ensureCustomer({ accountId, name, email, existing }) {
    if (existing) return existing;
    const c = await this.#request('POST', '/v1/customers', { name, email, metadata: { domaru_account_id: accountId } }, `cus-${accountId}`);
    return c.id;
  }

  /** Test mode convenience: attach a Stripe test token such as pm_card_visa. */
  async attachToken(customerRef, token) {
    if (this.livemode) {
      throw badRequest('use_setup_link', 'Card tokens are only accepted in test mode.', { hint: 'Create a card setup link and send it to the account owner.' });
    }
    try {
      const pm = await this.#request('POST', `/v1/payment_methods/${encodeURIComponent(token)}/attach`, { customer: customerRef });
      return present(pm);
    } catch (err) {
      if (err.stripe?.status === 400 || err.stripe?.status === 404) {
        throw badRequest('invalid_payment_token', `Stripe rejected payment token '${token}'.`, { param: 'token', hint: 'Use a Stripe test token like pm_card_visa, or a card setup link.' });
      }
      throw upstream(err);
    }
  }

  /**
   * A Stripe-hosted page where the human saves a card, or signs in to their
   * bank to connect an account (type 'bank'). Nothing is charged.
   */
  async createSetupLink({ customerRef, accountId, type = 'card' }) {
    const bank = type === 'bank';
    const s = await this.#request('POST', '/v1/checkout/sessions', {
      mode: 'setup',
      customer: customerRef,
      currency: 'usd',
      payment_method_types: [bank ? 'us_bank_account' : 'card'],
      payment_method_options: bank ? { us_bank_account: { verification_method: 'instant', financial_connections: { permissions: ['payment_method'] } } } : undefined,
      client_reference_id: accountId,
      success_url: `${this.publicUrl}/setup/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.publicUrl}/setup/canceled`,
    });
    return { id: s.id, url: s.url, expires_at: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null };
  }

  /** Resolve a finished setup session to the card or bank account it saved. */
  async completeSetup(sessionId) {
    const s = await this.#request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ['setup_intent.payment_method'] });
    if (s.status !== 'complete' || !s.setup_intent?.payment_method) return null;
    const mandate = typeof s.setup_intent.mandate === 'string' ? s.setup_intent.mandate : s.setup_intent.mandate?.id;
    return { accountId: s.client_reference_id, customerRef: s.customer, card: { ...present(s.setup_intent.payment_method), mandate: mandate ?? null } };
  }

  async charge({ amountCents, customerRef, pmRef, pmType = 'card', mandate, orderId, attempt }) {
    const bank = pmType === 'bank';
    try {
      const pi = await this.#request('POST', '/v1/payment_intents', {
        amount: amountCents,
        currency: 'usd',
        customer: customerRef,
        payment_method: pmRef,
        payment_method_types: [bank ? 'us_bank_account' : 'card'],
        // Bank debits need the mandate the owner accepted when connecting the account.
        mandate: bank && mandate ? mandate : undefined,
        mandate_data: bank && !mandate ? { customer_acceptance: { type: 'offline' } } : undefined,
        off_session: true,
        confirm: true,
        description: `Domaru order ${orderId}`,
        metadata: { order_id: orderId },
      }, `charge-${orderId}-${attempt}`);
      return chargeResult(pi);
    } catch (err) {
      if (err.stripe?.type === 'card_error') {
        return { status: 'failed', failure_code: err.stripe.decline_code ?? err.stripe.code ?? 'card_declined', ref: err.stripe.payment_intent?.id ?? null };
      }
      throw upstream(err);
    }
  }

  /** Send money back to the card or bank account the order was paid with. */
  async refund({ ref, amountCents, orderId, n, reason }) {
    try {
      const r = await this.#request('POST', '/v1/refunds', { payment_intent: ref, amount: amountCents, metadata: { order_id: orderId, reason } }, `refund-${orderId}-${n}`);
      return { status: r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'succeeded', ref: r.id };
    } catch (err) {
      throw upstream(err);
    }
  }

  /** Where a pending debit stands now. */
  async checkCharge({ ref }) {
    try {
      const pi = await this.#request('GET', `/v1/payment_intents/${encodeURIComponent(ref)}`);
      return chargeResult(pi);
    } catch (err) {
      throw upstream(err);
    }
  }
}

function present(pm) {
  if (pm.type === 'us_bank_account') {
    return { ref: pm.id, type: 'bank', brand: pm.us_bank_account?.bank_name ?? 'bank account', last4: pm.us_bank_account?.last4 ?? '????' };
  }
  return { ref: pm.id, type: 'card', brand: pm.card?.brand ?? 'card', last4: pm.card?.last4 ?? '????' };
}

function chargeResult(pi) {
  if (pi.status === 'succeeded') return { status: 'succeeded', failure_code: null, ref: pi.id };
  // Bank debits (and the occasional card) sit in 'processing' until the money moves.
  if (pi.status === 'processing') return { status: 'pending', failure_code: null, ref: pi.id };
  const failure = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code;
  return { status: 'failed', failure_code: pi.status === 'requires_action' ? 'authentication_required' : failure ?? pi.status, ref: pi.id };
}

function upstream(err) {
  // Stripe's own wording stays in our logs, not in what agents see.
  console.error('stripe error', err.stripe ?? err.message);
  return new ApiError(502, 'payment_provider_error', 'The payment provider could not be reached or refused the request.', { hint: 'Retry with the same idempotency key in a moment.' });
}

/**
 * Check a Stripe webhook's Stripe-Signature header (t=...,v1=...) against the
 * endpoint secret. Returns the parsed event, or null if it doesn't verify.
 */
export function verifyStripeEvent(rawBody, header, secret, { now = Date.now(), toleranceSec = 300 } = {}) {
  if (!header || !secret) return null;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = header.split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return null;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const ok = sigs.some((sig) => {
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

/** Sign a payload the way Stripe does; used by tests. */
export function signStripeEvent(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

/** Stripe-style form encoding with nested objects and arrays. */
export function encode(params, prefix) {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => out.push(typeof x === 'object' ? encode(x, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`));
    else if (typeof v === 'object') out.push(encode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}
