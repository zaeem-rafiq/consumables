// Core service layer. Both the HTTP API and the MCP server call into this, so
// behavior (pricing, spend policy, billing, fulfillment) is identical across
// surfaces.

import { createHash, randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { PRODUCTS, CATEGORIES, presentProduct, baseUnitsPerPack, monthlyUsage } from './catalog.js';
import { ApiError, badRequest, notFound, unauthorized, forbidden, conflict } from './errors.js';
import { MockPayments, addBusinessDays, BANK_CLEARING_BUSINESS_DAYS } from './payments.js';

export const PRICING = {
  subscription_discount_pct: 5,
  // Bank debits cost us far less than cards, so bank payers get some of that back.
  bank_discount_pct: 2,
  free_shipping_threshold_cents: 3500,
  shipping_cents: 599,
  tax_rate_pct: 8,
};

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
const BANK_OFFER = `Switch to bank payments and save ${PRICING.bank_discount_pct}% on every delivery.`;

export class Store {
  /**
   * @param {object} opts
   * @param {string} [opts.dbPath]
   * @param {import('./payments.js').MockPayments | import('./payments.js').StripePayments} [opts.payments]
   * @param {'mock' | 'manual'} [opts.fulfillment] mock ships itself on the account clock; manual waits for an operator
   * @param {'test' | 'live'} [opts.mode] live accounts run on the real clock and cannot advance it
   */
  constructor({ dbPath = ':memory:', payments = new MockPayments(), fulfillment = 'mock', mode = 'test' } = {}) {
    if (!['mock', 'manual'].includes(fulfillment)) throw new Error(`Unknown fulfillment mode '${fulfillment}'.`);
    if (!['test', 'live'].includes(mode)) throw new Error(`Unknown mode '${mode}'.`);
    this.db = openDb(dbPath);
    this.products = new Map(PRODUCTS.map((x) => [x.sku, x]));
    this.payments = payments;
    this.fulfillment = fulfillment;
    this.mode = mode;
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

  createAccount({ name, email, household_size = 2, policy = {}, start_date } = {}) {
    if (!name || typeof name !== 'string') throw badRequest('missing_param', 'name is required.', { param: 'name', hint: 'Pass a display name for the household, e.g. "Rafiq household".' });
    if (!Number.isInteger(household_size) || household_size < 1 || household_size > 20) {
      throw badRequest('invalid_param', 'household_size must be an integer from 1 to 20.', { param: 'household_size' });
    }
    if (start_date != null && (this.mode === 'live' || !isDate(start_date))) throw badRequest('invalid_param', 'start_date must be YYYY-MM-DD, and is only allowed in test mode.', { param: 'start_date' });
    const accountId = id('acct');
    const apiKey = `ck_${this.mode}_${randomBytes(18).toString('base64url')}`;
    const ownerKey = `ok_${this.mode}_${randomBytes(18).toString('base64url')}`;
    const now = start_date ? `${start_date}T12:00:00.000Z` : new Date().toISOString();
    const merged = this.#validatePolicy({ ...DEFAULT_POLICY, ...policy });
    this.db.prepare(`INSERT INTO accounts (id, name, email, mode, api_key_hash, owner_key_hash, household_size, policy_json, clock, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(accountId, name, email ?? null, this.mode, hash(apiKey), hash(ownerKey), household_size, j(merged), now, now);
    this.#emit(accountId, 'account.created', { account_id: accountId });
    return {
      account: this.getAccount(accountId),
      api_key: apiKey,
      owner_key: ownerKey,
      note: 'api_key is for the agent. owner_key is for the human: it approves held orders and changes spend policy. Neither is shown again.',
    };
  }

  /** Resolve a bearer key to { account, role } where role is 'agent' or 'owner'. */
  authenticate(key) {
    if (!key) throw unauthorized('Missing API key.', 'Send "Authorization: Bearer ck_test_..." (create one with POST /v1/accounts).');
    const h = hash(key);
    const agent = this.db.prepare('SELECT id FROM accounts WHERE api_key_hash = ?').get(h);
    if (agent) return { accountId: agent.id, role: 'agent' };
    const owner = this.db.prepare('SELECT id FROM accounts WHERE owner_key_hash = ?').get(h);
    if (owner) return { accountId: owner.id, role: 'owner' };
    throw unauthorized('Invalid API key.', 'Check the key, or create a new sandbox account with POST /v1/accounts.');
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
    this.db.prepare('INSERT INTO addresses (id, account_id, json, created_at) VALUES (?, ?, ?, ?)').run(addrId, a.id, j(body), a.clock);
    if (set_default || !a.default_address_id) this.db.prepare('UPDATE accounts SET default_address_id = ? WHERE id = ?').run(addrId, a.id);
    return { id: addrId, ...body };
  }

  listAddresses(auth) {
    return this.db.prepare('SELECT * FROM addresses WHERE account_id = ? ORDER BY created_at, rowid').all(auth.accountId).map((x) => ({ id: x.id, ...p(x.json) }));
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
    const rows = this.db.prepare("SELECT amounts_json FROM orders WHERE account_id = ? AND status IN ('paid', 'payment_pending') AND substr(created_at, 1, 7) = ?").all(accountId, month);
    return rows.reduce((s, r) => s + p(r.amounts_json).total_cents, 0);
  }

  #policyCheck(account, lines, total) {
    const policy = p(account.policy_json);
    const reasons = [];
    if (policy.approval_required_above_cents != null && total > policy.approval_required_above_cents) {
      reasons.push({ code: 'above_approval_threshold', message: `Order total ${total} exceeds approval threshold ${policy.approval_required_above_cents}.` });
    }
    if (policy.per_order_limit_cents != null && total > policy.per_order_limit_cents) {
      reasons.push({ code: 'per_order_limit', message: `Order total ${total} exceeds per-order limit ${policy.per_order_limit_cents}.` });
    }
    const spent = this.#monthSpend(account.id, dateOf(account.clock));
    if (policy.monthly_limit_cents != null && spent + total > policy.monthly_limit_cents) {
      reasons.push({ code: 'monthly_limit', message: `This order would bring monthly spend to ${spent + total}, over the limit of ${policy.monthly_limit_cents}.` });
    }
    if (policy.allowed_categories) {
      const bad = [...new Set(lines.map((l) => l.category).filter((c) => !policy.allowed_categories.includes(c)))];
      if (bad.length) reasons.push({ code: 'category_not_allowed', message: `Categories not allowed by policy: ${bad.join(', ')}.` });
    }
    return reasons;
  }

  quote(auth, { items, subscription = true, cadence_days, payment_method_id }) {
    const account = this.#account(auth.accountId);
    const norm = this.#normalizeItems(items);
    const pmId = payment_method_id ?? account.default_payment_method_id;
    const priced = this.price(norm, { subscription, bank: pmId ? this.#pm(account.id, pmId).type === 'bank' : false });
    const reasons = this.#policyCheck(account, priced.lines, priced.amounts.total_cents);
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
    const priced = this.price(items, { subscription: !!subscriptionId, bank: this.#pm(account.id, pmId).type === 'bank' });
    const orderId = id('ord');
    const now = account.clock;
    this.db.prepare(`INSERT INTO orders (id, account_id, subscription_id, status, lines_json, amounts_json, address_id, payment_method_id, charges_json, fulfill_on, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, '[]', ?, ?, ?)`).run(orderId, account.id, subscriptionId, j(priced.lines), j(priced.amounts), addrId, pmId, fulfillOn, now, now);
    const reasons = this.#policyCheck(account, priced.lines, priced.amounts.total_cents);
    if (reasons.length) {
      const apprId = id('appr');
      this.db.prepare(`INSERT INTO approvals (id, account_id, order_id, status, reasons_json, amount_cents, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`)
        .run(apprId, account.id, orderId, j(reasons), priced.amounts.total_cents, now);
      this.db.prepare("UPDATE orders SET status = 'requires_approval', approval_id = ? WHERE id = ?").run(apprId, orderId);
      this.#emit(account.id, 'approval.requested', { approval_id: apprId, order_id: orderId, reasons });
      return this.getOrder({ accountId: account.id }, orderId);
    }
    await this.#chargeAndFulfill(account, orderId);
    return this.getOrder({ accountId: account.id }, orderId);
  }

  async #chargeAndFulfill(account, orderId) {
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
      how_to_resolve: a.status === 'pending' ? 'The account owner approves or rejects with POST /v1/approvals/{id}/approve|reject using the owner_key. Agents cannot approve.' : undefined,
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
      await this.#chargeAndFulfill(account, a.order_id);
      this.#syncSubscriptionAfterPayment(account, a.order_id);
    } else {
      this.db.prepare("UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?").run(account.clock, a.order_id);
      this.#emit(account.id, 'order.canceled', { order_id: a.order_id, reason: 'approval_rejected' });
    }
    return this.getOrder(auth, a.order_id);
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
    for (const o of this.db.prepare("SELECT * FROM orders WHERE account_id = ? AND status = 'payment_pending' ORDER BY created_at, rowid").all(accountId)) {
      const charges = p(o.charges_json);
      const last = charges.at(-1);
      const pm = this.#pm(accountId, last.payment_method_id);
      const result = await this.payments.checkCharge({ ref: last.provider_ref, pmRef: pm.token, chargedOn: dateOf(last.created_at), today });
      if (result.status === 'pending') continue;
      charges[charges.length - 1] = { ...last, status: result.status, failure_code: result.failure_code, settled_at: account.clock };
      this.#settle(account, o.id, charges, result);
      this.#syncSubscriptionAfterPayment(this.#account(accountId), o.id);
    }

    const subs = this.db.prepare("SELECT s.*, pm.type AS pm_type FROM subscriptions s LEFT JOIN payment_methods pm ON pm.id = s.payment_method_id WHERE s.account_id = ? AND s.status = 'active'").all(accountId);
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
    return this.db.prepare(`SELECT o.*, s.status AS shipment_status, a.name AS account_name, a.email AS account_email
      FROM shipments s JOIN orders o ON o.id = s.order_id JOIN accounts a ON a.id = o.account_id
      WHERE s.status = ? ORDER BY o.created_at, o.rowid`).all(status).map((o) => {
      const order = this.#presentOrder(o);
      return {
        ...order,
        // Operator-only: the retail listing to buy for each line (never shown to agents).
        lines: order.lines.map((l) => ({ ...l, source: this.products.get(l.sku)?.source ?? null })),
        account: { id: o.account_id, name: o.account_name, email: o.account_email },
        ship_to: p(this.db.prepare('SELECT json FROM addresses WHERE id = ?').get(o.address_id).json),
      };
    });
  }

  #operatorShipment(orderId, from) {
    const sh = this.db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(orderId);
    if (!sh) throw notFound('shipment', orderId, 'Only paid orders have shipments.');
    if (sh.status !== from) throw conflict('invalid_shipment_state', `Shipment is ${sh.status}, expected ${from}.`);
    return sh;
  }

  markShipped(orderId, { carrier, tracking_number } = {}) {
    if (!carrier || !tracking_number) throw badRequest('missing_param', 'carrier and tracking_number are required.', { hint: 'e.g. carrier "UPS", tracking_number "1Z..."' });
    const sh = this.#operatorShipment(orderId, 'awaiting_fulfillment');
    const now = this.#account(sh.account_id).clock;
    this.db.prepare("UPDATE shipments SET status = 'shipped', carrier = ?, tracking_number = ?, shipped_at = ? WHERE id = ?").run(carrier, tracking_number, now, sh.id);
    this.#emit(sh.account_id, 'shipment.shipped', { shipment_id: sh.id, order_id: orderId, carrier, tracking_number });
    return this.#presentOrder(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  }

  markDelivered(orderId) {
    const sh = this.#operatorShipment(orderId, 'shipped');
    this.db.prepare("UPDATE shipments SET status = 'delivered', delivered_at = ? WHERE id = ?").run(this.#account(sh.account_id).clock, sh.id);
    this.#emit(sh.account_id, 'shipment.delivered', { shipment_id: sh.id, order_id: orderId });
    this.#afterDelivery(sh.account_id);
    return this.#presentOrder(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
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
