// One test (or more) per finding in security/security-review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { MockPayments, StripePayments, signStripeEvent } from '../src/payments.js';
import { ADDRESS, setup, ownerOf } from './helpers.js';

const TP = { sku: 'TP-2PLY-30', quantity: 1 };

async function serve(store, opts = {}) {
  const server = await startServer(store, { port: 0, host: '127.0.0.1', ...opts });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const linkIn = (body, path) => new URL(new RegExp(`https?://\\S+${path}\\S*`).exec(body)[0]);
const form = (body, cookie) => ({
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(body).toString(),
});

// ---- Finding 1: the agent got the owner key and could set its own limits

test('F1: sign-up never returns an owner key and refuses caller-chosen limits', () => {
  const store = new Store();
  assert.throws(() => store.createAccount({ name: 'X', email: 'x@example.com', policy: { per_order_limit_cents: null } }), (e) => e.status === 403);
  const created = store.createAccount({ name: 'X', email: 'x@example.com' });
  assert.equal(created.owner_key, undefined);
  assert.equal(created.account.policy.per_order_limit_cents, 15000, 'default limits');
  const invite = store.listEmails({ to: 'x@example.com', kind: 'owner_invite' })[0];
  assert.match(invite.body, /\/auth\/verify\?t=ln_/);
});

test('F1: an agent key cannot approve its own held order, even through the store', async () => {
  const { store, agent } = await setup();
  const order = await store.createOrder(agent, { items: [{ sku: 'TP-2PLY-30', quantity: 4 }] });
  assert.equal(order.status, 'requires_approval');
  await assert.rejects(() => store.decideApproval(agent, order.approval.id, 'approve'), (e) => e.status === 403);
  await assert.rejects(() => store.decideApprovalByToken(order.approval.id, 'at_guess', 'approve'), (e) => e.status === 404);
  const email = store.listEmails({ kind: 'approval_requested' })[0];
  assert.match(email.subject, /^Approve \$/);
  const link = linkIn(email.body, '/owner/approvals/');
  const done = await store.decideApprovalByToken(order.approval.id, link.searchParams.get('t'), 'approve');
  assert.equal(done.status, 'paid');
});

test('F1: Connect Domaru: emailed-link sign-in, setup, Allow, PKCE token that shops but cannot approve; owner can revoke', async () => {
  const store = new Store();
  const { server, base } = await serve(store);
  try {
    // An assistant discovers us from the 401 on /mcp.
    const anon = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);

    const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Muse', redirect_uris: ['https://muse.example/callback'] }) })).json();
    assert.ok(reg.client_id);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://muse.example/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })}`;

    // Not signed in: the page asks for an email, then the link signs them in.
    assert.match(await (await fetch(base + authorize)).text(), /Connect Domaru to Muse/);
    const sent = await fetch(`${base}/auth/signin`, form({ email: 'pat@example.com', next: authorize }));
    assert.match(await sent.text(), /Check your email/);
    const signInLink = linkIn(store.listEmails({ to: 'pat@example.com', kind: 'sign_in' })[0].body, '/auth/verify');
    const verify = await fetch(`${base}${signInLink.pathname}${signInLink.search}`, { redirect: 'manual' });
    assert.equal(verify.status, 303);
    assert.equal(verify.headers.get('location'), authorize);
    const cookie = verify.headers.get('set-cookie').split(';')[0];
    assert.match(verify.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    const reused = await fetch(`${base}${signInLink.pathname}${signInLink.search}`, { redirect: 'manual' });
    assert.equal(reused.status, 400, 'sign-in links work once');

    // Setup on the Connect page: Allow stays disabled until address and card exist.
    assert.match(await (await fetch(base + authorize, { headers: { cookie } })).text(), /disabled/);
    await fetch(`${base}/owner/addresses`, form({ ...ADDRESS, back: authorize }, cookie));
    await fetch(`${base}/owner/test-card`, form({ back: authorize }, cookie));
    const page = await (await fetch(base + authorize, { headers: { cookie } })).text();
    assert.doesNotMatch(page, /Allow Muse<\/button>\s*$/);
    const params = Object.fromEntries(new URL(base + authorize).searchParams);
    const noTerms = await fetch(`${base}/oauth/authorize`, form({ ...params, decision: 'allow' }, cookie));
    assert.equal(noTerms.status, 400, 'terms must be accepted');
    const allow = await fetch(`${base}/oauth/authorize`, form({ ...params, decision: 'allow', accept_terms: '1' }, cookie));
    assert.equal(allow.status, 303);
    const back = new URL(allow.headers.get('location'));
    assert.equal(back.origin + back.pathname, 'https://muse.example/callback');
    assert.equal(back.searchParams.get('state'), 'xyz');

    // Token exchange with PKCE; a wrong verifier fails and burns the code.
    const tokenReq = (extra) => fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: reg.client_id, redirect_uri: 'https://muse.example/callback', ...extra }));
    const tokens = await (await tokenReq({ code_verifier: verifier })).json();
    assert.ok(tokens.access_token.startsWith('dat_'));
    assert.equal((await tokenReq({ code_verifier: verifier })).status, 400, 'codes are single-use');

    const account = store.getAccount(store.authenticate(tokens.access_token).accountId);
    assert.equal(account.email, 'pat@example.com');
    assert.equal(account.owner.terms_current, true);
    const call = (method, path, body) => fetch(base + path, { method, headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const order = await (await call('POST', '/v1/orders', { items: [{ sku: 'TP-2PLY-30', quantity: 4 }] })).json();
    assert.equal(order.status, 'requires_approval', 'over the default approval threshold');
    assert.equal((await call('POST', `/v1/approvals/${order.approval.id}/approve`)).status, 403);
    assert.equal((await call('PATCH', '/v1/account/policy', { approval_required_above_cents: null })).status, 403);
    const small = await (await call('POST', '/v1/orders', { items: [TP] })).json();
    assert.equal(small.status, 'paid', 'the owner-entered address is already confirmed');

    // Refresh, then the owner disconnects the assistant and the token dies.
    const refreshed = await (await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }))).json();
    assert.ok(refreshed.access_token);
    assert.equal((await call('GET', '/v1/account')).status, 401, 'the old access token stops working after refresh');
    const grant = store.listGrants(ownerOf(account.id))[0];
    await fetch(`${base}/owner/grants/${grant.id}/revoke`, form({ back: '/owner' }, cookie));
    const after = await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    assert.equal(after.status, 401);
  } finally {
    server.close();
  }
});

test('F1: Connect rejects unknown clients, unregistered redirects and plain (non-PKCE) requests', async () => {
  const store = new Store();
  const { client_id } = store.registerClient({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  assert.throws(() => store.registerClient({ redirect_uris: ['http://evil.example/cb'] }), (e) => e.code === 'invalid_redirect_uri');
  assert.throws(() => store.oauthClient(client_id, 'https://evil.example/cb'), (e) => e.code === 'invalid_redirect_uri');
  const { store: s2, owner } = await setup();
  const c = s2.registerClient({ client_name: 'A', redirect_uris: ['https://a.example/cb'] });
  s2.acceptTerms(owner);
  assert.throws(() => s2.createAuthCode(owner, { client_id: c.client_id, redirect_uri: 'https://a.example/cb', code_challenge_method: 'plain', code_challenge: 'x'.repeat(43) }), (e) => e.code === 'invalid_request');
});

// ---- Finding 2: simultaneous orders slipped past the monthly limit

test('F2: ten orders at once cannot spend past the monthly limit', async () => {
  class SlowPayments extends MockPayments {
    async charge(args) {
      await new Promise((r) => setTimeout(r, 50));
      return super.charge(args);
    }
  }
  const { store, agent } = await setup({ store: new Store({ payments: new SlowPayments() }), policy: { monthly_limit_cents: 10000, approval_required_above_cents: null } });
  const orders = await Promise.all(Array.from({ length: 10 }, () => store.createOrder(agent, { items: [{ sku: 'TP-2PLY-30', quantity: 2 }] })));
  const paid = orders.filter((o) => o.status === 'paid');
  const total = paid.reduce((s, o) => s + o.amounts.total_cents, 0);
  assert.ok(total <= 10000, `charged ${total}`);
  assert.equal(paid.length + orders.filter((o) => o.status === 'requires_approval').length, 10);
  assert.ok(orders.filter((o) => o.status === 'requires_approval').every((o) => o.approval.reasons.some((r) => r.code === 'monthly_limit')));
});

// ---- Finding 3: deliveries to a new address, and the email, without the owner knowing

test('F3: the first order to an agent-added address waits for the owner; approving confirms it', async () => {
  const { store, agent, owner } = await setup();
  const addr = store.addAddress(agent, { ...ADDRESS, line1: '9 Stranger Rd' });
  assert.equal(addr.confirmed, false);
  const held = await store.createOrder(agent, { items: [TP], address_id: addr.id });
  assert.equal(held.status, 'requires_approval');
  assert.deepEqual(held.approval.reasons.map((r) => r.code), ['new_address']);
  assert.match(store.listEmails({ kind: 'approval_requested' })[0].body, /9 Stranger Rd/);
  await store.decideApproval(owner, held.approval.id, 'approve');
  assert.equal(store.listAddresses(agent).find((a) => a.id === addr.id).confirmed, true);
  assert.equal((await store.createOrder(agent, { items: [TP], address_id: addr.id })).status, 'paid');
  assert.throws(() => store.confirmAddress(agent, addr.id), (e) => e.status === 403);
});

test('F3: only the owner can change the owner email, and the old address is told', async () => {
  const { store, agent, owner } = await setup();
  assert.throws(() => store.updateAccount(agent, { email: 'thief@example.com' }), (e) => e.status === 403);
  store.updateAccount(agent, { household_size: 3 });
  store.updateAccount(owner, { email: 'new@example.com' });
  const notice = store.listEmails({ to: 'owner@example.com', kind: 'email_changed' })[0];
  assert.match(notice.body, /new@example\.com/);
});

// ---- Finding 4: secrets in links

test('F4: /mcp ignores keys in the link and only takes the Authorization header', async () => {
  const store = new Store();
  const { api_key } = store.createAccount({ name: 'M', email: 'm@example.com' });
  const { server, base } = await serve(store);
  try {
    const res = await fetch(`${base}/mcp?api_key=${api_key}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

// ---- Finding 5: Stripe webhooks

test('F5: a signed dispute webhook puts the household on hold; unsigned ones are refused', async () => {
  const { store, agent } = await setup();
  const sub = await store.createSubscription(agent, { items: [TP, { sku: 'PT-2PLY-12', quantity: 1 }], cadence_days: 28 });
  const orderId = sub.latest_order.id;
  // Mock card charges carry no provider ref; give this one a Stripe-like id.
  store.db.prepare("UPDATE orders SET charges_json = json_set(charges_json, '$[0].provider_ref', 'pi_123') WHERE id = ?").run(orderId);
  const { server, base } = await serve(store, { stripeWebhookSecret: 'whsec_test' });
  try {
    const event = JSON.stringify({ type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: 'pi_123', amount: 5000, reason: 'product_not_received', status: 'needs_response' } } });
    const bad = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: event });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': signStripeEvent(event, 'whsec_test') }, body: event });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
  assert.equal(store.getOrder(agent, orderId).dispute.reason, 'product_not_received');
  assert.ok(store.getAccount(agent.accountId).on_hold);
  await assert.rejects(() => store.createOrder(agent, { items: [TP] }), (e) => e.code === 'account_on_hold');
  await store.advanceClock(agent, { days: 30 });
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 1, 'renewals pause while on hold');
  assert.match(store.listEmails({ kind: 'dispute' })[0].subject, /Chargeback/);
  store.releaseHold(agent.accountId);
  await store.advanceClock(agent, { days: 1 });
  assert.equal(store.listOrders(agent, { subscription_id: sub.id }).length, 2, 'renewals resume after release');
});

test('F5: a card setup finished at Stripe is recorded even if the browser never came back', async () => {
  const pms = new Map();
  const sessions = new Map();
  const fetchStub = async (url, { method, body }) => {
    const u = new URL(url);
    const params = Object.fromEntries(new URLSearchParams(method === 'GET' ? u.search : body ?? ''));
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (u.pathname === '/v1/customers') return reply(200, { id: 'cus_1' });
    if (method === 'POST' && u.pathname === '/v1/checkout/sessions') {
      sessions.set('cs_1', { id: 'cs_1', customer: params.customer, client_reference_id: params.client_reference_id, status: 'open' });
      return reply(200, { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    }
    if (method === 'GET' && u.pathname === '/v1/checkout/sessions/cs_1') return reply(200, sessions.get('cs_1'));
    return reply(404, { error: { message: 'nope' } });
  };
  const store = new Store({ payments: new StripePayments({ secretKey: 'sk_test_x', publicUrl: 'https://shop.test', fetch: fetchStub }) });
  const { api_key } = store.createAccount({ name: 'W', email: 'w@example.com' });
  const agent = store.authenticate(api_key);
  await store.createCardSetupLink(agent);
  Object.assign(sessions.get('cs_1'), { status: 'complete', setup_intent: { payment_method: { id: 'pm_9', card: { brand: 'visa', last4: '1111' } } } });
  pms.set('pm_9', true);
  assert.deepEqual(await store.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'setup' } } }), { handled: true });
  assert.equal(store.listPaymentMethods(agent)[0].last4, '1111');
});

// ---- Finding 7: unlimited sign-ups

test('F7: sign-ups are rate limited per network', async () => {
  const { server, base } = await serve(new Store());
  try {
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${base}/v1/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `H${i}`, email: `h${i}@example.com` }) });
      statuses.push(res.status);
    }
    assert.equal(statuses.filter((s) => s === 201).length, 20);
    assert.equal(statuses.at(-1), 429);
  } finally {
    server.close();
  }
});

test('F7: sign-in emails are rate limited per address', async () => {
  const store = new Store();
  const { server, base } = await serve(store);
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await fetch(`${base}/auth/signin`, form({ email: 'spam@example.com' }))).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
  } finally {
    server.close();
  }
});

// ---- Finding 8: Stripe's own error text stays out of agent-facing errors

test('F8: payment provider errors are generic', async () => {
  const fetchStub = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'internal detail: acct_secret' } }) });
  const store = new Store({ payments: new StripePayments({ secretKey: 'sk_test_x', publicUrl: 'https://shop.test', fetch: fetchStub }) });
  const { api_key } = store.createAccount({ name: 'E', email: 'e@example.com' });
  const errors = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => store.createCardSetupLink(store.authenticate(api_key)), (e) => e.code === 'payment_provider_error' && !/acct_secret/.test(e.message));
  } finally {
    console.error = errors;
  }
});
