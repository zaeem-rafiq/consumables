// MCP server: the same capabilities as the HTTP API, shaped as tools an agent
// can discover and call without reading docs.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiError } from './errors.js';

const item = z.object({ sku: z.string().describe('Product SKU, e.g. TP-2PLY-30'), quantity: z.number().int().min(1).max(50).default(1) });
const items = z.array(item).min(1).describe('Line items: [{ sku, quantity }]');
const subId = z.string().describe('Subscription id (sub_...)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date as YYYY-MM-DD, in the account clock');
const idemKey = z.string().max(255).optional().describe('Optional. Reuse the same key when retrying so the action runs at most once.');

const INSTRUCTIONS = `Domaru sells everyday household supplies (toilet paper, paper towels, dish soap, trash bags, detergent...) on subscription, built for agents.
Typical flow: recommend_bundle -> quote -> create_subscription. Then manage with update_subscription, pause_subscription, skip_next_delivery, ship_now, report_supply_level and cancel_subscription.
Prices are integer cents (USD). Subscriptions get 5% off; orders of $35+ after discount ship free.
Spend policy is set by the human owner. Orders over policy are held with status "requires_approval"; tell the human, do not retry. Agents cannot approve orders or raise limits.
No account yet? Call create_account: it returns an api_key and attaches it to this session (stdio). To pay, call create_card_setup_link and send the URL to the human so they can save a card (in test mode you can pass payment_token pm_card_visa instead).
Sandbox only: advance_test_clock moves time forward to simulate renewals and deliveries.`;

/**
 * @param {import('./store.js').Store} store
 * @param {{ apiKey?: string }} session  mutable; create_account sets apiKey when allowed
 * @param {{ attachKeyOnSignup?: boolean }} opts
 */
export function buildMcpServer(store, session, { attachKeyOnSignup = true } = {}) {
  const server = new McpServer({ name: 'domaru', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const auth = () => store.authenticate(session.apiKey);
  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const fail = (err) => {
    const body = err instanceof ApiError ? err.toJSON() : { error: { code: 'internal_error', message: String(err?.message ?? err) } };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  };
  const tool = (name, { description, input = {}, readOnly = false, destructive = false, title }, fn) => {
    server.registerTool(name, {
      title,
      description,
      inputSchema: input,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false },
    }, async (args) => {
      try { return ok(await fn(args ?? {})); } catch (e) { return fail(e); }
    });
  };
  const idem = (args, op, fn) => {
    const a = auth();
    const { idempotency_key, ...rest } = args;
    return store.idempotent(a, idempotency_key && `mcp:${idempotency_key}`, JSON.stringify([op, rest]), () => fn(a, rest));
  };

  // ---- catalog (no account needed)
  tool('list_categories', { title: 'List categories', description: 'List product categories with product counts.', readOnly: true }, () => store.listCategories());

  tool('search_products', {
    title: 'Search products',
    description: 'Search the catalog. Returns price, pack size, unit price and a usage model for each product. Empty query lists everything.',
    readOnly: true,
    input: {
      query: z.string().optional().describe('Words to match, e.g. "toilet paper" or "unscented"'),
      category: z.string().optional().describe('Category id from list_categories'),
      tag: z.string().optional().describe('e.g. eco, bestseller, reusable'),
    },
  }, ({ query, category, tag }) => store.listProducts({ q: query, category, tag }));

  tool('get_product', { title: 'Get product', description: 'Full details for one SKU.', readOnly: true, input: { sku: z.string() } }, ({ sku }) => store.getProduct(sku));

  tool('recommend_bundle', {
    title: 'Recommend a bundle',
    description: 'Suggest quantities for a recurring delivery based on household size and cadence. Without skus, returns a starter bundle of everyday essentials.',
    readOnly: true,
    input: {
      household_size: z.number().int().min(1).max(20).optional().describe('People in the household; defaults to the account value'),
      skus: z.array(z.string()).optional().describe('Limit the bundle to these SKUs'),
      cadence_days: z.number().int().min(7).max(180).default(28),
    },
  }, (args) => store.recommend(session.apiKey ? auth() : null, args));

  // ---- account
  tool('create_account', {
    title: 'Create account',
    description: 'Create an account. Returns an agent api_key and an owner_key for the human. Optionally attaches a test card (test mode only) and a shipping address so you can subscribe right away.',
    input: {
      name: z.string().describe('Household name'),
      email: z.string().optional(),
      household_size: z.number().int().min(1).max(20).default(2),
      payment_token: z.string().optional().describe('Test mode card token, e.g. pm_card_visa'),
      address: z.object({
        name: z.string(), line1: z.string(), line2: z.string().optional(), city: z.string(), region: z.string(), postal_code: z.string(), phone: z.string().optional(),
      }).optional(),
    },
  }, async ({ name, email, household_size, payment_token, address }) => {
    const created = store.createAccount({ name, email, household_size });
    const a = { accountId: created.account.id, role: 'agent' };
    if (payment_token) await store.addPaymentMethod(a, { token: payment_token });
    if (address) store.addAddress(a, address);
    if (attachKeyOnSignup) session.apiKey = created.api_key;
    return {
      ...created,
      account: store.getAccount(a.accountId),
      session: attachKeyOnSignup
        ? 'This api_key is now attached to this MCP session.'
        : 'Reconnect with header "Authorization: Bearer <api_key>" to use account tools.',
    };
  });

  tool('get_account', { title: 'Get account', description: 'Account details, spend policy, month-to-date spend and the account clock.', readOnly: true }, () => store.getAccount(auth().accountId));

  tool('update_household', {
    title: 'Update household',
    description: 'Change household size (used for recommendations).',
    input: { household_size: z.number().int().min(1).max(20) },
  }, ({ household_size }) => store.updateAccount(auth(), { household_size }));

  tool('add_payment_method', {
    title: 'Add payment method',
    description: 'Test mode only: attach a card from a token (pm_card_visa, pm_card_mastercard, pm_card_declined, pm_card_insufficient_funds). For real cards use create_card_setup_link.',
    input: { token: z.string(), set_default: z.boolean().default(true) },
  }, (args) => store.addPaymentMethod(auth(), args));

  tool('create_card_setup_link', {
    title: 'Create card setup link',
    description: 'Get a secure Stripe page where the human saves their card. Send the URL to the account owner; the saved card becomes the default. Nothing is charged.',
  }, () => store.createCardSetupLink(auth()));

  tool('list_payment_methods', { title: 'List payment methods', description: 'Cards on file.', readOnly: true }, () => store.listPaymentMethods(auth()));

  tool('add_address', {
    title: 'Add shipping address',
    description: 'Add a US shipping address.',
    input: {
      name: z.string(), line1: z.string(), line2: z.string().optional(), city: z.string(), region: z.string().describe('State, e.g. NY'),
      postal_code: z.string(), phone: z.string().optional().describe('Recipient phone for the delivery carrier (recommended)'), set_default: z.boolean().default(true),
    },
  }, (args) => store.addAddress(auth(), args));

  tool('list_addresses', { title: 'List addresses', description: 'Shipping addresses on file.', readOnly: true }, () => store.listAddresses(auth()));

  // ---- pricing
  tool('quote', {
    title: 'Quote',
    description: 'Price a basket exactly as it would be charged, and say whether spend policy would hold it for human approval. Nothing is charged.',
    readOnly: true,
    input: { items, subscription: z.boolean().default(true), cadence_days: z.number().int().min(7).max(180).optional() },
  }, (args) => store.quote(auth(), args));

  // ---- subscriptions
  tool('create_subscription', {
    title: 'Create subscription',
    description: 'Start a recurring delivery. The first order is placed on start_date (default: today). Uses the default address and card unless given.',
    input: {
      items, cadence_days: z.number().int().min(7).max(180).default(28), start_date: date.optional(),
      address_id: z.string().optional(), payment_method_id: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(), idempotency_key: idemKey,
    },
  }, (args) => idem(args, 'create_subscription', (a, rest) => store.createSubscription(a, rest)));

  tool('list_subscriptions', {
    title: 'List subscriptions', description: 'All subscriptions, optionally filtered by status (active, paused, past_due, canceled).', readOnly: true,
    input: { status: z.enum(['active', 'paused', 'past_due', 'canceled']).optional() },
  }, (args) => store.listSubscriptions(auth(), args));

  tool('get_subscription', { title: 'Get subscription', description: 'One subscription with its next order estimate and latest order.', readOnly: true, input: { subscription_id: subId } },
    ({ subscription_id }) => store.getSubscription(auth(), subscription_id));

  tool('update_subscription', {
    title: 'Update subscription',
    description: 'Change items (replaces the list), cadence, next order date, address or card. Changing the card on a past_due subscription retries the failed payment.',
    input: {
      subscription_id: subId, items: items.optional(), cadence_days: z.number().int().min(7).max(180).optional(),
      next_order_date: date.optional(), address_id: z.string().optional(), payment_method_id: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    },
  }, ({ subscription_id, ...patch }) => store.updateSubscription(auth(), subscription_id, patch));

  tool('pause_subscription', {
    title: 'Pause subscription', description: 'Pause deliveries, optionally until a date (auto-resumes then).',
    input: { subscription_id: subId, until: date.optional() },
  }, ({ subscription_id, until }) => store.pauseSubscription(auth(), subscription_id, { until }));

  tool('resume_subscription', { title: 'Resume subscription', description: 'Resume a paused subscription. If an order was due during the pause it ships today.', input: { subscription_id: subId } },
    ({ subscription_id }) => store.resumeSubscription(auth(), subscription_id));

  tool('skip_next_delivery', { title: 'Skip next delivery', description: 'Push the next order back by one cadence.', input: { subscription_id: subId } },
    ({ subscription_id }) => store.skipNext(auth(), subscription_id));

  tool('ship_now', { title: 'Ship now', description: 'Place the next order today and restart the cadence from today.', input: { subscription_id: subId } },
    ({ subscription_id }) => store.shipNow(auth(), subscription_id));

  tool('report_supply_level', {
    title: 'Report supply level',
    description: 'Tell us the household is running low (ships now and shortens cadence ~15%) or overstocked (skips ahead and lengthens cadence ~15%).',
    input: { subscription_id: subId, signal: z.enum(['running_low', 'overstocked']) },
  }, ({ subscription_id, signal }) => store.reportSignal(auth(), subscription_id, { signal }));

  tool('cancel_subscription', {
    title: 'Cancel subscription', description: 'Cancel permanently. Orders already placed still ship.', destructive: true,
    input: { subscription_id: subId, reason: z.string().optional() },
  }, ({ subscription_id, reason }) => store.cancelSubscription(auth(), subscription_id, { reason }));

  // ---- orders
  tool('place_order', {
    title: 'Place one-time order', description: 'Buy once, no subscription (no subscription discount).',
    input: { items, address_id: z.string().optional(), payment_method_id: z.string().optional(), idempotency_key: idemKey },
  }, (args) => idem(args, 'place_order', (a, rest) => store.createOrder(a, rest)));

  tool('list_orders', {
    title: 'List orders', description: 'Orders, newest first, with payment and shipment status.', readOnly: true,
    input: { subscription_id: z.string().optional(), status: z.enum(['paid', 'requires_approval', 'payment_failed', 'canceled']).optional(), limit: z.number().int().min(1).max(200).default(20) },
  }, (args) => store.listOrders(auth(), args));

  tool('get_order', { title: 'Get order', description: 'One order with charges, approval and shipment tracking.', readOnly: true, input: { order_id: z.string() } },
    ({ order_id }) => store.getOrder(auth(), order_id));

  tool('list_approvals', {
    title: 'List approvals', description: 'Orders held for the human owner because they exceed spend policy.', readOnly: true,
    input: { status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending') },
  }, (args) => store.listApprovals(auth(), args));

  tool('list_events', {
    title: 'List events', description: 'Account activity feed (orders, shipments, approvals, subscription changes). Pass next_after back as after to poll for new events.', readOnly: true,
    input: { after: z.number().int().min(0).default(0), type: z.string().optional(), limit: z.number().int().min(1).max(1000).default(100) },
  }, (args) => store.listEvents(auth(), args));

  tool('advance_test_clock', {
    title: 'Advance test clock', description: 'Sandbox only. Move the account clock forward N days, running renewals, shipping and deliveries. Returns the events that happened.',
    input: { days: z.number().int().min(1).max(400) },
  }, ({ days }) => store.advanceClock(auth(), { days }));

  return server;
}
