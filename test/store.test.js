import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { ApiError } from '../src/errors.js';

const TP = { sku: 'TP-2PLY-24', quantity: 1 };
const PT = { sku: 'PT-2PLY-12', quantity: 1 };

test('catalog search and unknown sku hint', () => {
  const { store } = setup();
  const tp = store.listProducts({ q: 'toilet' });
  assert.ok(tp.length >= 2);
  assert.ok(tp.every((p) => p.category === 'paper'));
  assert.equal(store.listProducts({ category: 'laundry' }).length, 3);
  assert.throws(() => store.getProduct('TP-NOPE'), (e) => e.code === 'product_not_found' && /TP-2PLY-24/.test(e.hint));
  assert.throws(() => store.listProducts({ category: 'garden' }), (e) => e.code === 'unknown_category');
});

test('pricing: subscription discount, free shipping threshold, tax', () => {
  const { store } = setup();
  const small = store.price([{ sku: 'NAP-250', quantity: 1 }], { subscription: false });
  assert.deepEqual(small.amounts, { subtotal_cents: 699, discount_cents: 0, shipping_cents: 599, tax_cents: 56, total_cents: 1354, currency: 'usd' });
  const big = store.price([TP, PT], { subscription: true });
  assert.equal(big.amounts.subtotal_cents, 5298);
  assert.equal(big.amounts.discount_cents, 265);
  assert.equal(big.amounts.shipping_cents, 0);
  assert.equal(big.amounts.total_cents, 5298 - 265 + 403);
});

test('recommendations scale with household size', () => {
  const { store, agent } = setup();
  const two = store.recommend(agent, { skus: ['TP-2PLY-24'], cadence_days: 28 });
  const six = store.recommend(agent, { household_size: 6, skus: ['TP-2PLY-24'], cadence_days: 28 });
  assert.equal(two.items[0].quantity, 1);
  assert.ok(six.items[0].quantity > two.items[0].quantity);
  assert.ok(store.recommend(agent, {}).items.length >= 8);
});

test('subscription lifecycle: create ships today, renews on cadence, delivers', () => {
  const { store, agent } = setup();
  const sub = store.createSubscription(agent, { items: [TP, PT], cadence_days: 30 });
  assert.equal(sub.status, 'active');
  assert.equal(sub.latest_order.status, 'paid');
  assert.equal(sub.latest_order.shipment.status, 'processing');
  assert.equal(sub.next_order_date, '2026-02-04');

  const { events } = store.advanceClock(agent, { days: 3 });
  assert.deepEqual(events.map((e) => e.type), ['shipment.shipped', 'shipment.delivered']);

  store.advanceClock(agent, { days: 27 });
  const orders = store.listOrders(agent, { subscription_id: sub.id });
  assert.equal(orders.length, 2);
  assert.equal(orders[0].created_at.slice(0, 10), '2026-02-04');
  assert.equal(store.getSubscription(agent, sub.id).next_order_date, '2026-03-06');
});

test('modify, skip, pause with auto-resume, ship now, cancel', () => {
  const { store, agent } = setup();
  let sub = store.createSubscription(agent, { items: [TP], cadence_days: 28, start_date: '2026-01-10' });
  assert.equal(sub.latest_order, null);

  sub = store.updateSubscription(agent, sub.id, { items: [{ sku: 'TP-BAMBOO-24', quantity: 2 }], cadence_days: 42 });
  assert.equal(sub.items[0].sku, 'TP-BAMBOO-24');
  assert.equal(sub.cadence_days, 42);

  sub = store.skipNext(agent, sub.id);
  assert.equal(sub.next_order_date, '2026-02-21');

  sub = store.pauseSubscription(agent, sub.id, { until: '2026-03-01' });
  assert.equal(sub.status, 'paused');
  store.advanceClock(agent, { days: 60 }); // past next_order_date and pause_until
  sub = store.getSubscription(agent, sub.id);
  assert.equal(sub.status, 'active');
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 1, 'order due during pause ships on resume');

  sub = store.shipNow(agent, sub.id);
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 2);

  sub = store.cancelSubscription(agent, sub.id, { reason: 'moving' });
  assert.equal(sub.status, 'canceled');
  assert.equal(sub.next_order_date, null);
  store.advanceClock(agent, { days: 120 });
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 2);
  assert.throws(() => store.skipNext(agent, sub.id), (e) => e.code === 'subscription_canceled');
});

test('supply signals tune cadence', () => {
  const { store, agent } = setup();
  const sub = store.createSubscription(agent, { items: [TP], cadence_days: 40 });
  const low = store.reportSignal(agent, sub.id, { signal: 'running_low' });
  assert.equal(low.cadence_days, 34);
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 2);
  const over = store.reportSignal(agent, sub.id, { signal: 'overstocked' });
  assert.equal(over.cadence_days, 39);
});

test('declined card makes subscription past_due; new card recovers it', () => {
  const { store, agent } = setup({ token: 'pm_card_declined' });
  const sub = store.createSubscription(agent, { items: [TP] });
  assert.equal(sub.status, 'past_due');
  assert.equal(sub.latest_order.status, 'payment_failed');
  assert.equal(sub.latest_order.charges[0].failure_code, 'card_declined');

  const pm = store.addPaymentMethod(agent, { token: 'pm_card_visa' });
  const fixed = store.updateSubscription(agent, sub.id, { payment_method_id: pm.id });
  assert.equal(fixed.status, 'active');
  assert.equal(fixed.latest_order.status, 'paid');
  assert.equal(fixed.latest_order.charges.length, 2);
});

test('spend policy holds orders for the owner; agent cannot approve or raise limits', () => {
  const { store, agent, owner } = setup({ policy: { approval_required_above_cents: 5000 } });
  const quote = store.quote(agent, { items: [TP, PT] });
  assert.equal(quote.policy.would_require_approval, true);

  const order = store.createOrder(agent, { items: [TP, PT] });
  assert.equal(order.status, 'requires_approval');
  assert.equal(order.approval.reasons[0].code, 'above_approval_threshold');
  assert.equal(order.shipment, null);

  assert.throws(() => store.decideApproval(agent, order.approval.id, 'approve'), (e) => e.status === 403);
  assert.throws(() => store.updatePolicy(agent, { approval_required_above_cents: 99999 }), (e) => e.status === 403);

  const approved = store.decideApproval(owner, order.approval.id, 'approve');
  assert.equal(approved.status, 'paid');
  assert.ok(approved.shipment);
  assert.throws(() => store.decideApproval(owner, order.approval.id, 'reject'), (e) => e.code === 'approval_already_decided');
});

test('monthly limit and category allow-list', () => {
  const { store, agent, owner } = setup({ policy: { monthly_limit_cents: 6000, approval_required_above_cents: null } });
  assert.equal(store.createOrder(agent, { items: [TP] }).status, 'paid');
  const second = store.createOrder(agent, { items: [TP] });
  assert.equal(second.status, 'requires_approval');
  assert.equal(second.approval.reasons[0].code, 'monthly_limit');
  assert.equal(store.decideApproval(owner, second.approval.id, 'reject').status, 'canceled');

  store.updatePolicy(owner, { allowed_categories: ['paper'], monthly_limit_cents: null });
  const batt = store.createOrder(agent, { items: [{ sku: 'BATT-AA-24', quantity: 1 }] });
  assert.equal(batt.approval.reasons[0].code, 'category_not_allowed');
});

test('idempotency replays and rejects key reuse', () => {
  const { store, agent } = setup();
  const make = () => store.createSubscription(agent, { items: [TP] });
  const a = store.idempotent(agent, 'k1', 'fp-1', make);
  const b = store.idempotent(agent, 'k1', 'fp-1', make);
  assert.equal(a.id, b.id);
  assert.equal(b.idempotent_replay, true);
  assert.equal(store.listSubscriptions(agent).length, 1);
  assert.throws(() => store.idempotent(agent, 'k1', 'fp-2', make), (e) => e.code === 'idempotency_key_reused');
});

test('validation errors are structured with hints', () => {
  const { store, agent } = setup();
  const cases = [
    () => store.createSubscription(agent, { items: [] }),
    () => store.createSubscription(agent, { items: [TP], cadence_days: 3 }),
    () => store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-24', quantity: 0 }] }),
    () => store.addPaymentMethod(agent, { token: 'tok_real_card' }),
    () => store.authenticate('ck_test_wrong'),
  ];
  for (const c of cases) assert.throws(c, (e) => e instanceof ApiError && Boolean(e.code && e.message));
});

test('events feed is ordered and pageable', () => {
  const { store, agent } = setup();
  store.createSubscription(agent, { items: [TP] });
  const first = store.listEvents(agent, { limit: 2 });
  assert.equal(first.data.length, 2);
  const rest = store.listEvents(agent, { after: first.next_after });
  assert.ok(rest.data.every((e) => e.seq > first.next_after));
  assert.ok(rest.data.some((e) => e.type === 'order.paid'));
});
