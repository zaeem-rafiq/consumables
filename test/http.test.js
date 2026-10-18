import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { ADDRESS } from './helpers.js';

let server, base, store;
before(async () => {
  store = new Store();
  server = await startServer(store, { port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, { key, body, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type').startsWith('application/json') ? JSON.parse(text) : text };
};

test('discovery: index, llms.txt, openapi', async () => {
  const idx = await call('GET', '/');
  assert.equal(idx.body.mcp, `${base}/mcp`);
  const home = await call('GET', '/', { headers: { accept: 'text/html' } });
  assert.match(home.body, /can't overspend/);
  const md = await call('GET', '/', { headers: { accept: 'text/markdown' } });
  assert.match(md.body, /UCP/);
  const product = await call('GET', '/v1/products/TP-2PLY-30');
  assert.equal(product.body.source, undefined);
  assert.equal(product.body.brand, 'Great Value');
  const llms = await call('GET', '/llms.txt');
  assert.match(llms.body, /POST \/v1\/subscriptions/);
  const spec = await call('GET', '/openapi.json');
  assert.ok(spec.body.paths['/v1/subscriptions/{id}/pause'].post);
});

test('end-to-end agent flow over HTTP', async () => {
  const acct = await call('POST', '/v1/accounts', { body: { name: 'HTTP household', email: 'http@example.com', household_size: 3 } });
  assert.equal(acct.status, 201);
  assert.equal(acct.body.owner_key, undefined, 'the owner key never goes to the caller');
  const key = acct.body.api_key;

  assert.equal((await call('GET', '/v1/account')).status, 401);
  assert.equal((await call('POST', '/v1/payment_methods', { key, body: { token: 'pm_card_visa' } })).status, 201);
  assert.equal((await call('POST', '/v1/addresses', { key, body: ADDRESS })).status, 201);

  const rec = await call('POST', '/v1/recommendations', { key, body: { skus: ['TP-2PLY-30', 'PT-2PLY-12', 'DW-PODS-115'] } });
  assert.equal(rec.body.household_size, 3);

  const items = rec.body.plan[0].items.map(({ sku, quantity }) => ({ sku, quantity }));
  const idem = { 'idempotency-key': 'create-1' };
  const sub = await call('POST', '/v1/subscriptions', { key, body: { items, cadence_days: 28 }, headers: idem });
  assert.equal(sub.status, 201);
  // The agent added this address, so the first order waits for the owner, who approves from the email.
  assert.equal(sub.body.latest_order.status, 'requires_approval');
  const mail = store.listEmails({ to: 'http@example.com', kind: 'approval_requested' })[0];
  const link = new URL(/https?:\/\/\S+\/owner\/approvals\/\S+/.exec(mail.body)[0]);
  const page = await fetch(`${base}${link.pathname}${link.search}`);
  assert.match(await page.text(), /Approve \$/);
  const tap = await fetch(`${base}${link.pathname}/decide`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${link.searchParams.get('t')}&decision=approve` });
  assert.equal(tap.status, 303);
  assert.equal((await call('GET', `/v1/orders/${sub.body.latest_order.id}`, { key })).body.status, 'paid');
  const replay = await call('POST', '/v1/subscriptions', { key, body: { items, cadence_days: 28 }, headers: idem });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, sub.body.id);
  assert.equal((await call('GET', '/v1/subscriptions', { key })).body.data.length, 1);

  const paused = await call('POST', `/v1/subscriptions/${sub.body.id}/pause`, { key, body: {} });
  assert.equal(paused.body.status, 'paused');
  const resumed = await call('POST', `/v1/subscriptions/${sub.body.id}/resume`, { key });
  assert.equal(resumed.body.status, 'active');
  const patched = await call('PATCH', `/v1/subscriptions/${sub.body.id}`, { key, body: { cadence_days: 35 } });
  assert.equal(patched.body.cadence_days, 35);

  const adv = await call('POST', '/v1/test/clock/advance', { key, body: { days: 35 } });
  assert.ok(adv.body.events.some((e) => e.type === 'order.paid'));
  assert.equal((await call('GET', `/v1/orders?subscription_id=${sub.body.id}`, { key })).body.data.length, 2);

  const canceled = await call('POST', `/v1/subscriptions/${sub.body.id}/cancel`, { key, body: { reason: 'done' } });
  assert.equal(canceled.body.status, 'canceled');
});

test('agent keys cannot approve or change limits; policy at sign-up is refused', async () => {
  const refused = await call('POST', '/v1/accounts', { body: { name: 'Gated', email: 'g@example.com', policy: { per_order_limit_cents: null } } });
  assert.equal(refused.status, 403);
  const acct = await call('POST', '/v1/accounts', { body: { name: 'Gated', email: 'g@example.com' } });
  const key = acct.body.api_key;
  await call('POST', '/v1/payment_methods', { key, body: { token: 'pm_card_visa' } });
  await call('POST', '/v1/addresses', { key, body: ADDRESS });
  const order = await call('POST', '/v1/orders', { key, body: { items: [{ sku: 'TP-2PLY-30' }] } });
  assert.equal(order.body.status, 'requires_approval');
  const denied = await call('POST', `/v1/approvals/${order.body.approval.id}/approve`, { key });
  assert.equal(denied.status, 403);
  assert.ok(denied.body.error.hint);
  assert.equal((await call('PATCH', '/v1/account/policy', { key, body: { per_order_limit_cents: 1 } })).status, 403);
  assert.equal((await call('PATCH', '/v1/account', { key, body: { email: 'thief@example.com' } })).status, 403);
  const { owner_key: owner } = store.createOwnerKey({ accountId: acct.body.account.id, role: 'owner' });
  assert.equal((await call('PATCH', '/v1/account/policy', { key: owner, body: { per_order_limit_cents: 5000 } })).body.policy.per_order_limit_cents, 5000);
});

test('errors: 404 route, 405 method, bad json, unknown sku', async () => {
  assert.equal((await call('GET', '/v1/nope')).body.error.code, 'route_not_found');
  assert.equal((await call('DELETE', '/v1/products')).status, 405);
  const res = await fetch(`${base}/v1/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal((await res.json()).error.code, 'invalid_json');
  const sku = await call('GET', '/v1/products/TP-3PLY');
  assert.equal(sku.status, 404);
  assert.match(sku.body.error.hint, /TP-/);
});
