// HTTP API (JSON, Bearer auth) plus a Streamable HTTP MCP endpoint at /mcp.
// No framework: a small route table that also generates /openapi.json and /llms.txt.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiError, badRequest } from './errors.js';
import { buildMcpServer } from './mcp.js';
import { PRICING } from './store.js';
import { fulfillmentPage, messagePage } from './admin.js';

const MAX_BODY = 1_000_000;

/** [method, path, summary, auth, handler(ctx)]; auth is 'none' | 'agent' | 'owner' */
function routes(store) {
  return [
    ['GET', '/v1/categories', 'List product categories', 'none', () => store.listCategories()],
    ['GET', '/v1/products', 'Search products (?q=, ?category=, ?tag=)', 'none', ({ query }) => ({ data: store.listProducts(query) })],
    ['GET', '/v1/products/:sku', 'Get one product', 'none', ({ params }) => store.getProduct(params.sku)],
    ['POST', '/v1/recommendations', 'Recommend a bundle for a household { household_size, skus?, cadence_days? }', 'optional', ({ auth, body }) => store.recommend(auth, body)],

    ['POST', '/v1/accounts', 'Create a sandbox account { name, household_size?, email?, policy? } -> api_key + owner_key', 'none', ({ body }) => store.createAccount(body)],
    ['GET', '/v1/account', 'Get the current account, policy and month-to-date spend', 'agent', ({ auth }) => store.getAccount(auth.accountId)],
    ['PATCH', '/v1/account', 'Update { household_size?, name?, email? }', 'agent', ({ auth, body }) => store.updateAccount(auth, body)],
    ['PATCH', '/v1/account/policy', 'Owner only: update spend policy', 'owner', ({ auth, body }) => store.updatePolicy(auth, body)],

    ['POST', '/v1/payment_methods', 'Test mode: add a card from a token { token } (pm_card_visa, pm_card_declined, ...)', 'agent', ({ auth, body }) => store.addPaymentMethod(auth, body)],
    ['POST', '/v1/payment_methods/setup_link', 'Get a secure page where the human saves a card; send the url to the owner', 'agent', ({ auth }) => store.createCardSetupLink(auth)],
    ['GET', '/v1/payment_methods', 'List cards', 'agent', ({ auth }) => ({ data: store.listPaymentMethods(auth) })],
    ['POST', '/v1/addresses', 'Add a US shipping address', 'agent', ({ auth, body }) => store.addAddress(auth, body)],
    ['GET', '/v1/addresses', 'List addresses', 'agent', ({ auth }) => ({ data: store.listAddresses(auth) })],

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
    ['GET', '/v1/orders/:id', 'Get an order with charges and shipment', 'agent', ({ auth, params }) => store.getOrder(auth, params.id)],

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
    info: { title: 'Consumables API', version: '0.1.0', description: 'Household consumables on subscription, built for AI agents.' },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'ck_test_... (agent) or ok_test_... (owner)' } } },
    paths,
  };
}

function llmsTxt(table, baseUrl) {
  return `# Consumables

> Everyday household supplies (toilet paper, paper towels, dish soap, trash bags, detergent, batteries) on subscription, built for AI agents. JSON over HTTP or MCP.

- MCP (Streamable HTTP): ${baseUrl}/mcp  (send "Authorization: Bearer <api_key>")
- OpenAPI: ${baseUrl}/openapi.json
- Money is integer cents, USD. Dates are YYYY-MM-DD in the account clock.
- Subscriptions get ${PRICING.subscription_discount_pct}% off. Free shipping at $${PRICING.free_shipping_threshold_cents / 100}+ after discount, else $${PRICING.shipping_cents / 100}. Tax ${PRICING.tax_rate_pct}% (mock).

## Quickstart
1. POST /v1/accounts {"name":"My household","household_size":3} -> api_key (for you) and owner_key (give it to the human).
2. POST /v1/payment_methods/setup_link and send the url to the human to save a card (test mode: POST /v1/payment_methods {"token":"pm_card_visa"}). Then POST /v1/addresses {...}
3. POST /v1/recommendations {} -> a bundle sized to the household
4. POST /v1/subscriptions {"items":[...],"cadence_days":28}
5. Manage: PATCH, /pause, /resume, /skip, /ship_now, /supply_signal, /cancel

## Rules
- Send an Idempotency-Key header on POST/PATCH so retries never double-order.
- Orders over the owner's spend policy come back with status "requires_approval". Tell the human; do not retry. Only the owner_key can approve or change policy.
- Errors are { "error": { "code", "message", "hint" } }. Follow the hint.
- Sandbox: POST /v1/test/clock/advance {"days":30} simulates renewals and deliveries.

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

/**
 * Operator pages for concierge fulfillment. Auth is a shared ADMIN_KEY passed
 * as ?key= so the page works from a bookmark on a phone.
 */
async function handleAdmin(store, req, res, url, adminKey) {
  if (!adminKey) throw new ApiError(404, 'route_not_found', 'Admin pages are disabled.', { hint: 'Set ADMIN_KEY to enable them.' });
  if (url.searchParams.get('key') !== adminKey) return send(res, 401, messagePage('Not allowed', 'This link is missing the admin key.'), 'text/html');
  const back = () => { res.writeHead(303, { location: `/admin?key=${encodeURIComponent(adminKey)}` }); res.end(); };
  if (req.method === 'GET' && url.pathname === '/admin') {
    return send(res, 200, fulfillmentPage({
      awaiting: store.listFulfillmentQueue({ status: 'awaiting_fulfillment' }),
      shipped: store.listFulfillmentQueue({ status: 'shipped' }),
      key: adminKey,
    }), 'text/html');
  }
  if (req.method === 'GET' && url.pathname === '/admin/orders.json') return send(res, 200, { data: store.listFulfillmentQueue({ status: url.searchParams.get('status') ?? 'awaiting_fulfillment' }) });
  const m = /^\/admin\/orders\/([^/]+)\/(ship|deliver)$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    const body = (await readBody(req, { form: true })) ?? {};
    const order = m[2] === 'ship' ? store.markShipped(m[1], body) : store.markDelivered(m[1]);
    return (req.headers['content-type'] ?? '').includes('json') ? send(res, 200, order) : back();
  }
  throw new ApiError(404, 'route_not_found', `No route ${req.method} ${url.pathname}.`);
}

export function createApp(store, { baseUrl, adminKey } = {}) {
  const table = routes(store);

  const handleMcp = async (req, res, url) => {
    if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Use POST (stateless Streamable HTTP).' }, id: null });
    const body = await readBody(req);
    const server = buildMcpServer(store, { apiKey: bearer(req) ?? url.searchParams.get('api_key') ?? undefined }, { attachKeyOnSignup: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  return async (req, res) => {
    const base = baseUrl ?? `http://${req.headers.host ?? 'localhost'}`;
    const url = new URL(req.url, base);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type, idempotency-key, mcp-session-id, mcp-protocol-version',
          'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
        });
        return res.end();
      }
      if (url.pathname === '/mcp') return await handleMcp(req, res, url);
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, {
          name: 'Consumables', description: 'Household consumables on subscription, built for AI agents.',
          mcp: `${base}/mcp`, openapi: `${base}/openapi.json`, llms_txt: `${base}/llms.txt`, quickstart: 'POST /v1/accounts {"name":"..."}',
        });
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await handleAdmin(store, req, res, url, adminKey);
      if (req.method === 'GET' && url.pathname === '/setup/complete') {
        try {
          await store.completeCardSetup(url.searchParams.get('session_id') ?? '');
          return send(res, 200, messagePage('Card saved', 'Your card is saved for Consumables orders. You can close this tab; your agent will take it from here.'), 'text/html');
        } catch (err) {
          return send(res, err.status ?? 500, messagePage('Card not saved', err.hint ?? 'Something went wrong. Please try the link again.'), 'text/html');
        }
      }
      if (req.method === 'GET' && url.pathname === '/setup/canceled') return send(res, 200, messagePage('No card saved', 'You closed the card page before saving. Ask your agent for a new link when you are ready.'), 'text/html');
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

      const run = () => route.handler({ auth, params, query, body });
      const idemKey = req.headers['idempotency-key'];
      const result = auth && idemKey && req.method !== 'GET'
        ? await store.idempotent(auth, `http:${idemKey}`, createHash('sha256').update(`${req.method} ${url.pathname} ${JSON.stringify(body)}`).digest('hex'), run)
        : await run();
      const status = req.method === 'POST' && /^\/v1\/(accounts|subscriptions|orders|payment_methods|addresses)$/.test(url.pathname) && !result?.idempotent_replay ? 201 : 200;
      return send(res, status, result);
    } catch (err) {
      if (err instanceof ApiError) {
        if (url.pathname.startsWith('/admin') && !(req.headers['content-type'] ?? '').includes('json')) return send(res, err.status, messagePage('Could not update order', err.message), 'text/html');
        return send(res, err.status, err.toJSON());
      }
      console.error(err);
      return send(res, 500, { error: { code: 'internal_error', message: 'Something went wrong on our side.', hint: 'Retry with the same Idempotency-Key.' } });
    }
  };
}

export function startServer(store, { port = 8787, host = '0.0.0.0', baseUrl, adminKey } = {}) {
  const server = createServer(createApp(store, { baseUrl, adminKey }));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
