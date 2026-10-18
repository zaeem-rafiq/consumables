# Becoming the default store for agentic shopping

## The goal

When someone tells an agent "we're out of paper towels" or "keep the house stocked", the agent should reach for Consumables without being told to. Supabase got there for agent-built apps: ask Lovable, Bolt, v0 or Claude to "add a database" and you usually get Supabase. We want the same reflex for replenishment.

## Why this category, why now

- **Replenishment is the first purchase people will hand to an agent.** It's low-consideration, it repeats, the products are commodities, and the cost of a wrong pick is small. Nobody wants to approve toilet paper. Plenty of people want it to never run out.
- **Agents can already buy, but the stores weren't built for them.** Retail sites are built for human eyes and pull agents into checkout flows, upsells, CAPTCHAs and listings that change daily. Agents need stable SKUs, deterministic prices, structured errors and a clear boundary on spending authority.
- **The rails are settling, and not where we first assumed.** ChatGPT retired its in-chat Instant Checkout in March 2026, so OpenAI and Stripe's Agentic Commerce Protocol (ACP) now matters mostly as a product-feed format. Google's Universal Commerce Protocol (UCP) launched in January 2026 and has become the stronger checkout rail. It was co-developed with Shopify, Walmart and Target, and works alongside Google's AP2 payments protocol. On the payments side, Stripe's Shared Payment Token now carries Visa Intelligent Commerce and Mastercard Agent Pay credentials with built-in spending caps. That fits our bounded-authority promise well. (Details and sources are in the competitive landscape doc.)
- **Every brand is becoming agent-buyable by default.** In March 2026 Shopify turned on agent checkout for about 5.6 million stores, at no extra fee. A catalog plus an API is now table stakes. What sets us apart has to be trust (limits, approvals, no surprises), subscriptions with a usage model, and fulfillment economics.

## What made Supabase the default, and our version of each

| Supabase lever | What it means | Our version |
|---|---|---|
| Built on Postgres, which models already know | Agents write correct code against it on the first try | Copy Stripe's API shape (ids like `sub_`, `pm_card_visa` test tokens, idempotency keys, test clocks), which models have seen millions of times. **In the MVP.** |
| Instant provisioning, free tier | An agent can create a project with no human in the loop | `create_account` in one call, plus a full sandbox with a test clock. **In the MVP.** Live mode needs one human step: claim the account and add a card. |
| A first-class MCP server and LLM-friendly docs | Tools are discoverable inside the agent | MCP over stdio and Streamable HTTP, tool annotations, server instructions, `/llms.txt`, `/openapi.json`, and errors that carry a `hint`. **In the MVP.** |
| Distribution through the builders | The platform picks Supabase for the user | Get listed as the default "household supplies" tool in assistant connector directories (Claude, ChatGPT apps, Gemini) and MCP registries, and partner with personal-assistant apps. Consider also listing through Shopify's free Agentic Plan for cheap discovery in ChatGPT and Gemini, while subscriptions and spend rules stay on our own API. |
| Trust (RLS, auth, backups) | Safe to hand to agents | **Owner-controlled spend policy and approvals.** The agent can never approve its own order or raise its own limit. This is the main reason a human would let *this* store run unattended. **In the MVP.** |

## The moat: trust and reliability, not the catalog

Anyone can list paper towels. What's hard to copy is being the store a household (or a property manager running 200 units) will let an agent run with no supervision. That comes down to five promises:

1. **Bounded authority.** Policy is set by the human and enforced by the server. Anything outside it is held for approval, and nothing is silently charged. Next we map this onto spending-capped payment credentials (Stripe Shared Payment Tokens, AP2 mandates) so the bound travels with the payment itself. It's the failure people fear: in April 2026 an agent running a Stockholm cafe over-ordered toilet paper and about 3,000 gloves. Limits and held-for-approval orders make that impossible here.
2. **Price and stock guarantees.** Subscription price locks (e.g. 90 days) and substitution rules the owner sets in advance ("same or cheaper, same category, never scented"). Agents hate surprises even more than humans do.
3. **Determinism.** A quote equals the charge. Idempotent writes. Every state change is in an event feed, so an agent can audit what happened since it last checked.
4. **A usage model, not just a cart.** We ship cadence recommendations and `running_low` / `overstocked` signals today. Next comes learning per-household consumption, so the agent's job shrinks to "confirm".
5. **Neutrality.** We work the same in every assistant and every protocol, and we're not trying to pull the agent into a broader retail funnel. That's the position the big retailers can't credibly take.

## Wedges, in order

1. **Developers building household and personal assistants.** Give them the cheapest way to add "and it restocks your home" to their agent: an MCP install plus a revenue share per subscription they create. This is the Supabase playbook, where builders choose the default for end users.
2. **Short-term rentals, property managers and small offices.** Many locations with predictable usage, and an operator who already wants this automated. Bigger baskets, lower churn, and owner approval maps neatly onto how they already work. Bigger orders also fix the shipping math that sinks small household orders. Today restocking here is manual or bundled into management fees (Awning's starts around 15% of revenue). Needs multi-location accounts.
3. **Consumers through the big assistants.** Gemini checkout via UCP, ChatGPT discovery via an ACP product feed (ChatGPT no longer completes purchases in-chat), and Claude via our MCP connector. Claude has no shopping marketplace, so an MCP connector is the open way in, and that's exactly what we ship. This channel is the highest volume but the most competitive, so it's better entered with proof from wedges 1 and 2.

## Economics

Consumables are a low-margin, high-frequency business. A first margin check (October 2026, `business/margin-check.md` in the project files) gave us real numbers:

- **Most items make 40–60% before shipping. Shipping decides everything.** Every box we send costs $8–12 before it holds anything.
- **Bulky paper loses money when we ship it ourselves from one location.** Carriers bill a 12-roll paper towel box as about 27 lb, so the label costs about $42 for a $26.59 item. A paper-staples basket loses about $40 per order. Prices can't fix this.
- **Kitchen, laundry and bath items work.** They keep about 15% at today's prices and about 26% with a 15% price rise.

What makes it work:

- **Concierge phase: retailers deliver, we don't ship boxes.** Each order is placed on Walmart.com (with a Walmart+ membership) and delivered straight to the customer, free, from a warehouse near them. That turns the paper basket from about −$40 into about +$39 (43%), and lifts the kitchen and laundry basket to about 30%. It requires our catalog's pack sizes to match Walmart's, since packs can't be split. The risk is that Walmart reserves the right to refuse sales to resellers. Amazon is the backup, and options are in `business/paper-goods-delivery.md`. This gets us to launch. It isn't the long-term model.
- **Next: a wholesale or janitorial distributor that ships for us** (Essendant and similar), once volume qualifies. Case packs from regional warehouses suit rental operators especially.
- **Then: private label** ("Basics" in the catalog) for margin on the highest-volume SKUs, with our own stock at a 3PL once subscriptions make demand predictable.
- **Cheaper payments for repeat customers.** Cards are the default, since nobody shares bank details before a first order. After the first delivery, owners are offered bank payments (Stripe ACH, 0.8% capped at $5, against 2.9% + 30¢ for cards) with a 2% discount. Bank-paid subscriptions are charged about 4 business days before the retailer order, so the money clears first. On a $90 basket that saves about $2.20.
- **Basket building**: free shipping at a threshold, every-other-month cadences so each delivery is fuller, and cadence alignment so one delivery covers a cycle.
- **A partner revenue share** that's cheaper than paid acquisition.

## Key metrics

- Time from first API call to first order. Target: under 60 seconds in the sandbox.
- Share of orders with zero human touch, and the approval rate when a human is asked.
- Agent-initiated GMV, number of distinct agent platforms, and subscriptions per partner.
- Stockout incidents reported via `running_low` (lower is better), and churn.
- Money left per order after goods, delivery and card fees. Target: about 25% of what the customer pays.

## Roadmap

**Now (this MVP):** catalog, subscriptions with full lifecycle control, spend policy and approvals, Stripe payments (card setup link and off-session charges; mocked by default), concierge fulfillment with an operator page, HTTP API, MCP (stdio and remote), a test clock, and 29 passing tests.

**Next:**
- Catalog pack sizes and prices matched to retailer direct delivery, with bulky paper repriced or flagged
- Hosted deploy with a public URL and a listing in MCP registries
- Postgres
- Stripe live mode, with the owner claiming the account and adding a card
- An approval link sent to the owner by email or SMS
- Outbound webhooks
- OAuth for the remote MCP endpoint so a human can connect from claude.ai or ChatGPT
- A wholesale fulfillment partner

**Later:**
- UCP checkout (Gemini), an ACP product feed (ChatGPT discovery), and AP2 or Shared Payment Token mandates
- Price locks and substitution rules
- Multi-location org accounts
- Learned consumption models (and smart-device signals where they exist)
- Partner revenue share and a dashboard

## Risks

- **Amazon** (Subscribe & Save, and "Alexa for Shopping" with scheduled restocks and "Buy for Me"). Our counter is neutrality, an agent-first API and the trust layer; we don't compete on selection. Amazon also won a March 2026 court order blocking Perplexity's agent from shopping on Amazon. Outside agents can't rely on it, which makes neutrality a selling point.
- **Agent checkout layers** (Rye, Zinc and similar) let a developer buy from existing retailers instead of from us. They offer no subscriptions, spend policy or usage model, and buying through someone else's site carries the legal risk the Perplexity ruling showed.
- **Walmart and Instacart** are the most likely giants to open an official agent API for household goods: Instacart already has an MCP server, and Walmart co-developed UCP. Watch both.
- **Margins.** We have to get to private label and dense delivery quickly. Grove Collaborative, the best-known household subscription brand, saw revenue fall 17% year over year in Q2 2026 and received an NYSE notice. Shipping costs and churn are the reason.
- **Depending on Walmart for delivery.** While retailers deliver for us, Walmart can refuse reseller orders or close the account. Keep Amazon ready as a backup, and move to a distributor as soon as volume allows.
- **Price transparency.** Catalog prices are Walmart's price plus the ~8% sales tax we pay Walmart, card fees and a ~25% margin, which comes to about 1.65x Walmart's shelf price (toilet paper $30.99 against $18.93). Agents compare prices, and with retailer delivery the customer may see the retailer's price on the packing slip. What we sell is the restocking, limits and approvals, so we should test thinner margins on paper, or near-retail prices plus a small monthly service fee, against today's markups. A resale tax exemption would remove the ~8% we pay Walmart.
- **Fraud and abuse** from autonomous signups. Sandbox stays free, but live mode always requires a verified human owner.
- **Protocol churn.** ChatGPT's checkout lasted six months. Keep the core protocol-agnostic and treat UCP, ACP, AP2 and MCP as adapters.
