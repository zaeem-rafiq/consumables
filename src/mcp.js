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

const instructions = (base) => `Domaru sells everyday household supplies (toilet paper, paper towels, dish soap, trash bags, detergent...) on subscription, built for agents.
Typical flow: recommend_bundle -> quote -> create_subscription (recommend_bundle returns a plan of one to three deliveries, from frequent to slow for long-lasting items; create one subscription per plan entry so every item is covered). Then manage with update_subscription, pause_subscription, skip_next_delivery, ship_now, report_supply_level and cancel_subscription.
Prices are integer cents (USD). Subscriptions get 5% off; orders of $35+ after discount ship free.
Spend policy is set by the household's owner. An order outside it is still placed, but held with status "requires_approval": the owner gets an email with Approve and Decline buttons, and nothing is charged unless they approve. Tell the human it is waiting for the owner; do not retry, and never split it into smaller orders to stay under the limits. You cannot approve orders or change limits. The owner changes limits by signing in at ${base}/owner with their email (no password; Domaru emails a link).
Households connect Domaru from their assistant (Connect / sign in), which sets up the address, card and limits; you then shop within those limits. Developers without an account can call create_account (it emails the owner and returns an api_key attached to this session over stdio).
Problems with a delivery (never arrived, damaged, wrong or missing item): call report_problem; Domaru's team resolves it and you can read back the case. You cannot issue refunds. Before an order is bought from the retailer, cancel_order cancels it with a full refund.
Cards are the default. After the first delivery arrives, get_account shows bank_payments.offer: tell the human they can switch to bank payments and save 2% on every delivery, and send them the link from create_bank_setup_link.
Sandbox only: advance_test_clock moves time forward to simulate renewals and deliveries.`;

/**
 * @param {import('./store.js').Store} store
 * @param {{ apiKey?: string }} session  mutable; create_account sets apiKey when allowed
 * @param {{ attachKeyOnSignup?: boolean }} opts
 */
export function buildMcpServer(store, session, { attachKeyOnSignup = true } = {}) {
  const server = new McpServer({ name: 'domaru', version: '0.1.0' }, { instructions: instructions(store.publicUrl) });

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
    description: 'Suggest quantities for recurring deliveries based on household size and cadence. Returns plan: one to three deliveries (each with items and cadence_days), so long-lasting items come less often. Create one subscription per plan entry. Without skus, plans a starter set of everyday essentials.',
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
    description: "Developers: create an account with an agent api_key. Households should use Connect Domaru in their assistant instead. Domaru emails the owner a sign-in link; the owner approves held orders and sets limits, and limits start at the defaults. Optionally attaches a test card (test mode only) and a shipping address; the first order to an address you add waits for the owner's approval.",
    input: {
      name: z.string().describe('Household name'),
      email: z.string().describe("The account owner's email. They get the sign-in link and approval requests."),
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
    description: 'Test mode only: attach a card from a token (pm_card_visa, pm_card_mastercard, pm_card_declined, pm_card_insufficient_funds), or after the first delivery a bank account (pm_usBankAccount_success, pm_usBankAccount_insufficientFunds, pm_usBankAccount_accountClosed). For real cards use create_card_setup_link.',
    input: { token: z.string(), set_default: z.boolean().default(true) },
  }, (args) => store.addPaymentMethod(auth(), args));

  tool('create_card_setup_link', {
    title: 'Create card setup link',
    description: 'Get a secure Stripe page where the human saves their card. Send the URL to the account owner; the saved card becomes the default. Nothing is charged.',
  }, () => store.createCardSetupLink(auth()));

  tool('create_bank_setup_link', {
    title: 'Create bank setup link',
    description: 'After the first delivery arrives: get a secure Stripe page where the human signs in to their bank. Bank payers save 2% on every delivery and are charged a few business days before each one ships. Send the URL to the account owner; the account becomes the default and subscriptions switch to it. Offer it when get_account shows bank_payments.offer.',
  }, () => store.createBankSetupLink(auth()));

  tool('list_payment_methods', { title: 'List payment methods', description: 'Cards and bank accounts on file.', readOnly: true }, () => store.listPaymentMethods(auth()));

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
    description: 'Price a basket exactly as it would be charged, and say whether spend policy would hold it for human approval. Also lists any of these items already on the way or due from a subscription within a week (already_coming). Nothing is charged.',
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

  tool('skip_next_delivery', {
    title: 'Skip next delivery',
    description: 'Skip the next delivery (pushes it back one cadence). With skus, skip only those items in the next delivery: the rest still ships on time and the skipped items come back in the delivery after. To stop an item for good, use update_subscription to remove it.',
    input: { subscription_id: subId, skus: z.array(z.string()).optional().describe('Skip only these items, next delivery only') },
  }, ({ subscription_id, skus }) => store.skipNext(auth(), subscription_id, { skus }));

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
    title: 'Place one-time order', description: 'Buy once, no subscription (no subscription discount). Quote first: if the quote shows already_coming, tell the household what is already on the way and when, and only buy more if they clearly need it sooner or need more.',
    input: { items, address_id: z.string().optional(), payment_method_id: z.string().optional(), idempotency_key: idemKey },
  }, (args) => idem(args, 'place_order', (a, rest) => store.createOrder(a, rest)));

  tool('list_orders', {
    title: 'List orders', description: 'Orders, newest first, with payment and shipment status.', readOnly: true,
    input: { subscription_id: z.string().optional(), status: z.enum(['paid', 'payment_pending', 'requires_approval', 'payment_failed', 'canceled', 'refunded']).optional(), limit: z.number().int().min(1).max(200).default(20) },
  }, (args) => store.listOrders(auth(), args));

  tool('get_order', { title: 'Get order', description: 'One order with charges, approval and shipment tracking.', readOnly: true, input: { order_id: z.string() } },
    ({ order_id }) => store.getOrder(auth(), order_id));

  tool('cancel_order', {
    title: 'Cancel order',
    description: 'Cancel an order before Domaru has bought it from the retailer. A paid order is refunded in full to the card or bank it was paid with. Once bought it cannot be canceled; use report_problem instead.',
    destructive: true,
    input: { order_id: z.string(), reason: z.string().optional() },
  }, ({ order_id, reason }) => store.cancelOrder(auth(), order_id, { reason }));

  tool('report_problem', {
    title: 'Report a problem with an order',
    description: "Tell Domaru something went wrong with a delivery: never_arrived (tracking says delivered but it isn't there), damaged, wrong_item, missing_item, charged_wrong or other. Opens a case Domaru's team resolves with a refund or a free resend; read it back with get_case. Pass skus for the affected items only, a photo_url (https) for damage, and preferred: refund or resend if the household said. You cannot issue refunds yourself.",
    input: {
      order_id: z.string(),
      kind: z.enum(['never_arrived', 'damaged', 'wrong_item', 'missing_item', 'charged_wrong', 'other']),
      note: z.string().max(2000).optional().describe("What the household said, in a sentence or two"),
      photo_url: z.string().url().optional(),
      skus: z.array(z.string()).optional().describe('Only the affected items; omit for the whole order'),
      preferred: z.enum(['refund', 'resend']).optional(),
    },
  }, ({ order_id, ...rest }) => store.reportProblem(auth(), order_id, rest));

  tool('list_cases', {
    title: 'List problem reports', description: 'Problems reported on this account and what happens next for each.', readOnly: true,
    input: { status: z.enum(['open', 'resend_sent', 'refunded', 'closed']).optional() },
  }, (args) => store.listCases(auth(), args));

  tool('get_case', { title: 'Get problem report', description: 'One problem report: status, resolution and what happens next.', readOnly: true, input: { case_id: z.string() } },
    ({ case_id }) => store.getCase(auth(), case_id));

  tool('resend_owner_invite', {
    title: "Re-send the owner's sign-in link",
    description: "Email the account owner a fresh sign-in link (to the owner email on file), e.g. if they lost the first one. They use it to approve orders and set limits.",
  }, () => store.resendOwnerInvite(auth()));

  tool('list_approvals', {
    title: 'List approvals', description: 'Orders held for the human owner (over a limit, or the first order to a new address). The owner was emailed an Approve / Decline link.', readOnly: true,
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
