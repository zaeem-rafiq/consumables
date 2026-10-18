import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { StripePayments, encode } from '../src/payments.js';
import { startServer } from '../src/http.js';
import { ADDRESS } from './helpers.js';

/** A tiny in-memory stand-in for the parts of the Stripe API we call. */
function fakeStripe() {
  const calls = [];
  const sessions = new Map();
  let n = 0;
  const cards = { pm_card_visa: { brand: 'visa', last4: '4242' }, pm_card_chargeDeclined: { brand: 'visa', last4: '0002', decline: 'generic_decline' } };
  const pms = new Map();
  const intents = new Map();
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url, { method, headers, body }) => {
    const u = new URL(url);
    const params = Object.fromEntries(new URLSearchParams(method === 'GET' ? u.search : body ?? ''));
    calls.push({ method, path: u.pathname, params, idempotencyKey: headers['idempotency-key'], auth: headers.authorization });
    let m;
    if (method === 'POST' && u.pathname === '/v1/customers') return reply(200, { id: `cus_${++n}` });
    if (method === 'POST' && (m = /^\/v1\/payment_methods\/([^/]+)\/attach$/.exec(u.pathname))) {
      const card = cards[m[1]];
      if (!card) return reply(400, { error: { type: 'invalid_request_error', message: 'No such PaymentMethod' } });
      const id = `pm_${++n}`;
      pms.set(id, card);
      return reply(200, { id, card });
    }
    if (method === 'POST' && u.pathname === '/v1/payment_intents') {
      const card = pms.get(params.payment_method);
      if (card?.bank) {
        const pi = { id: `pi_${++n}`, status: 'processing' };
        intents.set(pi.id, pi);
        return reply(200, pi);
      }
      if (card?.decline) return reply(402, { error: { type: 'card_error', code: 'card_declined', decline_code: card.decline, payment_intent: { id: `pi_${++n}` } } });
      return reply(200, { id: `pi_${++n}`, status: 'succeeded' });
    }
    if (method === 'GET' && (m = /^\/v1\/payment_intents\/([^/]+)$/.exec(u.pathname))) return reply(200, intents.get(m[1]));
    if (method === 'POST' && u.pathname === '/v1/checkout/sessions') {
      const id = `cs_${++n}`;
      sessions.set(id, { id, customer: params.customer, client_reference_id: params.client_reference_id, status: 'open' });
      return reply(200, { id, url: `https://checkout.stripe.test/${id}`, expires_at: 1900000000 });
    }
    if (method === 'GET' && (m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(u.pathname))) {
      const s = sessions.get(m[1]);
      if (!s) return reply(404, { error: { type: 'invalid_request_error', message: 'No such session' } });
      return reply(200, s);
    }
    return reply(404, { error: { message: `fake stripe: no route ${method} ${u.pathname}` } });
  };
  /** Simulate the human finishing the hosted card page. */
  const completeSession = (id, card = { brand: 'mastercard', last4: '4444' }) => {
    const pmId = `pm_${++n}`;
    pms.set(pmId, card);
    Object.assign(sessions.get(id), { status: 'complete', setup_intent: { payment_method: { id: pmId, card } } });
  };
  /** Simulate the human signing in to their bank on the hosted page. */
  const completeBankSession = (id) => {
    const pmId = `pm_${++n}`;
    pms.set(pmId, { bank: true });
    Object.assign(sessions.get(id), {
      status: 'complete',
      setup_intent: { mandate: 'mandate_1', payment_method: { id: pmId, type: 'us_bank_account', us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' } } },
    });
  };
  /** Simulate the bank debit clearing or bouncing. */
  const settle = (piId, outcome) => Object.assign(intents.get(piId), outcome === 'succeeded'
    ? { status: 'succeeded' }
    : { status: 'requires_payment_method', last_payment_error: { code: outcome } });
  return { fetch, calls, completeSession, completeBankSession, settle };
}

async function stripeStore(opts = {}) {
  const stripe = fakeStripe();
  const payments = new StripePayments({ secretKey: 'sk_test_fake', publicUrl: 'https://shop.test', fetch: stripe.fetch });
  const store = new Store({ payments, ...opts });
  const { api_key } = store.createAccount({ name: 'Stripe home', email: 'home@example.com' });
  const agent = store.authenticate(api_key);
  store.addAddress(agent, ADDRESS);
  return { store, agent, stripe };
}

test('form encoding handles nested objects and arrays', () => {
  assert.equal(decodeURIComponent(encode({ a: 1, m: { k: 'v' }, l: ['x', 'y'], skip: undefined })), 'a=1&m[k]=v&l[0]=x&l[1]=y');
});

test('test tokens attach to a Stripe customer and orders charge off-session', async () => {
  const { store, agent, stripe } = await stripeStore();
  const pm = await store.addPaymentMethod(agent, { token: 'pm_card_visa' });
  assert.equal(pm.last4, '4242');
  const sub = await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-30', quantity: 1 }] });
  assert.equal(sub.latest_order.status, 'paid');

  const pi = stripe.calls.find((c) => c.path === '/v1/payment_intents');
  assert.equal(pi.params.amount, String(sub.latest_order.amounts.total_cents));
  assert.equal(pi.params.customer, 'cus_1');
  assert.equal(pi.params.off_session, 'true');
  assert.equal(pi.params.confirm, 'true');
  assert.equal(pi.idempotencyKey, `charge-${sub.latest_order.id}-1`);
  assert.equal(pi.auth, 'Bearer sk_test_fake');
  assert.ok(sub.latest_order.charges[0].provider_ref.startsWith('pi_'));
  assert.equal(stripe.calls.filter((c) => c.path === '/v1/customers').length, 1, 'customer is created once');
});

test('Stripe declines put the subscription past_due', async () => {
  const { store, agent } = await stripeStore();
  await store.addPaymentMethod(agent, { token: 'pm_card_chargeDeclined' });
  const sub = await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-30' }] });
  assert.equal(sub.status, 'past_due');
  assert.equal(sub.latest_order.charges[0].failure_code, 'generic_decline');
  await assert.rejects(() => store.addPaymentMethod(agent, { token: 'pm_nope' }), (e) => e.code === 'invalid_payment_token');
});

test('card setup link: human saves a card on Stripe, it becomes the default', async () => {
  const { store, agent, stripe } = await stripeStore();
  const link = await store.createCardSetupLink(agent);
  assert.match(link.url, /^https:\/\/checkout\.stripe\.test\/cs_/);
  const create = stripe.calls.find((c) => c.path === '/v1/checkout/sessions');
  assert.equal(create.params.mode, 'setup');
  assert.equal(create.params.success_url, 'https://shop.test/setup/complete?session_id={CHECKOUT_SESSION_ID}');

  const sessionId = link.url.split('/').pop();
  await assert.rejects(() => store.completeCardSetup(sessionId), (e) => e.code === 'setup_incomplete');
  stripe.completeSession(sessionId);

  const server = await startServer(store, { port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/setup/complete?session_id=${sessionId}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Card saved/);
  } finally {
    server.close();
  }
  const account = store.getAccount(agent.accountId);
  const [pm] = store.listPaymentMethods(agent);
  assert.equal(pm.last4, '4444');
  assert.equal(account.default_payment_method_id, pm.id);
  const sub = await store.createSubscription(agent, { items: [{ sku: 'PT-2PLY-12' }] });
  assert.equal(sub.latest_order.status, 'paid');
});

test('mock payments refuse setup links with a hint', async () => {
  const store = new Store();
  const { api_key } = store.createAccount({ name: 'Mock' });
  await assert.rejects(() => store.createCardSetupLink(store.authenticate(api_key)), (e) => e.code === 'setup_links_unavailable' && /pm_card_visa/.test(e.hint));
});

test('live keys refuse test tokens', async () => {
  const stripe = fakeStripe();
  const store = new Store({ payments: new StripePayments({ secretKey: 'sk_live_fake', publicUrl: 'https://shop.test', fetch: stripe.fetch }), mode: 'live', fulfillment: 'manual' });
  const created = store.createAccount({ name: 'Live' });
  assert.ok(created.api_key.startsWith('ck_live_'));
  await assert.rejects(() => store.addPaymentMethod(store.authenticate(created.api_key), { token: 'pm_card_visa' }), (e) => e.code === 'use_setup_link');
});

test('bank setup link: owner signs in to their bank after the first delivery; debits wait to clear', async () => {
  const { store, agent, stripe } = await stripeStore();
  await store.addPaymentMethod(agent, { token: 'pm_card_visa' });
  const sub = await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-30' }, { sku: 'PT-2PLY-12' }], cadence_days: 28 });
  await assert.rejects(() => store.createBankSetupLink(agent), (e) => e.code === 'bank_payments_not_available_yet');
  await store.advanceClock(agent, { days: 3 });

  const link = await store.createBankSetupLink(agent);
  assert.equal(link.offer, 'Switch to bank payments and save 2% on every delivery.');
  const create = stripe.calls.filter((c) => c.path === '/v1/checkout/sessions').at(-1);
  assert.equal(create.params['payment_method_types[0]'], 'us_bank_account');
  assert.equal(create.params['payment_method_options[us_bank_account][verification_method]'], 'instant');

  const sessionId = link.url.split('/').pop();
  stripe.completeBankSession(sessionId);
  const server = await startServer(store, { port: 0, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/setup/complete?session_id=${sessionId}`);
    assert.match(await res.text(), /Bank account connected/);
  } finally {
    server.close();
  }
  const bank = store.listPaymentMethods(agent).find((x) => x.type === 'bank');
  assert.equal(bank.last4, '6789');
  assert.equal(store.getSubscription(agent, sub.id).payment_method_id, bank.id);

  const { next_charge_date: chargeOn, next_order_date: shipOn } = store.getSubscription(agent, sub.id);
  const today = () => store.getAccount(agent.accountId).today;
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  await store.advanceClock(agent, { days: days(today(), chargeOn) });
  let [order] = store.listOrders(agent, { subscription_id: sub.id });
  assert.equal(order.status, 'payment_pending');
  const pi = stripe.calls.filter((c) => c.path === '/v1/payment_intents').at(-1);
  assert.equal(pi.params['payment_method_types[0]'], 'us_bank_account');
  assert.equal(pi.params.mandate, 'mandate_1');

  stripe.settle(order.charges[0].provider_ref, 'succeeded');
  await store.advanceClock(agent, { days: 1 });
  [order] = store.listOrders(agent, { subscription_id: sub.id });
  assert.equal(order.status, 'paid');
  if (today() < shipOn) assert.equal(order.shipment, null, 'cleared early: waits for its ship date');
  await store.advanceClock(agent, { days: days(today(), shipOn) || 1 });
  [order] = store.listOrders(agent, { subscription_id: sub.id });
  assert.ok(order.shipment);
});

test('a bounced Stripe bank debit fails the order', async () => {
  const { store, agent, stripe } = await stripeStore();
  await store.addPaymentMethod(agent, { token: 'pm_card_visa' });
  await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-30' }, { sku: 'PT-2PLY-12' }], cadence_days: 28 });
  await store.advanceClock(agent, { days: 3 });
  const sessionId = (await store.createBankSetupLink(agent)).url.split('/').pop();
  stripe.completeBankSession(sessionId);
  await store.completeCardSetup(sessionId);
  const order = await store.createOrder(agent, { items: [{ sku: 'TP-2PLY-30' }] });
  assert.equal(order.status, 'payment_pending');
  stripe.settle(order.charges[0].provider_ref, 'insufficient_funds');
  await store.advanceClock(agent, { days: 1 });
  const after = store.getOrder(agent, order.id);
  assert.equal(after.status, 'payment_failed');
  assert.equal(after.charges[0].failure_code, 'insufficient_funds');
  assert.equal(after.shipment, null);
});
