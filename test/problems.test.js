// operations/when-orders-go-wrong.md: refunds, cancel-before-buy, problem
// reports, resends, Walmart cancellations, late orders and owner emails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { setup } from './helpers.js';

const TP = { sku: 'TP-2PLY-30', quantity: 1 };
const PT = { sku: 'PT-2PLY-12', quantity: 1 };
const concierge = (support) => setup({ store: new Store({ fulfillment: 'manual', support }) });

test('refunds: partial then full, recorded on the order, emailed, and off the monthly spend', async () => {
  const { store, agent } = await concierge();
  const order = await store.createOrder(agent, { items: [TP, PT] });
  const spent = store.getAccount(agent.accountId).spend.spent_cents;
  let o = await store.refundOrder(order.id, { amount_cents: 1000, reason: 'damaged towels' });
  assert.equal(o.status, 'paid');
  assert.equal(o.refunded_cents, 1000);
  assert.equal(store.getAccount(agent.accountId).spend.spent_cents, spent - 1000);
  await assert.rejects(() => store.refundOrder(order.id, { amount_cents: order.amounts.total_cents }), (e) => e.code === 'invalid_param');
  o = await store.refundOrder(order.id, {});
  assert.equal(o.status, 'refunded');
  assert.equal(o.refunded_cents, order.amounts.total_cents);
  await assert.rejects(() => store.refundOrder(order.id, {}), (e) => e.code === 'nothing_to_refund');
  const mails = store.listEmails({ kind: 'refund' });
  assert.equal(mails.length, 2);
  assert.match(mails[0].body, /5 to 10 days/);
});

test('cancel before purchase refunds in full; after the operator buys it, cancel is refused', async () => {
  const { store, agent } = await concierge();
  const a = await store.createOrder(agent, { items: [TP] });
  const canceled = await store.cancelOrder(agent, a.id);
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.refunded_cents, a.amounts.total_cents);
  assert.equal(canceled.shipment.status, 'canceled');
  assert.equal(store.listFulfillmentQueue().length, 0, 'gone from the Walmart list');

  const b = await store.createOrder(agent, { items: [TP] });
  store.markPlaced(b.id, { retailer_order_id: 'WM-1' });
  await assert.rejects(() => store.cancelOrder(agent, b.id), (e) => e.code === 'order_already_bought' && /report_problem/.test(e.hint));
});

test('cancel during a pending bank debit refunds it automatically once it clears', async () => {
  const { store, agent, owner } = await setup();
  await store.createSubscription(agent, { items: [TP, PT], cadence_days: 28 });
  await store.advanceClock(agent, { days: 3 });
  await store.addPaymentMethod(agent, { token: 'pm_usBankAccount_success' });
  const order = await store.createOrder(agent, { items: [TP] });
  assert.equal(order.status, 'payment_pending');
  await store.cancelOrder(owner, order.id);
  await store.advanceClock(agent, { days: 7 });
  const after = store.getOrder(agent, order.id);
  assert.equal(after.status, 'canceled');
  assert.equal(after.charges[0].status, 'succeeded');
  assert.equal(after.refunded_cents, order.amounts.total_cents);
  assert.equal(after.shipment, null);
});

test('report a problem: case opened, support and owner emailed, agent reads it back', async () => {
  const { store, agent } = await concierge();
  const order = await store.createOrder(agent, { items: [TP, PT] });
  await assert.rejects(async () => store.reportProblem(agent, order.id, { kind: 'lost' }), (e) => e.code === 'invalid_param');
  const c = store.reportProblem(agent, order.id, { kind: 'damaged', skus: ['PT-2PLY-12'], note: 'box crushed', preferred: 'resend' });
  assert.equal(c.status, 'open');
  assert.equal(c.needs_proof, false, 'under $40');
  assert.match(c.what_happens_next, /refund or resend/);
  assert.equal(store.reportProblem(agent, order.id, { kind: 'damaged' }).id, c.id, 'one open case per order and kind');
  assert.equal(store.listCases(agent)[0].id, c.id);
  assert.match(store.listEmails({ to: 'support@domaru.app', kind: 'case_opened' })[0].body, /box crushed/);
  assert.equal(store.listEmails({ to: 'owner@example.com', kind: 'case_opened' }).length, 1);
  assert.throws(() => store.reportProblem(agent, 'ord_nope', { kind: 'damaged' }), (e) => e.status === 404);
});

test('proof rules: over the no-questions limit, and after 2 claims in 90 days (both settings)', async () => {
  const { store, agent } = await concierge();
  const big = await store.createOrder(agent, { items: [{ sku: 'TP-2PLY-30', quantity: 2 }] });
  assert.equal(store.reportProblem(agent, big.id, { kind: 'never_arrived' }).needs_proof, true, 'over $40');

  const { store: s2, agent: a2 } = await concierge();
  const orders = [];
  for (let i = 0; i < 3; i++) orders.push(await s2.createOrder(a2, { items: [TP] }));
  assert.equal(s2.reportProblem(a2, orders[0].id, { kind: 'damaged' }).needs_proof, false);
  assert.equal(s2.reportProblem(a2, orders[1].id, { kind: 'never_arrived' }).needs_proof, false);
  assert.equal(s2.reportProblem(a2, orders[2].id, { kind: 'missing_item' }).needs_proof, true, 'third claim');

  const { store: s3, agent: a3 } = await concierge({ no_questions_refund_cents: 100000, claim_limit: 5 });
  const o3 = await s3.createOrder(a3, { items: [{ sku: 'TP-2PLY-30', quantity: 2 }] });
  assert.equal(s3.reportProblem(a3, o3.id, { kind: 'never_arrived' }).needs_proof, false, 'limits are settings');
});

test('resolve a case with a free resend: a $0 order goes back on the Walmart list', async () => {
  const { store, agent } = await concierge();
  const order = await store.createOrder(agent, { items: [TP, PT] });
  store.markShipped(order.id, { carrier: 'Walmart', tracking_number: 'W1' });
  const c = store.reportProblem(agent, order.id, { kind: 'missing_item', skus: ['PT-2PLY-12'] });
  const done = await store.resolveCase(c.id, { action: 'resend' });
  assert.equal(done.status, 'resend_sent');
  const resend = store.getOrder(agent, done.resend_order_id);
  assert.equal(resend.amounts.total_cents, 0);
  assert.deepEqual(resend.lines.map((l) => l.sku), ['PT-2PLY-12']);
  assert.equal(resend.resend_of, order.id);
  assert.ok(store.listFulfillmentQueue().some((o) => o.id === resend.id));
  assert.match(store.getCase(agent, c.id).what_happens_next, /replacement is on the way/);
  await assert.rejects(() => store.resolveCase(c.id, { action: 'close' }), (e) => e.code === 'case_closed');
});

test('resolve a case with a refund (defaults to the affected items)', async () => {
  const { store, agent } = await concierge();
  const order = await store.createOrder(agent, { items: [TP, PT] });
  const c = store.reportProblem(agent, order.id, { kind: 'damaged', skus: ['TP-2PLY-30'] });
  const done = await store.resolveCase(c.id, { action: 'refund' });
  assert.equal(done.status, 'refunded');
  assert.equal(done.refund_cents, order.lines.find((l) => l.sku === 'TP-2PLY-30').line_total_cents);
  assert.equal(store.getOrder(agent, order.id).refunds[0].case_id, c.id);
});

test('Walmart canceled: back on the list flagged for Amazon; operator marks problems; late orders are flagged', async () => {
  const { store, agent } = await concierge();
  const order = await store.createOrder(agent, { items: [TP] });
  store.markPlaced(order.id, { retailer_order_id: 'WM-9' });
  const back = store.markRetailerCanceled(order.id);
  assert.equal(back.shipment.status, 'awaiting_fulfillment');
  assert.ok(back.shipment.retailer_canceled_at);
  store.markShipped(order.id, { carrier: 'Amazon', tracking_number: 'TBA1' });
  assert.equal(store.listLate().length, 0);
  await store.advanceClock(agent, { days: 7 });
  assert.equal(store.listLate()[0].id, order.id);
  const marked = store.markProblem(order.id, { problem: 'lost', note: 'no scan for a week' });
  assert.equal(marked.cases[0].kind, 'never_arrived');
  assert.equal(store.listEmails({ to: 'owner@example.com', kind: 'case_opened' }).length, 0, 'operator-marked cases do not email the owner as if they reported it');
});

test('owner emails: subscription started, shipped with tracking, payment failed', async () => {
  const { store, agent } = await concierge();
  await store.createSubscription(agent, { items: [TP, PT], cadence_days: 28 });
  const started = store.listEmails({ kind: 'subscription_started' })[0];
  assert.match(started.body, /renews automatically every 28 days/);
  assert.match(started.body, /at least 7 days before any increase/);
  const [order] = store.listOrders(agent);
  store.markShipped(order.id, { carrier: 'UPS', tracking_number: '1Z999' });
  assert.match(store.listEmails({ kind: 'shipped' })[0].body, /1Z999/);

  const { store: s2, agent: a2 } = await setup({ token: 'pm_card_declined' });
  await s2.createOrder(a2, { items: [TP] });
  assert.match(s2.listEmails({ kind: 'payment_failed' })[0].subject, /didn't go through/);
  for (const e of [...store.listEmails(), ...s2.listEmails()]) assert.match(e.body, /support@domaru\.app/);
});

test('emails are delivered by the configured mailer; failures are recorded, not thrown', async () => {
  const sent = [];
  const mailer = { name: 'test', send: async (m) => { sent.push(m); return m.to.includes('bounce') ? { status: 'failed', error: 'rejected' } : { status: 'sent', ref: 'em_1' }; } };
  const store = new Store({ mailer });
  store.createAccount({ name: 'A', email: 'a@example.com' });
  store.createAccount({ name: 'B', email: 'bounce@example.com' });
  await store.flushEmails();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].replyTo, 'support@domaru.app');
  assert.deepEqual(store.listEmails().map((e) => e.status).sort(), ['failed', 'sent']);
  await store.flushEmails();
  assert.equal(sent.length, 2, 'nothing is sent twice');
});

test('agents can report problems and cancel over HTTP; policy pages render with blanks marked', async () => {
  const store = new Store({ fulfillment: 'manual' });
  const { agent } = await setup({ store });
  const key = (await (async () => store.createAccount({ name: 'H', email: 'h@example.com' }))()).api_key;
  const server = await startServer(store, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const order = await store.createOrder(agent, { items: [TP] });
    const { owner_key: ownerKey } = store.createOwnerKey({ accountId: agent.accountId, role: 'owner' });
    const call = (method, path, body, k) => fetch(base + path, { method, headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const report = await call('POST', `/v1/orders/${order.id}/problems`, { kind: 'wrong_item', note: 'got napkins' }, ownerKey);
    assert.equal(report.status, 200);
    assert.equal((await (await call('GET', '/v1/cases', undefined, ownerKey)).json()).data.length, 1);
    assert.equal((await call('GET', `/v1/orders/${order.id}`, undefined, key)).status, 404, 'other households cannot see it');
    const cancel = await call('POST', `/v1/orders/${order.id}/cancel`, {}, ownerKey);
    assert.equal((await cancel.json()).status, 'canceled');

    for (const [path, heading] of [['/terms', /Terms of Service/], ['/privacy', /Privacy/], ['/refunds', /Refund/]]) {
      const html = await (await fetch(base + path)).text();
      assert.match(html, heading);
      assert.match(html, /<mark class="blank">\[/, 'placeholders stay visibly marked');
    }
    const landing = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text();
    assert.match(landing, /href="[^"]*\/refunds"/);
    assert.match(landing, /support@domaru\.app/);
  } finally {
    server.close();
  }
});
