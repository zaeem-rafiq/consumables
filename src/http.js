// HTTP API (JSON, Bearer auth) plus a Streamable HTTP MCP endpoint at /mcp.
// No framework: a small route table that also generates /openapi.json and /llms.txt.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiError, badRequest } from './errors.js';
import { buildMcpServer } from './mcp.js';
import { PRICING } from './store.js';
import { messagePage } from './ui.js';
import { landingPage } from './landing.js';
import { handleWeb, RateLimit, clientIp } from './web.js';
import { Ucp, ucpProfile } from './ucp.js';

const MAX_BODY = 1_000_000;

/** [method, path, summary, auth, handler(ctx)]; auth is 'none' | 'agent' | 'owner' */
function routes(store) {
  return [
    ['GET', '/v1/categories', 'List product categories', 'none', () => store.listCategories()],
    ['GET', '/v1/products', 'Search products (?q=, ?category=, ?tag=)', 'none', ({ query }) => ({ data: store.listProducts(query) })],
    ['GET', '/v1/products/:sku', 'Get one product', 'none', ({ params }) => store.getProduct(params.sku)],
    ['POST', '/v1/recommendations', 'Recommend a bundle for a household { household_size, skus?, cadence_days? }', 'optional', ({ auth, body }) => store.recommend(auth, body)],

    ['POST', '/v1/accounts', "Developers: create an account { name, email (the owner's), household_size? } -> api_key. The owner is emailed a sign-in link. Households use Connect Domaru (OAuth) instead", 'none', ({ body }) => store.createAccount(body)],
    ['POST', '/v1/account/owner_invite', "Re-send the owner's sign-in link to the owner email on file", 'agent', ({ auth }) => store.resendOwnerInvite(auth)],
    ['GET', '/v1/account', 'Get the current account, policy and month-to-date spend', 'agent', ({ auth }) => store.getAccount(auth.accountId)],
    ['PATCH', '/v1/account', 'Update { household_size?, name? } (email: owner only)', 'agent', ({ auth, body }) => store.updateAccount(auth, body)],
    ['PATCH', '/v1/account/policy', 'Owner only: update spend policy', 'owner', ({ auth, body }) => store.updatePolicy(auth, body)],

    ['POST', '/v1/payment_methods', 'Test mode: add a card or bank account from a token { token } (pm_card_visa, pm_card_declined, pm_usBankAccount_success, ...)', 'agent', ({ auth, body }) => store.addPaymentMethod(auth, body)],
    ['POST', '/v1/payment_methods/setup_link', 'Get a secure page where the human saves a card; send the url to the owner', 'agent', ({ auth }) => store.createCardSetupLink(auth)],
    ['POST', '/v1/payment_methods/bank_setup_link', 'After the first delivery: get a page where the human signs in to their bank to pay by bank and save 2% on every delivery', 'agent', ({ auth }) => store.createBankSetupLink(auth)],
    ['GET', '/v1/payment_methods', 'List cards and bank accounts', 'agent', ({ auth }) => ({ data: store.listPaymentMethods(auth) })],
    ['POST', '/v1/addresses', 'Add a US shipping address', 'agent', ({ auth, body }) => store.addAddress(auth, body)],
    ['GET', '/v1/addresses', 'List addresses (confirmed: false means the first order there waits for the owner)', 'agent', ({ auth }) => ({ data: store.listAddresses(auth) })],
    ['POST', '/v1/addresses/:id/confirm', 'Owner only: confirm an address', 'owner', ({ auth, params }) => store.confirmAddress(auth, params.id)],

    ['POST', '/v1/quotes', 'Price a basket and check spend policy { items, subscription?, cadence_days? }', 'agent', ({ auth, body }) => store.quote(auth, body)],

    ['POST', '/v1/subscriptions', 'Create a subscription { items, cadence_days?, start_date?, address_id?, payment_method_id?, metadata? }', 'agent', ({ auth, body }) => store.createSubscription(auth, body)],
    ['GET', '/v1/subscriptions', 'List subscriptions (?status=)', 'agent', ({ auth, query }) => ({ data: store.listSubscriptions(auth, query) })],
    ['GET', '/v1/subscriptions/:id', 'Get a subscription', 'agent', ({ auth, params }) => store.getSubscription(auth, params.id)],
    ['PATCH', '/v1/subscriptions/:id', 'Update items, cadence_days, next_order_date, address_id, payment_method_id, metadata', 'agent', ({ auth, params, body }) => store.updateSubscription(auth, params.id, body)],
    ['POST', '/v1/subscriptions/:id/pause', 'Pause { until? }', 'agent', ({ auth, params, body }) => store.pauseSubscription(auth, params.id, body)],
    ['POST', '/v1/subscriptions/:id/resume', 'Resume', 'agent', ({ auth, params }) => store.resumeSubscription(auth, params.id)],
    ['POST', '/v1/subscriptions/:id/skip', 'Skip the next delivery', 'agent', ({ auth, params }) => store.skipNext(auth, params.id)],
    ['POST', '/v1/subscriptions/:id/ship_now', 'Order now and restart the cadence', 'agent', ({ auth, params }) => store.shipNow(auth, params.id)],
    ['POST', '/v1/subscriptions/:id/supply_signal', "Report { signal: 'running_low' | 'overstocked' } to tune cadence", 'agent', ({ auth, params, body }) => store.reportSignal(auth, params.id, body)],
    ['POST', '/v1/subscriptions/:id/cancel', 'Cancel { reason? }', 'agent', ({ auth, params, body }) => store.cancelSubscription(auth, params.id, body)],

    ['POST', '/v1/orders', 'Place a one-time order { items, address_id?, payment_method_id? }', 'agent', ({ auth, body }) => store.createOrder(auth, body)],
    ['GET', '/v1/orders', 'List orders (?subscription_id=, ?status=, ?limit=)', 'agent', ({ auth, query }) => ({ data: store.listOrders(auth, query) })],
    ['GET', '/v1/orders/:id', 'Get an order with charges, refunds and shipment', 'agent', ({ auth, params }) => store.getOrder(auth, params.id)],
    ['POST', '/v1/orders/:id/cancel', 'Cancel an order before it is bought from the retailer; paid orders are refunded in full { reason? }', 'agent', ({ auth, params, body }) => store.cancelOrder(auth, params.id, body)],
    ['POST', '/v1/orders/:id/problems', "Report a problem { kind: never_arrived|damaged|wrong_item|missing_item|charged_wrong|other, note?, photo_url?, skus?, preferred?: refund|resend }", 'agent', ({ auth, params, body }) => store.reportProblem(auth, params.id, body)],
    ['GET', '/v1/cases', 'Problem reports and what happens next (?status=open|resend_sent|refunded|closed)', 'agent', ({ auth, query }) => ({ data: store.listCases(auth, query) })],
    ['GET', '/v1/cases/:id', 'One problem report', 'agent', ({ auth, params }) => store.getCase(auth, params.id)],

    ['GET', '/v1/approvals', 'List approvals (?status=pending|approved|rejected|all)', 'agent', ({ auth, query }) => ({ data: store.listApprovals(auth, query) })],
    ['POST', '/v1/approvals/:id/approve', 'Owner only: approve a held order', 'owner', ({ auth, params }) => store.decideApproval(auth, params.id, 'approve')],
    ['POST', '/v1/approvals/:id/reject', 'Owner only: reject a held order', 'owner', ({ auth, params }) => store.decideApproval(auth, params.id, 'reject')],

    ['GET', '/v1/events', 'Activity feed (?after=seq, ?type=, ?limit=)', 'agent', ({ auth, query }) => store.listEvents(auth, query)],
    ['POST', '/v1/test/clock/advance', 'Sandbox: advance the account clock { days }', 'agent', ({ auth, body }) => store.advanceClock(auth, body)],
  ].map(([method, path, summary, auth, handler]) => {
    const names = [];
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    return { method, path, summary, auth, handler, re, names };
  });
}

function openapi(table, baseUrl) {
  const paths = {};
  for (const r of table) {
    const p = r.path.replace(/:(\w+)/g, '{$1}');
    paths[p] ??= {};
    paths[p][r.method.toLowerCase()] = {
      summary: r.summary,
      security: r.auth === 'none' || r.auth === 'optional' ? [] : [{ bearer: [] }],
      parameters: r.names.map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } })),
      ...(r.method !== 'GET' ? { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } : {}),
      responses: { 200: { description: 'OK' }, default: { description: 'Error: { error: { code, message, hint?, param? } }' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Domaru API', version: '0.1.0', description: 'Household consumables on subscription, built for AI agents.' },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'ck_test_... (agent) or ok_test_... (owner)' } } },
    paths,
  };
}

const SUPPORT = 'support@domaru.app';

function llmsTxt(table, baseUrl) {
  return `# Domaru

> Everyday household supplies (toilet paper, paper towels, dish soap, trash bags, detergent, batteries) on subscription, built for AI agents. JSON over HTTP or MCP.

- MCP (Streamable HTTP): ${baseUrl}/mcp  (send "Authorization: Bearer <api_key>")
- OpenAPI: ${baseUrl}/openapi.json
- Money is integer cents, USD. Dates are YYYY-MM-DD in the account clock.
- Subscriptions get ${PRICING.subscription_discount_pct}% off. Free shipping at $${PRICING.free_shipping_threshold_cents / 100}+ after discount, else $${PRICING.shipping_cents / 100}. Tax ${PRICING.tax_rate_pct}% (mock).

## Quickstart
1. Households: connect Domaru from your assistant (MCP at ${baseUrl}/mcp uses OAuth: the person signs in by emailed link, adds an address and card, and taps Allow). Developers: POST /v1/accounts {"name":"My household","email":"owner@example.com"} -> api_key; the owner is emailed a sign-in link.
2. Developers only: POST /v1/payment_methods/setup_link and send the url to the human to save a card (test mode: POST /v1/payment_methods {"token":"pm_card_visa"}). Then POST /v1/addresses {...}; the first order to an address you add waits for the owner.
3. POST /v1/recommendations {} -> a bundle sized to the household
4. POST /v1/subscriptions {"items":[...],"cadence_days":28}
5. Manage: PATCH, /pause, /resume, /skip, /ship_now, /supply_signal, /cancel

## Rules
- Send an Idempotency-Key header on POST/PATCH so retries never double-order.
- Orders over the owner's spend policy come back with status "requires_approval". Domaru emails the owner an Approve / Decline link. Tell the human; do not retry. You can never approve or change limits.
- Something wrong with a delivery? POST /v1/orders/{id}/problems, then read back GET /v1/cases. Changed your mind before it was bought? POST /v1/orders/{id}/cancel (full refund). You cannot issue refunds.
- Support: ${SUPPORT}. Charges show on statements as DOMARU.
- Cards are the default. After the first delivery arrives, GET /v1/account shows bank_payments.offer: tell the human they can switch to bank payments and save ${PRICING.bank_discount_pct}% on every delivery, and send them the url from POST /v1/payment_methods/bank_setup_link. Bank payers are charged a few business days before each delivery (order status "payment_pending" until it clears). A bounced bank payment is handled like a declined card.
- Errors are { "error": { "code", "message", "hint" } }. Follow the hint.
- Sandbox: POST /v1/test/clock/advance {"days":30} simulates renewals and deliveries.

## Google Universal Commerce Protocol (UCP)
- Profile: GET ${baseUrl}/.well-known/ucp. Checkout: ${baseUrl}/ucp/checkout-sessions (create, get, PUT update, /complete, /cancel), with the same Bearer agent key.
- Pay with handler_id "account_card" and an instrument id from payment.instruments (the owner's saved card).
- Over-limit orders come back "requires_escalation" with a continue_url: the owner must approve.

## Endpoints
${table.map((r) => `- ${r.method} ${r.path}: ${r.summary}${r.auth === 'owner' ? ' [owner_key]' : ''}`).join('\n')}
`;
}

async function readBody(req, { form = false } = {}) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new ApiError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(c);
  }
  if (!size) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (form && !raw.trimStart().startsWith('{')) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('invalid_json', 'Request body is not valid JSON.', { hint: 'Send Content-Type: application/json with a JSON object body.' });
  }
}

function send(res, status, body, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body, null, 2) : body;
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'access-control-allow-origin': '*' });
  res.end(text);
}

function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

export function createApp(store, { baseUrl, adminKey, stripeWebhookSecret } = {}) {
  const table = routes(store);
  const limits = {
    signin: new RateLimit(5, 15 * 60_000),
    adminLogin: new RateLimit(10, 15 * 60_000),
    accounts: new RateLimit(20, 3600_000),
    setup: new RateLimit(20, 3600_000),
    register: new RateLimit(30, 3600_000),
  };

  const handleMcp = async (req, res, base) => {
    if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Use POST (stateless Streamable HTTP).' }, id: null });
    // Credentials only in the Authorization header. No credentials: 401 with a
    // pointer to our OAuth metadata, which is what starts "Connect Domaru".
    const key = bearer(req);
    let valid = false;
    try { valid = !!(key && store.authenticate(key)); } catch { valid = false; }
    if (!valid) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"${key ? ', error="invalid_token"' : ''}`,
        'access-control-allow-origin': '*', 'access-control-expose-headers': 'www-authenticate',
      });
      return res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Connect Domaru to continue.' }));
    }
    const body = await readBody(req);
    const server = buildMcpServer(store, { apiKey: key }, { attachKeyOnSignup: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  return async (req, res) => {
    res.on('finish', () => { store.flushEmails().catch((err) => console.error('email delivery failed', err)); });
    const base = baseUrl ?? `http://${req.headers.host ?? 'localhost'}`;
    const url = new URL(req.url, base);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type, idempotency-key, mcp-session-id, mcp-protocol-version, ucp-agent, request-id, x-api-key',
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
        });
        return res.end();
      }
      if (url.pathname === '/mcp') return await handleMcp(req, res, base);
      if (await handleWeb(store, req, res, url, { base, adminKey, stripeWebhookSecret, send, limits })) return;
      if (req.method === 'GET' && url.pathname === '/') {
        if ((req.headers.accept ?? '').includes('text/markdown')) return send(res, 200, llmsTxt(table, base), 'text/markdown');
        if ((req.headers.accept ?? '').includes('text/html')) return send(res, 200, landingPage({ base }), 'text/html');
        return send(res, 200, {
          name: 'Domaru', description: 'Household consumables on subscription, built for AI agents.',
          mcp: `${base}/mcp`, openapi: `${base}/openapi.json`, llms_txt: `${base}/llms.txt`, connect: 'Add the MCP endpoint to your assistant and sign in (OAuth)', support: 'support@domaru.app',
        });
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/.well-known/ucp') return send(res, 200, ucpProfile(base));
      if (url.pathname.startsWith('/ucp/') && await new Ucp(store, { base }).handle(req, res, url, { readBody, send, bearer })) return;
      if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openapi(table, base));
      if (req.method === 'GET' && url.pathname === '/llms.txt') return send(res, 200, llmsTxt(table, base), 'text/plain');

      const methodMatches = table.filter((r) => r.re.test(url.pathname));
      const route = methodMatches.find((r) => r.method === req.method);
      if (!route) {
        if (methodMatches.length) throw new ApiError(405, 'method_not_allowed', `${req.method} is not supported on ${url.pathname}.`, { hint: `Allowed: ${methodMatches.map((r) => r.method).join(', ')}.` });
        throw new ApiError(404, 'route_not_found', `No route ${req.method} ${url.pathname}.`, { hint: `See ${base}/llms.txt for all endpoints.` });
      }
      const m = route.re.exec(url.pathname);
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const query = Object.fromEntries(url.searchParams);
      const body = req.method === 'GET' ? undefined : (await readBody(req)) ?? {};
      if (body !== undefined && (typeof body !== 'object' || Array.isArray(body) || body === null)) throw badRequest('invalid_json', 'Request body must be a JSON object.');

      const key = bearer(req);
      let auth = null;
      if (route.auth === 'agent' || route.auth === 'owner') auth = store.authenticate(key);
      else if (route.auth === 'optional' && key) auth = store.authenticate(key);

      if ((route.path === '/v1/accounts' && !limits.accounts.hit(clientIp(req))) || (/setup_link$/.test(route.path) && !limits.setup.hit(clientIp(req)))) {
        throw new ApiError(429, 'rate_limited', 'Too many requests from this network.', { hint: 'Try again in an hour.' });
      }
      const run = () => route.handler({ auth, params, query, body });
      const idemKey = req.headers['idempotency-key'];
      const result = auth && idemKey && req.method !== 'GET'
        ? await store.idempotent(auth, `http:${idemKey}`, createHash('sha256').update(`${req.method} ${url.pathname} ${JSON.stringify(body)}`).digest('hex'), run)
        : await run();
      const status = req.method === 'POST' && /^\/v1\/(accounts|subscriptions|orders|payment_methods|addresses)$/.test(url.pathname) && !result?.idempotent_replay ? 201 : 200;
      return send(res, status, result);
    } catch (err) {
      if (err instanceof ApiError) {
        if (url.pathname.startsWith('/admin') && !(req.headers['content-type'] ?? '').includes('json')) return send(res, err.status, messagePage("That didn't work", err.message, { action: { href: '/admin', label: 'Back to orders' } }), 'text/html');
        return send(res, err.status, err.toJSON());
      }
      console.error(err);
      return send(res, 500, { error: { code: 'internal_error', message: 'Something went wrong on our side.', hint: 'Retry with the same Idempotency-Key.' } });
    }
  };
}

export function startServer(store, { port = 8787, host = '0.0.0.0', baseUrl, adminKey, stripeWebhookSecret } = {}) {
  const server = createServer(createApp(store, { baseUrl, adminKey, stripeWebhookSecret }));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
