import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail } from '../src/email-html.js';

test('email HTML: link becomes a button, reasons and items are laid out, text is escaped', () => {
  const html = renderEmail({
    kind: 'approval_requested',
    subject: 'Approve $19.98 for Domaru?',
    body: ['Needs your OK because:', '- over <limit>', '', '2 x Paper Towels  $19.98', 'Approve or decline:', 'https://domaru.app/owner/approvals/a?t=x', '', '--', 'Domaru · support@domaru.app'].join('\n'),
  });
  assert.match(html, />Review and approve</);
  assert.match(html, /href="https:\/\/domaru\.app\/owner\/approvals\/a\?t=x"/);
  assert.match(html, /over &lt;limit&gt;/);
  assert.match(html, /Paper Towels <span[^>]*>× 2<\/span>/);
  assert.match(html, /support@domaru\.app/);
  assert.doesNotMatch(html, /<script/);
});

test('admin order page shows the problem value, not NaN', async () => {
  const { Store } = await import('../src/store.js');
  const { adminOrderPage } = await import('../src/admin.js');
  const store = new Store();
  const { account, api_key } = store.createAccount({ name: 'T', email: 't@example.com' });
  const owner = { accountId: account.id, role: 'owner' };
  store.acceptTerms(owner);
  await store.addPaymentMethod(owner, { token: 'pm_card_visa' });
  store.addAddress(owner, { name: 'T', line1: '1 A St', city: 'B', region: 'AR', postal_code: '72712' });
  const agent = store.authenticate(api_key);
  const o = await store.createOrder(agent, { items: [{ sku: 'DISH-LIQ-90', quantity: 1 }] });
  await store.advanceClock(agent, { days: 4 });
  store.reportProblem(agent, o.id, { kind: 'damaged', skus: ['DISH-LIQ-90'] });
  const html = adminOrderPage(store.adminOrder(o.id));
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /\$11\.99/);
});

test('skipping one item leaves it out of the next delivery only', async () => {
  const { Store } = await import('../src/store.js');
  const store = new Store();
  const { account, api_key } = store.createAccount({ name: 'T', email: 't2@example.com' });
  const owner = { accountId: account.id, role: 'owner' };
  store.acceptTerms(owner);
  await store.addPaymentMethod(owner, { token: 'pm_card_visa' });
  store.addAddress(owner, { name: 'T', line1: '1 A St', city: 'B', region: 'AR', postal_code: '72712' });
  const agent = store.authenticate(api_key);
  const today = store.getAccount(account.id).today;
  const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 5);
  const sub = await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-30', quantity: 1 }, { sku: 'PT-2PLY-12', quantity: 1 }], cadence_days: 14, start_date: d.toISOString().slice(0, 10) });
  const skipped = store.skipNext(agent, sub.id, { skus: ['PT-2PLY-12'] });
  assert.deepEqual(skipped.skipping_next.skus, ['PT-2PLY-12']);
  assert.throws(() => store.skipNext(agent, sub.id, { skus: ['NOPE'] }));
  await store.advanceClock(agent, { days: 25 });
  const orders = store.listOrders(agent, { limit: 10 }).reverse();
  assert.deepEqual(orders[0].lines.map((l) => l.sku), ['TP-2PLY-30']);
  assert.deepEqual(orders[1].lines.map((l) => l.sku).sort(), ['PT-2PLY-12', 'TP-2PLY-30']);
});

test('returns: not before purchase, one of two boxes, within 30 days of delivery', async () => {
  const { Store } = await import('../src/store.js');
  const store = new Store();
  const { api_key, account } = store.createAccount({ name: 'R', email: 'r@example.com' });
  const owner = { accountId: account.id, role: 'owner' };
  const agent = store.authenticate(api_key);
  store.acceptTerms(owner);
  await store.addPaymentMethod(owner, { token: 'pm_card_visa' });
  store.addAddress(owner, { name: 'R', line1: '1 A St', city: 'Bentonville', region: 'AR', postal_code: '72712' });
  const o = await store.createOrder(agent, { items: [{ sku: 'TRASH-13G-90', quantity: 2 }] });
  assert.throws(() => store.reportProblem(agent, o.id, { kind: 'return' }), /not been bought/);
  await store.advanceClock(agent, { days: 1 });
  await assert.rejects(store.cancelOrder(agent, o.id), (e) => /kind 'return'/.test(e.hint));
  const c = store.reportProblem(agent, o.id, { kind: 'return', skus: ['TRASH-13G-90'], quantities: { 'TRASH-13G-90': 1 } });
  assert.deepEqual(c.quantities, { 'TRASH-13G-90': 1 });
  assert.equal(c.value_cents, Math.round(o.lines.find((l) => l.sku === 'TRASH-13G-90').line_total_cents / 2));
  assert.match(c.what_happens_next, /return label/);
  assert.throws(() => store.reportProblem(agent, o.id, { kind: 'return', quantities: { 'TRASH-13G-90': 3 } }), /quantities/);
  const late = await store.createOrder(agent, { items: [{ sku: 'PT-2PLY-12', quantity: 1 }] });
  await store.advanceClock(agent, { days: 40 });
  assert.equal(store.getOrder(agent, late.id).shipment.status, 'delivered');
  assert.throws(() => store.reportProblem(agent, late.id, { kind: 'return' }), /30 days/);
});
