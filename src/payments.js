// Payment providers. The store talks to one of these and never to a card
// network directly.
//
// - MockPayments: Stripe-style test tokens, no network. Default.
// - StripePayments: real Stripe over its REST API (no SDK). Cards are saved
//   by the human through a Stripe Checkout "setup" link, or attached from
//   Stripe test tokens in test mode, then charged off-session on each order.

import { ApiError, badRequest } from './errors.js';

const MOCK_CARDS = {
  pm_card_visa: { brand: 'visa', last4: '4242' },
  pm_card_mastercard: { brand: 'mastercard', last4: '4444' },
  pm_card_declined: { brand: 'visa', last4: '0002', fail: 'card_declined' },
  pm_card_insufficient_funds: { brand: 'visa', last4: '9995', fail: 'insufficient_funds' },
};

export class MockPayments {
  name = 'mock';
  supportsSetupLinks = false;

  async ensureCustomer() {
    return null;
  }

  async attachToken(_customerRef, token) {
    const card = MOCK_CARDS[token];
    if (!card) {
      throw badRequest('invalid_payment_token', `Unknown payment token '${token}'.`, {
        param: 'token', hint: `Sandbox tokens: ${Object.keys(MOCK_CARDS).join(', ')}.`,
      });
    }
    return { ref: token, brand: card.brand, last4: card.last4 };
  }

  async charge({ pmRef }) {
    const card = MOCK_CARDS[pmRef];
    return card?.fail ? { status: 'failed', failure_code: card.fail, ref: null } : { status: 'succeeded', failure_code: null, ref: null };
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
    const c = await this.#request('POST', '/v1/customers', { name, email, metadata: { consumables_account_id: accountId } }, `cus-${accountId}`);
    return c.id;
  }

  /** Test mode convenience: attach a Stripe test token such as pm_card_visa. */
  async attachToken(customerRef, token) {
    if (this.livemode) {
      throw badRequest('use_setup_link', 'Card tokens are only accepted in test mode.', { hint: 'Create a card setup link and send it to the account owner.' });
    }
    try {
      const pm = await this.#request('POST', `/v1/payment_methods/${encodeURIComponent(token)}/attach`, { customer: customerRef });
      return { ref: pm.id, brand: pm.card?.brand ?? 'card', last4: pm.card?.last4 ?? '????' };
    } catch (err) {
      if (err.stripe?.status === 400 || err.stripe?.status === 404) {
        throw badRequest('invalid_payment_token', `Stripe rejected payment token '${token}'.`, { param: 'token', hint: 'Use a Stripe test token like pm_card_visa, or a card setup link.' });
      }
      throw upstream(err);
    }
  }

  /** A Stripe-hosted page where the human saves a card. Nothing is charged. */
  async createSetupLink({ customerRef, accountId }) {
    const s = await this.#request('POST', '/v1/checkout/sessions', {
      mode: 'setup',
      customer: customerRef,
      currency: 'usd',
      payment_method_types: ['card'],
      client_reference_id: accountId,
      success_url: `${this.publicUrl}/setup/complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.publicUrl}/setup/canceled`,
    });
    return { id: s.id, url: s.url, expires_at: s.expires_at ? new Date(s.expires_at * 1000).toISOString() : null };
  }

  /** Resolve a finished setup session to the card it saved. */
  async completeSetup(sessionId) {
    const s = await this.#request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ['setup_intent.payment_method'] });
    if (s.status !== 'complete' || !s.setup_intent?.payment_method) return null;
    const pm = s.setup_intent.payment_method;
    return { accountId: s.client_reference_id, customerRef: s.customer, card: { ref: pm.id, brand: pm.card?.brand ?? 'card', last4: pm.card?.last4 ?? '????' } };
  }

  async charge({ amountCents, customerRef, pmRef, orderId, attempt }) {
    try {
      const pi = await this.#request('POST', '/v1/payment_intents', {
        amount: amountCents,
        currency: 'usd',
        customer: customerRef,
        payment_method: pmRef,
        off_session: true,
        confirm: true,
        description: `Consumables order ${orderId}`,
        metadata: { order_id: orderId },
      }, `charge-${orderId}-${attempt}`);
      if (pi.status === 'succeeded' || pi.status === 'processing') return { status: 'succeeded', failure_code: null, ref: pi.id };
      return { status: 'failed', failure_code: pi.status === 'requires_action' ? 'authentication_required' : pi.status, ref: pi.id };
    } catch (err) {
      if (err.stripe?.type === 'card_error') {
        return { status: 'failed', failure_code: err.stripe.decline_code ?? err.stripe.code ?? 'card_declined', ref: err.stripe.payment_intent?.id ?? null };
      }
      throw upstream(err);
    }
  }
}

function upstream(err) {
  return new ApiError(502, 'payment_provider_error', `The payment provider failed: ${err.message}`, { hint: 'Retry with the same idempotency key in a moment.' });
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
