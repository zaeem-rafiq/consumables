# Becoming the default store for agentic shopping

## The goal

When someone tells an agent "we're out of paper towels" or "keep the house stocked", the agent should reach for Consumables without being told to. Supabase got there for agent-built apps: ask Lovable, Bolt, v0 or Claude to "add a database" and you usually get Supabase. We want the same reflex for replenishment.

## Why this category, why now

- **Replenishment is the first purchase people will hand to an agent.** It's low-consideration, it repeats, the products are commodities, and the cost of a wrong pick is small. Nobody wants to approve toilet paper. Plenty of people want it to never run out.
- **Agents can already buy, but the stores weren't built for them.** Retail sites are built for human eyes and pull agents into checkout flows, upsells, CAPTCHAs and listings that change daily. Agents need stable SKUs, deterministic prices, structured errors and a clear boundary on spending authority.
- **The payment rails for agents are being laid now.** OpenAI and Stripe's Agentic Commerce Protocol, Google's AP2 (Agent Payments Protocol), Visa Intelligent Commerce and Mastercard Agent Pay all launched in 2025. Whoever is easiest to buy from inside those rails gets the early volume. (This is from my training knowledge; check the current state of each before committing engineering time.)

## What made Supabase the default, and our version of each

| Supabase lever | What it means | Our version |
|---|---|---|
| Built on Postgres, which models already know | Agents write correct code against it on the first try | Copy Stripe's API shape (ids like `sub_`, `pm_card_visa` test tokens, idempotency keys, test clocks), which models have seen millions of times. **In the MVP.** |
| Instant provisioning, free tier | An agent can create a project with no human in the loop | `create_account` in one call, plus a full sandbox with a test clock. **In the MVP.** Live mode needs one human step: claim the account and add a card. |
| A first-class MCP server and LLM-friendly docs | Tools are discoverable inside the agent | MCP over stdio and Streamable HTTP, tool annotations, server instructions, `/llms.txt`, `/openapi.json`, and errors that carry a `hint`. **In the MVP.** |
| Distribution through the builders | The platform picks Supabase for the user | Get listed as the default "household supplies" tool in assistant connector directories (Claude, ChatGPT apps, Gemini) and MCP registries, and partner with personal-assistant apps. |
| Trust (RLS, auth, backups) | Safe to hand to agents | **Owner-controlled spend policy and approvals.** The agent can never approve its own order or raise its own limit. This is the main reason a human would let *this* store run unattended. **In the MVP.** |

## The moat: trust and reliability, not the catalog

Anyone can list paper towels. What's hard to copy is being the store a household (or a property manager running 200 units) will let an agent run with no supervision. That comes down to five promises:

1. **Bounded authority.** Policy is set by the human and enforced by the server. Anything outside it is held for approval, and nothing is silently charged. Next we map this onto AP2-style mandates so the bound travels with the payment credential.
2. **Price and stock guarantees.** Subscription price locks (e.g. 90 days) and substitution rules the owner sets in advance ("same or cheaper, same category, never scented"). Agents hate surprises even more than humans do.
3. **Determinism.** A quote equals the charge. Idempotent writes. Every state change is in an event feed, so an agent can audit what happened since it last checked.
4. **A usage model, not just a cart.** We ship cadence recommendations and `running_low` / `overstocked` signals today. Next comes learning per-household consumption, so the agent's job shrinks to "confirm".
5. **Neutrality.** We work the same in every assistant and every protocol, and we're not trying to pull the agent into a broader retail funnel. That's the position the big retailers can't credibly take.

## Wedges, in order

1. **Developers building household and personal assistants.** Give them the cheapest way to add "and it restocks your home" to their agent: an MCP install plus a revenue share per subscription they create. This is the Supabase playbook, where builders choose the default for end users.
2. **Short-term rentals, property managers and small offices.** Many locations with predictable usage, and an operator who already wants this automated. Bigger baskets, lower churn, and owner approval maps neatly onto how they already work. Needs multi-location accounts.
3. **Consumers through the big assistants.** A listing in ChatGPT, Claude and Gemini connector directories, plus checkout via ACP and AP2. This is the highest volume but the most competitive, so it's better entered with proof from wedges 1 and 2.

## Economics (to validate)

Consumables are a low-margin, high-frequency business. What makes it work:

- **Private label** ("Basics" in the catalog) for margin on the highest-volume SKUs.
- **Subscription predictability** lets us buy and stock ahead with a 3PL. Early on, dropship through a wholesale distributor to avoid holding inventory.
- **Basket building**: free shipping at a threshold, and cadence alignment so one box ships per cycle.
- **A partner revenue share** that's cheaper than paid acquisition.

## Key metrics

- Time from first API call to first order. Target: under 60 seconds in the sandbox.
- Share of orders with zero human touch, and the approval rate when a human is asked.
- Agent-initiated GMV, number of distinct agent platforms, and subscriptions per partner.
- Stockout incidents reported via `running_low` (lower is better), and churn.

## Roadmap

**Now (this MVP):** catalog, subscriptions with full lifecycle control, spend policy and approvals, mocked payments and fulfillment, HTTP API, MCP (stdio and remote), a test clock, and 19 passing tests.

**Next:**
- Hosted deploy with a public URL and a listing in MCP registries
- Postgres
- Stripe (test, then live), with the owner claiming the account and adding a card
- An approval link sent to the owner by email or SMS
- Outbound webhooks
- OAuth for the remote MCP endpoint so a human can connect from claude.ai or ChatGPT
- A real fulfillment partner

**Later:**
- ACP and AP2 checkout
- Price locks and substitution rules
- Multi-location org accounts
- Learned consumption models (and smart-device signals where they exist)
- Partner revenue share and a dashboard

## Risks

- **Amazon** (Subscribe & Save, Alexa+, "Buy for Me"). Our counter is neutrality, an agent-first API, and the trust layer. We don't compete on selection.
- **Margins.** We have to get to private label and dense delivery quickly.
- **Fraud and abuse** from autonomous signups. Sandbox stays free, but live mode always requires a verified human owner.
- **Protocol churn.** Keep the core protocol-agnostic and treat ACP, AP2 and MCP as adapters.
