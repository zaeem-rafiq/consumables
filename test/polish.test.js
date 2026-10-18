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
