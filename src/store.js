// Core service layer. Both the HTTP API and the MCP server call into this, so
// behavior (pricing, spend policy, billing, fulfillment) is identical across
// surfaces.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { PRODUCTS, CATEGORIES, presentProduct, baseUnitsPerPack, monthlyUsage } from './catalog.js';
import { ApiError, badRequest, notFound, unauthorized, forbidden, conflict } from './errors.js';
import { MockPayments, addBusinessDays, BANK_CLEARING_BUSINESS_DAYS } from './payments.js';
import { OutboxMailer } from './email.js';

export const PRICING = {
  subscription_discount_pct: 5,
  // Bank debits cost us far less than cards, so bank payers get some of that back.
  bank_discount_pct: 2,
  free_shipping_threshold_cents: 3500,
  shipping_cents: 599,
  tax_rate_pct: 8,
};

/** Order-problem rules (operations/when-orders-go-wrong.md). Override per store with the `support` option. */
export const SUPPORT_DEFAULTS = {
  email: 'support@domaru.app',
  from: 'Domaru <support@domaru.app>',
  // Refund or resend without asking for proof up to this much per problem.
  no_questions_refund_cents: 4000,
  // More than this many never-arrived / damaged / missing claims in the window means proof first.
  claim_limit: 2,
  claim_window_days: 90,
};

/** Bump when the terms text changes; owners accept a specific version. */
export const TERMS_VERSION = '2026-10-18-draft';

export const DEFAULT_POLICY = {
  approval_required_above_cents: 10000,
  per_order_limit_cents: 15000,
  monthly_limit_cents: 40000,
  allowed_categories: null,
};

// A reasonable starter bundle: one product per everyday need.
const STARTER_SKUS = [
  'TP-2PLY-30', 'PT-2PLY-12', 'DISH-LIQ-90', 'DW-PODS-115', 'TRASH-13G-90',
  'LAUN-LIQ-115', 'HSOAP-REFILL-56', 'WIPES-225', 'SPONGE-8', 'TPASTE-6',
];

const MAX_ADVANCE_DAYS = 400;

const id = (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const j = (v) => JSON.stringify(v);
const p = (s) => (s == null ? null : JSON.parse(s));
const dateOf = (iso) => iso.slice(0, 10);
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const pct = (amount, rate) => Math.round((amount * rate) / 100);
const refundedCents = (o) => p(o.refunds_json ?? '[]').filter((r) => r.status === 'succeeded').reduce((s, r) => s + r.amount_cents, 0);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const okRedirect = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname));
  } catch {
    return false;
  }
};
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const BANK_OFFER = `Switch to bank payments and save ${PRICING.bank_discount_pct}% on every delivery.`;

export class Store {
  /**
   * @param {object} opts
   * @param {string} [opts.dbPath]
   * @param {import('./payments.js').MockPayments | import('./payments.js').StripePayments} [opts.payments]
   * @param {'mock' | 'manual'} [opts.fulfillment] mock ships itself on the account clock; manual waits for an operator
   * @param {'test' | 'live'} [opts.mode] live accounts run on the real clock and cannot advance it
   */
  constructor({ dbPath = ':memory:', payments = new MockPayments(), fulfillment = 'mock', mode = 'test', mailer = new OutboxMailer(), support = {}, publicUrl = 'http://localhost:8787' } = {}) {
    if (!['mock', 'manual'].includes(fulfillment)) throw new Error(`Unknown fulfillment mode '${fulfillment}'.`);
    if (!['test', 'live'].includes(mode)) throw new Error(`Unknown mode '${mode}'.`);
    this.db = openDb(dbPath);
    this.products = new Map(PRODUCTS.map((x) => [x.sku, x]));
    this.payments = payments;
    this.fulfillment = fulfillment;
    this.mode = mode;
    this.mailer = mailer;
    this.support = { ...SUPPORT_DEFAULTS, ...support };
    this.publicUrl = publicUrl.replace(/\/$/, '');
  }

  // ---------------------------------------------------------------- catalog

  listCategories() {
    return CATEGORIES.map((c) => ({ ...c, product_count: PRODUCTS.filter((x) => x.category === c.id).length }));
  }

  listProducts({ category, q, tag } = {}) {
    if (category && !CATEGORIES.some((c) => c.id === category)) {
      throw badRequest('unknown_category', `Unknown category '${category}'.`, {
        param: 'category', hint: `Use one of: ${CATEGORIES.map((c) => c.id).join(', ')}.`,
      });
    }
    const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
    return PRODUCTS.filter((x) => !category || x.category === category)
      .filter((x) => !tag || x.tags.includes(tag))
      .filter((x) => {
        const hay = `${x.name} ${x.sku} ${x.category} ${x.tags.join(' ')}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .map(presentProduct);
  }

  getProduct(sku) {
    const prod = this.products.get(sku);
    if (!prod) throw this.#unknownSku(sku);
    return presentProduct(prod);
  }

  #unknownSku(sku) {
    const q = String(sku).toLowerCase().split(/[^a-z0-9]+/)[0] || '';
    const near = PRODUCTS.filter((x) => q && (x.sku.toLowerCase().includes(q) || x.name.toLowerCase().includes(q))).map((x) => x.sku);
    return notFound('product', sku, near.length
      ? `Did you mean ${near.slice(0, 3).join(', ')}?`
      : 'Search the catalog with GET /v1/products?q=... (or the search_products tool) to find a valid SKU.');
  }

  // -------------------------------------------------------------- accounts

  /**
   * Sign-up. The agent gets its api_key; the owner key never goes to the caller.
   * Instead the owner is emailed a one-time link to claim the account, where they
   * accept the terms, approve orders and set limits. Limits start at the defaults.
   */
  createAccount({ name, email, household_size = 2, policy, start_date } = {}) {
    if (!name || typeof name !== 'string') throw badRequest('missing_param', 'name is required.', { param: 'name', hint: 'Pass a display name for the household, e.g. "Rafiq household".' });
    if (!isEmail(email)) throw badRequest('missing_param', "email is required: the account owner's email address.", { param: 'email', hint: 'Domaru emails the owner a link to claim the account, approve orders and set limits.' });
    if (policy !== undefined) {
      throw forbidden('Spending limits start at the defaults and only the owner can change them.', 'Create the account without policy. The owner sets limits after claiming the account from the email Domaru sends them.');
    }
    if (!Number.isInteger(household_size) || household_size < 1 || household_size > 20) {
      throw badRequest('invalid_param', 'household_size must be an integer from 1 to 20.', { param: 'household_size' });
    }
    if (start_date != null && (this.mode === 'live' || !isDate(start_date))) throw badRequest('invalid_param', 'start_date must be YYYY-MM-DD, and is only allowed in test mode.', { param: 'start_date' });
    const accountId = id('acct');
    const apiKey = `ck_${this.mode}_${randomBytes(18).toString('base64url')}`;
    // Placeholder until the owner claims the account; nobody holds a key that matches it.
    const unclaimed = hash(`unclaimed:${randomBytes(24).toString('hex')}`);
    const now = start_date ? `${start_date}T12:00:00.000Z` : new Date().toISOString();
    this.db.prepare(`INSERT INTO accounts (id, name, email, mode, api_key_hash, owner_key_hash, household_size, policy_json, clock, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(accountId, name, email, this.mode, hash(apiKey), unclaimed, household_size, j({ ...DEFAULT_POLICY }), now, now);
    this.#emit(accountId, 'account.created', { account_id: accountId });
    this.#sendOwnerInvite(this.#account(accountId));
    return {
      account: this.getAccount(accountId),
      api_key: apiKey,
      owner: { email, invite_sent: true },
      note: `api_key is for you, the agent, and is not shown again. We emailed ${email} a link to claim the account: the owner approves held orders and sets spending limits there. Until then the default limits apply.`,
    };
  }

  #sendOwnerInvite(a) {
    this.#mail(a, 'owner_invite', a.email, `Your Domaru account for ${a.name}`, [
      'Your assistant set up a Domaru account to keep your household stocked with everyday supplies.',
      'You are the owner. Sign in to review the terms, approve orders your assistant sends for approval, and set spending limits:',
      this.#loginLink(a.email, '/owner'),
      `Until you do, your assistant can only spend within our default limits: approval needed above ${usd(DEFAULT_POLICY.approval_required_above_cents)}, at most ${usd(DEFAULT_POLICY.monthly_limit_cents)} a month.`,
      "If you didn't expect this, ignore this email and nothing will be charged.",
    ]);
  }

  /** Re-send the owner's sign-in link to the email on file. */
  resendOwnerInvite(auth) {
    const a = this.#account(auth.accountId);
    this.#sendOwnerInvite(a);
    return { sent_to: a.email, next_step: 'Ask the owner to open the newest Domaru email.' };
  }

  // ------------------------------------------- owner sign-in (emailed link)

  #loginLink(email, next) {
    const token = `ln_${randomBytes(24).toString('base64url')}`;
    const expires = new Date(Date.now() + 30 * 60_000).toISOString();
    this.db.prepare('INSERT INTO logins (token_hash, email, next, expires_at) VALUES (?, ?, ?, ?)').run(hash(token), email.toLowerCase(), next ?? '/owner', expires);
    return `${this.publicUrl}/auth/verify?t=${token}`;
  }

  /** Email a one-time sign-in link. Households never have a password or key. */
  startSignIn(email, { next = '/owner' } = {}) {
    if (!isEmail(email)) throw badRequest('invalid_param', 'Enter a valid email address.', { param: 'email' });
    if (!String(next).startsWith('/') || String(next).startsWith('//')) next = '/owner';
    const link = this.#loginLink(email, next);
    this.#mail(null, 'sign_in', email, 'Your Domaru sign-in link', [
      'Tap to sign in to Domaru. The link works once, for 30 minutes:', link, '',
      "If you didn't ask for this, ignore this email.",
    ]);
    return { sent: true };
  }

  /**
   * The emailed link was opened. The email is the owner: sign in to their
   * household, or start one. Returns a browser session token and where to go next.
   */
  finishSignIn(token) {
    const row = token ? this.db.prepare('SELECT * FROM logins WHERE token_hash = ?').get(hash(String(token))) : null;
    if (!row || row.used_at || row.expires_at < new Date().toISOString()) {
      throw badRequest('link_expired', 'This sign-in link has expired or was already used.', { hint: 'Ask for a new one.' });
    }
    this.db.prepare('UPDATE logins SET used_at = ? WHERE token_hash = ?').run(new Date().toISOString(), row.token_hash);
    let a = this.db.prepare('SELECT * FROM accounts WHERE lower(email) = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(row.email);
    if (!a) {
      const accountId = id('acct');
      const now = new Date().toISOString();
      const placeholder = () => hash(`none:${randomBytes(24).toString('hex')}`);
      this.db.prepare(`INSERT INTO accounts (id, name, email, mode, api_key_hash, owner_key_hash, household_size, policy_json, clock, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?)`).run(accountId, 'My household', row.email, this.mode, placeholder(), placeholder(), j({ ...DEFAULT_POLICY }), now, now);
      this.#emit(accountId, 'account.created', { account_id: accountId, via: 'sign_in' });
      a = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    }
    if (!a.owner_claimed_at) this.db.prepare('UPDATE accounts SET owner_claimed_at = ? WHERE id = ?').run(new Date().toISOString(), a.id);
    const session = `os_${randomBytes(24).toString('base64url')}`;
    this.db.prepare("INSERT INTO sessions (token_hash, account_id, kind, created_at, expires_at) VALUES (?, ?, 'owner', ?, ?)")
      .run(hash(session), a.id, new Date().toISOString(), new Date(Date.now() + 30 * 86_400_000).toISOString());
    return { account_id: a.id, session, next: row.next };
  }

  /** Owner browser session -> owner auth, or null. */
  ownerSession(session) {
    if (!session) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND kind = 'owner'").get(hash(String(session)));
    if (!row || row.expires_at < new Date().toISOString()) return null;
    return { accountId: row.account_id, role: 'owner' };
  }

  /** Operator sessions for the admin page (cookie), separate from household sessions. */
  createAdminSession() {
    const token = `as_${randomBytes(24).toString('base64url')}`;
    this.db.prepare("INSERT INTO sessions (token_hash, account_id, kind, created_at, expires_at) VALUES (?, '-', 'admin', ?, ?)")
      .run(hash(token), new Date().toISOString(), new Date(Date.now() + 12 * 3600_000).toISOString());
    return token;
  }

  isAdminSession(token) {
    if (!token) return false;
    const row = this.db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ? AND kind = 'admin'").get(hash(String(token)));
    return !!row && row.expires_at > new Date().toISOString();
  }

  endSession(session) {
    if (session) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(String(session)));
  }

  /** The owner accepts the terms, including automatic renewal. Recorded with the version. */
  acceptTerms(auth) {
    if (auth.role !== 'owner') throw forbidden('Only the account owner can accept the terms.');
    const a = this.#account(auth.accountId);
    this.db.prepare('UPDATE accounts SET terms_version = ?, terms_accepted_at = ? WHERE id = ?').run(TERMS_VERSION, new Date().toISOString(), a.id);
    this.#emit(a.id, 'account.terms_accepted', { terms_version: TERMS_VERSION });
    return this.getAccount(a.id);
  }

  /** Developers only: a raw owner key for scripting. Households never need one. */
  createOwnerKey(auth) {
    if (auth.role !== 'owner') throw forbidden('Only the account owner can create an owner key.');
    const a = this.#account(auth.accountId);
    const key = `ok_${a.mode}_${randomBytes(18).toString('base64url')}`;
    this.db.prepare('UPDATE accounts SET owner_key_hash = ? WHERE id = ?').run(hash(key), a.id);
    return { owner_key: key, note: 'Shown once. Creating a new one replaces it.' };
  }

  // ------------------------------------------ Connect Domaru (OAuth for assistants)

  /** RFC 7591 dynamic registration: assistants register themselves once. */
  registerClient({ client_name, redirect_uris } = {}) {
    if (!Array.isArray(redirect_uris) || !redirect_uris.length || redirect_uris.some((u) => !okRedirect(u))) {
      throw badRequest('invalid_redirect_uri', 'redirect_uris must be https URLs (or http://localhost for development).', { param: 'redirect_uris' });
    }
    const clientId = `cl_${randomBytes(12).toString('base64url')}`;
    const name = String(client_name ?? 'An assistant').slice(0, 80);
    this.db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)').run(clientId, name, j(redirect_uris), new Date().toISOString());
    return { client_id: clientId, client_name: name, redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  }

  oauthClient(clientId, redirectUri) {
    const c = clientId ? this.db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(clientId) : null;
    if (!c) throw badRequest('invalid_client', 'Unknown client.');
    if (redirectUri !== undefined && !p(c.redirect_uris_json).includes(redirectUri)) throw badRequest('invalid_redirect_uri', 'redirect_uri is not registered for this client.');
    return { id: c.id, name: c.name };
  }

  /** What the Connect page still needs before the owner can tap Allow. */
  connectChecklist(auth) {
    const a = this.#account(auth.accountId);
    const addr = this.db.prepare('SELECT 1 FROM addresses WHERE account_id = ? AND confirmed = 1 LIMIT 1').get(a.id);
    return {
      terms: a.terms_version === TERMS_VERSION,
      address: !!addr,
      payment_method: !!a.default_payment_method_id,
      ready: a.terms_version === TERMS_VERSION && !!addr && !!a.default_payment_method_id,
    };
  }

  /** The owner tapped Allow. Returns a one-time code for the assistant's redirect. */
  createAuthCode(auth, { client_id, redirect_uri, code_challenge, code_challenge_method }) {
    if (auth.role !== 'owner') throw forbidden('Only the account owner can connect an assistant.');
    this.oauthClient(client_id, redirect_uri);
    if (code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge ?? '')) throw badRequest('invalid_request', 'PKCE with S256 is required.');
    if (!this.connectChecklist(auth).ready) throw conflict('setup_incomplete', 'Finish setting up the household first.');
    const code = `co_${randomBytes(24).toString('base64url')}`;
    this.db.prepare('INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(code), client_id, auth.accountId, redirect_uri, code_challenge, new Date(Date.now() + 10 * 60_000).toISOString());
    return code;
  }

  #issueTokens(accountId, client, grantId) {
    const access = `dat_${randomBytes(24).toString('base64url')}`;
    const refresh = `drt_${randomBytes(24).toString('base64url')}`;
    const expires = new Date(Date.now() + 3600_000).toISOString();
    if (grantId) {
      this.db.prepare('UPDATE grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ? WHERE id = ?').run(hash(access), expires, hash(refresh), grantId);
    } else {
      this.db.prepare('INSERT INTO grants (id, account_id, client_id, client_name, access_hash, access_expires_at, refresh_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id('grant'), accountId, client.id, client.name, hash(access), expires, hash(refresh), new Date().toISOString());
      this.#emit(accountId, 'assistant.connected', { client_name: client.name });
    }
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'shop' };
  }

  /** Token endpoint: authorization_code (with PKCE) or refresh_token. */
  oauthToken({ grant_type, code, code_verifier, client_id, redirect_uri, refresh_token } = {}) {
    const fail = (error, description) => Object.assign(new ApiError(400, error, description), { oauth: { error, error_description: description } });
    if (grant_type === 'authorization_code') {
      const row = code ? this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash(String(code))) : null;
      if (!row || row.used_at || row.expires_at < new Date().toISOString() || row.client_id !== client_id || row.redirect_uri !== redirect_uri) throw fail('invalid_grant', 'The code is invalid or expired.');
      const challenge = createHash('sha256').update(String(code_verifier ?? '')).digest('base64url');
      this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(new Date().toISOString(), row.code_hash);
      if (!safeEqual(challenge, row.code_challenge)) throw fail('invalid_grant', 'PKCE verification failed.');
      return this.#issueTokens(row.account_id, this.oauthClient(client_id));
    }
    if (grant_type === 'refresh_token') {
      const g = refresh_token ? this.db.prepare('SELECT * FROM grants WHERE refresh_hash = ?').get(hash(String(refresh_token))) : null;
      if (!g || g.revoked_at || g.client_id !== client_id) throw fail('invalid_grant', 'The refresh token is invalid or was revoked.');
      return this.#issueTokens(g.account_id, null, g.id);
    }
    throw fail('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  listGrants(auth) {
    return this.db.prepare('SELECT * FROM grants WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at').all(auth.accountId)
      .map((g) => ({ id: g.id, client_name: g.client_name, connected_at: g.created_at, last_used_at: g.last_used_at }));
  }

  revokeGrant(auth, grantId) {
    if (auth.role !== 'owner') throw forbidden('Only the account owner can disconnect an assistant.');
    const g = this.db.prepare('SELECT * FROM grants WHERE id = ? AND account_id = ?').get(grantId, auth.accountId);
    if (!g) throw notFound('grant', grantId);
    this.db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), g.id);
    this.#emit(auth.accountId, 'assistant.disconnected', { client_name: g.client_name });
    return { revoked: true };
  }

  /** Resolve a bearer key to { account, role } where role is 'agent' or 'owner'. */
  authenticate(key) {
    if (!key) throw unauthorized('Missing credentials.', 'Connect Domaru from your assistant, or send "Authorization: Bearer ck_test_..." (developers: POST /v1/accounts).');
    const h = hash(key);
    const agent = this.db.prepare('SELECT id FROM accounts WHERE api_key_hash = ?').get(h);
    if (agent) return { accountId: agent.id, role: 'agent' };
    const owner = this.db.prepare('SELECT id FROM accounts WHERE owner_key_hash = ?').get(h);
    if (owner) return { accountId: owner.id, role: 'owner' };
    // Connected assistants: shop within limits, never approve or change limits.
    const g = this.db.prepare('SELECT * FROM grants WHERE access_hash = ? AND revoked_at IS NULL').get(h);
    if (g && g.access_expires_at > new Date().toISOString()) {
      this.db.prepare('UPDATE grants SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), g.id);
      return { accountId: g.account_id, role: 'agent', grantId: g.id };
    }
    throw unauthorized('Invalid or expired key.', 'Reconnect Domaru in your assistant, or check the developer key.');
  }

  #account(accountId) {
    const a = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!a) throw notFound('account', accountId);
    if (a.mode === 'live') a.clock = new Date().toISOString();
    return a;
  }

  getAccount(accountId) {
    const a = this.#account(accountId);
    const today = dateOf(a.clock);
    return {
      id: a.id,
      name: a.name,
      email: a.email,
      mode: a.mode,
      household_size: a.household_size,
      policy: p(a.policy_json),
      spend: { month: today.slice(0, 7), spent_cents: this.#monthSpend(a.id, today) },
      clock: a.clock,
      today,
      payments: this.payments.name,
      fulfillment: this.fulfillment,
      default_payment_method_id: a.default_payment_method_id,
      default_address_id: a.default_address_id,
      owner: { email: a.email, claimed: !!a.owner_claimed_at, terms_version: a.terms_version, terms_current: a.terms_version === TERMS_VERSION },
      on_hold: a.hold_reason ? { reason: a.hold_reason, next_step: `Orders are paused. The owner should contact ${this.support.email}.` } : null,
      support: { email: this.support.email },
      bank_payments: this.#bankStatus(a),
      created_at: a.created_at,
    };
  }

  /** Bank payments open up once the first delivery has arrived. */
  #bankStatus(a) {
    const eligible = !!this.db.prepare("SELECT 1 FROM shipments WHERE account_id = ? AND status = 'delivered' LIMIT 1").get(a.id);
    const pm = a.default_payment_method_id ? this.db.prepare('SELECT type FROM payment_methods WHERE id = ?').get(a.default_payment_method_id) : null;
    const usingBank = pm?.type === 'bank';
    const offer = eligible && !usingBank;
    return {
      eligible,
      using_bank: usingBank,
      discount_pct: PRICING.bank_discount_pct,
      offer: offer ? BANK_OFFER : null,
      next_step: offer
        ? 'Call create_bank_setup_link (POST /v1/payment_methods/bank_setup_link) and send the url to the owner. They sign in to their bank; it becomes the default and their subscriptions switch to it.'
        : eligible ? null : 'Available after the first delivery arrives.',
    };
  }

  updateAccount(auth, { household_size, name, email }) {
    const a = this.#account(auth.accountId);
    if (household_size != null && (!Number.isInteger(household_size) || household_size < 1 || household_size > 20)) {
      throw badRequest('invalid_param', 'household_size must be an integer from 1 to 20.', { param: 'household_size' });
    }
    if (email != null && email !== a.email) {
      // Approval requests go to this address, so only the owner may move it.
      if (auth.role !== 'owner') throw forbidden("Only the account owner can change the owner's email.", 'Ask the owner to change it on their Domaru owner page.');
      if (!isEmail(email)) throw badRequest('invalid_param', 'email must be an email address.', { param: 'email' });
      this.#mail(a, 'email_changed', a.email, 'Your Domaru email was changed', [
        `The owner email for ${a.name} was changed to ${email}. Approval requests and receipts now go there.`,
        `If you didn't do this, reply to this email or write to ${this.support.email} right away.`,
      ]);
    }
    this.db.prepare('UPDATE accounts SET household_size = ?, name = ?, email = ? WHERE id = ?')
      .run(household_size ?? a.household_size, name ?? a.name, email ?? a.email, a.id);
    return this.getAccount(a.id);
  }

  updatePolicy(auth, patch) {
    if (auth.role !== 'owner') {
      throw forbidden('Only the account owner can change spend policy.', 'Ask the human to change it with their owner_key. Agents cannot raise their own limits.');
    }
    const a = this.#account(auth.accountId);
    const merged = this.#validatePolicy({ ...p(a.policy_json), ...patch });
    this.db.prepare('UPDATE accounts SET policy_json = ? WHERE id = ?').run(j(merged), a.id);
    this.#emit(a.id, 'policy.updated', { policy: merged });
    return this.getAccount(a.id);
  }

  #validatePolicy(policy) {
    const out = {};
    for (const k of ['approval_required_above_cents', 'per_order_limit_cents', 'monthly_limit_cents']) {
      const v = policy[k];
      if (v !== null && (!Number.isInteger(v) || v < 0)) throw badRequest('invalid_param', `${k} must be a non-negative integer (cents) or null.`, { param: k });
      out[k] = v;
    }
    const cats = policy.allowed_categories;
    if (cats != null) {
      if (!Array.isArray(cats) || cats.some((c) => !CATEGORIES.some((x) => x.id === c))) {
        throw badRequest('invalid_param', 'allowed_categories must be null or a list of category ids.', { param: 'allowed_categories', hint: `Valid ids: ${CATEGORIES.map((c) => c.id).join(', ')}.` });
      }
    }
    out.allowed_categories = cats ?? null;
    return out;
  }

  // ---------------------------------------------------- payment & address

  async #customer(a) {
    if (a.provider_customer_id || this.payments.name === 'mock') return a.provider_customer_id;
    const ref = await this.payments.ensureCustomer({ accountId: a.id, name: a.name, email: a.email });
    this.db.prepare('UPDATE accounts SET provider_customer_id = ? WHERE id = ?').run(ref, a.id);
    return ref;
  }

  #savePm(a, card, setDefault) {
    const existing = this.db.prepare('SELECT * FROM payment_methods WHERE account_id = ? AND token = ?').get(a.id, card.ref);
    const pmId = existing?.id ?? id('pm');
    if (!existing) {
      const type = card.type ?? 'card';
      this.db.prepare('INSERT INTO payment_methods (id, account_id, token, type, brand, last4, mandate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(pmId, a.id, card.ref, type, card.brand, card.last4, card.mandate ?? null, a.clock);
      this.#emit(a.id, 'payment_method.added', { payment_method_id: pmId, type, brand: card.brand, last4: card.last4 });
    }
    if (setDefault || !a.default_payment_method_id) this.db.prepare('UPDATE accounts SET default_payment_method_id = ? WHERE id = ?').run(pmId, a.id);
    // Switching to bank is a household decision: their running subscriptions move with it.
    if (setDefault && (card.type ?? 'card') === 'bank') {
      for (const sub of this.db.prepare("SELECT id FROM subscriptions WHERE account_id = ? AND status IN ('active', 'paused') AND payment_method_id != ?").all(a.id, pmId)) {
        this.#touch(a, sub.id, { payment_method_id: pmId });
        this.#emit(a.id, 'subscription.updated', { subscription_id: sub.id, fields: ['payment_method_id'] });
      }
    }
    return this.#presentPm(this.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(pmId));
  }

  #requireBankEligible(a) {
    if (!this.#bankStatus(a).eligible) {
      throw conflict('bank_payments_not_available_yet', 'Bank payments open up after the first delivery arrives.', { hint: 'Pay by card for now; get_account shows bank_payments.offer once it is available.' });
    }
  }

  /** Attach a card or bank account from a test token (pm_card_visa, pm_usBankAccount_success, ...). */
  async addPaymentMethod(auth, { token, set_default = true } = {}) {
    if (!token || typeof token !== 'string') throw badRequest('missing_param', 'token is required.', { param: 'token', hint: 'In test mode use pm_card_visa.' });
    const a = this.#account(auth.accountId);
    if (token.startsWith('pm_usBankAccount')) this.#requireBankEligible(a);
    const card = await this.payments.attachToken(await this.#customer(a), token);
    return this.#savePm(a, card, set_default);
  }

  /** A secure page where the human saves a card. Send the URL to the account owner. */
  async createCardSetupLink(auth) {
    if (!this.payments.supportsSetupLinks) {
      throw badRequest('setup_links_unavailable', 'Card setup links need the Stripe payment provider.', { hint: 'In the sandbox, call add_payment_method with token pm_card_visa instead.' });
    }
    const a = this.#account(auth.accountId);
    const link = await this.payments.createSetupLink({ customerRef: await this.#customer(a), accountId: a.id });
    return { url: link.url, expires_at: link.expires_at, next_step: 'Send this link to the account owner. Once they save a card it becomes the default payment method; check with list_payment_methods.' };
  }

  /** A secure page where the human signs in to their bank to pay by bank. Send the URL to the account owner. */
  async createBankSetupLink(auth) {
    const a = this.#account(auth.accountId);
    this.#requireBankEligible(a);
    if (!this.payments.supportsSetupLinks) {
      throw badRequest('setup_links_unavailable', 'Bank setup links need the Stripe payment provider.', { hint: 'In the sandbox, call add_payment_method with token pm_usBankAccount_success instead.' });
    }
    const link = await this.payments.createSetupLink({ customerRef: await this.#customer(a), accountId: a.id, type: 'bank' });
    return {
      url: link.url, expires_at: link.expires_at, offer: BANK_OFFER,
      next_step: 'Send this link to the account owner. They sign in to their bank on a Stripe page; the account becomes the default and their subscriptions switch to it. Bank payments are charged a few business days before each delivery ships.',
    };
  }

  /** Called when the human returns from the setup page. */
  async completeCardSetup(sessionId) {
    const done = await this.payments.completeSetup(sessionId);
    if (!done) throw badRequest('setup_incomplete', 'This card setup has not been completed.', { hint: 'Open the setup link again and finish saving the card.' });
    const a = this.db.prepare('SELECT * FROM accounts WHERE id = ? AND provider_customer_id = ?').get(done.accountId, done.customerRef);
    if (!a) throw notFound('account', done.accountId);
    return { account_id: a.id, payment_method: this.#savePm(this.#account(a.id), done.card, true) };
  }

  listPaymentMethods(auth) {
    return this.db.prepare('SELECT * FROM payment_methods WHERE account_id = ? ORDER BY created_at, rowid').all(auth.accountId).map((x) => this.#presentPm(x));
  }

  #presentPm(x) {
    return { id: x.id, type: x.type, brand: x.brand, last4: x.last4, created_at: x.created_at };
  }

  #pm(accountId, pmId) {
    const x = this.db.prepare('SELECT * FROM payment_methods WHERE id = ? AND account_id = ?').get(pmId, accountId);
    if (!x) throw notFound('payment_method', pmId, 'List payment methods with GET /v1/payment_methods.');
    return x;
  }

  addAddress(auth, { name, line1, line2, city, region, postal_code, phone, country = 'US', set_default = true } = {}) {
    for (const [k, v] of Object.entries({ name, line1, city, region, postal_code })) {
      if (!v || typeof v !== 'string') throw badRequest('missing_param', `${k} is required.`, { param: k });
    }
    if (country !== 'US') throw badRequest('unsupported_country', 'Only US addresses are supported right now.', { param: 'country' });
    const a = this.#account(auth.accountId);
    const addrId = id('addr');
    const body = { name, line1, line2: line2 ?? null, city, region, postal_code, phone: phone ?? null, country };
    // An agent-added address is unconfirmed: the first order to it waits for the owner.
    const confirmed = auth.role === 'owner' ? 1 : 0;
    this.db.prepare('INSERT INTO addresses (id, account_id, json, confirmed, created_at) VALUES (?, ?, ?, ?, ?)').run(addrId, a.id, j(body), confirmed, a.clock);
    if (set_default || !a.default_address_id) this.db.prepare('UPDATE accounts SET default_address_id = ? WHERE id = ?').run(addrId, a.id);
    this.#emit(a.id, 'address.added', { address_id: addrId, confirmed: !!confirmed });
    return this.#presentAddress(this.db.prepare('SELECT * FROM addresses WHERE id = ?').get(addrId));
  }

  listAddresses(auth) {
    return this.db.prepare('SELECT * FROM addresses WHERE account_id = ? ORDER BY created_at, rowid').all(auth.accountId).map((x) => this.#presentAddress(x));
  }

  #presentAddress(x) {
    return {
      id: x.id, ...p(x.json), confirmed: !!x.confirmed,
      ...(x.confirmed ? {} : { note: 'The first order to this address waits for the owner to approve it.' }),
    };
  }

  confirmAddress(auth, addrId) {
    if (auth.role !== 'owner') throw forbidden('Only the account owner can confirm an address.', 'The first order to a new address goes to the owner for approval instead.');
    this.#address(auth.accountId, addrId);
    this.db.prepare('UPDATE addresses SET confirmed = 1 WHERE id = ?').run(addrId);
    return this.#presentAddress(this.db.prepare('SELECT * FROM addresses WHERE id = ?').get(addrId));
  }

  #address(accountId, addrId) {
    const x = this.db.prepare('SELECT * FROM addresses WHERE id = ? AND account_id = ?').get(addrId, accountId);
    if (!x) throw notFound('address', addrId, 'List addresses with GET /v1/addresses.');
    return x;
  }

  // ------------------------------------------------------------- pricing

  #normalizeItems(items, param = 'items') {
    if (!Array.isArray(items) || items.length === 0) {
      throw badRequest('missing_param', `${param} must be a non-empty list of { sku, quantity }.`, { param, hint: 'Example: [{"sku":"TP-2PLY-30","quantity":1}]' });
    }
    const merged = new Map();
    for (const [i, it] of items.entries()) {
      if (!it || typeof it.sku !== 'string') throw badRequest('invalid_param', `${param}[${i}].sku is required.`, { param: `${param}[${i}].sku` });
      if (!this.products.has(it.sku)) throw this.#unknownSku(it.sku);
      const qty = it.quantity ?? 1;
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw badRequest('invalid_param', `${param}[${i}].quantity must be an integer from 1 to 50.`, { param: `${param}[${i}].quantity` });
      merged.set(it.sku, (merged.get(it.sku) ?? 0) + qty);
    }
    return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
  }

  price(items, { subscription = false, bank = false } = {}) {
    const lines = items.map(({ sku, quantity }) => {
      const prod = this.products.get(sku);
      return { sku, name: prod.name, category: prod.category, quantity, unit_price_cents: prod.price_cents, line_total_cents: prod.price_cents * quantity };
    });
    const subtotal = lines.reduce((s, l) => s + l.line_total_cents, 0);
    const discount = subscription ? pct(subtotal, PRICING.subscription_discount_pct) : 0;
    const bankDiscount = bank ? pct(subtotal, PRICING.bank_discount_pct) : 0;
    // Free shipping is judged before the bank discount, so switching to bank never adds shipping.
    const shipping = subtotal - discount >= PRICING.free_shipping_threshold_cents ? 0 : PRICING.shipping_cents;
    const afterDiscount = subtotal - discount - bankDiscount;
    const tax = pct(afterDiscount, PRICING.tax_rate_pct);
    return {
      lines,
      amounts: {
        subtotal_cents: subtotal, discount_cents: discount, bank_discount_cents: bankDiscount, shipping_cents: shipping, tax_cents: tax,
        total_cents: afterDiscount + shipping + tax, currency: 'usd',
      },
    };
  }

  #monthSpend(accountId, today) {
    const month = today.slice(0, 7);
    // 'pending' counts too: an order mid-charge has already claimed its share of the limit.
    const rows = this.db.prepare("SELECT amounts_json, refunds_json FROM orders WHERE account_id = ? AND status IN ('pending', 'paid', 'payment_pending') AND substr(created_at, 1, 7) = ?").all(accountId, month);
    return rows.reduce((s, r) => s + p(r.amounts_json).total_cents - refundedCents(r), 0);
  }

  #policyCheck(account, lines, total, addrId) {
    const policy = p(account.policy_json);
    const reasons = [];
    const addr = addrId ? this.db.prepare('SELECT confirmed FROM addresses WHERE id = ?').get(addrId) : null;
    if (addr && !addr.confirmed) {
      reasons.push({ code: 'new_address', message: 'This is the first order to a new delivery address.' });
    }
    if (policy.approval_required_above_cents != null && total > policy.approval_required_above_cents) {
      reasons.push({ code: 'above_approval_threshold', message: `${usd(total)} is over the ${usd(policy.approval_required_above_cents)} limit for orders without your OK.` });
    }
    if (policy.per_order_limit_cents != null && total > policy.per_order_limit_cents) {
      reasons.push({ code: 'per_order_limit', message: `${usd(total)} is over the ${usd(policy.per_order_limit_cents)} per-order limit.` });
    }
    const spent = this.#monthSpend(account.id, dateOf(account.clock));
    if (policy.monthly_limit_cents != null && spent + total > policy.monthly_limit_cents) {
      reasons.push({ code: 'monthly_limit', message: `It would bring this month's spending to ${usd(spent + total)}, over the ${usd(policy.monthly_limit_cents)} monthly limit.` });
    }
    if (policy.allowed_categories) {
      const bad = [...new Set(lines.map((l) => l.category).filter((c) => !policy.allowed_categories.includes(c)))];
      if (bad.length) reasons.push({ code: 'category_not_allowed', message: `${bad.map((c) => CATEGORIES.find((x) => x.id === c)?.name ?? c).join(' and ')} ${bad.length > 1 ? 'are' : 'is'} not on the list of allowed aisles.` });
    }
    return reasons;
  }

  quote(auth, { items, subscription = true, cadence_days, payment_method_id }) {
    const account = this.#account(auth.accountId);
    const norm = this.#normalizeItems(items);
    const pmId = payment_method_id ?? account.default_payment_method_id;
    const priced = this.price(norm, { subscription, bank: pmId ? this.#pm(account.id, pmId).type === 'bank' : false });
    const reasons = this.#policyCheck(account, priced.lines, priced.amounts.total_cents, account.default_address_id);
    const out = {
      ...priced,
      subscription,
      policy: { would_require_approval: reasons.length > 0, reasons },
      valid_until: addDays(dateOf(account.clock), 1),
    };
    if (subscription && cadence_days) {
      this.#validateCadence(cadence_days);
      out.cadence_days = cadence_days;
      out.estimated_monthly_cents = Math.round((priced.amounts.total_cents * 30) / cadence_days);
    }
    return out;
  }

  // ------------------------------------------------------ recommendations

  recommend(auth, { household_size, skus, cadence_days = 28 } = {}) {
    const account = auth ? this.#account(auth.accountId) : null;
    const people = household_size ?? account?.household_size ?? 2;
    if (!Number.isInteger(people) || people < 1 || people > 20) throw badRequest('invalid_param', 'household_size must be an integer from 1 to 20.', { param: 'household_size' });
    this.#validateCadence(cadence_days);
    const chosen = skus?.length ? skus : STARTER_SKUS;
    const items = chosen.map((sku) => {
      const prod = this.products.get(sku);
      if (!prod) throw this.#unknownSku(sku);
      const perDay = monthlyUsage(prod, people) / 30;
      const perPack = baseUnitsPerPack(prod);
      const quantity = Math.max(1, Math.round((perDay * cadence_days) / perPack));
      return {
        sku, name: prod.name, quantity,
        days_of_supply: perDay > 0 ? Math.round((quantity * perPack) / perDay) : null,
        estimated_monthly_usage: { amount: Math.round(monthlyUsage(prod, people) * 10) / 10, unit: prod.pack.base_unit ?? prod.pack.unit },
      };
    });
    const priced = this.price(items, { subscription: true });
    return {
      household_size: people,
      cadence_days,
      items: items.map(({ sku, quantity, name, days_of_supply, estimated_monthly_usage }) => ({ sku, name, quantity, days_of_supply, estimated_monthly_usage })),
      per_delivery: priced.amounts,
      estimated_monthly_cents: Math.round((priced.amounts.total_cents * 30) / cadence_days),
      next_step: 'Pass `items` and `cadence_days` to create_subscription (POST /v1/subscriptions). Some items last longer than the cadence; drop them or create a second subscription with a longer cadence.',
    };
  }

  // -------------------------------------------------------------- orders

  async createOrder(auth, { items, address_id, payment_method_id } = {}) {
    const account = this.#account(auth.accountId);
    const norm = this.#normalizeItems(items);
    const { addrId, pmId } = this.#resolveShipPay(account, address_id, payment_method_id);
    return this.#placeOrder(account, { items: norm, addrId, pmId, subscriptionId: null, fulfillOn: dateOf(account.clock) });
  }

  #resolveShipPay(account, addressId, pmId) {
    const addrId = addressId ?? account.default_address_id;
    const payId = pmId ?? account.default_payment_method_id;
    if (!addrId) throw badRequest('missing_address', 'No shipping address on file.', { hint: 'Add one with POST /v1/addresses (or the add_address tool), then retry.' });
    if (!payId) throw badRequest('missing_payment_method', 'No payment method on file.', { hint: 'Add one with POST /v1/payment_methods using token "pm_card_visa" in the sandbox, then retry.' });
    this.#address(account.id, addrId);
    this.#pm(account.id, payId);
    return { addrId, pmId: payId };
  }

  /** fulfillOn: the day the order may ship. Bank debits are charged ahead of it so they clear first. */
  async #placeOrder(account, { items, addrId, pmId, subscriptionId, fulfillOn }) {
    this.#requireNotOnHold(account);
    const priced = this.price(items, { subscription: !!subscriptionId, bank: this.#pm(account.id, pmId).type === 'bank' });
    const orderId = id('ord');
    const now = account.clock;
    // Check the limits and record the order in one synchronous step (no await in
    // between), so simultaneous orders each see the others' spend.
    const reasons = this.#policyCheck(account, priced.lines, priced.amounts.total_cents, addrId);
    this.db.prepare(`INSERT INTO orders (id, account_id, subscription_id, status, lines_json, amounts_json, address_id, payment_method_id, charges_json, fulfill_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`).run(orderId, account.id, subscriptionId, reasons.length ? 'requires_approval' : 'pending', j(priced.lines), j(priced.amounts), addrId, pmId, fulfillOn, now, now);
    if (reasons.length) {
      this.#requestApproval(account, orderId, reasons, priced);
      return this.getOrder({ accountId: account.id }, orderId);
    }
    await this.#chargeAndFulfill(account, orderId);
    return this.getOrder({ accountId: account.id }, orderId);
  }

  #requestApproval(account, orderId, reasons, priced) {
    const apprId = id('appr');
    const token = `at_${randomBytes(24).toString('base64url')}`;
    this.db.prepare(`INSERT INTO approvals (id, account_id, order_id, status, reasons_json, amount_cents, token_hash, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(apprId, account.id, orderId, j(reasons), priced.amounts.total_cents, hash(token), account.clock);
    this.db.prepare('UPDATE orders SET approval_id = ? WHERE id = ?').run(apprId, orderId);
    this.#emit(account.id, 'approval.requested', { approval_id: apprId, order_id: orderId, reasons });
    const addr = p(this.db.prepare('SELECT json FROM orders o JOIN addresses a ON a.id = o.address_id WHERE o.id = ?').get(orderId).json);
    this.#mail(account, 'approval_requested', account.email, `Approve ${usd(priced.amounts.total_cents)} for Domaru?`, [
      `Your assistant wants to order ${usd(priced.amounts.total_cents)} of supplies for ${account.name}. It needs your OK because:`,
      ...reasons.map((r) => `- ${r.message}`),
      '',
      ...priced.lines.map((l) => `${l.quantity} x ${l.name}  ${usd(l.line_total_cents)}`),
      `Ships to: ${[addr.name, addr.line1, addr.line2, `${addr.city}, ${addr.region} ${addr.postal_code}`].filter(Boolean).join(', ')}`,
      '',
      'Approve or decline (nothing is charged unless you approve):',
      `${this.publicUrl}/owner/approvals/${apprId}?t=${token}`,
    ]);
    return apprId;
  }

  #requireNotOnHold(account) {
    if (account.hold_reason) {
      throw conflict('account_on_hold', 'Orders on this account are paused.', { hint: `Ask the owner to contact ${this.support.email}.` });
    }
  }

  async #chargeAndFulfill(account, orderId) {
    this.db.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(orderId);
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const pm = this.#pm(account.id, order.payment_method_id);
    const amounts = p(order.amounts_json);
    const prior = p(order.charges_json);
    const result = await this.payments.charge({
      amountCents: amounts.total_cents, customerRef: this.#account(account.id).provider_customer_id, pmRef: pm.token, pmType: pm.type, mandate: pm.mandate,
      orderId, attempt: prior.length + 1,
    });
    const charge = {
      id: id('ch'), amount_cents: amounts.total_cents, payment_method_id: pm.id, created_at: account.clock,
      status: result.status, failure_code: result.failure_code, provider_ref: result.ref,
    };
    const charges = [...prior, charge];
    if (result.status === 'pending') {
      this.db.prepare("UPDATE orders SET status = 'payment_pending', charges_json = ?, updated_at = ? WHERE id = ?").run(j(charges), account.clock, orderId);
      this.#emit(account.id, 'order.payment_pending', { order_id: orderId, amount_cents: amounts.total_cents });
      return false;
    }
    return this.#settle(account, orderId, charges, result);
  }

  /** Record a charge's final outcome. A paid order ships once its ship date arrives. */
  #settle(account, orderId, charges, result) {
    if (result.status !== 'succeeded') {
      this.db.prepare("UPDATE orders SET status = 'payment_failed', charges_json = ?, updated_at = ? WHERE id = ?").run(j(charges), account.clock, orderId);
      this.#emit(account.id, 'order.payment_failed', { order_id: orderId, failure_code: result.failure_code });
      const a = this.#account(account.id);
      this.#mail(a, 'payment_failed', a.email, "Your Domaru payment didn't go through", [
        `We couldn't collect ${usd(charges.at(-1).amount_cents)} for order ${orderId} (${String(result.failure_code ?? 'declined').replace(/_/g, ' ')}).`,
        'Nothing has been bought or shipped. Your assistant can retry with another card or bank account, or you can ask it to.',
      ]);
      return false;
    }
    this.db.prepare("UPDATE orders SET status = 'paid', charges_json = ?, updated_at = ? WHERE id = ?").run(j(charges), account.clock, orderId);
    this.#emit(account.id, 'order.paid', { order_id: orderId, amount_cents: charges.at(-1).amount_cents });
    const o = this.db.prepare('SELECT fulfill_on FROM orders WHERE id = ?').get(orderId);
    if (!o.fulfill_on || o.fulfill_on <= dateOf(account.clock)) this.#ship(account, orderId);
    return true;
  }

  #ship(account, orderId) {
    const today = dateOf(account.clock);
    const shipId = id('shp');
    const mock = this.fulfillment === 'mock';
    this.db.prepare(`INSERT INTO shipments (id, order_id, account_id, status, carrier, tracking_number, created_at, estimated_delivery_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(shipId, orderId, account.id, mock ? 'processing' : 'awaiting_fulfillment',
      mock ? 'mock_ground' : '', mock ? `MOCK${randomBytes(6).toString('hex').toUpperCase()}` : '', account.clock, addDays(today, mock ? 3 : 5));
    this.#emit(account.id, 'shipment.created', { shipment_id: shipId, order_id: orderId });
  }

  /** After the first delivery arrives, offer the household a cheaper way to pay. */
  #afterDelivery(accountId) {
    const delivered = this.db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE account_id = ? AND status = 'delivered'").get(accountId).n;
    const status = this.#bankStatus(this.#account(accountId));
    if (delivered === 1 && status.offer) {
      this.#emit(accountId, 'payment.bank_offer', { discount_pct: PRICING.bank_discount_pct, message: BANK_OFFER, next_step: status.next_step });
    }
  }

  getOrder(auth, orderId) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(orderId, auth.accountId);
    if (!o) throw notFound('order', orderId, 'List orders with GET /v1/orders.');
    return this.#presentOrder(o);
  }

  listOrders(auth, { subscription_id, status, limit = 50 } = {}) {
    let sql = 'SELECT * FROM orders WHERE account_id = ?';
    const args = [auth.accountId];
    if (subscription_id) { sql += ' AND subscription_id = ?'; args.push(subscription_id); }
    if (status) { sql += ' AND status = ?'; args.push(status); }
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
    args.push(Math.min(Math.max(1, Number(limit) || 50), 200));
    return this.db.prepare(sql).all(...args).map((o) => this.#presentOrder(o));
  }

  #presentOrder(o) {
    const s = this.db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(o.id);
    const appr = o.approval_id ? this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(o.approval_id) : null;
    return {
      id: o.id,
      status: o.status,
      subscription_id: o.subscription_id,
      lines: p(o.lines_json),
      amounts: p(o.amounts_json),
      address_id: o.address_id,
      payment_method_id: o.payment_method_id,
      charges: p(o.charges_json),
      ship_date: o.fulfill_on,
      refunds: p(o.refunds_json ?? '[]'),
      refunded_cents: refundedCents(o),
      resend_of: o.resend_of ?? null,
      dispute: p(o.dispute_json ?? null),
      approval: appr ? this.#presentApproval(appr) : null,
      shipment: s ? {
        id: s.id, status: s.status, carrier: s.carrier || null, tracking_number: s.tracking_number || null,
        estimated_delivery_date: s.estimated_delivery_date, shipped_at: s.shipped_at, delivered_at: s.delivered_at,
      } : null,
      created_at: o.created_at,
      updated_at: o.updated_at,
    };
  }

  // ----------------------------------------------------------- approvals

  listApprovals(auth, { status = 'pending' } = {}) {
    const rows = status === 'all'
      ? this.db.prepare('SELECT * FROM approvals WHERE account_id = ? ORDER BY created_at DESC, rowid DESC').all(auth.accountId)
      : this.db.prepare('SELECT * FROM approvals WHERE account_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC').all(auth.accountId, status);
    return rows.map((a) => this.#presentApproval(a));
  }

  #presentApproval(a) {
    return {
      id: a.id, status: a.status, order_id: a.order_id, amount_cents: a.amount_cents,
      reasons: p(a.reasons_json), created_at: a.created_at, decided_at: a.decided_at,
      how_to_resolve: a.status === 'pending' ? 'The owner was emailed an Approve / Decline link. Tell them it is waiting. Agents cannot approve.' : undefined,
    };
  }

  async decideApproval(auth, approvalId, decision) {
    if (auth.role !== 'owner') throw forbidden('Only the account owner can approve or reject orders.', 'Tell the human an approval is waiting; they resolve it with their owner_key.');
    const account = this.#account(auth.accountId);
    const a = this.db.prepare('SELECT * FROM approvals WHERE id = ? AND account_id = ?').get(approvalId, account.id);
    if (!a) throw notFound('approval', approvalId);
    if (a.status !== 'pending') throw conflict('approval_already_decided', `Approval is already ${a.status}.`);
    this.db.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'rejected', account.clock, a.id);
    this.#emit(account.id, `approval.${decision === 'approve' ? 'approved' : 'rejected'}`, { approval_id: a.id, order_id: a.order_id });
    if (decision === 'approve') {
      // Approving an order to a new address confirms the address too.
      this.db.prepare('UPDATE addresses SET confirmed = 1 WHERE id = (SELECT address_id FROM orders WHERE id = ?)').run(a.order_id);
      await this.#chargeAndFulfill(account, a.order_id);
      this.#syncSubscriptionAfterPayment(account, a.order_id);
    } else {
      this.db.prepare("UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?").run(account.clock, a.order_id);
      this.#emit(account.id, 'order.canceled', { order_id: a.order_id, reason: 'approval_rejected' });
    }
    return this.getOrder(auth, a.order_id);
  }

  /** The owner taps Approve or Decline in the email; the link carries a one-time token for that approval. */
  async decideApprovalByToken(approvalId, token, decision) {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!a || !a.token_hash || !token || !safeEqual(a.token_hash, hash(String(token)))) throw notFound('approval', approvalId, 'Open the link from the newest approval email.');
    return this.decideApproval({ accountId: a.account_id, role: 'owner' }, approvalId, decision);
  }

  /** What the approval email link shows, if the token matches. */
  approvalForToken(approvalId, token) {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!a || !a.token_hash || !token || !safeEqual(a.token_hash, hash(String(token)))) return null;
    const auth = { accountId: a.account_id, role: 'owner' };
    const order = this.getOrder(auth, a.order_id);
    const acct = this.getAccount(a.account_id);
    return { approval: this.#presentApproval(a), order, ship_to: this.#presentAddress(this.#address(a.account_id, order.address_id)), account: acct.name, spend: acct.spend, policy: acct.policy };
  }

  /** The agent can take back an order it asked the owner to approve. It can never approve one. */
  withdrawOrder(auth, orderId, reason = 'withdrawn_by_agent') {
    const account = this.#account(auth.accountId);
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(orderId, account.id);
    if (!o) throw notFound('order', orderId);
    if (o.status !== 'requires_approval') throw conflict('order_not_withdrawable', `Order is ${o.status}; only orders waiting for approval can be withdrawn.`);
    this.db.prepare("UPDATE approvals SET status = 'withdrawn', decided_at = ? WHERE id = ? AND status = 'pending'").run(account.clock, o.approval_id);
    this.db.prepare("UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?").run(account.clock, o.id);
    this.#emit(account.id, 'order.canceled', { order_id: o.id, reason });
    return this.getOrder(auth, o.id);
  }

  // ------------------------------------------- cancellations, refunds, problems

  #orderRow(accountId, orderId) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ? AND account_id = ?').get(orderId, accountId);
    if (!o) throw notFound('order', orderId, 'List orders with GET /v1/orders.');
    return o;
  }

  /**
   * Cancel an order any time before it has been bought from the retailer. A
   * paid order is refunded in full automatically.
   */
  async cancelOrder(auth, orderId, { reason } = {}) {
    const account = this.#account(auth.accountId);
    const o = this.#orderRow(account.id, orderId);
    const why = reason ?? `canceled_by_${auth.role}`;
    if (o.status === 'requires_approval') return this.withdrawOrder(auth, o.id, why);
    if (o.status === 'payment_failed' || o.status === 'payment_pending') {
      // A pending bank debit that later clears is refunded by the scheduler.
      this.db.prepare("UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?").run(account.clock, o.id);
      if (o.subscription_id) {
        const sub = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(o.subscription_id);
        if (sub.status === 'past_due' && sub.failed_order_id === o.id) this.#touch(account, sub.id, { status: 'active', failed_order_id: null, status_reason: null });
      }
      this.#emit(account.id, 'order.canceled', { order_id: o.id, reason: why });
      return this.getOrder(auth, o.id);
    }
    if (o.status !== 'paid') throw conflict('order_not_cancelable', `Order is ${o.status}.`);
    const sh = this.db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(o.id);
    if (sh && !['awaiting_fulfillment', 'processing'].includes(sh.status)) {
      throw conflict('order_already_bought', 'This order has already been bought from the retailer, so it can no longer be canceled.', { hint: 'If something is wrong with it, use report_problem (POST /v1/orders/{id}/problems).' });
    }
    if (sh) this.db.prepare("UPDATE shipments SET status = 'canceled' WHERE id = ?").run(sh.id);
    this.db.prepare("UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?").run(account.clock, o.id);
    this.#emit(account.id, 'order.canceled', { order_id: o.id, reason: why });
    const refundable = this.#refundable(o);
    if (refundable > 0) await this.#refund(account, o.id, refundable, 'canceled_before_purchase');
    return this.getOrder(auth, o.id);
  }

  #refundable(o) {
    const paid = p(o.charges_json).filter((c) => c.status === 'succeeded').reduce((s, c) => s + c.amount_cents, 0);
    return paid - refundedCents(o);
  }

  async #refund(account, orderId, amountCents, reason, caseId = null) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const refundable = this.#refundable(o);
    if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > refundable) {
      throw badRequest('invalid_param', `amount_cents must be from 1 to ${refundable}.`, { param: 'amount_cents' });
    }
    const charge = p(o.charges_json).filter((c) => c.status === 'succeeded').at(-1);
    const n = p(o.refunds_json).length + 1;
    const r = await this.payments.refund({ ref: charge.provider_ref, amountCents, orderId, n, reason });
    const rec = { id: id('re'), amount_cents: amountCents, reason, case_id: caseId, status: r.status, provider_ref: r.ref, created_at: this.#account(account.id).clock };
    const latest = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const refunds = [...p(latest.refunds_json), rec];
    const full = r.status === 'succeeded' && this.#refundable({ ...latest, refunds_json: j(refunds) }) === 0;
    this.db.prepare(`UPDATE orders SET refunds_json = ?, status = CASE WHEN ? AND status = 'paid' THEN 'refunded' ELSE status END, updated_at = ? WHERE id = ?`)
      .run(j(refunds), full ? 1 : 0, rec.created_at, orderId);
    if (r.status !== 'succeeded') throw new ApiError(502, 'refund_failed', 'The payment provider did not accept the refund.', { hint: 'Try again, or refund it in the Stripe dashboard.' });
    this.#emit(account.id, 'order.refunded', { order_id: orderId, amount_cents: amountCents, reason, case_id: caseId });
    const a = this.#account(account.id);
    this.#mail(a, 'refund', a.email, `Refund of ${usd(amountCents)} from Domaru`, [
      `We refunded ${usd(amountCents)} for order ${orderId} to the card or bank account you paid with.`,
      'It usually shows up in 5 to 10 days, depending on your bank.',
    ]);
    return rec;
  }

  /** Operator only (admin page): full or partial refund through the payment provider. */
  async refundOrder(orderId, { amount_cents, reason = 'operator' } = {}) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw notFound('order', orderId);
    const amount = amount_cents == null || amount_cents === '' ? this.#refundable(o) : Number(amount_cents);
    if (this.#refundable(o) < 1) throw conflict('nothing_to_refund', 'Nothing left to refund on this order.');
    await this.#refund(this.#account(o.account_id), o.id, amount, reason || 'operator');
    return this.#presentOrder(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  }

  static PROBLEM_KINDS = ['never_arrived', 'damaged', 'wrong_item', 'missing_item', 'charged_wrong', 'other'];
  static CLAIM_KINDS = ['never_arrived', 'damaged', 'missing_item'];

  /** Agents (and owners) report a problem with an order. Only the operator moves money. */
  reportProblem(auth, orderId, { kind, note, photo_url, skus, preferred } = {}, reportedBy = auth.role) {
    const account = this.#account(auth.accountId);
    const o = this.#orderRow(account.id, orderId);
    if (!Store.PROBLEM_KINDS.includes(kind)) throw badRequest('invalid_param', `kind must be one of: ${Store.PROBLEM_KINDS.join(', ')}.`, { param: 'kind' });
    if (!['paid', 'refunded'].includes(o.status)) {
      throw conflict('order_not_reportable', `Order is ${o.status}.`, { hint: o.status === 'requires_approval' || o.status === 'payment_pending' ? 'Nothing has been bought yet; cancel_order instead.' : undefined });
    }
    if (preferred != null && !['refund', 'resend'].includes(preferred)) throw badRequest('invalid_param', "preferred must be 'refund' or 'resend'.", { param: 'preferred' });
    if (photo_url != null && !/^https:\/\/\S+$/.test(photo_url)) throw badRequest('invalid_param', 'photo_url must be an https link.', { param: 'photo_url' });
    const lines = p(o.lines_json);
    if (skus != null && (!Array.isArray(skus) || skus.some((sku) => !lines.some((l) => l.sku === sku)))) {
      throw badRequest('invalid_param', 'skus must list SKUs from this order.', { param: 'skus', hint: `This order has: ${lines.map((l) => l.sku).join(', ')}.` });
    }
    const open = this.db.prepare("SELECT * FROM cases WHERE order_id = ? AND kind = ? AND status = 'open'").get(o.id, kind);
    if (open) return this.#presentCase(open);

    const affected = skus?.length ? lines.filter((l) => skus.includes(l.sku)) : lines;
    const value = affected.reduce((sum, l) => sum + l.line_total_cents, 0);
    const since = addDays(dateOf(account.clock), -this.support.claim_window_days);
    const prior = this.db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE account_id = ? AND kind IN (${Store.CLAIM_KINDS.map(() => '?').join(', ')}) AND substr(created_at, 1, 10) >= ?`)
      .get(account.id, ...Store.CLAIM_KINDS, since).n;
    let proof = null;
    if (Store.CLAIM_KINDS.includes(kind) && prior >= this.support.claim_limit) proof = 'repeat_claims';
    else if (['never_arrived', 'damaged', 'missing_item', 'wrong_item'].includes(kind) && value > this.support.no_questions_refund_cents) proof = 'over_limit';

    const caseId = id('case');
    this.db.prepare(`INSERT INTO cases (id, account_id, order_id, kind, note, photo_url, skus_json, preferred, value_cents, needs_proof, proof_reason, status, reported_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`).run(caseId, account.id, o.id, kind, note ?? null, photo_url ?? null, j(affected.map((l) => l.sku)), preferred ?? null,
      value, proof ? 1 : 0, proof, reportedBy, account.clock, account.clock);
    this.#emit(account.id, 'case.opened', { case_id: caseId, order_id: o.id, kind });
    const c = this.#presentCase(this.db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId));
    this.#mailSupport('case_opened', `[${kind.replace(/_/g, ' ')}] ${account.name}, order ${o.id}`, [
      `${account.name} (${account.email}) reported: ${kind.replace(/_/g, ' ')}${reportedBy === 'operator' ? ' (marked by you)' : ` (via ${reportedBy})`}.`,
      `Items: ${affected.map((l) => `${l.quantity} x ${l.name}`).join('; ')} (${usd(value)})`,
      note ? `Note: ${note}` : null, photo_url ? `Photo: ${photo_url}` : null, preferred ? `They prefer a ${preferred}.` : null,
      proof ? `Proof needed first: ${proof === 'repeat_claims' ? `${prior} claims in ${this.support.claim_window_days} days` : `over ${usd(this.support.no_questions_refund_cents)}`}.` : 'Within the no-questions limit: refund or resend.',
      `Case ${caseId}: ${this.publicUrl}/admin/orders/${o.id}`,
    ].filter(Boolean));
    if (reportedBy !== 'operator') {
      this.#mail(account, 'case_opened', account.email, `We're on it: your Domaru order ${o.id}`, [
        `Your assistant told us about a problem (${kind.replace(/_/g, ' ')}).`, c.what_happens_next, 'Reply to this email if there is anything to add.',
      ]);
    }
    return c;
  }

  listCases(auth, { status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM cases WHERE account_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC').all(auth.accountId, status)
      : this.db.prepare('SELECT * FROM cases WHERE account_id = ? ORDER BY created_at DESC, rowid DESC').all(auth.accountId);
    return rows.map((c) => this.#presentCase(c));
  }

  getCase(auth, caseId) {
    const c = this.db.prepare('SELECT * FROM cases WHERE id = ? AND account_id = ?').get(caseId, auth.accountId);
    if (!c) throw notFound('case', caseId, 'List cases with GET /v1/cases.');
    return this.#presentCase(c);
  }

  #presentCase(c) {
    const proof = c.needs_proof
      ? (c.kind === 'damaged' ? ' Because of the amount or recent claims, we need a photo first: pass photo_url or reply to our email with one.' : ' Because of the amount or recent claims, we check the carrier\'s delivery record first.')
      : '';
    const next = {
      never_arrived: "Packages often turn up within a day at a neighbor's door or in the mailbox. If it still hasn't, we refund or resend it, the household's choice.",
      damaged: 'We refund or resend the damaged items. No need to send anything back.',
      wrong_item: 'We send the right item. Keep the wrong one; no need to send it back.',
      missing_item: 'Big orders sometimes come in two boxes. If the item is not in a second box, we refund or resend it.',
      charged_wrong: 'We check the charge and refund anything extra.',
      other: `Our support team will reply by email within one business day (${this.support.email}).`,
    }[c.kind];
    const done = {
      resend_sent: `A replacement is on the way (order ${c.resend_order_id}).`,
      refunded: `Refunded ${usd(c.refund_cents ?? 0)} to the original payment method. It shows up in 5 to 10 days.`,
      closed: c.resolution ?? 'Closed.',
    }[c.status];
    return {
      id: c.id, order_id: c.order_id, kind: c.kind, status: c.status, note: c.note, photo_url: c.photo_url, skus: p(c.skus_json),
      preferred: c.preferred, needs_proof: !!c.needs_proof, resolution: c.resolution, resend_order_id: c.resend_order_id, refund_cents: c.refund_cents,
      what_happens_next: done ?? next + proof, created_at: c.created_at, updated_at: c.updated_at,
    };
  }

  /** Operator: open cases across all accounts, oldest first. */
  listOpenCases() {
    return this.db.prepare("SELECT c.*, a.name AS account_name, a.email AS account_email FROM cases c JOIN accounts a ON a.id = c.account_id WHERE c.status = 'open' ORDER BY c.created_at, c.rowid")
      .all().map((c) => ({ ...this.#presentCase(c), account: { id: c.account_id, name: c.account_name, email: c.account_email }, value_cents: c.value_cents, proof_reason: c.proof_reason, reported_by: c.reported_by }));
  }

  /** Operator: settle a case with a refund, a free resend, or by closing it. */
  async resolveCase(caseId, { action, amount_cents, note } = {}) {
    const c = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!c) throw notFound('case', caseId);
    if (c.status !== 'open') throw conflict('case_closed', `Case is already ${c.status}.`);
    const account = this.#account(c.account_id);
    const fields = { resolution: note || null };
    if (action === 'refund') {
      const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(c.order_id);
      const amount = amount_cents == null || amount_cents === '' ? Math.min(c.value_cents, this.#refundable(o)) : Number(amount_cents);
      await this.#refund(account, c.order_id, amount, `case_${c.kind}`, c.id);
      Object.assign(fields, { status: 'refunded', refund_cents: amount });
    } else if (action === 'resend') {
      const resend = this.#resend(account, c.order_id, p(c.skus_json));
      Object.assign(fields, { status: 'resend_sent', resend_order_id: resend });
    } else if (action === 'close') {
      fields.status = 'closed';
    } else {
      throw badRequest('invalid_param', "action must be 'refund', 'resend' or 'close'.", { param: 'action' });
    }
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE cases SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), account.clock, c.id);
    const out = this.#presentCase(this.db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id));
    this.#emit(account.id, 'case.updated', { case_id: c.id, status: out.status });
    if (action !== 'refund') this.#mail(account, 'case_updated', account.email, `Update on your Domaru order ${c.order_id}`, [out.what_happens_next]);
    return out;
  }

  /** A free copy of some or all of an order's items, back in the fulfillment queue. */
  #resend(account, orderId, skus) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const lines = p(o.lines_json).filter((l) => !skus?.length || skus.includes(l.sku)).map((l) => ({ ...l, unit_price_cents: 0, line_total_cents: 0 }));
    const newId = id('ord');
    const amounts = { subtotal_cents: 0, discount_cents: 0, bank_discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0, currency: 'usd' };
    this.db.prepare(`INSERT INTO orders (id, account_id, subscription_id, status, lines_json, amounts_json, address_id, payment_method_id, charges_json, fulfill_on, resend_of, created_at, updated_at)
      VALUES (?, ?, NULL, 'paid', ?, ?, ?, ?, '[]', ?, ?, ?, ?)`).run(newId, account.id, j(lines), j(amounts), o.address_id, o.payment_method_id, dateOf(account.clock), o.id, account.clock, account.clock);
    this.#emit(account.id, 'order.resend_created', { order_id: newId, resend_of: o.id });
    this.#ship(account, newId);
    return newId;
  }

  // --------------------------------------------------- disputes and holds

  /** Stripe webhook events, already signature-checked by the HTTP layer. */
  async handleStripeEvent(event) {
    const obj = event?.data?.object ?? {};
    const orderFor = (pi) => (pi ? this.db.prepare("SELECT o.* FROM orders o, json_each(o.charges_json) c WHERE json_extract(c.value, '$.provider_ref') = ?").get(pi) : null);
    switch (event?.type) {
      case 'checkout.session.completed':
        if (obj.mode !== 'setup') return { handled: false };
        try {
          await this.completeCardSetup(obj.id);
        } catch { /* already recorded via the return page, or incomplete */ }
        return { handled: true };
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed': {
        const o = orderFor(obj.id);
        if (o) await this.#runDue(o.account_id);
        return { handled: !!o };
      }
      case 'charge.dispute.created':
      case 'charge.dispute.closed':
      case 'charge.dispute.updated': {
        const o = orderFor(typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id);
        if (!o) return { handled: false };
        const dispute = { id: obj.id, reason: obj.reason ?? null, amount_cents: obj.amount ?? null, status: obj.status ?? null, updated_at: new Date().toISOString() };
        this.db.prepare('UPDATE orders SET dispute_json = ? WHERE id = ?').run(j(dispute), o.id);
        const account = this.#account(o.account_id);
        if (event.type === 'charge.dispute.created') {
          // One chargeback pauses the household until it is sorted out.
          this.db.prepare('UPDATE accounts SET hold_reason = ? WHERE id = ?').run(`chargeback on order ${o.id}`, o.account_id);
          this.#emit(o.account_id, 'account.on_hold', { reason: 'chargeback', order_id: o.id });
          this.#mailSupport('dispute', `Chargeback: ${account.name}, order ${o.id} (${usd(obj.amount ?? 0)})`, [
            `${account.name} (${account.email}) disputed order ${o.id}: ${obj.reason ?? 'no reason given'}.`,
            'The account is on hold: no new orders or renewals until you release it.',
            'If the complaint is real, accept it in Stripe. Otherwise answer it in Stripe with the order, the delivery tracking and the owner approval if there was one.',
            `${this.publicUrl}/admin/orders/${o.id}`,
          ]);
        }
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  }

  /** Operator: lift a hold once a chargeback or other issue is resolved. */
  releaseHold(accountId) {
    const a = this.#account(accountId);
    this.db.prepare('UPDATE accounts SET hold_reason = NULL WHERE id = ?').run(a.id);
    this.#emit(a.id, 'account.hold_released', {});
    return this.getAccount(a.id);
  }

  // ------------------------------------------------------- subscriptions

  #validateCadence(cadence) {
    if (!Number.isInteger(cadence) || cadence < 7 || cadence > 180) {
      throw badRequest('invalid_param', 'cadence_days must be an integer from 7 to 180.', { param: 'cadence_days', hint: 'Use recommend_bundle to get a cadence that matches household usage.' });
    }
  }

  async createSubscription(auth, { items, cadence_days = 28, start_date, address_id, payment_method_id, metadata = {} } = {}) {
    const account = this.#account(auth.accountId);
    const norm = this.#normalizeItems(items);
    this.#validateCadence(cadence_days);
    const today = dateOf(account.clock);
    if (start_date != null && (!isDate(start_date) || start_date < today)) {
      throw badRequest('invalid_param', 'start_date must be YYYY-MM-DD and not in the past.', { param: 'start_date', hint: `Account today is ${today}. Omit start_date to ship today.` });
    }
    const { addrId, pmId } = this.#resolveShipPay(account, address_id, payment_method_id);
    const subId = id('sub');
    this.db.prepare(`INSERT INTO subscriptions (id, account_id, status, items_json, cadence_days, next_order_date, address_id, payment_method_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`).run(subId, account.id, j(norm), cadence_days, start_date ?? today, addrId, pmId, j(metadata), account.clock, account.clock);
    this.#emit(account.id, 'subscription.created', { subscription_id: subId });
    const priced = this.price(norm, { subscription: true, bank: this.#pm(account.id, pmId).type === 'bank' });
    this.#mail(account, 'subscription_started', account.email, 'Your Domaru subscription has started', [
      `Your assistant started a subscription for ${account.name}. It renews automatically every ${cadence_days} days until you or your assistant cancel it.`,
      '',
      ...priced.lines.map((l) => `${l.quantity} x ${l.name}  ${usd(l.line_total_cents)}`),
      `Each delivery: about ${usd(priced.amounts.total_cents)} including tax and shipping. First delivery ships ${start_date ?? today}.`,
      '',
      `To pause, skip or cancel, ask your assistant, or write to ${this.support.email} and we'll do it for you. Prices can change; we'll email you at least 7 days before any increase.`,
    ]);
    await this.#runDue(account.id);
    return this.getSubscription(auth, subId);
  }

  #sub(accountId, subId) {
    const s = this.db.prepare('SELECT * FROM subscriptions WHERE id = ? AND account_id = ?').get(subId, accountId);
    if (!s) throw notFound('subscription', subId, 'List subscriptions with GET /v1/subscriptions.');
    return s;
  }

  getSubscription(auth, subId) {
    return this.#presentSub(this.#sub(auth.accountId, subId));
  }

  listSubscriptions(auth, { status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM subscriptions WHERE account_id = ? AND status = ? ORDER BY created_at, rowid').all(auth.accountId, status)
      : this.db.prepare('SELECT * FROM subscriptions WHERE account_id = ? ORDER BY created_at, rowid').all(auth.accountId);
    return rows.map((s) => this.#presentSub(s));
  }

  #presentSub(s) {
    const items = p(s.items_json);
    const bank = this.db.prepare('SELECT type FROM payment_methods WHERE id = ?').get(s.payment_method_id)?.type === 'bank';
    const priced = this.price(items, { subscription: true, bank });
    const latest = this.db.prepare('SELECT * FROM orders WHERE subscription_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(s.id);
    return {
      id: s.id,
      status: s.status,
      status_reason: s.status_reason,
      items: priced.lines.map(({ sku, name, quantity, unit_price_cents }) => ({ sku, name, quantity, unit_price_cents })),
      cadence_days: s.cadence_days,
      next_order_date: s.status === 'canceled' ? null : s.next_order_date,
      next_charge_date: s.status === 'canceled' ? null : this.#chargeDate(s.next_order_date, bank),
      pause_until: s.pause_until,
      address_id: s.address_id,
      payment_method_id: s.payment_method_id,
      estimated_next_order: priced.amounts,
      estimated_monthly_cents: Math.round((priced.amounts.total_cents * 30) / s.cadence_days),
      latest_order: latest ? this.#presentOrder(latest) : null,
      metadata: p(s.metadata_json),
      created_at: s.created_at,
      updated_at: s.updated_at,
      canceled_at: s.canceled_at,
    };
  }

  #touch(account, subId, fields) {
    const keys = Object.keys(fields);
    const sql = `UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => fields[k]), account.clock, subId);
  }

  #requireNotCanceled(s) {
    if (s.status === 'canceled') throw conflict('subscription_canceled', 'This subscription is canceled.', { hint: 'Create a new subscription instead.' });
  }

  async updateSubscription(auth, subId, { items, cadence_days, next_order_date, address_id, payment_method_id, metadata } = {}) {
    const account = this.#account(auth.accountId);
    const s = this.#sub(account.id, subId);
    this.#requireNotCanceled(s);
    const fields = {};
    if (items !== undefined) fields.items_json = j(this.#normalizeItems(items));
    if (cadence_days !== undefined) { this.#validateCadence(cadence_days); fields.cadence_days = cadence_days; }
    if (next_order_date !== undefined) {
      if (!isDate(next_order_date) || next_order_date < dateOf(account.clock)) throw badRequest('invalid_param', 'next_order_date must be YYYY-MM-DD and not in the past.', { param: 'next_order_date' });
      fields.next_order_date = next_order_date;
    }
    if (address_id !== undefined) { this.#address(account.id, address_id); fields.address_id = address_id; }
    if (payment_method_id !== undefined) { this.#pm(account.id, payment_method_id); fields.payment_method_id = payment_method_id; }
    if (metadata !== undefined) fields.metadata_json = j({ ...p(s.metadata_json), ...metadata });
    if (!Object.keys(fields).length) throw badRequest('nothing_to_update', 'No updatable fields were provided.', { hint: 'Pass any of: items, cadence_days, next_order_date, address_id, payment_method_id, metadata.' });
    this.#touch(account, s.id, fields);
    this.#emit(account.id, 'subscription.updated', { subscription_id: s.id, fields: Object.keys(fields).map((k) => k.replace(/_json$/, '')) });

    // A new card on a past-due subscription retries the failed order right away.
    if (s.status === 'past_due' && payment_method_id !== undefined && s.failed_order_id) {
      const failed = this.db.prepare('SELECT lines_json FROM orders WHERE id = ?').get(s.failed_order_id);
      const repriced = this.price(p(failed.lines_json), { subscription: true, bank: this.#pm(account.id, payment_method_id).type === 'bank' });
      this.db.prepare('UPDATE orders SET payment_method_id = ?, amounts_json = ? WHERE id = ?').run(payment_method_id, j(repriced.amounts), s.failed_order_id);
      if (await this.#chargeAndFulfill(this.#account(account.id), s.failed_order_id)) this.#syncSubscriptionAfterPayment(this.#account(account.id), s.failed_order_id);
    }
    return this.getSubscription(auth, s.id);
  }

  pauseSubscription(auth, subId, { until } = {}) {
    const account = this.#account(auth.accountId);
    const s = this.#sub(account.id, subId);
    this.#requireNotCanceled(s);
    const today = dateOf(account.clock);
    if (until != null && (!isDate(until) || until <= today)) throw badRequest('invalid_param', 'until must be a future date (YYYY-MM-DD).', { param: 'until', hint: `Account today is ${today}. Omit until to pause indefinitely.` });
    this.#touch(account, s.id, { status: 'paused', pause_until: until ?? null, status_reason: until ? `paused until ${until}` : 'paused indefinitely' });
    this.#emit(account.id, 'subscription.paused', { subscription_id: s.id, until: until ?? null });
    return this.getSubscription(auth, s.id);
  }

  async resumeSubscription(auth, subId) {
    const account = this.#account(auth.accountId);
    const s = this.#sub(account.id, subId);
    this.#requireNotCanceled(s);
    if (s.status !== 'paused') throw conflict('not_paused', `Subscription is ${s.status}, not paused.`);
    this.#resume(account, s);
    await this.#runDue(account.id);
    return this.getSubscription(auth, s.id);
  }

  #resume(account, s) {
    const today = dateOf(account.clock);
    this.#touch(account, s.id, { status: 'active', pause_until: null, status_reason: null, next_order_date: s.next_order_date < today ? today : s.next_order_date });
    this.#emit(account.id, 'subscription.resumed', { subscription_id: s.id });
  }

  skipNext(auth, subId) {
    const account = this.#account(auth.accountId);
    const s = this.#sub(account.id, subId);
    this.#requireNotCanceled(s);
    const next = addDays(s.next_order_date, s.cadence_days);
    this.#touch(account, s.id, { next_order_date: next });
    this.#emit(account.id, 'subscription.skipped', { subscription_id: s.id, skipped_date: s.next_order_date, next_order_date: next });
    return this.getSubscription(auth, s.id);
  }

  async shipNow(auth, subId) {
    const account = this.#account(auth.accountId);
    const s = this.#sub(account.id, subId);
    this.#requireNotCanceled(s);
    if (s.status === 'past_due') throw conflict('subscription_past_due', 'The last payment failed.', { hint: 'Update payment_method_id on the subscription to retry it first.' });
    this.#touch(account, s.id, { next_order_date: dateOf(account.clock) });
    if (s.status === 'paused') this.#resume(account, { ...s, next_order_date: dateOf(account.clock) });
    await this.#runDue(account.id);
    return this.getSubscription(auth, s.id);
  }

  /**
   * Agents rarely know exact usage; they do notice "we're out" or "the closet is
   * full". Feed that back and the cadence adjusts.
   */
  async reportSignal(auth, subId, { signal } = {}) {
    const account = this.#account(auth.accountId);
    const s = this.#sub(account.id, subId);
    this.#requireNotCanceled(s);
    if (signal === 'running_low') {
      const cadence = Math.max(7, Math.round(s.cadence_days * 0.85));
      this.#touch(account, s.id, { cadence_days: cadence });
      this.#emit(account.id, 'subscription.cadence_adjusted', { subscription_id: s.id, from: s.cadence_days, to: cadence, signal });
      return await this.shipNow(auth, s.id);
    }
    if (signal === 'overstocked') {
      const cadence = Math.min(180, Math.round(s.cadence_days * 1.15));
      this.#touch(account, s.id, { cadence_days: cadence, next_order_date: addDays(s.next_order_date, cadence) });
      this.#emit(account.id, 'subscription.cadence_adjusted', { subscription_id: s.id, from: s.cadence_days, to: cadence, signal });
      return this.getSubscription(auth, s.id);
    }
    throw badRequest('invalid_param', "signal must be 'running_low' or 'overstocked'.", { param: 'signal' });
  }

  cancelSubscription(auth, subId, { reason } = {}) {
    const account = this.#account(auth.accountId);
    const s = this.#sub(account.id, subId);
    this.#requireNotCanceled(s);
    this.#touch(account, s.id, { status: 'canceled', canceled_at: account.clock, status_reason: reason ?? null, pause_until: null });
    this.#emit(account.id, 'subscription.canceled', { subscription_id: s.id, reason: reason ?? null });
    return this.getSubscription(auth, s.id);
  }

  // ----------------------------------------------- scheduler & test clock

  /** Run everything due on the account's current date: renewals and shipment progress. */
  async #runDue(accountId) {
    const account = this.#account(accountId);
    const today = dateOf(account.clock);

    for (const s of this.db.prepare("SELECT * FROM subscriptions WHERE account_id = ? AND status = 'paused' AND pause_until IS NOT NULL AND pause_until <= ?").all(accountId, today)) {
      this.#resume(account, s);
    }

    // Bank debits started earlier: see whether they cleared or bounced.
    const pending = this.db.prepare(`SELECT * FROM orders WHERE account_id = ? AND (status = 'payment_pending'
      OR (status = 'canceled' AND json_extract(charges_json, '$[#-1].status') = 'pending')) ORDER BY created_at, rowid`).all(accountId);
    for (const o of pending) {
      const charges = p(o.charges_json);
      const last = charges.at(-1);
      const pm = this.#pm(accountId, last.payment_method_id);
      const result = await this.payments.checkCharge({ ref: last.provider_ref, pmRef: pm.token, chargedOn: dateOf(last.created_at), today });
      if (result.status === 'pending') continue;
      charges[charges.length - 1] = { ...last, status: result.status, failure_code: result.failure_code, settled_at: account.clock };
      if (o.status === 'canceled') {
        // Canceled while the debit was in flight: give the money straight back.
        this.db.prepare('UPDATE orders SET charges_json = ? WHERE id = ?').run(j(charges), o.id);
        if (result.status === 'succeeded') await this.#refund(account, o.id, last.amount_cents, 'canceled_before_purchase');
        continue;
      }
      this.#settle(account, o.id, charges, result);
      this.#syncSubscriptionAfterPayment(this.#account(accountId), o.id);
    }

    const subs = account.hold_reason ? [] : this.db.prepare("SELECT s.*, pm.type AS pm_type FROM subscriptions s LEFT JOIN payment_methods pm ON pm.id = s.payment_method_id WHERE s.account_id = ? AND s.status = 'active'").all(accountId);
    for (const s of subs.filter((x) => this.#chargeDate(x.next_order_date, x.pm_type === 'bank') <= today)) {
      const shipOn = s.next_order_date < today ? today : s.next_order_date;
      // Claim this renewal before charging so overlapping runs never order twice.
      const claimed = this.db.prepare("UPDATE subscriptions SET next_order_date = ?, updated_at = ? WHERE id = ? AND status = 'active' AND next_order_date = ?")
        .run(addDays(shipOn, s.cadence_days), account.clock, s.id, s.next_order_date);
      if (claimed.changes !== 1) continue;
      const order = await this.#placeOrder(account, { items: p(s.items_json), addrId: s.address_id, pmId: s.payment_method_id, subscriptionId: s.id, fulfillOn: shipOn });
      this.#syncSubscriptionAfterPayment(this.#account(accountId), order.id);
    }

    // Paid ahead of time: ship once the ship date arrives.
    for (const o of this.db.prepare("SELECT o.id FROM orders o LEFT JOIN shipments sh ON sh.order_id = o.id WHERE o.account_id = ? AND o.status = 'paid' AND sh.id IS NULL AND o.fulfill_on <= ?").all(accountId, today)) {
      this.#ship(account, o.id);
    }

    if (this.fulfillment !== 'mock') return;
    for (const sh of this.db.prepare("SELECT * FROM shipments WHERE account_id = ? AND status IN ('processing', 'shipped')").all(accountId)) {
      if (sh.status === 'processing' && addDays(dateOf(sh.created_at), 1) <= today) {
        this.db.prepare("UPDATE shipments SET status = 'shipped', shipped_at = ? WHERE id = ?").run(account.clock, sh.id);
        this.#emit(accountId, 'shipment.shipped', { shipment_id: sh.id, order_id: sh.order_id, tracking_number: sh.tracking_number });
        sh.status = 'shipped';
      }
      if (sh.status === 'shipped' && sh.estimated_delivery_date <= today) {
        this.db.prepare("UPDATE shipments SET status = 'delivered', delivered_at = ? WHERE id = ?").run(account.clock, sh.id);
        this.#emit(accountId, 'shipment.delivered', { shipment_id: sh.id, order_id: sh.order_id });
        this.#afterDelivery(accountId);
      }
    }
  }

  /** Bank payers are charged early enough for the debit to clear before the order is bought. */
  #chargeDate(shipDate, bank) {
    return bank ? addBusinessDays(shipDate, -BANK_CLEARING_BUSINESS_DAYS) : shipDate;
  }

  #syncSubscriptionAfterPayment(account, orderId) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o.subscription_id) return;
    const s = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(o.subscription_id);
    if (o.status === 'payment_failed' && s.status === 'active') {
      this.#touch(account, s.id, { status: 'past_due', failed_order_id: o.id, status_reason: `payment failed on ${o.id}` });
      this.#emit(account.id, 'subscription.past_due', { subscription_id: s.id, order_id: o.id });
    } else if (o.status === 'paid' && s.status === 'past_due' && s.failed_order_id === o.id) {
      this.#touch(account, s.id, { status: 'active', failed_order_id: null, status_reason: null });
      this.#emit(account.id, 'subscription.recovered', { subscription_id: s.id, order_id: o.id });
    }
  }

  /** Sandbox only: move the account's clock forward day by day, running renewals and shipping. */
  async advanceClock(auth, { days = 1 } = {}) {
    if (!Number.isInteger(days) || days < 1 || days > MAX_ADVANCE_DAYS) throw badRequest('invalid_param', `days must be an integer from 1 to ${MAX_ADVANCE_DAYS}.`, { param: 'days' });
    const account = this.#account(auth.accountId);
    if (account.mode !== 'test') throw forbidden('The clock can only be advanced in test mode.');
    const before = this.#lastEventSeq(account.id);
    for (let i = 0; i < days; i++) {
      const a = this.#account(account.id);
      const next = new Date(Date.parse(a.clock) + 86_400_000).toISOString();
      this.db.prepare('UPDATE accounts SET clock = ? WHERE id = ?').run(next, a.id);
      await this.#runDue(a.id);
    }
    return { account: this.getAccount(account.id), events: this.listEvents(auth, { after: before, limit: 1000 }).data };
  }

  /** Live mode scheduler tick: renewals, bank debits and ship dates for every live account. */
  async runAllDue() {
    const ids = this.db.prepare(`SELECT id FROM accounts a WHERE a.mode = 'live' AND (
      EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id AND s.status IN ('active', 'paused'))
      OR EXISTS (SELECT 1 FROM orders o WHERE o.account_id = a.id AND o.status IN ('payment_pending', 'paid') AND NOT EXISTS (SELECT 1 FROM shipments sh WHERE sh.order_id = o.id)))`).all();
    for (const { id: accountId } of ids) await this.#runDue(accountId);
    return ids.length;
  }

  // ---------------------------------------------- operator (concierge) fulfillment

  /** Paid orders the operator still has to buy and ship, oldest first. */
  listFulfillmentQueue({ status = 'awaiting_fulfillment' } = {}) {
    return this.db.prepare(`SELECT o.* FROM shipments s JOIN orders o ON o.id = s.order_id
      WHERE s.status = ? ORDER BY o.created_at, o.rowid`).all(status).map((o) => this.#operatorOrder(o));
  }

  /** Operator view of one order: Walmart listings, ship-to, account, cases. */
  #operatorOrder(o) {
    const order = this.#presentOrder(o);
    const a = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(o.account_id);
    const today = dateOf(this.#account(o.account_id).clock);
    const sh = this.db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(o.id);
    return {
      ...order,
      // Operator-only: the retail listing to buy for each line (never shown to agents).
      lines: order.lines.map((l) => ({ ...l, source: this.products.get(l.sku)?.source ?? null })),
      account: { id: a.id, name: a.name, email: a.email, hold_reason: a.hold_reason },
      ship_to: p(this.db.prepare('SELECT json FROM addresses WHERE id = ?').get(o.address_id).json),
      shipment: order.shipment && {
        ...order.shipment,
        retailer_order_id: sh.retailer_order_id, retailer_canceled_at: sh.retailer_canceled_at, problem: sh.problem,
        late: !['delivered', 'canceled'].includes(sh.status) && sh.estimated_delivery_date < today,
      },
      cases: this.db.prepare('SELECT * FROM cases WHERE order_id = ? ORDER BY created_at').all(o.id).map((c) => this.#presentCase(c)),
      refundable_cents: this.#refundable(o),
    };
  }

  adminOrder(orderId) {
    const o = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw notFound('order', orderId);
    return this.#operatorOrder(o);
  }

  /** Bought or due but past the expected delivery date with no delivered mark. */
  listLate() {
    return this.db.prepare("SELECT o.* FROM shipments s JOIN orders o ON o.id = s.order_id WHERE s.status IN ('awaiting_fulfillment', 'placed', 'shipped') ORDER BY s.estimated_delivery_date")
      .all().map((o) => this.#operatorOrder(o)).filter((o) => o.shipment.late);
  }

  #operatorShipment(orderId, from) {
    const sh = this.db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(orderId);
    if (!sh) throw notFound('shipment', orderId, 'Only paid orders have shipments.');
    const ok = Array.isArray(from) ? from : [from];
    if (!ok.includes(sh.status)) throw conflict('invalid_shipment_state', `Shipment is ${sh.status}, expected ${ok.join(' or ')}.`);
    return sh;
  }

  /** The operator bought it on Walmart. From here the household can no longer cancel. */
  markPlaced(orderId, { retailer_order_id } = {}) {
    const sh = this.#operatorShipment(orderId, 'awaiting_fulfillment');
    this.db.prepare("UPDATE shipments SET status = 'placed', retailer_order_id = ?, retailer_canceled_at = NULL WHERE id = ?").run(retailer_order_id || null, sh.id);
    this.#emit(sh.account_id, 'shipment.placed', { shipment_id: sh.id, order_id: orderId });
    return this.adminOrder(orderId);
  }

  /** Walmart canceled it: back to the queue, to buy elsewhere (Amazon) or refund. */
  markRetailerCanceled(orderId) {
    const sh = this.#operatorShipment(orderId, ['placed', 'awaiting_fulfillment']);
    this.db.prepare("UPDATE shipments SET status = 'awaiting_fulfillment', retailer_canceled_at = ? WHERE id = ?").run(this.#account(sh.account_id).clock, sh.id);
    this.#emit(sh.account_id, 'shipment.retailer_canceled', { shipment_id: sh.id, order_id: orderId, next: 'Domaru is buying it from another retailer at no extra cost.' });
    return this.adminOrder(orderId);
  }

  /** Operator marks lost, damaged or wrong item; opens a case if none is open. */
  markProblem(orderId, { problem, note } = {}) {
    const kinds = { lost: 'never_arrived', damaged: 'damaged', wrong_item: 'wrong_item' };
    if (!kinds[problem]) throw badRequest('invalid_param', "problem must be 'lost', 'damaged' or 'wrong_item'.", { param: 'problem' });
    const sh = this.db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(orderId);
    if (!sh) throw notFound('shipment', orderId);
    this.db.prepare('UPDATE shipments SET problem = ? WHERE id = ?').run(problem, sh.id);
    const open = this.db.prepare("SELECT * FROM cases WHERE order_id = ? AND status = 'open'").get(orderId);
    if (!open) this.reportProblem({ accountId: sh.account_id, role: 'operator' }, orderId, { kind: kinds[problem], note }, 'operator');
    return this.adminOrder(orderId);
  }

  markShipped(orderId, { carrier, tracking_number } = {}) {
    if (!carrier || !tracking_number) throw badRequest('missing_param', 'carrier and tracking_number are required.', { hint: 'e.g. carrier "UPS", tracking_number "1Z..."' });
    const sh = this.#operatorShipment(orderId, ['awaiting_fulfillment', 'placed']);
    const now = this.#account(sh.account_id).clock;
    this.db.prepare("UPDATE shipments SET status = 'shipped', carrier = ?, tracking_number = ?, shipped_at = ? WHERE id = ?").run(carrier, tracking_number, now, sh.id);
    this.#emit(sh.account_id, 'shipment.shipped', { shipment_id: sh.id, order_id: orderId, carrier, tracking_number });
    const a = this.#account(sh.account_id);
    this.#mail(a, 'shipped', a.email, 'Your Domaru order is on the way', [
      `Order ${orderId} has shipped with ${carrier}. Tracking: ${tracking_number}.`,
      'The box may come from Walmart or Amazon; we buy from them and ship straight to you.',
      `Problem with it? Tell your assistant, or reply to this email.`,
    ]);
    return this.#presentOrder(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  }

  markDelivered(orderId) {
    const sh = this.#operatorShipment(orderId, 'shipped');
    this.db.prepare("UPDATE shipments SET status = 'delivered', delivered_at = ? WHERE id = ?").run(this.#account(sh.account_id).clock, sh.id);
    this.#emit(sh.account_id, 'shipment.delivered', { shipment_id: sh.id, order_id: orderId });
    this.#afterDelivery(sh.account_id);
    return this.#presentOrder(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  }

  // -------------------------------------------------------------- email

  /** Queue an email. Delivery happens in flushEmails, outside the request. */
  #mail(account, kind, to, subject, lines) {
    if (!to) return;
    const body = [...lines, '', '--', `Domaru · ${this.support.email} · Charges show on your statement as DOMARU.`].join('\n');
    this.db.prepare("INSERT INTO emails (id, account_id, kind, to_addr, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)")
      .run(id('em'), account?.id ?? null, kind, to, subject, body, account?.clock ?? new Date().toISOString());
  }

  #mailSupport(kind, subject, lines) {
    this.#mail(null, kind, this.support.email, subject, lines);
  }

  /** Deliver queued email. Safe to call often; overlapping calls share one run. */
  flushEmails() {
    this.#flushing ??= (async () => {
      try {
        for (const e of this.db.prepare("SELECT * FROM emails WHERE status = 'queued' ORDER BY rowid").all()) {
          let r;
          try {
            r = await this.mailer.send({ id: e.id, from: this.support.from, replyTo: this.support.email, to: e.to_addr, subject: e.subject, text: e.body });
          } catch (err) {
            r = { status: 'failed', error: err.message };
          }
          this.db.prepare('UPDATE emails SET status = ?, provider_ref = ?, error = ?, sent_at = ? WHERE id = ?').run(r.status, r.ref ?? null, r.error ?? null, new Date().toISOString(), e.id);
        }
      } finally {
        this.#flushing = null;
      }
    })();
    return this.#flushing;
  }

  #flushing = null;

  /** Operator view of sent and queued mail, newest first. */
  listEmails({ account_id, to, kind, limit = 50 } = {}) {
    let sql = 'SELECT * FROM emails WHERE 1 = 1';
    const args = [];
    if (account_id) { sql += ' AND account_id = ?'; args.push(account_id); }
    if (to) { sql += ' AND to_addr = ?'; args.push(to); }
    if (kind) { sql += ' AND kind = ?'; args.push(kind); }
    sql += ' ORDER BY rowid DESC LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args).map((e) => ({ id: e.id, account_id: e.account_id, kind: e.kind, to: e.to_addr, subject: e.subject, body: e.body, status: e.status, created_at: e.created_at }));
  }

  // -------------------------------------------------------------- events

  #emit(accountId, type, data) {
    const a = this.#account(accountId);
    this.db.prepare('INSERT INTO events (id, account_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id('evt'), accountId, type, j(data), a.clock);
  }

  #lastEventSeq(accountId) {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE account_id = ?').get(accountId).s;
  }

  listEvents(auth, { after = 0, type, limit = 100 } = {}) {
    let sql = 'SELECT * FROM events WHERE account_id = ? AND seq > ?';
    const args = [auth.accountId, Number(after) || 0];
    if (type) { sql += ' AND type = ?'; args.push(type); }
    sql += ' ORDER BY seq LIMIT ?';
    args.push(Math.min(Math.max(1, Number(limit) || 100), 1000));
    const data = this.db.prepare(sql).all(...args).map((e) => ({ seq: e.seq, id: e.id, type: e.type, data: p(e.data_json), created_at: e.created_at }));
    return { data, next_after: data.length ? data[data.length - 1].seq : Number(after) || 0 };
  }

  // --------------------------------------------------------- idempotency

  /**
   * Run `fn` once per (account, key). Replays return the stored result; reusing
   * a key with a different request is an error.
   */
  async idempotent(auth, key, fingerprint, fn) {
    if (!key) return fn();
    const prior = this.db.prepare('SELECT * FROM idempotency WHERE account_id = ? AND key = ?').get(auth.accountId, key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw conflict('idempotency_key_reused', 'This idempotency key was already used with a different request.', { hint: 'Use a fresh key for a new operation.' });
      if (prior.response_json === 'null') throw conflict('idempotent_request_in_progress', 'A request with this idempotency key is still running.', { hint: 'Retry in a moment with the same key.' });
      return { ...p(prior.response_json), idempotent_replay: true };
    }
    // Reserve the key first so a concurrent retry can't run the operation twice.
    this.db.prepare("INSERT INTO idempotency (account_id, key, fingerprint, response_json, created_at) VALUES (?, ?, ?, 'null', ?)")
      .run(auth.accountId, key, fingerprint, new Date().toISOString());
    try {
      const result = await fn();
      this.db.prepare('UPDATE idempotency SET response_json = ? WHERE account_id = ? AND key = ?').run(j(result), auth.accountId, key);
      return result;
    } catch (err) {
      this.db.prepare('DELETE FROM idempotency WHERE account_id = ? AND key = ?').run(auth.accountId, key);
      throw err;
    }
  }
}

export { ApiError };
