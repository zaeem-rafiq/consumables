# Consumables

Boring household stuff (toilet paper, paper towels, kitchen towels, dish soap, trash bags, detergent, batteries) sold on subscription to AI agents.

The store is built for agents first. It has an HTTP API and an MCP server, and both run on the same core:

- **Zero-friction start.** One call creates a sandbox account. There's no signup form and no dashboard to click through.
- **Agent-grade catalog.** Every SKU has its pack size, a normalized unit price and a usage model (units per person per month), so an agent can compare products and size orders without scraping.
- **Full subscription control.** Agents can create, modify, pause (optionally until a date), resume, skip, ship now, cancel, and report that the household is "running low" or "overstocked". The last one tunes the cadence.
- **Human-in-the-loop by design.** Signup returns two keys. The agent gets an `api_key` and the human gets an `owner_key`. The owner sets the spend policy: an approval threshold, a per-order limit, a monthly limit and allowed categories. Orders that break the policy are held as `requires_approval`. Agents can't approve orders or raise their own limits.
- **Safe retries.** `Idempotency-Key` works on every POST and PATCH (`idempotency_key` on the MCP tools).
- **Self-describing.** `/llms.txt`, `/openapi.json`, MCP tool annotations and server instructions all ship with the server. Every error carries `code`, `message` and a `hint` that says what to do next.
- **Test clock.** `advance_test_clock` / `POST /v1/test/clock/advance` jumps forward in time so you can watch renewals, shipping, deliveries, declines and auto-resume happen.

Payments and fulfillment are **mocked**. Use Stripe-style card tokens (`pm_card_visa`, `pm_card_declined`, `pm_card_insufficient_funds`). Shipments go `processing → shipped → delivered` over 3 days on the account clock.

See [docs/STRATEGY.md](docs/STRATEGY.md) for how this becomes the default store for agentic shopping.

## Run it

Requires Node 22.5+. It uses the built-in `node:sqlite`, so there are no native dependencies.

```bash
npm install
npm test          # 19 tests: store, HTTP API, MCP (in-memory + Streamable HTTP)
npm start         # HTTP API + remote MCP on http://localhost:8787 (PORT, CONSUMABLES_DB, PUBLIC_URL)
npm run mcp       # local MCP server over stdio
```

### Connect an agent

Claude Code, local stdio:

```bash
claude mcp add consumables -- node /path/to/consumables/bin/mcp-stdio.js
```

Claude Code, remote HTTP:

```bash
claude mcp add --transport http consumables http://localhost:8787/mcp --header "Authorization: Bearer ck_test_..."
```

Over stdio with no key, the agent calls `create_sandbox_account` and the new key attaches to the session. To reuse an account, set `CONSUMABLES_API_KEY`.

## HTTP quickstart

```bash
B=http://localhost:8787
KEY=$(curl -s -XPOST $B/v1/accounts -d '{"name":"Our flat","household_size":3}' | jq -r .api_key)
H="authorization: Bearer $KEY"
curl -s -XPOST $B/v1/payment_methods -H "$H" -d '{"token":"pm_card_visa"}'
curl -s -XPOST $B/v1/addresses -H "$H" -d '{"name":"Zaeem","line1":"1 Main St","city":"New York","region":"NY","postal_code":"10001"}'
curl -s -XPOST $B/v1/recommendations -H "$H" -d '{}'
curl -s -XPOST $B/v1/subscriptions -H "$H" -H 'idempotency-key: first-sub' \
  -d '{"items":[{"sku":"TP-2PLY-24","quantity":1},{"sku":"PT-2PLY-12","quantity":1}],"cadence_days":28}'
curl -s -XPOST $B/v1/test/clock/advance -H "$H" -d '{"days":30}'
```

The full endpoint list is in `GET /llms.txt`.

## MCP tools

`list_categories`, `search_products`, `get_product`, `recommend_bundle`, `quote`, `create_sandbox_account`, `get_account`, `update_household`, `add_payment_method`, `list_payment_methods`, `add_address`, `list_addresses`, `create_subscription`, `list_subscriptions`, `get_subscription`, `update_subscription`, `pause_subscription`, `resume_subscription`, `skip_next_delivery`, `ship_now`, `report_supply_level`, `cancel_subscription`, `place_order`, `list_orders`, `get_order`, `list_approvals`, `list_events`, `advance_test_clock`.

## Layout

```
src/catalog.js   seed catalog (23 SKUs, 6 categories) + usage models
src/store.js     all business logic: pricing, policy, subscriptions, billing, fulfillment, events, idempotency
src/http.js      JSON API, /mcp (Streamable HTTP, stateless), /openapi.json, /llms.txt
src/mcp.js       MCP tool definitions over the store
bin/             server.js (HTTP) and mcp-stdio.js
test/            node:test suites
```

## Rules the engine follows

- Money is integer cents in USD. Subscriptions get 5% off. Shipping is free at $35+ after the discount, $5.99 below that. Tax is a flat mock 8%.
- A renewal places the order on `next_order_date`, then sets the next date to today + `cadence_days`.
- A failed payment puts the subscription in `past_due`. Updating its `payment_method_id` retries the failed order right away.
- A pause with `until` auto-resumes on that date. If an order came due during the pause, it ships on resume.
- Monthly spend counts paid orders in the account clock's calendar month.

## Not built yet

Real payments (Stripe), a real 3PL, Postgres, outbound webhooks, OAuth for the remote MCP endpoint, an owner approval UI (email/SMS link), and live mode. See the roadmap in the strategy doc.
