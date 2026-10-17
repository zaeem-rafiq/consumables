// Google's Universal Commerce Protocol (UCP), checkout capability over REST.
//
// Spec: https://ucp.dev/2026-08-25/specification/shopping/checkout/rest/
// We implement dev.ucp.shopping.checkout with the fulfillment extension.
// Checkouts are bound to a Consumables account (Bearer agent key), so the
// owner's spend policy applies exactly as it does on the REST API and MCP:
// an order over policy comes back as requires_escalation and waits for the owner.
// Payment uses the card the owner saved on the account; agents can't bring a
// new card through UCP.

import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';

export const UCP_VERSION = '2026-08-25';
const SPEC = `https://ucp.dev/${UCP_VERSION}`;
const CHECKOUT_TTL_MS = 6 * 60 * 60 * 1000;
const HANDLER_NAME = 'com.consumables.account_card';
const HANDLER_ID = 'account_card';

const capabilities = () => ({
  'dev.ucp.shopping.checkout': [{ version: UCP_VERSION, spec: `${SPEC}/specification/shopping/checkout`, schema: `${SPEC}/schemas/shopping/checkout.json` }],
  'dev.ucp.shopping.fulfillment': [{
    version: UCP_VERSION, spec: `${SPEC}/specification/shopping/extensions/fulfillment`, schema: `${SPEC}/schemas/shopping/fulfillment.json`, extends: 'dev.ucp.shopping.checkout',
  }],
});

const paymentHandlers = (base) => ({
  [HANDLER_NAME]: [{
    id: HANDLER_ID,
    version: UCP_VERSION,
    spec: `${base}/llms.txt`,
    available_instruments: [{ type: 'card' }],
    config: { description: "Charges the card the account owner saved. Send the instrument id from payment.instruments, or omit it to use the default card." },
  }],
});

/** Public business profile served at /.well-known/ucp. */
export function ucpProfile(base) {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': [{
          version: UCP_VERSION, spec: `${SPEC}/specification/overview/`, transport: 'rest', endpoint: `${base}/ucp`, schema: `${SPEC}/services/shopping/rest.openapi.json`,
        }],
      },
      capabilities: capabilities(),
      payment_handlers: paymentHandlers(base),
    },
  };
}

class UcpError extends Error {
  constructor(status, code, content) {
    super(content);
    this.status = status;
    this.code = code;
  }
}

const msg = (code, content, { type = 'error', severity = 'recoverable', path } = {}) => ({ type, code, content, ...(type === 'error' ? { severity } : {}), ...(path ? { path } : {}) });
const ucpId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;

export class Ucp {
  constructor(store, { base }) {
    this.store = store;
    this.db = store.db;
    this.base = base;
  }

  // ------------------------------------------------------------ storage

  #load(auth, id) {
    const row = this.db.prepare('SELECT * FROM ucp_checkouts WHERE id = ? AND account_id = ?').get(id, auth.accountId);
    if (!row) throw new UcpError(404, 'not_found', `No checkout session ${id}.`);
    return JSON.parse(row.json);
  }

  #save(auth, c) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO ucp_checkouts (id, account_id, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`).run(c.id, auth.accountId, JSON.stringify(c), now, now);
  }

  // ------------------------------------------------------------ inputs

  /** Validate line items; unknown items become messages instead of failures. */
  #readLines(lineItems, messages) {
    if (!Array.isArray(lineItems)) throw new UcpError(400, 'invalid_request', 'line_items must be a list of { item: { id }, quantity }.');
    const out = [];
    lineItems.forEach((li, i) => {
      const sku = li?.item?.id;
      const quantity = li?.quantity ?? 1;
      if (typeof sku !== 'string' || !this.store.products.has(sku)) {
        messages.push(msg('item_unavailable', `We don't sell an item with id '${sku}'. Search the catalog at ${this.base}/v1/products.`, { path: `$.line_items[${i}].item.id`, severity: 'unrecoverable' }));
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        messages.push(msg('invalid_quantity', 'Quantity must be a whole number from 1 to 50.', { path: `$.line_items[${i}].quantity` }));
        return;
      }
      out.push({ id: typeof li.id === 'string' && li.id ? li.id : `li_${out.length + 1}`, sku, quantity });
    });
    return out;
  }

  /** Pick the shipping destination: an address already on file by id, or a new one added to the account. */
  #readDestination(auth, fulfillment, current, messages) {
    const method = fulfillment?.methods?.find((m) => m?.type === 'shipping');
    if (!method) return current;
    const dests = Array.isArray(method.destinations) ? method.destinations : [];
    const wanted = method.selected_destination_id ?? dests[0]?.id;
    const known = new Set(this.store.listAddresses(auth).map((a) => a.id));
    if (wanted && known.has(wanted)) return wanted;
    const d = dests.find((x) => x.id === wanted) ?? dests[0];
    if (!d) return current;
    if (d.address_country && d.address_country !== 'US') {
      messages.push(msg('address_undeliverable', 'We only deliver in the US right now.', { path: '$.fulfillment.methods[0].destinations[0].address_country', severity: 'requires_buyer_input' }));
      return current;
    }
    const name = [d.first_name, d.last_name].filter(Boolean).join(' ') || this.store.getAccount(auth.accountId).name;
    try {
      return this.store.addAddress(auth, {
        name, line1: d.street_address, line2: d.extended_address, city: d.address_locality, region: d.address_region, postal_code: d.postal_code, phone: d.phone_number, set_default: false,
      }).id;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      messages.push(msg('address_incomplete', `The shipping address is incomplete: ${err.message}`, { path: '$.fulfillment.methods[0].destinations[0]', severity: 'requires_buyer_input' }));
      return current;
    }
  }

  // ------------------------------------------------------------ output

  #present(auth, c, extraMessages = []) {
    const account = this.store.getAccount(auth.accountId);
    this.#syncWithOrder(auth, c);
    const messages = [...(c.messages ?? []), ...extraMessages];
    const priced = c.lines.length ? this.store.price(c.lines, { subscription: false }) : null;
    const a = priced?.amounts;
    const addresses = this.store.listAddresses(auth);
    const destinationId = c.destination_id ?? account.default_address_id;
    const cards = this.store.listPaymentMethods(auth);
    const open = !['completed', 'canceled', 'requires_escalation'].includes(c.status);

    if (open) {
      if (!c.lines.length) messages.push(msg('missing', 'Add at least one item.', { path: '$.line_items', severity: 'requires_buyer_input' }));
      if (!destinationId) messages.push(msg('missing', 'Add a shipping address.', { path: '$.fulfillment.methods[0].destinations', severity: 'requires_buyer_input' }));
      if (!cards.length) {
        messages.push(msg('payment_method_required', `No card on file. Ask the account owner to save one: POST ${this.base}/v1/payment_methods/setup_link returns a link for them.`, { severity: 'requires_buyer_input', path: '$.payment' }));
      }
      if (priced && destinationId) {
        const q = this.store.quote(auth, { items: c.lines, subscription: false });
        if (q.policy.would_require_approval) {
          messages.push(msg('owner_approval_required', `This order is outside the owner's spending limits (${q.policy.reasons.join('; ')}). Completing it sends it to the owner for approval; nothing is charged until they approve.`, { type: 'info' }));
        }
      }
      c.status = c.lines.length && destinationId && cards.length ? 'ready_for_complete' : 'incomplete';
    }

    const lineItems = c.lines.map((l) => {
      const prod = this.store.products.get(l.sku);
      const total = prod.price_cents * l.quantity;
      return { id: l.id, item: { id: l.sku, title: prod.name, price: prod.price_cents }, quantity: l.quantity, totals: [{ type: 'subtotal', amount: total }, { type: 'total', amount: total }] };
    });
    const totals = a ? [
      { type: 'subtotal', amount: a.subtotal_cents },
      { type: 'fulfillment', amount: a.shipping_cents, display_text: a.shipping_cents ? 'Shipping' : 'Free shipping' },
      { type: 'tax', amount: a.tax_cents },
      { type: 'total', amount: a.total_cents },
    ] : [{ type: 'subtotal', amount: 0 }, { type: 'total', amount: 0 }];

    const out = {
      ucp: { version: UCP_VERSION, capabilities: capabilities(), payment_handlers: paymentHandlers(this.base) },
      id: c.id,
      status: c.status,
      currency: 'USD',
      line_items: lineItems,
      totals,
      messages,
      links: [
        { type: 'terms_of_service', url: `${this.base}/terms` },
        { type: 'privacy_policy', url: `${this.base}/privacy` },
      ],
      expires_at: c.expires_at,
      fulfillment: {
        methods: [{
          id: 'shipping_1',
          type: 'shipping',
          line_item_ids: lineItems.map((l) => l.id),
          selected_destination_id: destinationId ?? null,
          destinations: addresses.map((x) => ({
            type: 'shipping_address', id: x.id, street_address: x.line1, ...(x.line2 ? { extended_address: x.line2 } : {}),
            address_locality: x.city, address_region: x.region, postal_code: x.postal_code, address_country: x.country ?? 'US',
          })),
          groups: [{
            id: 'package_1',
            line_item_ids: lineItems.map((l) => l.id),
            selected_option_id: 'standard',
            options: [{
              id: 'standard', title: 'Standard delivery',
              description: { plain: `Free over $35, otherwise $${((a?.shipping_cents || 599) / 100).toFixed(2)}. Usually arrives in 2 to 5 days.` },
              totals: [{ type: 'total', amount: a?.shipping_cents ?? 0 }],
            }],
          }],
        }],
      },
      payment: {
        instruments: cards.map((pm) => ({
          id: pm.id, handler_id: HANDLER_ID, type: 'card', selected: pm.id === (c.payment_method_id ?? account.default_payment_method_id),
          display: { brand: pm.brand, last_digits: pm.last4, description: `${pm.brand} •••• ${pm.last4}` },
        })),
      },
    };
    if (c.buyer) out.buyer = c.buyer;
    if (c.status === 'requires_escalation') out.continue_url = `${this.base}/approvals/${c.approval_id}`;
    if (c.order_id && c.status === 'completed') out.order = { id: c.order_id, label: `Order ${c.order_id}`, permalink_url: `${this.base}/v1/orders/${c.order_id}` };
    return out;
  }

  /** A held order changes when the owner decides; reflect that on the checkout. */
  #syncWithOrder(auth, c) {
    if (c.status !== 'requires_escalation' || !c.order_id) return;
    const order = this.store.getOrder(auth, c.order_id);
    if (order.status === 'paid') c.status = 'completed';
    else if (order.status === 'canceled') { c.status = 'canceled'; c.messages = [msg('owner_rejected', 'The account owner declined this order.', { severity: 'unrecoverable' })]; }
    else if (order.status === 'payment_failed') { c.status = 'canceled'; c.messages = [msg('payment_failed', 'The owner approved the order but the card was declined.', { severity: 'unrecoverable' })]; }
    else return;
    this.#save(auth, c);
  }

  // ------------------------------------------------------------ operations

  create(auth, body) {
    const messages = [];
    const lines = this.#readLines(body.line_items ?? [], messages);
    if (!lines.length && (body.line_items ?? []).length) {
      return { status: 200, body: { ucp: { version: UCP_VERSION, status: 'error' }, messages, continue_url: `${this.base}/` } };
    }
    const c = {
      id: ucpId('chk'), status: 'incomplete', lines, buyer: body.buyer ?? null, messages: [],
      expires_at: new Date(Date.now() + CHECKOUT_TTL_MS).toISOString(),
    };
    c.destination_id = this.#readDestination(auth, body.fulfillment, null, messages);
    const out = this.#present(auth, c, messages);
    this.#save(auth, c);
    return { status: 201, body: out };
  }

  get(auth, id) {
    const c = this.#load(auth, id);
    return { status: 200, body: this.#present(auth, c) };
  }

  update(auth, id, body) {
    const c = this.#load(auth, id);
    if (['completed', 'canceled'].includes(c.status)) {
      return { status: 200, body: this.#present(auth, c, [msg('checkout_closed', `This checkout is ${c.status} and can't be changed.`, { severity: 'unrecoverable' })]) };
    }
    if (c.status === 'requires_escalation') {
      return { status: 200, body: this.#present(auth, c, [msg('awaiting_owner', 'This order is waiting for the owner. Cancel the checkout to change it.')]) };
    }
    const messages = [];
    c.lines = this.#readLines(body.line_items ?? [], messages);
    c.buyer = body.buyer ?? null;
    c.destination_id = this.#readDestination(auth, body.fulfillment, c.destination_id, messages);
    const out = this.#present(auth, c, messages);
    this.#save(auth, c);
    return { status: 200, body: out };
  }

  async complete(auth, id, body) {
    const c = this.#load(auth, id);
    if (c.status === 'completed' || c.status === 'requires_escalation') return { status: 200, body: this.#present(auth, c) };
    if (c.status === 'canceled') return { status: 200, body: this.#present(auth, c, [msg('checkout_closed', 'This checkout was canceled.', { severity: 'unrecoverable' })]) };
    if (Date.parse(c.expires_at) < Date.now()) {
      c.status = 'canceled';
      this.#save(auth, c);
      return { status: 200, body: this.#present(auth, c, [msg('checkout_expired', 'This checkout expired. Start a new one.', { severity: 'unrecoverable' })]) };
    }
    const instrument = body?.payment?.instruments?.find((x) => x.selected !== false) ?? body?.payment?.instruments?.[0];
    if (!instrument) throw new UcpError(400, 'invalid_request', 'payment.instruments must contain the selected instrument.');
    if (instrument.handler_id !== HANDLER_ID) {
      return { status: 200, body: this.#present(auth, c, [msg('payment_handler_unsupported', `Use the ${HANDLER_ID} handler: it charges the card the owner saved on the account.`, { path: '$.payment.instruments[0].handler_id' })]) };
    }
    const pmId = instrument.credential?.token ?? instrument.id;
    if (pmId && !this.store.listPaymentMethods(auth).some((pm) => pm.id === pmId)) {
      return { status: 200, body: this.#present(auth, c, [msg('payment_failed', 'That card is not on this account. Use one of the instruments listed in payment.instruments.', { path: '$.payment.instruments[0].id' })]) };
    }

    const view = this.#present(auth, c);
    if (view.status !== 'ready_for_complete') return { status: 200, body: view };

    c.payment_method_id = pmId ?? null;
    const order = await this.store.createOrder(auth, {
      items: c.lines.map(({ sku, quantity }) => ({ sku, quantity })), address_id: c.destination_id ?? undefined, payment_method_id: pmId ?? undefined,
    });
    c.order_id = order.id;
    const extra = [];
    if (order.status === 'paid') c.status = 'completed';
    else if (order.status === 'requires_approval') {
      c.status = 'requires_escalation';
      c.approval_id = order.approval.id;
      extra.push(msg('owner_approval_required', `Held for the account owner's approval: ${order.approval.reasons.join('; ')}. Nothing has been charged.`, { severity: 'requires_buyer_review' }));
    } else {
      c.status = 'ready_for_complete';
      c.order_id = null;
      extra.push(msg('payment_failed', `The card was declined (${order.charges.at(-1)?.failure_code ?? 'declined'}). Ask the owner to update their card, then complete again with a new Idempotency-Key.`, { severity: 'requires_buyer_input' }));
    }
    c.messages = extra.filter((m) => m.severity === 'requires_buyer_review');
    this.#save(auth, c);
    return { status: 200, body: this.#present(auth, c, extra.filter((m) => m.severity !== 'requires_buyer_review')) };
  }

  cancel(auth, id) {
    const c = this.#load(auth, id);
    if (['completed', 'canceled'].includes(c.status)) {
      return { status: 200, body: this.#present(auth, c, [msg('checkout_closed', `This checkout is already ${c.status}.`, { severity: 'unrecoverable' })]) };
    }
    if (c.status === 'requires_escalation' && c.order_id) this.store.withdrawOrder(auth, c.order_id, 'ucp_checkout_canceled');
    c.status = 'canceled';
    c.messages = [];
    this.#save(auth, c);
    return { status: 200, body: this.#present(auth, c) };
  }

  // ------------------------------------------------------------ HTTP

  /** Route a request under /ucp. Returns false if the path isn't ours. */
  async handle(req, res, url, { readBody, send, bearer }) {
    const m = /^\/ucp\/checkout-sessions(?:\/([^/]+))?(?:\/(complete|cancel))?$/.exec(url.pathname);
    if (!m) return false;
    try {
      const key = bearer(req) ?? req.headers['x-api-key'];
      if (!key) throw new UcpError(401, 'unauthorized', 'Send your Consumables agent key as Authorization: Bearer ck_... Create an account with POST /v1/accounts.');
      let auth;
      try {
        auth = this.store.authenticate(key);
      } catch {
        throw new UcpError(401, 'unauthorized', 'That API key is not valid.');
      }
      const [, id, action] = m;
      const body = req.method === 'GET' ? undefined : (await readBody(req)) ?? {};
      const run = async () => {
        if (req.method === 'POST' && !id) return this.create(auth, body);
        if (req.method === 'GET' && id && !action) return this.get(auth, id);
        if (req.method === 'PUT' && id && !action) return this.update(auth, id, body);
        if (req.method === 'POST' && id && action === 'complete') return this.complete(auth, id, body);
        if (req.method === 'POST' && id && action === 'cancel') return this.cancel(auth, id);
        throw new UcpError(405, 'method_not_allowed', `${req.method} is not supported on ${url.pathname}.`);
      };
      const idemKey = req.headers['idempotency-key'];
      const result = idemKey && req.method !== 'GET'
        ? await this.store.idempotent(auth, `ucp:${idemKey}`, createHash('sha256').update(`${req.method} ${url.pathname} ${JSON.stringify(body)}`).digest('hex'), run)
        : await run();
      const { status, body: out } = result;
      send(res, result.idempotent_replay && status === 201 ? 201 : status, out);
    } catch (err) {
      if (err instanceof UcpError) send(res, err.status, { code: err.code, content: err.message });
      else if (err instanceof ApiError) send(res, err.status, { code: err.code, content: err.hint ? `${err.message} ${err.hint}` : err.message });
      else {
        console.error(err);
        send(res, 500, { code: 'internal_error', content: 'Something went wrong on our side. Retry with the same Idempotency-Key.' });
      }
    }
    return true;
  }
}
