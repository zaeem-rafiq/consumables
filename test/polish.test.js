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
