# Domaru

Boring household stuff (toilet paper, paper towels, kitchen towels, dish soap, trash bags, detergent, batteries) sold on subscription to AI agents.

The store is built for agents first. It has an HTTP API and an MCP server, and both run on the same core:

- **Zero-friction start.** One call creates a sandbox account. There's no signup form and no dashboard to click through.
- **Agent-grade catalog.** Every SKU has its pack size, a normalized unit price and a usage model (units per person per month), so an agent can compare products and size orders without scraping.
- **Full subscription control.** Agents can create, modify, pause (optionally until a date), resume, skip, ship now, cancel, and report that the household is "running low" or "overstocked". The last one tunes the cadence.
- **Human-in-the-loop by design.** Signup returns two keys. The agent gets an `api_key` and the human gets an `owner_key`. The owner sets the spend policy: an approval threshold, a per-order limit, a monthly limit and allowed categories. Orders that break the policy are held as `requires_approval`. Agents can't approve orders or raise their own limits.
- **Safe retries.** `Idempotency-Key` works on every POST and PATCH (`idempotency_key` on the MCP tools).
- **Self-describing.** `/llms.txt`, `/openapi.json`, MCP tool annotations and server instructions all ship with the server. Every error carries `code`, `message` and a `hint` that says what to do next.
- **Test clock.** `advance_test_clock` / `POST /v1/test/clock/advance` jumps forward in time so you can watch renewals, shipping, deliveries, declines and auto-resume happen.

## Payments

By default payments are mocked, using Stripe-style test tokens (`pm_card_visa`, `pm_card_declined`, `pm_card_insufficient_funds`).

Set `STRIPE_SECRET_KEY` to use real Stripe:

- The agent calls `create_card_setup_link` (`POST /v1/payment_methods/setup_link`) and sends the URL to the human. The human saves a card on Stripe's hosted page and lands on `/setup/complete`, and that card becomes the default.
- Every order is charged off-session with a Stripe PaymentIntent, using an idempotency key per order attempt so retries never double-charge. A declined charge puts the subscription in `past_due`.
- With an `sk_test_` key, test tokens such as `pm_card_visa` also work. An `sk_live_` key switches accounts to live mode, which uses the real clock and a renewal scheduler that runs every 15 minutes. It also refuses test tokens.

## Fulfillment

- `FULFILLMENT=mock` (default): shipments go `processing → shipped → delivered` over 3 days on the account clock.
- `FULFILLMENT=manual` (concierge): paid orders wait as `awaiting_fulfillment`. Every SKU is one Walmart.com listing (the catalog keeps its URL and cost, which agents never see). The operator opens `/admin?key=ADMIN_KEY`, and each order shows the exact Walmart items to add to the cart plus the customer's address to use as the Walmart delivery address. With Walmart+ delivery is free. The operator pastes the tracking number once Walmart ships, and later marks the order delivered. Each step emits `shipment.shipped` / `shipment.delivered` events the agent can see.

## Google UCP

The store also speaks Google's [Universal Commerce Protocol](https://ucp.dev) (version 2026-08-25), the checkout standard behind Gemini and AI Mode shopping:

- `GET /.well-known/ucp` is the public business profile.
- `/ucp/checkout-sessions` implements the checkout capability over REST (create, get, update, complete, cancel) plus the fulfillment extension.
- Checkouts belong to an account (Bearer agent key) and pay with the card the owner saved (`account_card` handler), so the owner's limits apply: an over-limit order returns `requires_escalation` and waits for the owner. Canceling the checkout withdraws it.

Not done yet: Stripe's shared payment token handler (needs a Stripe network profile ID), guest checkout without an account, response signing, the order webhook capability, and Google Merchant Center onboarding (a product feed plus Google's waitlist).

## Configuration

| Variable | Purpose |
|---|---|
| `PORT`, `DOMARU_DB` | Server port (default 8787) and SQLite file |
| `PUBLIC_URL` | Public base URL. Required with Stripe. |
| `STRIPE_SECRET_KEY` | Turns on real Stripe payments |
| `FULFILLMENT` | `mock` or `manual` |
| `ADMIN_KEY` | Turns on the `/admin` operator page |

Live mode (an `sk_live_` key) refuses to start unless `FULFILLMENT=manual` and `ADMIN_KEY` are set, so real orders always reach a person.

See [docs/STRATEGY.md](docs/STRATEGY.md) for how this becomes the default store for agentic shopping, and [docs/PITCH.md](docs/PITCH.md) for the pitch copy.

## Prices

Each price is set from the Walmart cost by `priceFromCost` in `src/catalog.js`: it covers about 8% sales tax paid to Walmart and card fees, and keeps about 25% of the subscription price. Change `TARGET_MARGIN` to move every price at once.

## Run it

Requires Node 22.5+. It uses the built-in `node:sqlite`, so there are no native dependencies.

```bash
npm install
npm test          # 35 tests: store, HTTP API, MCP, UCP, Stripe (faked API), concierge fulfillment
npm start         # HTTP API + remote MCP on http://localhost:8787 (see Configuration below)
npm run mcp       # local MCP server over stdio
```

### Connect an agent

Claude Code, local stdio:

```bash
claude mcp add domaru -- node /path/to/domaru/bin/mcp-stdio.js
```

Claude Code, remote HTTP:

```bash
claude mcp add --transport http domaru http://localhost:8787/mcp --header "Authorization: Bearer ck_test_..."
```

Over stdio with no key, the agent calls `create_account` and the new key attaches to the session. To reuse an account, set `DOMARU_API_KEY`.

## HTTP quickstart

```bash
B=http://localhost:8787
KEY=$(curl -s -XPOST $B/v1/accounts -d '{"name":"Our flat","household_size":3}' | jq -r .api_key)
H="authorization: Bearer $KEY"
curl -s -XPOST $B/v1/payment_methods -H "$H" -d '{"token":"pm_card_visa"}'
curl -s -XPOST $B/v1/addresses -H "$H" -d '{"name":"Zaeem","line1":"1 Main St","city":"New York","region":"NY","postal_code":"10001"}'
curl -s -XPOST $B/v1/recommendations -H "$H" -d '{}'
curl -s -XPOST $B/v1/subscriptions -H "$H" -H 'idempotency-key: first-sub' \
  -d '{"items":[{"sku":"TP-2PLY-30","quantity":1},{"sku":"PT-2PLY-12","quantity":1}],"cadence_days":28}'
curl -s -XPOST $B/v1/test/clock/advance -H "$H" -d '{"days":30}'
```

The full endpoint list is in `GET /llms.txt`.

## MCP tools

`list_categories`, `search_products`, `get_product`, `recommend_bundle`, `quote`, `create_account`, `get_account`, `update_household`, `create_card_setup_link`, `add_payment_method`, `list_payment_methods`, `add_address`, `list_addresses`, `create_subscription`, `list_subscriptions`, `get_subscription`, `update_subscription`, `pause_subscription`, `resume_subscription`, `skip_next_delivery`, `ship_now`, `report_supply_level`, `cancel_subscription`, `place_order`, `list_orders`, `get_order`, `list_approvals`, `list_events`, `advance_test_clock`.

## Layout

```
src/catalog.js   catalog (22 SKUs, 6 categories), Walmart source per SKU, pricing rule, usage models
src/store.js     all business logic: pricing, policy, subscriptions, billing, fulfillment, events, idempotency
src/payments.js  MockPayments and StripePayments (REST, no SDK)
src/admin.js     operator fulfillment page and card-setup result pages
src/landing.js   the home page people see at /
src/ucp.js       Google UCP profile and checkout sessions
src/http.js      JSON API, /mcp (Streamable HTTP, stateless), /openapi.json, /llms.txt
src/mcp.js       MCP tool definitions over the store
bin/             server.js (HTTP) and mcp-stdio.js
test/            node:test suites
```

## Rules the engine follows

- `GET /` returns the landing page to browsers (`Accept: text/html`) and a JSON index to agents.
- Money is integer cents in USD. Subscriptions get 5% off. Shipping is free at $35+ after the discount, $5.99 below that. Tax is a flat mock 8%.
- A renewal places the order on `next_order_date`, then sets the next date to today + `cadence_days`.
- A failed payment puts the subscription in `past_due`. Updating its `payment_method_id` retries the failed order right away.
- A pause with `until` auto-resumes on that date. If an order came due during the pause, it ships on resume.
- Monthly spend counts paid orders in the account clock's calendar month.

## Not built yet

Hosting, Postgres, Stripe webhooks (for disputes and refunds), outbound webhooks to agents, OAuth for the remote MCP endpoint, an owner approval UI (email/SMS link), and dropship or 3PL fulfillment. See the roadmap in the strategy doc.
