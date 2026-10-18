#!/usr/bin/env -S node --no-warnings
// Dress rehearsal: one household's whole life with Domaru, end to end, in test
// mode. A real browser plays the person (clicks the emailed links, fills in the
// Connect page, taps Approve); a real MCP client plays their assistant; the
// operator page plays us. Every step is checked, and a screenshot is saved at
// each moment the person sees something.
//
//   PLAYWRIGHT=/path/to/playwright node scripts/rehearsal.js [outDir]
//
// Nothing leaves this machine: payments are the mock processor unless
// STRIPE_SECRET_KEY (sk_test_...) is set, and email stays in the outbox.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { StripePayments } from '../src/payments.js';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const out = process.argv[2] ?? 'rehearsal';
mkdirSync(out, { recursive: true });

const key = process.env.STRIPE_SECRET_KEY;
if (key && !key.startsWith('sk_test_')) throw new Error('The rehearsal only runs against Stripe test mode (sk_test_...).');
const ADMIN_KEY = 'rehearsal-admin-key';
const store = new Store({ ...(key ? { payments: new StripePayments({ secretKey: key }) } : {}) });
const server = await startServer(store, { port: 0, host: '127.0.0.1', adminKey: ADMIN_KEY });
const base = `http://127.0.0.1:${server.address().port}`;
store.publicUrl = base;

const EMAIL = 'rehearsal@example.com';
// The assistant's callback stays on this machine (nothing is sent to a real assistant).
const CALLBACK = 'http://localhost:9/callback';
const log = [];
let shot = 0;
let failed = 0;
const step = (title) => { log.push(`\n## ${title}\n`); console.log(`\n${title}`); };
const ok = (what, pass, detail = '') => {
  if (!pass) failed++;
  log.push(`- ${pass ? 'PASS' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`);
  console.log(`  ${pass ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
};
const snap = async (page, name) => {
  const file = `${String(++shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(out, file), fullPage: true });
  log.push(`- Screenshot: ${file}`);
};
const latestEmail = (kind) => store.listEmails({ to: EMAIL, kind, limit: 1 })[0];
const linkIn = (email) => /https?:\/\/\S+/.exec(email?.body ?? '')?.[0];

const browser = await chromium.launch();
const person = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();

// ---------------------------------------------------------------- 1. connect
step('1. The household connects Domaru from their assistant');
const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }) })).json();
ok('assistant registered itself', !!reg.client_id);
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorizeUrl = `${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'rehearsal' })}`;

let code;
person.on('request', (r) => { if (r.url().startsWith(CALLBACK)) code = new URL(r.url()).searchParams.get('code'); });
await person.goto(authorizeUrl);
await snap(person, 'sign-in');
await person.fill('input[name=email]', EMAIL);
await person.click('button:has-text("Email me a sign-in link")');
await snap(person, 'check-your-email');
const signIn = latestEmail('sign_in');
ok('sign-in email sent', !!linkIn(signIn), signIn?.subject);
await person.goto(linkIn(signIn));
await snap(person, 'connect-empty');
ok('lands on the Connect page', await person.isVisible('h1:has-text("Connect Claude")'));

await person.fill('input[name=name]', 'Riley Carter');
await person.fill('input[name=phone]', '479-555-0199');
await person.fill('input[name=line1]', '210 Walnut Ave');
await person.fill('input[name=city]', 'Bentonville');
await person.fill('input[name=region]', 'AR');
await person.fill('input[name=postal_code]', '72712');
await person.click('button:has-text("Save address")');
ok('address saved', await person.isVisible('.addr'));
await person.click('button:has-text("Test mode: use a test card")');
ok('test card saved', await person.isVisible('text=4242'));
await person.fill('input[name=approval_required_above]', '60');
await person.fill('input[name=monthly_limit]', '250');
await person.fill('input[name=per_order_limit]', '120');
await person.check('input[name=accept_terms]');
await snap(person, 'connect-ready');
await person.click('button:has-text("Allow Claude")');
for (let i = 0; i < 50 && !code; i++) await person.waitForTimeout(100);
ok('Allow sends the assistant back with a code', !!code);

const token = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: reg.client_id, code_verifier: verifier }) })).json();
ok('assistant got an access token', !!token.access_token);

const mcp = new Client({ name: 'rehearsal-assistant', version: '1.0.0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token.access_token}` } } }));
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = r.content?.map((c) => c.text).join('') ?? '';
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { error: !!r.isError, data };
};
const acct = (await call('get_account')).data;
ok('limits from the Connect page are in force', acct.policy?.approval_required_above_cents === 6000 && acct.policy?.monthly_limit_cents === 25000 && acct.policy?.per_order_limit_cents === 12000, JSON.stringify(acct.policy));

// ---------------------------------------------------------------- 2. orders
step('2. The assistant sets up regular deliveries');
const rec = (await call('recommend_bundle', { household_size: 3 })).data;
ok('recommendation has a plan', Array.isArray(rec.plan) && rec.plan.length > 0, `${rec.plan?.length} deliveries, about $${(rec.estimated_monthly_cents / 100).toFixed(2)}/month`);
const sub = await call('create_subscription', { items: [{ sku: 'TP-2PLY-30', quantity: 1 }, { sku: 'PT-2PLY-12', quantity: 1 }], cadence_days: 42 });
ok('subscription created and first order paid', !sub.error && sub.data.latest_order?.status === 'paid', sub.error ? JSON.stringify(sub.data) : sub.data.id);
ok('subscription email sent', !!latestEmail('subscription_started'));

step('3. A big order is held for the owner, who approves it from the email');
const self = await call('place_order', { items: [{ sku: 'DW-PODS-115', quantity: 4 }] });
ok('order over $60 is held, not charged', !self.error && self.data.status === 'requires_approval', self.data.status);
const approve = await call('list_approvals');
const pending = (approve.data.data ?? approve.data).find?.((a) => a.status === 'pending');
// The assistant's token tries the owner-only approve endpoint directly.
const selfApprove = await fetch(`${base}/v1/approvals/${pending?.id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${token.access_token}` } });
ok("assistant can't approve its own order", !!pending && selfApprove.status === 403, `HTTP ${selfApprove.status}`);
const approvalEmail = latestEmail('approval_requested');
ok('approval email sent', !!approvalEmail, approvalEmail?.subject);
await person.goto(linkIn(approvalEmail).replace(/[).,]+$/, ''));
await snap(person, 'approval');
await person.click('button:has-text("Approve")');
await snap(person, 'approved');
const afterApprove = (await call('get_order', { order_id: self.data.id })).data;
ok('order is paid after the owner approves', afterApprove.status === 'paid', afterApprove.status);

// ---------------------------------------------------------------- 3. problem
step('4. A box arrives damaged; the assistant reports it and we refund');
await call('advance_test_clock', { days: 5 });
const delivered = (await call('get_order', { order_id: self.data.id })).data;
ok('order delivered', delivered.shipment?.status === 'delivered', delivered.shipment?.status);
const report = await call('report_problem', { order_id: self.data.id, kind: 'damaged', skus: ['DW-PODS-115'], note: 'Box was crushed and pods spilled.' });
ok('problem reported', !report.error, report.error ? JSON.stringify(report.data) : report.data.what_happens_next);
ok('"we\'re on it" email sent', !!latestEmail('case_opened'));

const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await admin.goto(`${base}/admin`);
await admin.fill('input[name=key]', ADMIN_KEY);
await Promise.all([admin.waitForNavigation(), admin.press('input[name=key]', 'Enter')]);
await admin.goto(`${base}/admin/orders/${self.data.id}`);
await snap(admin, 'operator-order');
await admin.click('.panel button:has-text("Refund")');
await snap(admin, 'operator-refunded');
const kase = (await call('list_cases')).data;
const c0 = (kase.data ?? kase)[0];
ok('case refunded', c0?.status === 'refunded', `${c0?.status} ${c0?.refund_cents != null ? `$${(c0.refund_cents / 100).toFixed(2)}` : ''}`);
const refundEmail = latestEmail('refund');
ok('refund email sent', !!refundEmail, refundEmail?.subject);

step('5. The owner checks their page');
await person.goto(`${base}/owner`);
await snap(person, 'owner-page');
const ownerText = await person.textContent('main');
ok('owner page shows the refund', /refunded/i.test(ownerText));
ok('owner page shows the next delivery', /Next delivery/i.test(ownerText));

step('6. Emails the household received');
for (const e of store.listEmails({ to: EMAIL, limit: 20 }).reverse()) log.push(`- ${e.kind}: "${e.subject}"`);

await mcp.close();
await browser.close();
server.close();
writeFileSync(join(out, 'report.md'), `# Domaru dress rehearsal\n\n${new Date().toISOString()} · ${key ? 'Stripe test mode' : 'mock payments'} · ${failed ? `${failed} step(s) failed` : 'every step passed'}\n${log.join('\n')}\n`);
console.log(`\n${failed ? `${failed} FAILED` : 'All steps passed'}. Report and screenshots in ${out}/`);
process.exit(failed ? 1 : 0);
