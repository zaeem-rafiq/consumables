#!/usr/bin/env -S node --no-warnings
// Render every page a person sees, in light and dark, desktop and phone, so
// design changes can be checked by eye. Seeds a sandbox household with a held
// order, a delivered order and a problem report first.
//
//   node scripts/screens.js [outDir]       (needs Playwright; PLAYWRIGHT=/path/to/playwright)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { renderEmail } from '../src/email-html.js';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const out = process.argv[2] ?? 'screens';
mkdirSync(out, { recursive: true });

const ADMIN_KEY = 'screens-admin-key';
const store = new Store({ fulfillment: 'manual' }); // orders wait in the operator's Walmart queue
const server = await startServer(store, { port: 0, host: '127.0.0.1', adminKey: ADMIN_KEY });
const base = `http://127.0.0.1:${server.address().port}`;
store.publicUrl = base; // links in emails point at this server

// ---- a household mid-life
const email = 'sam@example.com';
const created = store.createAccount({ name: 'Rafiq household', email, household_size: 3 });
const owner = { accountId: created.account.id, role: 'owner' };
const agent = store.authenticate(created.api_key);
store.acceptTerms(owner);
await store.addPaymentMethod(owner, { token: 'pm_card_visa' });
store.addAddress(owner, { name: 'Sam Rafiq', line1: '12 Oak St', city: 'Bentonville', region: 'AR', postal_code: '72712', phone: '479-555-0134' });
const first = await store.createOrder(agent, { items: [{ sku: 'DISH-LIQ-90', quantity: 2 }, { sku: 'TRASH-13G-90', quantity: 1 }] });
await store.advanceClock(agent, { days: 4 });
store.reportProblem(agent, first.id, { kind: 'damaged', skus: ['DISH-LIQ-90'], note: 'Soap leaked all over the box.' });
await store.createSubscription(agent, { items: [{ sku: 'TP-2PLY-30', quantity: 1 }, { sku: 'PT-2PLY-12', quantity: 1 }], cadence_days: 28, start_date: store.getAccount(owner.accountId).today });
const held = await store.createOrder(agent, { items: [{ sku: 'DW-PODS-115', quantity: 8 }] });
// A second held order the owner already approved, for the "done" state of the approval page.
const held2 = await store.createOrder(agent, { items: [{ sku: 'LAUN-LIQ-115', quantity: 7 }] });
const approvedPath = (() => { const e = store.listEmails({ kind: 'approval_requested', limit: 1 })[0]; return /\S+\/owner\/approvals\/\S+/.exec(e.body)[0].replace(/^https?:\/\/[^/]+/, ''); })();
await store.decideApprovalByToken(approvedPath.split('/')[3].split('?')[0], new URL(approvedPath, base).searchParams.get('t'), 'approve');

const linkFrom = (kind, re) => {
  const e = store.listEmails({ kind, limit: 1 })[0];
  const m = e && re.exec(e.body);
  if (!m) throw new Error(`no ${kind} email link`);
  return m[0].replace(/^https?:\/\/[^/]+/, '');
};
const approvalPath = (() => { const e = store.listEmails({ kind: 'approval_requested', limit: 5 }).find((x) => x.body.includes(held.id)) ?? store.listEmails({ kind: 'approval_requested', limit: 5 }).at(-1); return /\S+\/owner\/approvals\/\S+/.exec(e.body)[0].replace(/^https?:\/\/[^/]+/, ''); })();

// Owner session: request a sign-in email, open the link.
store.startSignIn(email);
const verify = linkFrom('sign_in', /\S+\/auth\/verify\?t=\S+/);
const { session } = store.finishSignIn(new URL(verify, base).searchParams.get('t'));

// Assistant asking to connect.
const client = store.registerClient({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
const authorize = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's' })}`;

const pages = [
  ['landing', '/', {}],
  ['signin', '/auth/signin', {}],
  ['connect', authorize, { owner: true }],
  ['owner', '/owner', { owner: true }],
  ['approval', approvalPath, {}],
  ['approval-done', approvedPath, {}],
  ['setup-canceled', '/setup/canceled', {}],
  ['privacy', '/privacy', {}],
  ['not-found', '/nothing-here', {}],
  ['expired', '/auth/verify?t=nope', {}],
  ['terms', '/terms', {}],
  ['refunds', '/refunds', {}],
  ['admin-login', '/admin', {}],
  ['admin', '/admin', { admin: true }],
  ['admin-order', `/admin/orders/${first.id}`, { admin: true }],
  ['admin-emails', '/admin/emails', { admin: true }],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? undefined });
for (const scheme of ['light', 'dark']) {
  for (const [device, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: device === 'phone' ? 2 : 1 });
    await ctx.addCookies([{ name: 'domaru_owner', value: session, url: base }]);
    const login = await ctx.newPage();
    await login.goto(`${base}/admin`);
    await login.fill('input[name=key]', ADMIN_KEY);
    await Promise.all([login.waitForNavigation(), login.press('input[name=key]', 'Enter')]);
    await login.close();
    const anon = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: device === 'phone' ? 2 : 1 });
    for (const [name, path, need] of pages) {
      const page = await (need.owner || need.admin ? ctx : anon).newPage();
      await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => page.goto(base + path));
      await page.screenshot({ path: join(out, `${name}-${device}-${scheme}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
    await anon.close();
  }
}
// A second household, only to produce every other kind of email.
{
  const lee = store.createAccount({ name: 'Lee household', email: 'jo@example.com', household_size: 2 });
  const o2 = { accountId: lee.account.id, role: 'owner' };
  const a2 = store.authenticate(lee.api_key);
  store.acceptTerms(o2);
  await store.addPaymentMethod(o2, { token: 'pm_card_visa' });
  store.addAddress(o2, { name: 'Jo Lee', line1: '88 Elm Ave', city: 'Rogers', region: 'AR', postal_code: '72756', phone: '479-555-0177' });
  const o = await store.createOrder(a2, { items: [{ sku: 'PT-2PLY-12', quantity: 1 }, { sku: 'HSOAP-REFILL-56', quantity: 1 }] });
  store.markPlaced(o.id, { retailer_order_id: '2000123-45678' });
  store.markShipped(o.id, { carrier: 'FedEx', tracking_number: '771234567890' });
  store.markDelivered(o.id);
  const c = store.reportProblem(a2, o.id, { kind: 'missing_item', skus: ['HSOAP-REFILL-56'], note: 'No hand soap in the box.' });
  await store.resolveCase(c.id, { action: 'refund', note: 'Refunded the missing hand soap.' });
  await store.addPaymentMethod(o2, { token: 'pm_card_chargeDeclined' }).catch(() => store.addPaymentMethod(o2, { token: 'pm_card_declined' }));
  await store.createOrder(a2, { items: [{ sku: 'TRASH-13G-90', quantity: 1 }] }).catch(() => {});
  store.updateAccount(o2, { email: 'jo.lee@example.com' });
}

// Every kind of email, as the HTML a mail app shows (light only: emails declare a light scheme).
mkdirSync(join(out, 'emails'), { recursive: true });
const kinds = new Map();
for (const e of store.listEmails({ limit: 200 })) if (!kinds.has(e.kind)) kinds.set(e.kind, e);
for (const [device, viewport] of [['desktop', { width: 900, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: device === 'phone' ? 2 : 1 });
  for (const [kind, e] of kinds) {
    await page.setContent(renderEmail(e, { base }), { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(out, 'emails', `${kind}-${device}.png`), fullPage: true });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(`Saved to ${out}/ (held order ${held.id}, approval ${approvalPath})`);
