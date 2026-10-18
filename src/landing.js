// The human-facing home page: what the store promises the person whose agent
// shops here. Agents asking for JSON at / still get the machine index, and
// Accept: text/markdown gets llms.txt.
//
// Design source: Figma "Domaru landing page" (Landing page). The idea is the
// supermarket shelf-edge label plus a live look at the trust layer: the agent's
// own calls on the left, the owner's approval card on the right.

import { PRODUCTS, presentProduct, monthlyUsage, baseUnitsPerPack } from './catalog.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

const SHELF = ['TP-2PLY-30', 'PT-2PLY-12', 'DW-PODS-115', 'LAUN-LIQ-115', 'TRASH-13G-90', 'WIPES-225', 'HSOAP-REFILL-56', 'BATT-AA-24'];

/** "$1.03 per roll", "15¢ per load": the boxed unit price on a shelf tag. */
function unitPrice(p) {
  const cents = p.price_cents / baseUnitsPerPack(p);
  const unit = { sq_ft: 'sq ft' }[p.pack.base_unit] ?? p.pack.base_unit ?? p.pack.unit;
  const amount = cents >= 100 ? usd(Math.round(cents)) : `${cents < 10 ? cents.toFixed(1) : Math.round(cents)}¢`;
  return { amount, per: `per ${unit}` };
}

function lasts(p, people = 2) {
  const days = baseUnitsPerPack(p) / (monthlyUsage(p, people) / 30);
  if (days < 90) return `about ${Math.round(days)} days`;
  if (days < 330) return `about ${Math.round(days / 30)} months`;
  return 'about a year';
}

function tag(raw) {
  const p = presentProduct(raw);
  const u = unitPrice(raw);
  return `<article class="tag">
    <div class="tag__top"><span>${esc(p.brand)}</span><span class="mono">${esc(p.sku)}</span></div>
    <h3 class="tag__name">${esc(p.name)}</h3>
    <div class="tag__prices">
      <p class="tag__price">${usd(p.price_cents)}</p>
      <p class="tag__unit"><span>Unit price</span><strong>${u.amount}</strong><span>${esc(u.per)}</span></p>
    </div>
    <p class="tag__note">Lasts a 2-person home ${lasts(raw)}</p>
  </article>`;
}

const STYLE = `
/* Layout: poster headline, then pitch beside the trust layer (agent transcript + owner card); signage numbers; a month strip; shelf rails of price tags; a dark band for assistant makers. */
:root {
  --paper: #f6f6f3; --surface: #ffffff; --ink: #141414; --ink-2: #3d3d3a; --muted: #6b6b66; --rule: #dcdcd6;
  --tag: #ffd60a; --tag-hover: #ffe14d; --stop: #d7261e; --go: #1f8a4c;
  --band: #141414; --band-ink: #f2f2ee; --band-muted: #a3a39c; --band-rule: #3a3a36; --code: #1e1e1c; --go-dark: #3ccf7a; --stop-dark: #ff5a4a;
  --display: "Barlow Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  --body: "Barlow", "Helvetica Neue", Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
  --s1: 0.25rem; --s2: 0.5rem; --s3: 0.75rem; --s4: 1rem; --s5: 1.5rem; --s6: 2rem; --s8: 3rem; --s10: 4rem; --s12: 5rem; --s14: 6rem;
  --radius: 4px;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #121211; --surface: #1c1c1a; --ink: #f2f2ee; --ink-2: #d0d0ca; --muted: #9a9a93; --rule: #33332f;
  --stop: #ff5a4a; --go: #3ccf7a; --band: #000000; --code: #161615; color-scheme: dark; } }
:root[data-theme="dark"] {
  --paper: #121211; --surface: #1c1c1a; --ink: #f2f2ee; --ink-2: #d0d0ca; --muted: #9a9a93; --rule: #33332f;
  --stop: #ff5a4a; --go: #3ccf7a; --band: #000000; --code: #161615; color-scheme: dark; }

* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink-2); font: 400 1.0625rem/1.6 var(--body); -webkit-font-smoothing: antialiased; }
h1, h2, h3, p { margin: 0; }
[hidden] { display: none !important; }
h1, h2, h3 { color: var(--ink); }
a { color: inherit; }
.mono { font-family: var(--mono); }
:focus-visible { outline: 3px solid var(--tag); outline-offset: 3px; }
.wrap { max-width: 1200px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.display { font-family: var(--display); font-weight: 900; text-transform: uppercase; letter-spacing: -0.005em; text-wrap: balance; }

/* buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0.75rem 1.5rem; border-radius: var(--radius); border: 2px solid var(--ink); font: 700 1rem/1 var(--body); text-decoration: none; color: var(--ink); background: transparent; cursor: pointer; transition: transform 150ms ease, background-color 150ms ease; }
.btn:hover { transform: translateY(-1px); }
.btn:active { transform: none; }
.btn--primary { background: var(--tag); border-color: var(--tag); color: #141414; }
.btn--primary:hover { background: var(--tag-hover); border-color: var(--tag-hover); }
.btn--dark { background: var(--ink); color: var(--paper); }

/* nav */
.nav { display: flex; align-items: center; justify-content: space-between; gap: var(--s5); padding-block: var(--s5); }
.logo { display: inline-flex; align-items: center; gap: 0.625rem; font: 900 1.875rem/1 var(--display); color: var(--ink); text-decoration: none; }
.logo i { width: 18px; height: 18px; background: var(--tag); border: 2.5px solid var(--ink); }
.nav__right { display: flex; align-items: center; gap: var(--s6); }
.nav__links { display: flex; gap: var(--s6); }
.nav__links a { color: var(--muted); text-decoration: none; font-weight: 500; }
.nav__links a:hover { color: var(--ink); }
.nav__signin { color: var(--ink); font-weight: 600; text-decoration: none; padding: var(--s2) var(--s4); border: 1px solid var(--rule); border-radius: var(--radius); }
.nav__signin:hover { border-color: var(--ink); }
.nav__signin:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (max-width: 1023px) { .nav__links { display: none; } }

/* hero */
.hero { padding-block: var(--s6) var(--s14); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s10); }
.hero h1 { font-size: clamp(3.4rem, 10.6vw, 9.5rem); line-height: 0.87; }
.hero__row { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s8); align-items: start; }
@media (min-width: 1024px) { .hero__row { grid-template-columns: 352px minmax(0, 1fr); } }
.pitch { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s5); align-content: start; }
.pitch__lede { font-size: 1.375rem; line-height: 1.45; color: var(--ink-2); max-width: 30ch; }
.ctas { display: flex; flex-wrap: wrap; gap: var(--s3); }
.hint { font: 400 0.8125rem/1.5 var(--mono); color: var(--muted); overflow-wrap: anywhere; }

.trust { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s4); align-items: start; min-width: 0; }
@media (min-width: 720px) { .trust { grid-template-columns: minmax(0, 1fr) 252px; } }
.term { background: var(--band); color: var(--band-ink); border-radius: var(--radius); overflow: hidden; min-width: 0; }
.term__head { display: flex; justify-content: space-between; gap: var(--s3); padding: 0.875rem 1.25rem; border-bottom: 1px solid var(--band-rule); font: 400 0.75rem/1.4 var(--mono); color: var(--band-muted); }
.live { display: inline-flex; align-items: center; gap: 6px; color: var(--go-dark); font-weight: 700; }
.live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--go-dark); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.term__scroll { overflow-x: auto; }
.term ol { list-style: none; margin: 0; padding: 1.125rem 1.25rem 1.25rem; display: grid; gap: 0.625rem; min-width: 30rem; font: 400 0.8125rem/1.5 var(--mono); }
.term li { display: grid; grid-template-columns: 3.25rem minmax(0, 1fr) auto; gap: 0.875rem; color: var(--band-muted); }
@media (max-width: 639px) { .term ol { min-width: 0; } .term li { grid-template-columns: 3.25rem minmax(0, 1fr); row-gap: 0.125rem; } .term li > span:nth-child(2) { overflow-wrap: anywhere; } .term li > span:nth-child(3) { grid-column: 2; } }
.term li.agent span:first-child { color: var(--tag); }
.term li.agent span:nth-child(2) { color: var(--band-ink); }
.term li span:last-child { text-align: right; color: var(--band-ink); font-weight: 500; }
.term .ok { color: var(--go-dark) !important; }
.term .no { color: var(--stop-dark) !important; font-weight: 700 !important; }
@media (prefers-reduced-motion: no-preference) {
  .term li { animation: line-in 360ms cubic-bezier(0.16, 1, 0.3, 1) both; }
  .term li:nth-child(2) { animation-delay: 120ms; } .term li:nth-child(3) { animation-delay: 240ms; } .term li:nth-child(4) { animation-delay: 360ms; }
  .term li:nth-child(5) { animation-delay: 600ms; } .term li:nth-child(6) { animation-delay: 760ms; } .term li:nth-child(7) { animation-delay: 920ms; }
  .owner { animation: card-in 420ms cubic-bezier(0.16, 1, 0.3, 1) 1000ms both; }
}
@keyframes line-in { from { transform: translateX(-6px); opacity: 0.2; } }
@keyframes card-in { from { transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) { .live::before { animation: none; } .btn { transition: none; } }

.owner { background: var(--surface); border: 2px solid var(--ink); border-radius: var(--radius); padding: 1.25rem; display: grid; gap: 0.875rem; }
.owner__eyebrow { font: 600 0.6875rem/1 var(--body); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.owner__title { font: 900 2.25rem/1 var(--display); color: var(--stop); }
.owner__item b { display: block; color: var(--ink); font-weight: 600; }
.owner__item span { color: var(--muted); font-size: 0.875rem; }
.owner__amount { font: 900 3.25rem/0.95 var(--display); color: var(--ink); font-variant-numeric: tabular-nums; }
.owner__actions { display: flex; gap: var(--s2); }
.owner__actions .btn { flex: 1; padding-inline: 0.75rem; }
.meter { display: grid; gap: 6px; }
.meter__row { display: flex; justify-content: space-between; font-size: 0.8125rem; color: var(--muted); }
.meter__row b { font: 500 0.75rem/1.6 var(--mono); color: var(--ink); }
.meter__track { height: 8px; background: var(--rule); border-radius: 2px; overflow: hidden; }
.meter__track i { display: block; height: 100%; background: var(--ink); }

/* sections */
.section { padding-block: var(--s14); border-top: 1px solid var(--rule); }
.head { display: grid; gap: var(--s4); margin-bottom: var(--s8); }
.head h2 { font-size: clamp(2.5rem, 6vw, 4.5rem); line-height: 0.94; max-width: 13ch; }
.head p { font-size: 1.25rem; line-height: 1.5; max-width: 40ch; }

.numbers { display: grid; gap: var(--s8); }
@media (min-width: 900px) { .numbers { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.num { display: grid; gap: 0.875rem; align-content: start; min-width: 0; }
.num__big { font: 900 clamp(5.5rem, 8.6vw, 8.5rem)/0.88 var(--display); color: var(--ink); font-variant-numeric: tabular-nums; border-bottom: 4px solid var(--ink); padding-bottom: var(--s3); }
.num__big--stop { color: var(--stop); }
.num h3 { font-size: 1.5rem; line-height: 1.25; font-weight: 700; }
.num p { max-width: 36ch; }

.month { display: grid; grid-template-columns: repeat(31, minmax(0, 1fr)); gap: 4px; }
.month span { height: 72px; background: var(--rule); }
.month .box { background: var(--ink); } .month .low { background: var(--tag); } .month .held { background: var(--stop); }
.axis { display: flex; justify-content: space-between; font: 400 0.75rem/1 var(--mono); color: var(--muted); margin-block: var(--s4) var(--s8); }
.events { display: grid; gap: var(--s6); }
@media (min-width: 900px) { .events { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s8); } }
.event { display: grid; grid-template-columns: 14px 1fr; gap: 0.875rem; }
.event i { width: 14px; height: 14px; margin-top: 0.3rem; background: var(--ink); }
.event--low i { background: var(--tag); outline: 1px solid var(--ink); }
.event--held i { background: var(--stop); }
.event b { display: block; color: var(--ink); font-weight: 700; }
.event span { color: var(--muted); font-size: 0.9375rem; line-height: 1.55; }

.rail { display: grid; gap: var(--s5); padding-bottom: var(--s4); border-bottom: 10px solid var(--ink); margin-bottom: var(--s8); }
@media (min-width: 640px) { .rail { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1024px) { .rail { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.tag { background: var(--tag); color: #141414; border-top: 6px solid #141414; padding: 0.75rem 1rem 1rem; display: flex; flex-direction: column; gap: 0.625rem; min-width: 0; }
.tag__top { display: flex; justify-content: space-between; gap: var(--s2); font: 600 0.75rem/1.2 var(--body); letter-spacing: 0.06em; text-transform: uppercase; }
.tag__top .mono { letter-spacing: 0; text-transform: none; font-weight: 400; }
.tag__name { color: #141414; font: 700 1.0625rem/1.3 var(--body); }
.tag__prices { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s3); margin-top: auto; }
.tag__price { font: 900 clamp(3rem, 3.9vw, 3.75rem)/0.85 var(--display); white-space: nowrap; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.tag__unit { display: grid; flex-shrink: 0; text-align: center; background: #fff; border: 2px solid #141414; padding: 0.375rem 0.625rem; line-height: 1.15; font-size: 0.75rem; }
.tag__unit span:first-child { font-weight: 600; font-size: 0.625rem; letter-spacing: 0.06em; text-transform: uppercase; }
.tag__unit strong { font: 800 1.625rem/1.1 var(--display); font-variant-numeric: tabular-nums; }
.tag__note { font-weight: 600; font-size: 0.8125rem; border-top: 1px solid rgba(20, 20, 20, 0.35); padding-top: var(--s2); }
.fine { font-size: 0.9375rem; color: var(--muted); max-width: 70ch; }

/* band for assistant makers */
.band { background: var(--band); color: var(--band-muted); padding-block: var(--s14); }
.band__row { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s8); }
@media (min-width: 1024px) { .band__row { grid-template-columns: 470px minmax(0, 1fr); gap: var(--s10); } }
.band h2 { color: var(--band-ink); font-size: clamp(2.5rem, 6vw, 4.5rem); line-height: 0.94; margin-bottom: var(--s5); }
.band__lede { font-size: 1.1875rem; line-height: 1.55; max-width: 38ch; }
.tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--band-rule); }
.tabs button { font: 600 0.9375rem/1 var(--body); color: var(--band-muted); background: none; border: 0; border-bottom: 3px solid transparent; padding: 0.875rem 1.125rem; min-height: 44px; white-space: nowrap; cursor: pointer; }
.tabs button[aria-selected="true"] { color: var(--band-ink); border-bottom-color: var(--tag); }
.tabs button:hover { color: var(--band-ink); }
.code { background: var(--code); padding: 1.375rem 1.5rem; display: grid; gap: 0.625rem; }
.code__row { display: flex; justify-content: space-between; gap: var(--s4); align-items: flex-start; }
.code pre { margin: 0; font: 400 0.9375rem/1.6 var(--mono); color: var(--band-ink); white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.code .comment { font: 400 0.875rem/1.55 var(--mono); color: var(--band-muted); }
.copy { font: 600 0.8125rem/1 var(--body); color: var(--band-ink); background: none; border: 1px solid var(--band-rule); border-radius: var(--radius); padding: 0.5rem 0.75rem; min-height: 36px; cursor: pointer; flex: none; }
.copy:hover { border-color: var(--band-muted); }
.doors { list-style: none; margin: 0; padding: 0.5rem 0 0; }
.doors li { display: grid; gap: var(--s1) var(--s5); padding-block: 0.875rem; border-bottom: 1px solid var(--band-rule); font-size: 0.9375rem; }
@media (min-width: 640px) { .doors li { grid-template-columns: 13.75rem 1fr; } }
.doors code { font: 500 0.875rem/1.5 var(--mono); color: var(--tag); }

footer { padding-block: var(--s8) var(--s10); display: grid; gap: var(--s5); }
.foot__row { display: flex; flex-wrap: wrap; gap: var(--s4); justify-content: space-between; align-items: center; }
.foot__row nav { display: flex; flex-wrap: wrap; gap: var(--s3) var(--s5); color: var(--muted); font-weight: 500; }
.foot__row nav a { text-decoration: none; } .foot__row nav a:hover { color: var(--ink); }
.agent-note { font: 400 0.8125rem/1.6 var(--mono); color: var(--muted); max-width: 82ch; }
`;

const FONTS = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800;900&family=Barlow:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap';

const SCRIPT = `
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  }));
  $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const text = b.closest('.code__row').querySelector('pre').textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch { const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1600);
  }));
})();`;

/** Page body. Shared by the server and the static preview build. */
export function landingBody({ base = '' } = {}) {
  const host = base.replace(/^https?:\/\//, '') || 'this site';
  const get = (sku) => PRODUCTS.find((p) => p.sku === sku);
  const tp = get('TP-2PLY-30'); const trash = get('TRASH-13G-90'); const pods = get('DW-PODS-115');
  const tax = (c) => Math.round(c * 0.08);
  const first = tp.price_cents + trash.price_cents; const firstTotal = first + tax(first);
  const stock = pods.price_cents * 8; const stockTotal = stock + tax(stock);
  const rails = [SHELF.slice(0, 4), SHELF.slice(4)].map((r) => `<div class="rail">${r.map((s) => tag(get(s))).join('')}</div>`).join('');
  const marks = { 3: 'box', 12: 'low', 14: 'box', 17: 'held' };
  const month = Array.from({ length: 31 }, (_, i) => `<span${marks[i + 1] ? ` class="${marks[i + 1]}"` : ''}></span>`).join('');

  const tabs = [
    ['mcp', 'Claude (MCP)', `claude mcp add --transport http domaru ${base}/mcp`, '# then ask: "Keep us stocked on paper towels, under $60 a month."'],
    ['ucp', 'Gemini (UCP)', `curl ${base}/.well-known/ucp`, '# checkouts live at /ucp/checkout-sessions, with your agent key'],
    ['rest', 'REST', `curl -X POST ${base}/v1/accounts -d '{"name":"Our flat","email":"you@example.com"}'`, '# returns an agent api_key; the owner gets a sign-in link by email'],
    ['prompt', 'Setup prompt', `Read ${base}/llms.txt and connect Domaru for our home. I'll approve it from the email.`, '# paste into any assistant that can browse or call tools'],
  ];

  return `
<div class="wrap">
  <header class="nav">
    <a class="logo" href="#top"><i aria-hidden="true"></i>Domaru</a>
    <div class="nav__right">
      <nav class="nav__links" aria-label="Sections"><a href="#limits">Limits</a><a href="#how">How it works</a><a href="#prices">Prices</a><a href="#assistants">For assistants</a></nav>
      <a class="nav__signin" href="${esc(base)}/owner">Sign in</a>
    </div>
  </header>

  <main id="top">
    <div class="hero">
      <h1 class="display">Never run out.<br>Never overspend.</h1>
      <div class="hero__row">
        <div class="pitch">
          <p class="pitch__lede">Your AI agent keeps the toilet paper, detergent and trash bags coming. You set the limits. It can't overspend.</p>
          <div class="ctas"><a class="btn btn--primary" href="#how">See how it works</a><a class="btn" href="#prices">See prices</a></div>
          <p class="hint">Agents: start at ${esc(host)}/llms.txt</p>
        </div>

        <div class="trust" aria-label="Example: an agent's calls and the owner's approval card">
          <div class="term">
            <div class="term__head"><span>agent session · household acct_4471</span><span class="live">LIVE</span></div>
            <div class="term__scroll"><ol>
              <li class="agent"><span>agent</span><span>quote(TP-2PLY-30 ×1, TRASH-13G-90 ×1)</span><span>${usd(firstTotal)}</span></li>
              <li><span>store</span><span>within $150/order and $400/month</span><span class="ok">ok</span></li>
              <li class="agent"><span>agent</span><span>place_order()</span><span class="ok">${usd(firstTotal)} charged</span></li>
              <li><span>store</span><span>quote − charge</span><span>$0.00</span></li>
              <li class="agent"><span>agent</span><span>quote(DW-PODS-115 ×8)</span><span>${usd(stockTotal)}</span></li>
              <li><span>store</span><span>over the $150 per-order limit</span><span class="no">HELD</span></li>
              <li class="agent"><span>agent</span><span>approve(ord_7f3a)</span><span class="no">403 owner_only</span></li>
            </ol></div>
          </div>
          <div class="owner">
            <p class="owner__eyebrow">Your phone · owner email</p>
            <p class="owner__title">Held for you</p>
            <p class="owner__item"><b>${esc(pods.name.replace('Dishwasher Pods, ', 'Dishwasher Pods, ').replace(' count', ' ct'))} × 8</b><span>Over your $150 per-order limit</span></p>
            <p class="owner__amount">${usd(stockTotal)}</p>
            <div class="owner__actions"><span class="btn btn--dark" role="presentation">Approve</span><span class="btn" role="presentation">Decline</span></div>
            <div class="meter"><div class="meter__row"><span>October</span><b>${usd(firstTotal)} of $400</b></div><div class="meter__track"><i style="width:${Math.round((firstTotal / 40000) * 100)}%"></i></div></div>
          </div>
        </div>
      </div>
    </div>

    <section class="section" id="limits">
      <div class="head"><h2 class="display">Your agent's limits, in three numbers</h2><p>Your agent gets one key and you get another. Our server checks these on every order, whatever the agent says.</p></div>
      <div class="numbers">
        <div class="num"><p class="num__big">$150</p><h3>It can't overspend.</h3><p>Set a per-order cap, a monthly budget and the aisles it may shop. Anything outside them waits for you.</p></div>
        <div class="num"><p class="num__big num__big--stop">0</p><h3>Orders it can approve itself.</h3><p>Approving a held order or raising a limit needs your key. The agent's key can't, so there is nothing to talk it into.</p></div>
        <div class="num"><p class="num__big">$0.00</p><h3>Between quote and charge.</h3><p>The price your agent is quoted is the price you're charged. Every box, skip and change is in a log you can both read.</p></div>
      </div>
    </section>

    <section class="section" id="how">
      <div class="head"><h2 class="display">A month of not thinking about paper towels</h2><p>Boxes are sized to your household. When something runs low early, your agent says so and the next box moves up.</p></div>
      <div class="month" role="img" aria-label="October: boxes on the 3rd and 14th, detergent running low on the 12th, a stock-up held on the 17th">${month}</div>
      <div class="axis"><span>Oct 1</span><span>Oct 15</span><span>Oct 31</span></div>
      <div class="events">
        <p class="event"><i aria-hidden="true"></i><span><b>Oct 3 and 14 · boxes arrive</b>Toilet paper and trash bags, then paper towels. Each one charged exactly as quoted.</span></p>
        <p class="event event--low"><i aria-hidden="true"></i><span><b>Oct 12 · running low</b>Your agent reports detergent is going faster than planned, so the next jug comes forward.</span></p>
        <p class="event event--held"><i aria-hidden="true"></i><span><b>Oct 17 · held for you</b>A ${usd(stockTotal)} stock-up is over your $150 limit. It waits, and nothing is charged unless you approve.</span></p>
      </div>
    </section>

    <section class="section" id="prices">
      <div class="head"><h2 class="display">The boring stuff, priced like a shelf tag</h2><p>Brands you know, in the pack sizes big stores sell. Subscriptions take 5% off, and boxes over $35 ship free.</p></div>
      ${rails}
      <p class="fine">We buy from major retailers and arrange delivery to your door, so your box may carry the retailer's name. Our price includes that service, and you see it before anything is charged.</p>
    </section>
  </main>
</div>

<section class="band" id="assistants">
  <div class="wrap band__row">
    <div>
      <h2 class="display">Add Domaru to your assistant</h2>
      <p class="band__lede">For teams building personal assistants. Your users already ask it to run errands. One connection lets it keep their house stocked, with subscriptions, held orders and spending limits your users set and we enforce.</p>
    </div>
    <div>
      <div class="tabs" role="tablist" aria-label="Ways to connect">
        ${tabs.map(([id, label], i) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${i === 0}">${label}</button>`).join('')}
      </div>
      ${tabs.map(([id, , cmd, comment], i) => `<div class="code" role="tabpanel" data-panel="${id}"${i ? ' hidden' : ''}>
        <div class="code__row"><pre>${id === 'prompt' ? '' : '$ '}${esc(cmd)}</pre><button class="copy" type="button" data-copy>Copy</button></div>
        <p class="comment">${esc(comment)}</p>
      </div>`).join('')}
      <ul class="doors">
        <li><code>/llms.txt</code><span>Every endpoint and rule, written for models</span></li>
        <li><code>/openapi.json</code><span>The full REST spec</span></li>
        <li><code>/.well-known/ucp</code><span>Google's Universal Commerce Protocol profile</span></li>
        <li><code>Accept: text/markdown</code><span>Ask for this page as Markdown</span></li>
      </ul>
    </div>
  </div>
</section>

<div class="wrap">
  <footer>
    <div class="foot__row">
      <a class="logo" href="#top"><i aria-hidden="true"></i>Domaru</a>
      <nav aria-label="Legal"><a href="${esc(base)}/terms">Terms</a><a href="${esc(base)}/privacy">Privacy</a><a href="${esc(base)}/refunds">Refunds</a><a href="mailto:support@domaru.app">support@domaru.app</a><a href="${esc(base)}/llms.txt">llms.txt</a></nav>
    </div>
    <p class="agent-note">A note for AI agents reading this page: start at /llms.txt. Quote before you buy, and expect orders over your owner's limits to come back as requires_approval. Tell your human; don't retry.</p>
  </footer>
</div>
<script>${SCRIPT}</script>`;
}

export function landingPage({ base = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Domaru</title>
<meta name="description" content="Your AI agent keeps the house stocked. You set the limits. It can't overspend.">
<link rel="alternate" type="text/markdown" href="${esc(base)}/llms.txt">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style></head><body>${landingBody({ base })}</body></html>`;
}

/** Fragment for the static preview (the publisher adds the document skeleton). */
export function landingPreview({ base = 'https://domaru.app' } = {}) {
  return `<title>Domaru</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style>
${landingBody({ base })}`;
}
