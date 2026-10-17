import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { buildMcpServer } from '../src/mcp.js';
import { startServer } from '../src/http.js';
import { ADDRESS } from './helpers.js';

const parse = (r) => JSON.parse(r.content[0].text);

async function connect(store, session = {}) {
  const server = buildMcpServer(store, session);
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('tools are discoverable with annotations', async () => {
  const client = await connect(new Store());
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['search_products', 'recommend_bundle', 'create_subscription', 'pause_subscription', 'cancel_subscription', 'advance_test_clock']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(tools.find((t) => t.name === 'cancel_subscription').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'search_products').annotations.readOnlyHint, true);
  assert.match(client.getInstructions(), /requires_approval/);
});

test('agent goes from zero to subscription over MCP (stdio-style session)', async () => {
  const client = await connect(new Store());
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });

  const noAuth = await call('get_account');
  assert.equal(noAuth.isError, true);
  assert.match(parse(noAuth).error.hint, /POST \/v1\/accounts/);

  const acct = parse(await call('create_sandbox_account', { name: 'MCP home', household_size: 4, payment_token: 'pm_card_visa', address: ADDRESS }));
  assert.ok(acct.api_key.startsWith('ck_test_'));
  assert.ok(acct.account.default_payment_method_id);

  const rec = parse(await call('recommend_bundle', { cadence_days: 28 }));
  assert.equal(rec.household_size, 4);
  const items = rec.items.slice(0, 4).map(({ sku, quantity }) => ({ sku, quantity }));

  const quote = parse(await call('quote', { items, cadence_days: 28 }));
  assert.ok(quote.amounts.total_cents > 0);

  const sub = parse(await call('create_subscription', { items, cadence_days: 28, idempotency_key: 'abc' }));
  const again = parse(await call('create_subscription', { items, cadence_days: 28, idempotency_key: 'abc' }));
  assert.equal(again.id, sub.id);

  assert.equal(parse(await call('skip_next_delivery', { subscription_id: sub.id })).next_order_date > sub.next_order_date, true);
  assert.equal(parse(await call('pause_subscription', { subscription_id: sub.id })).status, 'paused');
  assert.equal(parse(await call('resume_subscription', { subscription_id: sub.id })).status, 'active');
  const low = parse(await call('report_supply_level', { subscription_id: sub.id, signal: 'running_low' }));
  assert.ok(low.cadence_days < 28);
  const adv = parse(await call('advance_test_clock', { days: 5 }));
  assert.ok(adv.events.some((e) => e.type === 'shipment.delivered'));
  assert.equal(parse(await call('cancel_subscription', { subscription_id: sub.id })).status, 'canceled');

  const bad = await call('get_product', { sku: 'nope' });
  assert.equal(bad.isError, true);
});

test('remote MCP over Streamable HTTP with bearer key', async () => {
  const store = new Store();
  const server = await startServer(store, { port: 0, host: '127.0.0.1' });
  try {
    const { api_key } = store.createAccount({ name: 'Remote' });
    const client = new Client({ name: 'remote-agent', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${api_key}` } },
    }));
    const account = parse(await client.callTool({ name: 'get_account', arguments: {} }));
    assert.equal(account.name, 'Remote');
    const products = parse(await client.callTool({ name: 'search_products', arguments: { query: 'paper towels' } }));
    assert.equal(products[0].sku, 'PT-2PLY-12');
    await client.close();
  } finally {
    server.close();
  }
});
