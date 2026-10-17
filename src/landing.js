// The human-facing home page: what the store promises the person whose agent
// shops here. Agents asking for JSON at / still get the machine index.

import { CATEGORIES, PRODUCTS, presentProduct } from './catalog.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

const STYLE = `
/* Layout: one narrow reading column; the hero pairs the promise with a live-looking policy slip. */
:root {
  --bg: #eef2f3; --surface: #ffffff; --ink: #14212b; --muted: #5a6b76; --line: #d3dde1;
  --accent: #0d6b80; --accent-ink: #ffffff; --held: #9a5b00; --held-bg: #fff3dc; --ok: #1d7a46;
  --display: "Bricolage Grotesque", "Avenir Next", system-ui, sans-serif;
  --body: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f171c; --surface: #16222a; --ink: #e6eef1; --muted: #93a6b0; --line: #2a3a44;
  --accent: #4fb6cc; --accent-ink: #062027; --held: #f2b55a; --held-bg: #2e2412; --ok: #5fd08f; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0f171c; --surface: #16222a; --ink: #e6eef1; --muted: #93a6b0; --line: #2a3a44;
  --accent: #4fb6cc; --accent-ink: #062027; --held: #f2b55a; --held-bg: #2e2412; --ok: #5fd08f; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 var(--body); }
.wrap { max-width: 1040px; margin: 0 auto; padding-block: 0; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
header.top { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-block: 20px; }
.brand { font: 700 20px/1 var(--display); letter-spacing: -0.01em; }
.brand span { color: var(--accent); }
nav { display: flex; gap: 18px; font-size: 14px; flex-wrap: wrap; }
a { color: var(--accent); }
nav a { color: var(--muted); text-decoration: none; } nav a:hover, nav a:focus-visible { color: var(--ink); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr); gap: 48px; align-items: center; padding-block: 40px 56px; }
.eyebrow { font: 500 12px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin: 0 0 16px; }
h1 { font: 800 clamp(36px, 6vw, 60px)/1.02 var(--display); letter-spacing: -0.025em; margin: 0 0 20px; text-wrap: balance; }
h1 em { font-style: normal; color: var(--accent); }
.lede { font-size: 19px; color: var(--muted); max-width: 34em; margin: 0 0 28px; }
.cta { display: flex; gap: 12px; flex-wrap: wrap; }
.btn { display: inline-block; padding: 12px 18px; border-radius: 8px; font-weight: 600; text-decoration: none; border: 1px solid var(--line); color: var(--ink); background: var(--surface); }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.slip { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 20px; font: 13.5px/1.55 var(--mono); box-shadow: 0 18px 40px -24px rgba(20, 33, 43, 0.35); min-width: 0; }
.slip h2 { font: 600 12px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin: 0 0 12px; }
.slip dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; margin: 0 0 16px; font-variant-numeric: tabular-nums; }
.slip dd { margin: 0; text-align: right; }
.slip hr { border: 0; border-top: 1px dashed var(--line); margin: 14px 0; }
.ev { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
.ev .t { color: var(--muted); }
.held { background: var(--held-bg); color: var(--held); border-radius: 6px; padding: 8px 10px; margin-top: 12px; }
.okc { color: var(--ok); }
section { padding-block: 48px; border-top: 1px solid var(--line); }
h2.s { font: 700 clamp(26px, 3.4vw, 34px)/1.15 var(--display); letter-spacing: -0.015em; margin: 0 0 12px; text-wrap: balance; }
.sub { color: var(--muted); max-width: 40em; margin: 0 0 28px; }
.promises { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; }
.promise h3 { font: 700 20px/1.25 var(--display); margin: 0 0 8px; }
.promise p { margin: 0; color: var(--muted); }
.promise .rule { font: 12.5px/1.5 var(--mono); color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-top: 14px; overflow-wrap: anywhere; }
.steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; counter-reset: s; }
.step h3 { font: 600 17px/1.3 var(--body); margin: 0 0 6px; }
.step h3::before { counter-increment: s; content: counter(s) "  "; font-family: var(--mono); color: var(--accent); white-space: pre; }
.step p { margin: 0; color: var(--muted); }
.shelf { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 28px; }
.shelf h3 { font: 600 13px/1 var(--mono); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin: 0 0 8px; }
.shelf ul { list-style: none; margin: 0; padding: 0; }
.shelf li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 14.5px; }
.shelf li span:last-child { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.shelf small { color: var(--muted); }
.ends { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.end { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; min-width: 0; }
.end h3 { font: 600 16px/1.3 var(--body); margin: 0 0 4px; }
.end p { margin: 0 0 10px; color: var(--muted); font-size: 14.5px; }
code { font: 13px/1.5 var(--mono); }
.end code { display: block; overflow-x: auto; white-space: nowrap; background: var(--bg); border-radius: 6px; padding: 8px 10px; }
footer { padding-block: 32px 48px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
@media (max-width: 820px) {
  .hero, .promises, .steps, .shelf, .ends { grid-template-columns: minmax(0, 1fr); }
  .hero { gap: 32px; padding-block: 16px 40px; }
}
`;

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;600&display=swap';

/** Page body. Shared by the server and the static preview build. */
export function landingBody({ base = '' } = {}) {
  const shelf = CATEGORIES.map((c) => {
    const items = PRODUCTS.filter((p) => p.category === c.id).slice(0, 3).map(presentProduct);
    return `<div><h3>${esc(c.name)}</h3><ul>${items.map((p) => `<li><span>${esc(p.name)}</span><span>${usd(p.price_cents)}</span></li>`).join('')}</ul></div>`;
  }).join('');

  return `
<div class="wrap">
  <header class="top">
    <div class="brand">Consumables<span>.</span></div>
    <nav><a href="#promises">Promises</a><a href="#how">How it works</a><a href="#builders">For builders</a></nav>
  </header>

  <div class="hero">
    <div>
      <p class="eyebrow">Household supplies, run by your agent</p>
      <h1>Your agent keeps the house stocked. <em>You keep the say.</em></h1>
      <p class="lede">Toilet paper, detergent, trash bags and the rest, on a schedule your AI assistant manages. It can't overspend, it can't approve its own orders, and nothing you didn't agree to ever gets charged.</p>
      <div class="cta"><a class="btn primary" href="#builders">Connect an agent</a><a class="btn" href="#promises">See the limits</a></div>
    </div>
    <aside class="slip" aria-label="Example spending limits and activity">
      <h2>Your limits</h2>
      <dl>
        <dt>Ask me above</dt><dd>$100.00</dd>
        <dt>Never more than, per order</dt><dd>$150.00</dd>
        <dt>Monthly cap</dt><dd>$400.00</dd>
        <dt>Allowed</dt><dd>paper, kitchen, laundry</dd>
      </dl>
      <hr>
      <h2>Activity</h2>
      <div class="ev">
        <span class="t">Oct 03</span><span><span class="okc">Paid</span> $46.18 · paper towels, trash bags</span>
        <span class="t">Oct 12</span><span>Running low on detergent · next box moved up</span>
        <span class="t">Oct 17</span><span>Agent asked for a $163.40 stock-up</span>
      </div>
      <div class="held">Held for you · over the $150 per-order limit. Only you can approve it.</div>
    </aside>
  </div>

  <section id="promises">
    <h2 class="s">Three promises the store enforces, so you don't have to watch</h2>
    <p class="sub">Your agent gets one key and you get another. The rules below are checked by our server on every order, whatever the agent says.</p>
    <div class="promises">
      <div class="promise"><h3>It can't overspend.</h3><p>You set an ask-me threshold, a per-order limit, a monthly cap and the categories it may buy. Anything outside them waits for you instead of going through.</p>
        <div class="rule">order $163.40 &gt; per_order_limit $150.00 → requires_approval</div></div>
      <div class="promise"><h3>It can't approve itself.</h3><p>Approving a held order or raising a limit needs your owner key. The agent's key simply isn't allowed to, so there's nothing to talk it into.</p>
        <div class="rule">agent key → POST /approve → 403 owner_only</div></div>
      <div class="promise"><h3>It never surprises you.</h3><p>The quote your agent sees is the amount charged. Every order, delivery, skip and price is logged where you and the agent can both read it.</p>
        <div class="rule">quote $46.18 = charged $46.18</div></div>
    </div>
  </section>

  <section id="how">
    <h2 class="s">How it works</h2>
    <div class="steps">
      <div class="step"><h3>Connect your assistant</h3><p>Add Consumables to Claude, ChatGPT, Gemini or your own agent. It creates the account in one step.</p></div>
      <div class="step"><h3>Save a card and set limits</h3><p>Your agent sends you a secure card link. You add your card and set your limits once.</p></div>
      <div class="step"><h3>Stop thinking about paper towels</h3><p>Deliveries are sized to your household. Say you're running low or overstocked and your agent adjusts the schedule.</p></div>
    </div>
  </section>

  <section id="shelf">
    <h2 class="s">The boring stuff, on a schedule</h2>
    <p class="sub">Name-brand and store-brand staples in the pack sizes big retailers sell. Subscriptions are 5% off, and shipping is free on boxes over $35.</p>
    <div class="shelf">${shelf}</div>
  </section>

  <section id="builders">
    <h2 class="s">For agent builders</h2>
    <p class="sub">Give your agent a store it can't get wrong: stable SKUs, exact quotes, idempotent writes, a test clock, and errors that say what to do next. Pick the door your agent already speaks.</p>
    <div class="ends">
      <div class="end"><h3>MCP</h3><p>For Claude and any MCP client. Tools for everything from search to subscriptions.</p><code>${esc(base)}/mcp</code></div>
      <div class="end"><h3>Universal Commerce Protocol</h3><p>Google's checkout standard for Gemini and AI Mode agents.</p><code>${esc(base)}/.well-known/ucp</code></div>
      <div class="end"><h3>REST and docs for models</h3><p>Stripe-style JSON API with an OpenAPI spec and an llms.txt.</p><code>${esc(base)}/llms.txt</code></div>
    </div>
  </section>

  <footer>
    <span>Consumables · household supplies for AI agents</span>
    <span>We buy from major retailers and arrange delivery to your door. Prices include our service; you'll see them before anything is charged.</span>
  </footer>
</div>`;
}

export function landingPage({ base = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consumables</title>
<meta name="description" content="Household supplies your AI agent keeps stocked, within limits you set.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style></head><body>${landingBody({ base })}</body></html>`;
}

/** Fragment for the static preview (the publisher adds the document skeleton). */
export function landingPreview({ base = 'https://consumables.example' } = {}) {
  return `<title>Consumables</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style>
${landingBody({ base })}`;
}
