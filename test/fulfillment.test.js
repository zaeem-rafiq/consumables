import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { ADDRESS } from './helpers.js';

async function conciergeStore(opts = {}) {
  const store = new Store({ fulfillment: 'manual', ...opts });
  const { api_key } = store.createAccount({ name: 'Concierge home', start_date: opts.mode === 'live' ? undefined : '2026-01-05' });
  const agent = store.authenticate(api_key);
  await store.addPaymentMethod(agent, { token: 'pm_card_visa' });
  store.addAddress(agent, ADDRESS);
  return { store, agent };
}

test('paid orders wait for the operator instead of shipping themselves', async () => {
  const { store, agent } = await conciergeStore();
  const sub = await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-24', quantity: 2 }] });
  const order = sub.latest_order;
  assert.equal(order.shipment.status, 'awaiting_fulfillment');
  assert.equal(order.shipment.tracking_number, null);

  await store.advanceClock(agent, { days: 5 });
  assert.equal(store.getOrder(agent, order.id).shipment.status, 'awaiting_fulfillment');

  const [queued] = store.listFulfillmentQueue();
  assert.equal(queued.id, order.id);
  assert.equal(queued.ship_to.postal_code, ADDRESS.postal_code);
  assert.equal(queued.lines[0].quantity, 2);

  assert.throws(() => store.markShipped(order.id, { carrier: 'UPS' }), (e) => e.code === 'missing_param');
  assert.throws(() => store.markDelivered(order.id), (e) => e.code === 'invalid_shipment_state');
  const shipped = store.markShipped(order.id, { carrier: 'UPS', tracking_number: '1Z999' });
  assert.equal(shipped.shipment.status, 'shipped');
  assert.equal(store.markDelivered(order.id).shipment.status, 'delivered');
  assert.equal(store.listFulfillmentQueue().length, 0);

  const types = store.listEvents(agent, { limit: 1000 }).data.map((e) => e.type);
  assert.ok(types.includes('shipment.shipped') && types.includes('shipment.delivered'));
});

test('operator page: key required, lists orders, ships and delivers via forms', async () => {
  const { store, agent } = await conciergeStore();
  const sub = await store.createSubscription(agent, { items: [{ sku: 'PT-2PLY-12' }] });
  const orderId = sub.latest_order.id;
  const server = await startServer(store, { port: 0, host: '127.0.0.1', adminKey: 'secret' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/admin`)).status, 401);
    assert.equal((await fetch(`${base}/admin?key=wrong`)).status, 401);
    const html = await (await fetch(`${base}/admin?key=secret`)).text();
    assert.match(html, /Paper Towels/);
    assert.match(html, /Concierge home/);
    assert.match(html, /10001/);

    const form = { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
    const ship = await fetch(`${base}/admin/orders/${orderId}/ship?key=secret`, { ...form, body: 'carrier=USPS&tracking_number=9400' });
    assert.equal(ship.status, 303);
    assert.equal(store.getOrder(agent, orderId).shipment.tracking_number, '9400');
    const deliver = await fetch(`${base}/admin/orders/${orderId}/deliver?key=secret`, { ...form, body: '' });
    assert.equal(deliver.status, 303);
    assert.equal(store.getOrder(agent, orderId).shipment.status, 'delivered');
    const again = await fetch(`${base}/admin/orders/${orderId}/deliver?key=secret`, { ...form, body: '' });
    assert.equal(again.status, 409);
  } finally {
    server.close();
  }
});

test('admin pages are off without an admin key', async () => {
  const server = await startServer(new Store(), { port: 0, host: '127.0.0.1' });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/admin?key=`)).status, 404);
  } finally {
    server.close();
  }
});

test('live mode runs on the real clock and renews once even if runs overlap', async () => {
  const { store, agent } = await conciergeStore({ mode: 'live' });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(store.getAccount(agent.accountId).today, today);
  await assert.rejects(() => store.advanceClock(agent, { days: 1 }), (e) => e.status === 403);

  const sub = await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-24' }], start_date: undefined });
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 1);
  store.db.prepare('UPDATE subscriptions SET next_order_date = ? WHERE id = ?').run(today, sub.id);
  await Promise.all([store.runAllDue(), store.runAllDue()]);
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 2);
});
