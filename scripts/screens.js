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

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const out = process.argv[2] ?? 'screens';
mkdirSync(out, { recursive: true });

const ADMIN_KEY = 'screens-admin-key';
const store = new Store();
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

const linkFrom = (kind, re) => {
  const e = store.listEmails({ kind, limit: 1 })[0];
  const m = e && re.exec(e.body);
  if (!m) throw new Error(`no ${kind} email link`);
  return m[0].replace(/^https?:\/\/[^/]+/, '');
};
const approvalPath = linkFrom('approval_requested', /\S+\/owner\/approvals\/\S+/);

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
await browser.close();
server.close();
console.log(`Saved to ${out}/ (held order ${held.id}, approval ${approvalPath})`);
