import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { UCP_VERSION } from '../src/ucp.js';
import { ADDRESS } from './helpers.js';

const AGENT_PROFILE = { 'ucp-agent': 'profile="https://platform.example/.well-known/ucp"' };

async function withServer(fn, { token = 'pm_card_visa', address = true } = {}) {
  const store = new Store();
  const created = store.createAccount({ name: 'UCP home', start_date: '2026-01-05' });
  const agent = store.authenticate(created.api_key);
  if (token) await store.addPaymentMethod(agent, { token });
  if (address) store.addAddress(agent, ADDRESS);
  const server = await startServer(store, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.api_key}`, ...AGENT_PROFILE, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn({ store, created, agent, owner: store.authenticate(created.owner_key), call, base });
  } finally {
    server.close();
  }
}

const lines = (...pairs) => ({ line_items: pairs.map(([id, quantity]) => ({ item: { id }, quantity })) });
const instrument = (id) => ({ payment: { instruments: [{ id, handler_id: 'account_card', type: 'card', selected: true }] } });

test('UCP discovery profile advertises checkout over REST', async () => {
  await withServer(async ({ base }) => {
    const profile = await (await fetch(`${base}/.well-known/ucp`)).json();
    assert.equal(profile.ucp.version, UCP_VERSION);
    assert.equal(profile.ucp.services['dev.ucp.shopping'][0].endpoint, `${base}/ucp`);
    assert.ok(profile.ucp.capabilities['dev.ucp.shopping.checkout']);
    assert.ok(profile.ucp.capabilities['dev.ucp.shopping.fulfillment'][0].extends);
    assert.ok(profile.ucp.payment_handlers['app.domaru.account_card']);
  });
});

test('UCP checkout: create, complete with the saved card, order is paid', async () => {
  await withServer(async ({ call, store, agent }) => {
    const created = await call('POST', '/ucp/checkout-sessions', lines(['TP-2PLY-30', 1], ['TRASH-13G-90', 1]), { 'idempotency-key': 'c1' });
    assert.equal(created.status, 201);
    const c = created.body;
    assert.equal(c.status, 'ready_for_complete');
    assert.equal(c.currency, 'USD');
    assert.equal(c.line_items[0].item.price, store.getProduct('TP-2PLY-30').price_cents);
    const total = c.totals.find((t) => t.type === 'total').amount;
    assert.equal(c.totals.filter((t) => t.type !== 'total').reduce((s, t) => s + t.amount, 0), total);
    assert.ok(c.links.some((l) => l.type === 'terms_of_service') && c.links.some((l) => l.type === 'privacy_policy'));
    assert.equal(c.fulfillment.methods[0].destinations[0].postal_code, ADDRESS.postal_code);

    const replay = await call('POST', '/ucp/checkout-sessions', lines(['TP-2PLY-30', 1], ['TRASH-13G-90', 1]), { 'idempotency-key': 'c1' });
    assert.equal(replay.body.id, c.id);

    const pm = c.payment.instruments[0];
    const done = await call('POST', `/ucp/checkout-sessions/${c.id}/complete`, instrument(pm.id), { 'idempotency-key': 'k1' });
    assert.equal(done.body.status, 'completed');
    assert.equal(store.getOrder(agent, done.body.order.id).status, 'paid');
    assert.equal(store.getOrder(agent, done.body.order.id).amounts.total_cents, total);

    const again = await call('POST', `/ucp/checkout-sessions/${c.id}/complete`, instrument(pm.id), { 'idempotency-key': 'k1' });
    assert.equal(again.body.order.id, done.body.order.id);
    assert.equal(store.listOrders(agent).length, 1);
  });
});

test('UCP checkout over the owner limit waits for the owner, who stays in control', async () => {
  await withServer(async ({ call, store, agent, owner }) => {
    const c = (await call('POST', '/ucp/checkout-sessions', lines(['LAUN-PODS-76', 10]))).body;
    assert.equal(c.status, 'ready_for_complete');
    assert.ok(c.messages.some((m) => m.code === 'owner_approval_required'));

    const held = (await call('POST', `/ucp/checkout-sessions/${c.id}/complete`, instrument(c.payment.instruments[0].id))).body;
    assert.equal(held.status, 'requires_escalation');
    assert.match(held.continue_url, /\/approvals\//);
    assert.ok(held.messages.some((m) => m.severity === 'requires_buyer_review'));
    assert.equal(held.order, undefined);

    const order = store.listOrders(agent)[0];
    assert.equal(order.status, 'requires_approval');
    await store.decideApproval(owner, order.approval.id, 'approve');
    const after = (await call('GET', `/ucp/checkout-sessions/${c.id}`)).body;
    assert.equal(after.status, 'completed');
    assert.equal(after.order.id, order.id);
  });
});

test('UCP cancel withdraws a held order so the owner is not asked anymore', async () => {
  await withServer(async ({ call, store, agent }) => {
    const c = (await call('POST', '/ucp/checkout-sessions', lines(['LAUN-PODS-76', 10]))).body;
    await call('POST', `/ucp/checkout-sessions/${c.id}/complete`, instrument(c.payment.instruments[0].id));
    const canceled = (await call('POST', `/ucp/checkout-sessions/${c.id}/cancel`, {})).body;
    assert.equal(canceled.status, 'canceled');
    assert.equal(store.listApprovals(agent).length, 0);
  });
});

test('UCP checkout: missing address, new destination, unknown item, auth, foreign card', async () => {
  await withServer(async ({ call, base }) => {
    const c = (await call('POST', '/ucp/checkout-sessions', lines(['DW-PODS-115', 1]))).body;
    assert.equal(c.status, 'incomplete');
    assert.ok(c.messages.some((m) => m.code === 'missing'));

    const updated = (await call('PUT', `/ucp/checkout-sessions/${c.id}`, {
      ...lines(['DW-PODS-115', 2]),
      fulfillment: { methods: [{ type: 'shipping', destinations: [{ first_name: 'Jane', last_name: 'Doe', street_address: '5 Elm St', address_locality: 'Little Rock', address_region: 'AR', postal_code: '72201', address_country: 'US', phone_number: '+15015550100' }] }] },
    })).body;
    assert.equal(updated.status, 'ready_for_complete');
    assert.equal(updated.line_items[0].quantity, 2);
    assert.equal(updated.fulfillment.methods[0].destinations[0].postal_code, '72201');

    const bad = await call('POST', `/ucp/checkout-sessions/${c.id}/complete`, instrument('pm_not_mine'));
    assert.ok(bad.body.messages.some((m) => m.code === 'payment_failed'));
    assert.equal(bad.body.status, 'ready_for_complete');

    const unknown = await call('POST', '/ucp/checkout-sessions', lines(['NOPE-1', 1]));
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.ucp.status, 'error');
    assert.equal(unknown.body.id, undefined);

    const anon = await fetch(`${base}/ucp/checkout-sessions`, { method: 'POST', body: '{}' });
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).code, 'unauthorized');
  }, { address: false });
});

test('UCP checkout: declined card leaves the checkout open', async () => {
  await withServer(async ({ call }) => {
    const c = (await call('POST', '/ucp/checkout-sessions', lines(['SPONGE-8', 1]))).body;
    const res = (await call('POST', `/ucp/checkout-sessions/${c.id}/complete`, instrument(c.payment.instruments[0].id))).body;
    assert.equal(res.status, 'ready_for_complete');
    assert.ok(res.messages.some((m) => m.code === 'payment_failed'));
  }, { token: 'pm_card_declined' });
});
