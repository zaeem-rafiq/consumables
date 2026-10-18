// Everything a person (not an agent) opens in a browser: policy pages, the
// emailed-link sign-in, Connect Domaru (OAuth for assistants), the owner's
// page, one-tap approvals, the operator page, and Stripe's webhook.

import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
import { messagePage, policyPage } from './ui.js';
import { signInPage, checkEmailPage, connectPage, approvalPage, ownerPage } from './owner.js';
import { adminLoginPage, fulfillmentPage, adminOrderPage, emailLogPage } from './admin.js';
import { verifyStripeEvent } from './payments.js';

const POLICIES = {
  '/terms': ['Terms of service', 'terms-of-service.md'],
  '/privacy': ['Privacy policy', 'privacy-policy.md'],
  '/refunds': ['Refund and delivery policy', 'refund-and-delivery-policy.md'],
};
const policyText = Object.fromEntries(Object.entries(POLICIES).map(([path, [title, file]]) => {
  try {
    return [path, readFileSync(new URL(`../docs/legal/${file}`, import.meta.url), 'utf8')];
  } catch {
    return [path, `# ${title}\n\nComing soon.`];
  }
}));

const OWNER_COOKIE = 'domaru_owner';
const ADMIN_COOKIE = 'domaru_admin';
const BACK_COOKIE = 'domaru_back';

/** Fixed-window counter per key, in memory. Enough for one server. */
export class RateLimit {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  hit(key) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

export function clientIp(req) {
  const fwd = req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
}

function cookie(name, value, { base, maxAge, path = '/', sameSite = 'Lax' }) {
  const secure = base.startsWith('https:') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new ApiError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req) {
  const raw = await readRaw(req);
  if (raw.trimStart().startsWith('{')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const safeBack = (b, fallback = '/owner') => (typeof b === 'string' && b.startsWith('/') && !b.startsWith('//') && !b.includes('\\') ? b : fallback);
const cents = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Math.round(Number(v) * 100));
const sameKey = (a, b) => {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
};

/**
 * @returns {Promise<boolean>} true when the request was a web route and has been answered.
 */
export async function handleWeb(store, req, res, url, { base, adminKey, stripeWebhookSecret, send, limits }) {
  const path = url.pathname;
  const html = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...headers });
    res.end(body);
    return true;
  };
  const redirect = (to, headers = {}) => {
    res.writeHead(303, { location: to, 'cache-control': 'no-store', ...headers });
    res.end();
    return true;
  };
  const jar = cookies(req);
  const owner = () => store.ownerSession(jar[OWNER_COOKIE]);
  const ip = clientIp(req);

  // ---- policies
  if (req.method === 'GET' && POLICIES[path]) return html(200, policyPage(POLICIES[path][0], policyText[path]));

  // ---- OAuth discovery (MCP authorization)
  if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
    send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['shop'], bearer_methods_supported: ['header'], resource_name: 'Domaru' });
    return true;
  }
  if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
    send(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['shop'],
      service_documentation: `${base}/llms.txt`,
    });
    return true;
  }
  if (req.method === 'POST' && path === '/oauth/register') {
    if (!limits.register.hit(ip)) { send(res, 429, { error: 'slow_down', error_description: 'Too many registrations.' }); return true; }
    const body = await readForm(req);
    try {
      send(res, 201, store.registerClient(body));
    } catch (err) {
      send(res, 400, { error: err.code === 'invalid_redirect_uri' ? 'invalid_redirect_uri' : 'invalid_client_metadata', error_description: err.message });
    }
    return true;
  }
  if (req.method === 'POST' && path === '/oauth/token') {
    const body = await readForm(req);
    try {
      const tokens = store.oauthToken(body);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' });
      res.end(JSON.stringify(tokens));
    } catch (err) {
      const e = err.oauth ?? { error: 'invalid_request', error_description: err.message };
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(e));
    }
    return true;
  }
  if (path === '/oauth/authorize') {
    const q = req.method === 'POST' ? await readForm(req) : Object.fromEntries(url.searchParams);
    const oauth = Object.fromEntries(['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource']
      .filter((k) => q[k] != null).map((k) => [k, String(q[k])]));
    let client;
    try {
      client = store.oauthClient(oauth.client_id, oauth.redirect_uri);
    } catch {
      return html(400, messagePage("This link doesn't look right", 'The assistant sent an invalid connection request. Try connecting Domaru again from your assistant.'));
    }
    const back = `/oauth/authorize?${new URLSearchParams(oauth)}`;
    const bounce = (params) => {
      const to = new URL(oauth.redirect_uri);
      for (const [k, v] of Object.entries({ ...params, state: oauth.state, iss: base })) if (v != null) to.searchParams.set(k, v);
      return redirect(to.toString());
    };
    if (oauth.response_type !== 'code') return bounce({ error: 'unsupported_response_type' });
    const auth = owner();
    if (!auth) return html(200, signInPage({ next: back, clientName: client.name }));
    const render = (error) => {
      const account = store.getAccount(auth.accountId);
      return html(error ? 400 : 200, connectPage({
        client, account, checklist: store.connectChecklist(auth), addresses: store.listAddresses(auth), paymentMethods: store.listPaymentMethods(auth),
        policy: account.policy, oauth, back, testMode: store.mode === 'test', error,
      }));
    };
    if (req.method === 'GET') return render();
    if (q.decision !== 'allow') return bounce({ error: 'access_denied' });
    if (!q.accept_terms) return render('Please agree to the terms to continue.');
    try {
      store.acceptTerms(auth);
      // The limits on the Connect page are part of the Allow form.
      if (['approval_required_above', 'per_order_limit', 'monthly_limit'].some((k) => k in q)) {
        store.updatePolicy(auth, { approval_required_above_cents: cents(q.approval_required_above), per_order_limit_cents: cents(q.per_order_limit), monthly_limit_cents: cents(q.monthly_limit) });
      }
      const code = store.createAuthCode(auth, oauth);
      return bounce({ code });
    } catch (err) {
      if (err.code === 'invalid_request') return bounce({ error: 'invalid_request', error_description: err.message });
      return render(err.message);
    }
  }

  // ---- sign-in by emailed link
  if (path === '/auth/signin') {
    if (req.method === 'GET') return html(200, signInPage({ next: safeBack(url.searchParams.get('next')) }));
    if (req.method === 'POST') {
      const body = await readForm(req);
      const next = safeBack(body.next);
      const email = String(body.email ?? '').trim();
      if (!limits.signin.hit(ip) || !limits.signin.hit(`email:${email.toLowerCase()}`)) {
        return html(429, signInPage({ next, error: 'Too many sign-in emails. Wait a few minutes and try again.' }));
      }
      try {
        store.startSignIn(email, { next });
      } catch (err) {
        return html(400, signInPage({ next, error: err.message }));
      }
      return html(200, checkEmailPage({ email }));
    }
  }
  if (req.method === 'GET' && path === '/auth/verify') {
    try {
      const { session, next } = store.finishSignIn(url.searchParams.get('t'));
      return redirect(safeBack(next), { 'set-cookie': cookie(OWNER_COOKIE, session, { base, maxAge: 30 * 86400 }) });
    } catch (err) {
      return html(400, messagePage('That link has expired', 'Sign-in links work once, for 30 minutes. Ask for a new one.', { action: { href: '/auth/signin', label: 'Email me a new link' } }));
    }
  }

  // ---- one-tap approval from the email (the link is the permission)
  let m;
  if ((m = /^\/owner\/approvals\/([^/]+)(\/decide)?$/.exec(path)) && (req.method === 'GET' || m[2])) {
    const body = req.method === 'POST' ? await readForm(req) : {};
    const token = body.t ?? url.searchParams.get('t');
    if (req.method === 'POST') {
      if (!['approve', 'reject'].includes(body.decision)) return html(400, messagePage('Something went wrong', 'Choose Approve or Decline.'));
      try {
        await store.decideApprovalByToken(m[1], token, body.decision);
      } catch (err) {
        if (err.code !== 'approval_already_decided') return html(err.status ?? 400, messagePage('This link has expired', 'Open the newest approval email, or sign in to see what is waiting.', { action: { href: '/owner', label: 'Go to your account' } }));
      }
      return redirect(`/owner/approvals/${encodeURIComponent(m[1])}?t=${encodeURIComponent(token)}`);
    }
    const info = store.approvalForToken(m[1], token);
    if (!info) return html(404, messagePage('This link has expired', 'Open the newest approval email, or sign in to see what is waiting.', { action: { href: '/owner', label: 'Go to your account' } }));
    return html(200, approvalPage({ info, token }));
  }

  // ---- the owner's page
  if (path === '/owner' || path.startsWith('/owner/')) {
    const auth = owner();
    if (!auth) {
      if (req.method === 'GET') return html(200, signInPage({ next: safeBack(path) }));
      return redirect('/auth/signin');
    }
    if (req.method === 'GET' && path === '/owner') {
      const account = store.getAccount(auth.accountId);
      const approvals = store.listApprovals(auth, { status: 'pending' }).map((approval) => {
        const order = store.getOrder(auth, approval.order_id);
        return { approval, order, ship_to: store.listAddresses(auth).find((a) => a.id === order.address_id) };
      });
      return html(200, ownerPage({
        account, approvals, addresses: store.listAddresses(auth), paymentMethods: store.listPaymentMethods(auth), grants: store.listGrants(auth),
        orders: store.listOrders(auth, { limit: 10 }), cases: store.listCases(auth), testMode: store.mode === 'test',
        subscriptions: store.listSubscriptions(auth).filter((x) => x.status !== 'canceled'),
        flash: { saved: 'Saved.', approved: 'Approved. The order is being placed.', rejected: 'Declined. Nothing was charged.', card: 'Card saved.', disconnected: 'Assistant disconnected.' }[url.searchParams.get('done')],
      }));
    }
    if (req.method !== 'POST') return false;
    const body = await readForm(req);
    const back = safeBack(body.back);
    const done = (key = 'saved') => redirect(back === '/owner' ? `/owner?done=${key}` : back);
    const fail = (err) => html(err.status ?? 400, messagePage("That didn't work", err.hint ? `${err.message} ${err.hint}` : err.message, { action: { href: back, label: 'Go back' } }));
    try {
      if (path === '/owner/signout') {
        store.endSession(jar[OWNER_COOKIE]);
        return redirect('/', { 'set-cookie': cookie(OWNER_COOKIE, '', { base, maxAge: 0 }) });
      }
      if (path === '/owner/addresses') {
        store.addAddress(auth, { name: body.name, line1: body.line1, line2: body.line2 || undefined, city: body.city, region: String(body.region ?? '').toUpperCase(), postal_code: body.postal_code, phone: body.phone || undefined });
        return done();
      }
      if ((m = /^\/owner\/addresses\/([^/]+)\/confirm$/.exec(path))) { store.confirmAddress(auth, m[1]); return done(); }
      if (path === '/owner/policy') {
        store.updatePolicy(auth, { approval_required_above_cents: cents(body.approval_required_above), per_order_limit_cents: cents(body.per_order_limit), monthly_limit_cents: cents(body.monthly_limit) });
        return done();
      }
      if (path === '/owner/terms') {
        if (!body.accept_terms) throw new ApiError(400, 'terms_not_accepted', 'Tick the box to accept the terms.');
        store.acceptTerms(auth);
        return done();
      }
      if (path === '/owner/email') { store.updateAccount(auth, { email: String(body.email ?? '').trim() }); return done(); }
      if (path === '/owner/card' || path === '/owner/bank') {
        if (!limits.setup.hit(ip)) throw new ApiError(429, 'rate_limited', 'Too many attempts. Try again later.');
        if (!store.payments.supportsSetupLinks) throw new ApiError(400, 'setup_links_unavailable', 'Saving a real card needs Stripe to be connected.', { hint: store.mode === 'test' ? 'In test mode, use a test card instead.' : undefined });
        const link = path === '/owner/card' ? await store.createCardSetupLink(auth) : await store.createBankSetupLink(auth);
        return redirect(link.url, { 'set-cookie': cookie(BACK_COOKIE, back, { base, maxAge: 3600 }) });
      }
      if (path === '/owner/test-card') {
        if (store.mode !== 'test') throw new ApiError(403, 'forbidden', 'Test cards only work in test mode.');
        await store.addPaymentMethod(auth, { token: 'pm_card_visa' });
        return done('card');
      }
      if ((m = /^\/owner\/approvals\/([^/]+)\/(approve|reject)$/.exec(path))) {
        await store.decideApproval(auth, m[1], m[2]);
        return done(m[2] === 'approve' ? 'approved' : 'rejected');
      }
      if ((m = /^\/owner\/grants\/([^/]+)\/revoke$/.exec(path))) { store.revokeGrant(auth, m[1]); return done('disconnected'); }
      if (path === '/owner/developer-key') {
        const { owner_key: key } = store.createOwnerKey(auth);
        const account = store.getAccount(auth.accountId);
        return html(200, ownerPage({
          account, approvals: [], addresses: store.listAddresses(auth), paymentMethods: store.listPaymentMethods(auth), grants: store.listGrants(auth),
          orders: store.listOrders(auth, { limit: 10 }), cases: store.listCases(auth), testMode: store.mode === 'test', developerKey: key,
          subscriptions: store.listSubscriptions(auth).filter((x) => x.status !== 'canceled'),
        }));
      }
    } catch (err) {
      if (err instanceof ApiError) return fail(err);
      throw err;
    }
    return false;
  }

  // ---- Stripe's hosted card page sends the person back here
  if (req.method === 'GET' && path === '/setup/complete') {
    try {
      const done = await store.completeCardSetup(url.searchParams.get('session_id') ?? '');
      const back = jar[BACK_COOKIE] ? safeBack(jar[BACK_COOKIE]) : null;
      if (back && owner()) return redirect(back === '/owner' ? '/owner?done=card' : back, { 'set-cookie': cookie(BACK_COOKIE, '', { base, maxAge: 0 }) });
      if (done.payment_method.type === 'bank') return html(200, messagePage('Bank account connected', 'Your deliveries are now paid from your bank account, and you save 2% on every one. You can close this tab.'));
      return html(200, messagePage('Card saved', 'Your card is saved for Domaru orders. You can close this tab; your assistant will take it from here.'));
    } catch (err) {
      return html(err.status ?? 500, messagePage('Card not saved', err.hint ?? 'Something went wrong. Please try again.'));
    }
  }
  if (req.method === 'GET' && path === '/setup/canceled') {
    const back = jar[BACK_COOKIE] ? safeBack(jar[BACK_COOKIE]) : null;
    if (back && owner()) return redirect(back);
    return html(200, messagePage('Nothing saved', 'You closed the page before saving. Ask your assistant for a new link when you are ready.'));
  }
  if (req.method === 'GET' && /^\/approvals\/[^/]+$/.test(path)) {
    return html(200, messagePage('Waiting for the account owner', 'This order is outside the limits the account owner set, so we emailed them to approve or decline it. Nothing is charged until they approve.'));
  }

  // ---- Stripe webhook
  if (req.method === 'POST' && path === '/webhooks/stripe') {
    if (!stripeWebhookSecret) return false;
    const raw = await readRaw(req);
    const event = verifyStripeEvent(raw, req.headers['stripe-signature'], stripeWebhookSecret);
    if (!event) { send(res, 400, { error: 'invalid_signature' }); return true; }
    send(res, 200, await store.handleStripeEvent(event));
    return true;
  }

  // ---- operator pages
  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!adminKey) throw new ApiError(404, 'route_not_found', 'Admin pages are disabled.', { hint: 'Set ADMIN_KEY to enable them.' });
    const bearerKey = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const signedIn = store.isAdminSession(jar[ADMIN_COOKIE]) || (bearerKey && sameKey(bearerKey, adminKey));
    const json = (req.headers['content-type'] ?? '').includes('json') || (req.headers.accept ?? '').includes('application/json');
    if (path === '/admin/login' && req.method === 'POST') {
      if (!limits.adminLogin.hit(ip)) return html(429, adminLoginPage({ error: 'Too many attempts. Wait 15 minutes.' }));
      const body = await readForm(req);
      if (!body.key || !sameKey(body.key, adminKey)) return html(401, adminLoginPage({ error: 'Wrong password.' }));
      return redirect('/admin', { 'set-cookie': cookie(ADMIN_COOKIE, store.createAdminSession(), { base, maxAge: 12 * 3600, path: '/admin', sameSite: 'Strict' }) });
    }
    if (!signedIn) {
      if (json) { send(res, 401, { error: { code: 'unauthorized', message: 'Admin sign-in required.' } }); return true; }
      return html(req.method === 'GET' && path === '/admin' ? 200 : 401, adminLoginPage());
    }
    if (path === '/admin/logout' && req.method === 'POST') {
      return redirect('/admin', { 'set-cookie': cookie(ADMIN_COOKIE, '', { base, maxAge: 0, path: '/admin', sameSite: 'Strict' }) });
    }
    if (req.method === 'GET' && path === '/admin') {
      return html(200, fulfillmentPage({
        awaiting: store.listFulfillmentQueue({ status: 'awaiting_fulfillment' }), placed: store.listFulfillmentQueue({ status: 'placed' }),
        shipped: store.listFulfillmentQueue({ status: 'shipped' }), cases: store.listOpenCases(), late: store.listLate(),
      }));
    }
    if (req.method === 'GET' && path === '/admin/orders.json') { send(res, 200, { data: store.listFulfillmentQueue({ status: url.searchParams.get('status') ?? 'awaiting_fulfillment' }) }); return true; }
    if (req.method === 'GET' && path === '/admin/emails') return html(200, emailLogPage(store.listEmails({ limit: 100 })));
    if (req.method === 'GET' && path === '/admin/find') return redirect(`/admin/orders/${encodeURIComponent(url.searchParams.get('order') ?? '')}`);
    if (req.method === 'GET' && (m = /^\/admin\/orders\/([^/]+)$/.exec(path))) return html(200, adminOrderPage(store.adminOrder(m[1])));
    if (req.method === 'POST') {
      const body = await readForm(req);
      let result;
      let to = '/admin';
      if ((m = /^\/admin\/orders\/([^/]+)\/(ship|deliver|place|retailer-canceled|refund|problem)$/.exec(path))) {
        const [, orderId, action] = m;
        to = action === 'ship' || action === 'deliver' || action === 'place' ? '/admin' : `/admin/orders/${orderId}`;
        if (action === 'ship') result = store.markShipped(orderId, body);
        if (action === 'deliver') result = store.markDelivered(orderId);
        if (action === 'place') result = store.markPlaced(orderId, body);
        if (action === 'retailer-canceled') result = store.markRetailerCanceled(orderId);
        if (action === 'refund') result = await store.refundOrder(orderId, { amount_cents: body.amount_cents ?? cents(body.amount), reason: body.reason });
        if (action === 'problem') result = store.markProblem(orderId, body);
      } else if ((m = /^\/admin\/cases\/([^/]+)\/resolve$/.exec(path))) {
        result = await store.resolveCase(m[1], { action: body.action, amount_cents: body.amount_cents ?? cents(body.amount), note: body.note });
        to = `/admin/orders/${result.order_id}`;
      } else if ((m = /^\/admin\/accounts\/([^/]+)\/release$/.exec(path))) {
        result = store.releaseHold(m[1]);
      } else {
        return false;
      }
      if (json) { send(res, 200, result); return true; }
      return redirect(to);
    }
    return false;
  }
  return false;
}
