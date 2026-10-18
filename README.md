# Domaru

Boring household stuff (toilet paper, paper towels, kitchen towels, dish soap, trash bags, detergent, batteries) sold on subscription to AI agents.

The store is built for agents first. It has an HTTP API and an MCP server, and both run on the same core:

- **No keys for households.** People using a personal assistant (Claude, ChatGPT, Muse and others) just "Connect Domaru". The assistant opens a Domaru page; the person signs in with an emailed link (no password), confirms the address, saves a card on Stripe's page, keeps or changes the limits and taps Allow. See [Connect Domaru](#connect-domaru).
- **Agent-grade catalog.** Every SKU has its pack size, a normalized unit price and a usage model (units per person per month), so an agent can compare products and size orders without scraping.
- **Full subscription control.** Agents can create, modify, pause (optionally until a date), resume, skip, ship now, cancel, and report that the household is "running low" or "overstocked". The last one tunes the cadence.
- **Human-in-the-loop by design.** The owner is whoever controls the household's email. The owner sets the spend policy: an approval threshold, a per-order limit, a monthly limit and allowed categories. Orders that break the policy, and the first order to an address the agent added, are held as `requires_approval` and the owner gets an email with Approve and Decline buttons. Agents can't approve orders, confirm addresses or change limits.
- **Safe retries.** `Idempotency-Key` works on every POST and PATCH (`idempotency_key` on the MCP tools).
- **Self-describing.** `/llms.txt`, `/openapi.json`, MCP tool annotations and server instructions all ship with the server. Every error carries `code`, `message` and a `hint` that says what to do next.
- **Test clock.** `advance_test_clock` / `POST /v1/test/clock/advance` jumps forward in time so you can watch renewals, shipping, deliveries, declines and auto-resume happen.

## Payments

By default payments are mocked, using Stripe-style test tokens (`pm_card_visa`, `pm_card_declined`, `pm_card_insufficient_funds`).

Set `STRIPE_SECRET_KEY` to use real Stripe:

- The agent calls `create_card_setup_link` (`POST /v1/payment_methods/setup_link`) and sends the URL to the human. The human saves a card on Stripe's hosted page and lands on `/setup/complete`, and that card becomes the default.
- Every order is charged off-session with a Stripe PaymentIntent, using an idempotency key per order attempt so retries never double-charge. A declined charge puts the subscription in `past_due`.
- With an `sk_test_` key, test tokens such as `pm_card_visa` also work. An `sk_live_` key switches accounts to live mode, which uses the real clock and a renewal scheduler that runs every 15 minutes. It also refuses test tokens.

### Bank payments

Cards are the default. People rarely hand over bank details before they've shopped with you, so bank payments open up only after a household's first delivery arrives:

- The store emits `payment.bank_offer` and `get_account` shows `bank_payments.offer`: "Switch to bank payments and save 2% on every delivery."
- The agent calls `create_bank_setup_link` (`POST /v1/payment_methods/bank_setup_link`). The owner signs in to their bank on Stripe's hosted page (US ACH via Financial Connections, which Stripe prices at 0.8% capped at $5). The bank account becomes the default and the household's subscriptions move to it.
- Bank payers get `bank_discount_pct` (2%) off the subtotal on every order, shown as `bank_discount_cents`. Free shipping is judged before that discount, so switching never adds a shipping fee. Cards carry no surcharge.
- A bank debit takes days to clear, so subscriptions paid by bank are charged 4 business days before the delivery date (`next_charge_date`). The order sits in `payment_pending` until the debit clears, and it only reaches the fulfillment queue once it is `paid` and its `ship_date` has arrived. Nothing is bought at Walmart before the money is in. Each delivery is still one charge.
- A bounced debit (`insufficient_funds`, `account_closed`, ...) is treated like a declined card: the order is `payment_failed`, the subscription goes `past_due`, and setting a new payment method retries it.
- Sandbox bank tokens: `pm_usBankAccount_success`, `pm_usBankAccount_insufficientFunds`, `pm_usBankAccount_accountClosed`. Mock debits clear or bounce after 4 business days on the account clock. Weekends are skipped; bank holidays are not modeled yet.

## Fulfillment

- `FULFILLMENT=mock` (default): shipments go `processing → shipped → delivered` over 3 days on the account clock.
- `FULFILLMENT=manual` (concierge): paid orders wait as `awaiting_fulfillment`. Every SKU is one Walmart.com listing (the catalog keeps its URL and cost, which agents never see). The operator signs in at `/admin` with `ADMIN_KEY` (a cookie session; 10 wrong tries per 15 minutes locks the IP out), and each order shows the exact Walmart items to add to the cart plus the customer's address to use as the Walmart delivery address. With Walmart+ delivery is free. The operator records the Walmart order number ("Mark placed", after which the customer can no longer cancel), pastes the tracking number once Walmart ships, and later marks the order delivered. If Walmart cancels, "Walmart canceled" puts the order back on the list flagged for Amazon. Orders still not delivered after their expected delivery date are flagged late. Each step emits `shipment.shipped` / `shipment.delivered` events the agent can see.

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
| `ADMIN_KEY` | Turns on the `/admin` operator page. At least 24 characters. |
| `STRIPE_WEBHOOK_SECRET` | Verifies `/webhooks/stripe` (setup completion, bank debits clearing, disputes). Required in live mode. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Sends owner emails through Resend. Without it emails are only recorded (see `/admin/emails`). Required in live mode. |
| `TRUST_PROXY` | Where rate limits read the caller's address: `auto` (default; `X-Forwarded-For` from a proxy on a private network), `cloudflare` (`CF-Connecting-IP`; only when the origin accepts traffic from Cloudflare alone), or `none` |
| `SUPPORT_EMAIL` | Shown on every page and email, and receives problem reports (default `support@domaru.app`) |
| `REFUND_NO_QUESTIONS_CENTS`, `CLAIM_LIMIT`, `CLAIM_WINDOW_DAYS` | Problem-report rules (defaults $40, 2 claims, 90 days) |

Use a Stripe **restricted key** (`rk_live_...`) with write access to Customers, SetupIntents, PaymentIntents, Checkout Sessions and Refunds, and read access to PaymentMethods and Disputes. Nothing else is needed, so a leaked key can't move money out.

Live mode (an `sk_live_` or `rk_live_` key) refuses to start unless `FULFILLMENT=manual` and `ADMIN_KEY` are set, so real orders always reach a person.

See [docs/STRATEGY.md](docs/STRATEGY.md) for how this becomes the default store for agentic shopping, and [docs/PITCH.md](docs/PITCH.md) for the pitch copy.

## Prices

Each price is set from the Walmart cost by `priceFromCost` in `src/catalog.js`: it covers about 8% sales tax paid to Walmart and card fees, and keeps about 25% of the subscription price. Change `TARGET_MARGIN` to move every price at once.

## Run it

Requires Node 22.5+. It uses the built-in `node:sqlite`, so there are no native dependencies.

```bash
npm install
npm test          # 74 tests: store, HTTP API, MCP, UCP, Stripe (faked API), fulfillment, security, refunds and problems
npm start         # HTTP API + remote MCP on http://localhost:8787 (see Configuration below)
npm run mcp       # local MCP server over stdio
```

### Connect Domaru

This is how households connect. The remote MCP endpoint `/mcp` follows the MCP authorization spec:

1. An assistant calls `/mcp` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata=.../.well-known/oauth-protected-resource`.
2. It registers itself (`POST /oauth/register`, RFC 7591) and opens `/oauth/authorize` with PKCE (S256 only).
3. The person signs in with an emailed one-time link (30 minutes). A new email starts a new household.
4. One page walks them through address, card (Stripe Checkout, setup mode) and limits, then terms and **Allow**.
5. The assistant gets a token that can shop within the limits. It can't approve orders, confirm addresses or change limits. Tokens refresh by rotation; the owner can disconnect an assistant from `/owner` at any time.

The owner page `/owner` (same emailed-link sign-in) shows approvals, limits, connected assistants, addresses, payment, orders and problem reports.

### Developer keys

Developers building their own agent can still use keys:

Claude Code, local stdio:

```bash
claude mcp add domaru -- node /path/to/domaru/bin/mcp-stdio.js
```

Claude Code, remote HTTP:

```bash
claude mcp add --transport http domaru http://localhost:8787/mcp --header "Authorization: Bearer ck_test_..."
```

Over stdio with no key, the agent calls `create_account` (an owner email is required) and the new key attaches to the session; the owner is emailed a sign-in link to set limits. To reuse an account, set `DOMARU_API_KEY`. An owner can create a developer owner key from the bottom of `/owner`; households never need one.

## Refunds, cancellations and problems

- **Cancel** (`POST /v1/orders/:id/cancel`, `cancel_order`): allowed until the operator marks the Walmart order placed, and refunds in full. A bank debit still clearing is refunded automatically once it clears.
- **Report a problem** (`POST /v1/orders/:id/problems`, `report_problem`): never arrived, damaged, wrong item, missing item, charged wrong, other. Support and the owner are emailed; `get_case` says what happens next. Claims up to $40 are refunded or resent with no questions; above that, or after 2 claims in 90 days, the operator asks for a photo.
- **Operator actions** on `/admin/orders/:id`: refund any amount, mark lost/damaged/wrong item, resend free (a $0 order back on the Walmart list), Walmart canceled.
- **Disputes**: a Stripe dispute pauses the household's orders and renewals until the operator releases the hold.
- **Owner emails**: subscription started (auto-renewal and 7-day price-change notice), approval needed, shipped with tracking, payment failed, refund, problem received. Every email names the support address and says charges appear as DOMARU.

Policies live at `/terms`, `/privacy` and `/refunds` (from `docs/legal/`); bracketed blanks such as the company's legal name are highlighted until filled in. Owners accept the current terms version at Connect, and the version and time are recorded.

## HTTP quickstart

```bash
B=http://localhost:8787
KEY=$(curl -s -XPOST $B/v1/accounts -d '{"name":"Our flat","email":"you@example.com","household_size":3}' | jq -r .api_key)
H="authorization: Bearer $KEY"
curl -s -XPOST $B/v1/payment_methods -H "$H" -d '{"token":"pm_card_visa"}'
curl -s -XPOST $B/v1/addresses -H "$H" -d '{"name":"Zaeem","line1":"1 Main St","city":"New York","region":"NY","postal_code":"10001"}'   # agent-added: the first order to it waits for the owner's OK by email
curl -s -XPOST $B/v1/recommendations -H "$H" -d '{}'
curl -s -XPOST $B/v1/subscriptions -H "$H" -H 'idempotency-key: first-sub' \
  -d '{"items":[{"sku":"TP-2PLY-30","quantity":1},{"sku":"PT-2PLY-12","quantity":1}],"cadence_days":28}'
curl -s -XPOST $B/v1/test/clock/advance -H "$H" -d '{"days":30}'
```

The full endpoint list is in `GET /llms.txt`.

## MCP tools

`list_categories`, `search_products`, `get_product`, `recommend_bundle`, `quote`, `create_account`, `get_account`, `update_household`, `create_card_setup_link`, `create_bank_setup_link`, `add_payment_method`, `list_payment_methods`, `add_address`, `list_addresses`, `create_subscription`, `list_subscriptions`, `get_subscription`, `update_subscription`, `pause_subscription`, `resume_subscription`, `skip_next_delivery`, `ship_now`, `report_supply_level`, `cancel_subscription`, `place_order`, `list_orders`, `get_order`, `cancel_order`, `report_problem`, `list_cases`, `get_case`, `resend_owner_invite`, `list_approvals`, `list_events`, `advance_test_clock`.

## Layout

```
src/catalog.js   catalog (22 SKUs, 6 categories), Walmart source per SKU, pricing rule, usage models
src/store.js     all business logic: pricing, policy, subscriptions, billing, fulfillment, events, idempotency
src/payments.js  MockPayments and StripePayments (REST, no SDK)
src/web.js       human pages: sign-in, Connect (OAuth), owner page, one-tap approvals, policies, admin, Stripe webhooks
src/ui.js        shared page layout and styles
src/owner.js     sign-in, Connect, approval and owner pages
src/admin.js     operator pages (Walmart list, order detail, email log)
src/email.js     OutboxMailer (records only) and ResendMailer
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
- Monthly spend counts paid, pending and clearing orders in the account clock's calendar month, minus refunds. The limit check and the order insert happen together, so parallel orders can't overshoot it.

## Not built yet

Hosting, Postgres, outbound webhooks to agents, SMS approvals, a price-change mechanism (prices change only by deploy today, so the 7-day notice in the terms is a manual step: email subscribers before deploying a price increase), and dropship or 3PL fulfillment. See the roadmap in the strategy doc.
