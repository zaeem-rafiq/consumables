import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { ApiError } from '../src/errors.js';

const TP = { sku: 'TP-2PLY-24', quantity: 1 };
const PT = { sku: 'PT-2PLY-12', quantity: 1 };

test('catalog search and unknown sku hint', async () => {
  const { store } = await setup();
  const tp = await store.listProducts({ q: 'toilet' });
  assert.ok(tp.length >= 2);
  assert.ok(tp.every((p) => p.category === 'paper'));
  assert.equal((await store.listProducts({ category: 'laundry' })).length, 3);
  assert.throws(() => store.getProduct('TP-NOPE'), (e) => e.code === 'product_not_found' && /TP-2PLY-24/.test(e.hint));
  assert.throws(() => store.listProducts({ category: 'garden' }), (e) => e.code === 'unknown_category');
});

test('pricing: subscription discount, free shipping threshold, tax', async () => {
  const { store } = await setup();
  const small = await store.price([{ sku: 'NAP-250', quantity: 1 }], { subscription: false });
  assert.deepEqual(small.amounts, { subtotal_cents: 699, discount_cents: 0, shipping_cents: 599, tax_cents: 56, total_cents: 1354, currency: 'usd' });
  const big = await store.price([TP, PT], { subscription: true });
  assert.equal(big.amounts.subtotal_cents, 5298);
  assert.equal(big.amounts.discount_cents, 265);
  assert.equal(big.amounts.shipping_cents, 0);
  assert.equal(big.amounts.total_cents, 5298 - 265 + 403);
});

test('recommendations scale with household size', async () => {
  const { store, agent } = await setup();
  const two = await store.recommend(agent, { skus: ['TP-2PLY-24'], cadence_days: 28 });
  const six = await store.recommend(agent, { household_size: 6, skus: ['TP-2PLY-24'], cadence_days: 28 });
  assert.equal(two.items[0].quantity, 1);
  assert.ok(six.items[0].quantity > two.items[0].quantity);
  assert.ok((await store.recommend(agent, {})).items.length >= 8);
});

test('subscription lifecycle: create ships today, renews on cadence, delivers', async () => {
  const { store, agent } = await setup();
  const sub = await store.createSubscription(agent, { items: [TP, PT], cadence_days: 30 });
  assert.equal(sub.status, 'active');
  assert.equal(sub.latest_order.status, 'paid');
  assert.equal(sub.latest_order.shipment.status, 'processing');
  assert.equal(sub.next_order_date, '2026-02-04');

  const { events } = await store.advanceClock(agent, { days: 3 });
  assert.deepEqual(events.map((e) => e.type), ['shipment.shipped', 'shipment.delivered']);

  await store.advanceClock(agent, { days: 27 });
  const orders = await store.listOrders(agent, { subscription_id: sub.id });
  assert.equal(orders.length, 2);
  assert.equal(orders[0].created_at.slice(0, 10), '2026-02-04');
  assert.equal((await store.getSubscription(agent, sub.id)).next_order_date, '2026-03-06');
});

test('modify, skip, pause with auto-resume, ship now, cancel', async () => {
  const { store, agent } = await setup();
  let sub = await store.createSubscription(agent, { items: [TP], cadence_days: 28, start_date: '2026-01-10' });
  assert.equal(sub.latest_order, null);

  sub = await store.updateSubscription(agent, sub.id, { items: [{ sku: 'TP-BAMBOO-24', quantity: 2 }], cadence_days: 42 });
  assert.equal(sub.items[0].sku, 'TP-BAMBOO-24');
  assert.equal(sub.cadence_days, 42);

  sub = await store.skipNext(agent, sub.id);
  assert.equal(sub.next_order_date, '2026-02-21');

  sub = await store.pauseSubscription(agent, sub.id, { until: '2026-03-01' });
  assert.equal(sub.status, 'paused');
  await store.advanceClock(agent, { days: 60 }); // past next_order_date and pause_until
  sub = await store.getSubscription(agent, sub.id);
  assert.equal(sub.status, 'active');
  assert.equal((await store.listOrders(agent, { subscription_id: sub.id })).length, 1, 'order due during pause ships on resume');

  sub = await store.shipNow(agent, sub.id);
  assert.equal((await store.listOrders(agent, { subscription_id: sub.id })).length, 2);

  sub = await store.cancelSubscription(agent, sub.id, { reason: 'moving' });
  assert.equal(sub.status, 'canceled');
  assert.equal(sub.next_order_date, null);
  await store.advanceClock(agent, { days: 120 });
  assert.equal((await store.listOrders(agent, { subscription_id: sub.id })).length, 2);
  assert.throws(() => store.skipNext(agent, sub.id), (e) => e.code === 'subscription_canceled');
});

test('supply signals tune cadence', async () => {
  const { store, agent } = await setup();
  const sub = await store.createSubscription(agent, { items: [TP], cadence_days: 40 });
  const low = await store.reportSignal(agent, sub.id, { signal: 'running_low' });
  assert.equal(low.cadence_days, 34);
  assert.equal((await store.listOrders(agent, { subscription_id: sub.id })).length, 2);
  const over = await store.reportSignal(agent, sub.id, { signal: 'overstocked' });
  assert.equal(over.cadence_days, 39);
});

test('declined card makes subscription past_due; new card recovers it', async () => {
  const { store, agent } = await setup({ token: 'pm_card_declined' });
  const sub = await store.createSubscription(agent, { items: [TP] });
  assert.equal(sub.status, 'past_due');
  assert.equal(sub.latest_order.status, 'payment_failed');
  assert.equal(sub.latest_order.charges[0].failure_code, 'card_declined');

  const pm = await store.addPaymentMethod(agent, { token: 'pm_card_visa' });
  const fixed = await store.updateSubscription(agent, sub.id, { payment_method_id: pm.id });
  assert.equal(fixed.status, 'active');
  assert.equal(fixed.latest_order.status, 'paid');
  assert.equal(fixed.latest_order.charges.length, 2);
});

test('spend policy holds orders for the owner; agent cannot approve or raise limits', async () => {
  const { store, agent, owner } = await setup({ policy: { approval_required_above_cents: 5000 } });
  const quote = await store.quote(agent, { items: [TP, PT] });
  assert.equal(quote.policy.would_require_approval, true);

  const order = await store.createOrder(agent, { items: [TP, PT] });
  assert.equal(order.status, 'requires_approval');
  assert.equal(order.approval.reasons[0].code, 'above_approval_threshold');
  assert.equal(order.shipment, null);

  await assert.rejects(() => store.decideApproval(agent, order.approval.id, 'approve'), (e) => e.status === 403);
  assert.throws(() => store.updatePolicy(agent, { approval_required_above_cents: 99999 }), (e) => e.status === 403);

  const approved = await store.decideApproval(owner, order.approval.id, 'approve');
  assert.equal(approved.status, 'paid');
  assert.ok(approved.shipment);
  await assert.rejects(() => store.decideApproval(owner, order.approval.id, 'reject'), (e) => e.code === 'approval_already_decided');
});

test('monthly limit and category allow-list', async () => {
  const { store, agent, owner } = await setup({ policy: { monthly_limit_cents: 6000, approval_required_above_cents: null } });
  assert.equal((await store.createOrder(agent, { items: [TP] })).status, 'paid');
  const second = await store.createOrder(agent, { items: [TP] });
  assert.equal(second.status, 'requires_approval');
  assert.equal(second.approval.reasons[0].code, 'monthly_limit');
  assert.equal((await store.decideApproval(owner, second.approval.id, 'reject')).status, 'canceled');

  await store.updatePolicy(owner, { allowed_categories: ['paper'], monthly_limit_cents: null });
  const batt = await store.createOrder(agent, { items: [{ sku: 'BATT-AA-24', quantity: 1 }] });
  assert.equal(batt.approval.reasons[0].code, 'category_not_allowed');
});

test('idempotency replays and rejects key reuse', async () => {
  const { store, agent } = await setup();
  const make = () => store.createSubscription(agent, { items: [TP] });
  const a = await store.idempotent(agent, 'k1', 'fp-1', make);
  const b = await store.idempotent(agent, 'k1', 'fp-1', make);
  assert.equal(a.id, b.id);
  assert.equal(b.idempotent_replay, true);
  assert.equal((await store.listSubscriptions(agent)).length, 1);
  await assert.rejects(() => store.idempotent(agent, 'k1', 'fp-2', make), (e) => e.code === 'idempotency_key_reused');
});

test('validation errors are structured with hints', async () => {
  const { store, agent } = await setup();
  const cases = [
    () => store.createSubscription(agent, { items: [] }),
    () => store.createSubscription(agent, { items: [TP], cadence_days: 3 }),
    () => store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-24', quantity: 0 }] }),
    () => store.addPaymentMethod(agent, { token: 'tok_real_card' }),
    () => store.authenticate('ck_test_wrong'),
  ];
  for (const c of cases) await assert.rejects(async () => c(), (e) => e instanceof ApiError && Boolean(e.code && e.message));
});

test('events feed is ordered and pageable', async () => {
  const { store, agent } = await setup();
  await store.createSubscription(agent, { items: [TP] });
  const first = await store.listEvents(agent, { limit: 2 });
  assert.equal(first.data.length, 2);
  const rest = await store.listEvents(agent, { after: first.next_after });
  assert.ok(rest.data.every((e) => e.seq > first.next_after));
  assert.ok(rest.data.some((e) => e.type === 'order.paid'));
});
