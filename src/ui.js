// Shared look for every page a person sees outside the landing page: sign-in,
// Connect Domaru, the owner's page, approvals, policies and the operator page.
// Same system as the landing page (Figma "Domaru landing page"): paper and
// ink, Barlow with Barlow Condensed for headings, shelf-tag yellow for the one
// action that matters on each page, green for done, red for stop.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

export const FONTS = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800;900&family=Barlow:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap';

const STYLE = `
:root {
  --paper: #f6f6f3; --surface: #ffffff; --sunk: #efefea; --ink: #141414; --ink-2: #3d3d3a; --muted: #6b6b66; --rule: #dcdcd6;
  --tag: #ffd60a; --tag-hover: #ffe14d; --stop: #c4211a; --stop-bg: #fdecea; --go: #1a7a43; --go-bg: #e7f4ec; --warn-bg: #fff6cc;
  --display: "Barlow Condensed", "Arial Narrow", "Helvetica Neue", sans-serif;
  --body: "Barlow", "Helvetica Neue", Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
  --s1: 0.25rem; --s2: 0.5rem; --s3: 0.75rem; --s4: 1rem; --s5: 1.5rem; --s6: 2rem; --s8: 3rem; --s10: 4rem;
  --radius: 4px;
}
@media (prefers-color-scheme: dark) { :root {
  --paper: #121211; --surface: #1c1c1a; --sunk: #171716; --ink: #f2f2ee; --ink-2: #d0d0ca; --muted: #9a9a93; --rule: #33332f;
  --stop: #ff6b5c; --stop-bg: #2a1614; --go: #3ccf7a; --go-bg: #12241a; --warn-bg: #2a2610; color-scheme: dark; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink-2); font: 400 1rem/1.6 var(--body); -webkit-font-smoothing: antialiased; }
h1, h2, h3, p { margin: 0; }
h1, h2, h3 { color: var(--ink); }
a { color: var(--ink); text-underline-offset: 3px; }
:focus-visible { outline: 3px solid var(--tag); outline-offset: 2px; }
.wrap { max-width: var(--w, 640px); margin: 0 auto; padding-inline: max(16px, env(safe-area-inset-left, 0px)); }
.wrap--wide { --w: 1040px; }

.top { border-bottom: 1px solid var(--rule); }
.top .wrap { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); min-height: 64px; }
.logo { display: inline-flex; align-items: center; gap: 0.5rem; font: 900 1.5rem/1 var(--display); color: var(--ink); text-decoration: none; text-transform: uppercase; }
.logo i { width: 14px; height: 14px; background: var(--tag); border: 2px solid var(--ink); }
.top__right { display: flex; align-items: center; gap: var(--s4); font-size: 0.9375rem; color: var(--muted); }

main { padding-block: var(--s8) var(--s10); }
.stack { display: grid; gap: var(--s5); }
.stack--tight { display: grid; gap: var(--s3); }
.title { font: 900 clamp(2.25rem, 7vw, 3.25rem)/0.95 var(--display); text-transform: uppercase; letter-spacing: -0.005em; text-wrap: balance; }
.lede { font-size: 1.125rem; line-height: 1.5; color: var(--ink-2); max-width: 52ch; }
.muted { color: var(--muted); }
.small { font-size: 0.875rem; }
.mono { font-family: var(--mono); font-size: 0.875em; }
h2.section { font: 800 1.375rem/1.15 var(--display); text-transform: uppercase; margin-top: var(--s6); }

.panel { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); padding: var(--s5); }
.panel + .panel { margin-top: var(--s3); }
.panel__head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
.panel__head h3 { font: 700 1.0625rem/1.3 var(--body); }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; min-height: 48px; padding: 0.75rem 1.5rem; border-radius: var(--radius); border: 2px solid var(--ink); font: 700 1rem/1 var(--body); text-decoration: none; color: var(--ink); background: transparent; cursor: pointer; transition: transform 150ms ease, background-color 150ms ease; }
.btn:hover { transform: translateY(-1px); }
.btn:active { transform: none; }
.btn[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; }
.btn--primary { background: var(--tag); border-color: var(--tag); color: #141414; }
.btn--primary:hover { background: var(--tag-hover); border-color: var(--tag-hover); }
.btn--quiet { border-color: var(--rule); }
.btn--stop { border-color: var(--stop); color: var(--stop); }
.btn--sm { min-height: 40px; padding: 0.5rem 1rem; font-size: 0.9375rem; }
.btn--block { width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center; }
.linkbtn { background: none; border: 0; padding: 0; font: inherit; color: var(--ink); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }

form { margin: 0; }
.form { display: grid; gap: var(--s4); }
.grid2 { display: grid; gap: var(--s4); grid-template-columns: minmax(0, 1fr); }
@media (min-width: 560px) { .grid2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
label { display: grid; gap: 0.375rem; font-weight: 600; color: var(--ink); font-size: 0.9375rem; }
label .muted { font-weight: 400; }
input[type=text], input[type=email], input[type=number], input[type=url], select, textarea {
  width: 100%; min-height: 48px; padding: 0.625rem 0.875rem; font: 400 1rem/1.4 var(--body); color: var(--ink);
  background: var(--surface); border: 1.5px solid var(--rule); border-radius: var(--radius); }
input:focus, select:focus, textarea:focus { border-color: var(--ink); outline: none; box-shadow: 0 0 0 3px var(--tag); }
.check { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: var(--s3); align-items: start; font-weight: 400; color: var(--ink-2); }
.check input { width: 22px; height: 22px; margin: 2px 0 0; accent-color: #141414; }
.money { position: relative; }
.money span { position: absolute; left: 0.875rem; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; }
.money input { padding-left: 1.75rem; }

.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s3); }
.step { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); padding: var(--s5); display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: var(--s4); }
.step__mark { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--rule); display: grid; place-items: center; font: 700 0.875rem/1 var(--body); color: var(--muted); }
.step--done .step__mark { background: var(--go); border-color: var(--go); color: #fff; }
.step--done .step__mark::before { content: ""; width: 10px; height: 6px; border-left: 2.5px solid currentColor; border-bottom: 2.5px solid currentColor; transform: translateY(-1px) rotate(-45deg); }
.step h3 { font: 700 1.0625rem/1.3 var(--body); margin-top: 2px; }
.step__body { display: grid; gap: var(--s3); min-width: 0; }

.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.375rem var(--s5); margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
.lines { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.lines td, .lines th { padding: 0.625rem 0; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
.lines td { overflow-wrap: anywhere; }
.lines th + th, .lines td + td { padding-left: var(--s3); }
.lines .sub { display: block; font-size: 0.8125rem; color: var(--muted); }
.lines th { font: 600 0.8125rem/1.3 var(--body); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.lines .num { text-align: right; padding-left: var(--s4); white-space: nowrap; }
.lines tr.total td { border-bottom: 0; font-weight: 700; color: var(--ink); padding-top: var(--s3); }

.big { font: 900 clamp(3rem, 12vw, 4.5rem)/0.9 var(--display); color: var(--ink); font-variant-numeric: tabular-nums; }
.badge { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.1875rem 0.5rem; border-radius: 999px; font: 600 0.8125rem/1.3 var(--body); background: var(--sunk); color: var(--ink-2); white-space: nowrap; }
.badge--go { background: var(--go-bg); color: var(--go); }
.badge--stop { background: var(--stop-bg); color: var(--stop); }
.badge--warn { background: var(--warn-bg); color: var(--ink); }
.notice { border-left: 4px solid var(--tag); background: var(--surface); padding: var(--s4) var(--s5); border-radius: 0 var(--radius) var(--radius) 0; }
.notice--stop { border-left-color: var(--stop); }
.notice--go { border-left-color: var(--go); }
.divider { border: 0; border-top: 1px solid var(--rule); margin: var(--s2) 0; }
.addr { white-space: pre-line; color: var(--ink); }
.reasons { margin: 0; padding-left: 1.25rem; display: grid; gap: 0.25rem; }

.prose { max-width: 68ch; }
.prose h1 { font: 900 clamp(2.25rem, 7vw, 3.25rem)/0.95 var(--display); text-transform: uppercase; margin-bottom: var(--s5); }
.prose h2 { font: 800 1.5rem/1.15 var(--display); text-transform: uppercase; margin: var(--s8) 0 var(--s3); }
.prose h3 { font: 700 1.125rem/1.3 var(--body); margin: var(--s5) 0 var(--s2); }
.prose p, .prose ul, .prose ol, .prose table, .prose blockquote { margin: 0 0 var(--s4); }
.prose li { margin-bottom: 0.375rem; }
.prose blockquote { border-left: 4px solid var(--tag); background: var(--surface); padding: var(--s4) var(--s5); }
.prose blockquote p:last-child { margin: 0; }
.prose table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
.prose td, .prose th { border-bottom: 1px solid var(--rule); padding: 0.625rem var(--s3) 0.625rem 0; text-align: left; vertical-align: top; min-width: 12rem; }
.prose strong { color: var(--ink); }
mark.blank { background: var(--warn-bg); color: var(--ink); padding: 0 0.25rem; border-radius: 2px; outline: 1px dashed #b89a00; }

/* the owner's approval card (Figma: "Owner approval card") */
.owner { background: var(--surface); border: 2px solid var(--ink); border-radius: var(--radius); padding: var(--s5); display: grid; gap: var(--s4); align-content: start; min-width: 0; }
.owner__eyebrow { font: 600 0.6875rem/1 var(--body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.owner__title { font: 900 2.25rem/0.95 var(--display); text-transform: uppercase; color: var(--stop); }
.owner__title--done { color: var(--go); }
.owner__title--quiet { color: var(--muted); }
.owner__items { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
.owner__items li { display: flex; justify-content: space-between; gap: var(--s4); padding-block: 0.5rem; border-bottom: 1px solid var(--rule); color: var(--ink); font-weight: 600; }
.owner__items li span:last-child { font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.owner__amount { font: 900 3.25rem/0.9 var(--display); color: var(--ink); font-variant-numeric: tabular-nums; }
.owner__note { font-size: 0.875rem; color: var(--muted); }
.why { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.375rem; }
.why li { display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 0.625rem; align-items: baseline; color: var(--ink-2); font-size: 0.9375rem; }
.why li::before { content: ""; width: 10px; height: 10px; background: var(--stop); transform: translateY(1px); }
.owner__actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s2); }
.owner__actions form, .owner__actions .btn { width: 100%; }
.meter { display: grid; gap: 6px; }
.meter__row { display: flex; justify-content: space-between; gap: var(--s3); font-size: 0.8125rem; color: var(--muted); }
.meter__row b { font: 500 0.75rem/1.6 var(--mono); color: var(--ink); white-space: nowrap; }
.meter__track { display: flex; height: 8px; background: var(--rule); border-radius: 2px; overflow: hidden; }
.meter__track i { display: block; height: 100%; background: var(--ink); }
.meter__track i.add { background: repeating-linear-gradient(-45deg, var(--stop) 0 3px, transparent 3px 6px); }
.meter__track i.over { background: var(--stop); }

/* owner page */
.hh { display: grid; gap: var(--s2); }
.signage { display: grid; gap: var(--s5); grid-template-columns: minmax(0, 1fr); }
@media (min-width: 760px) { .signage { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s6); } }
.sign { display: grid; gap: var(--s2); align-content: start; min-width: 0; }
.sign__label { font: 600 0.75rem/1 var(--body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.sign__big { font: 900 clamp(2.75rem, 6vw, 3.5rem)/0.9 var(--display); color: var(--ink); font-variant-numeric: tabular-nums; border-bottom: 4px solid var(--ink); padding-bottom: var(--s3); overflow-wrap: anywhere; }
.sign__big--quiet { color: var(--muted); border-bottom-color: var(--rule); }
.sign p { font-size: 0.9375rem; }
.cards { display: grid; gap: var(--s4); grid-template-columns: minmax(0, 1fr); }
@media (min-width: 760px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.sched { list-style: none; margin: 0; padding: 0; border-top: 2px solid var(--ink); }
.sched li { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) auto; gap: var(--s2) var(--s5); align-items: baseline; padding-block: var(--s4); border-bottom: 1px solid var(--rule); }
.sched__date { font: 800 1.375rem/1 var(--display); text-transform: uppercase; color: var(--ink); font-variant-numeric: tabular-nums; }
.sched__what { color: var(--ink); font-weight: 600; min-width: 0; }
.sched__what span { display: block; font-weight: 400; font-size: 0.875rem; color: var(--muted); }
.sched__amt { font-variant-numeric: tabular-nums; color: var(--ink); text-align: right; white-space: nowrap; }
@media (max-width: 559px) { .sched li { grid-template-columns: 4.5rem minmax(0, 1fr); } .sched__amt { grid-column: 2; text-align: left; } }
.settings { display: grid; gap: var(--s4); grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 860px) { .settings { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.settings .panel + .panel { margin-top: 0; }
.panel > h3 { font: 700 1.0625rem/1.3 var(--body); margin-bottom: var(--s3); }
.hint { font-size: 0.8125rem; font-weight: 400; color: var(--muted); }
.status-line { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.9375rem; color: var(--ink-2); white-space: nowrap; }
.status-line i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.status-line--go i { background: var(--go); } .status-line--warn i { background: var(--tag); outline: 1px solid var(--ink); } .status-line--stop i { background: var(--stop); }
.table-scroll { overflow-x: auto; }

/* message pages */
.eyebrow { display: inline-flex; align-items: center; gap: 0.625rem; font: 600 0.75rem/1 var(--body); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.eyebrow i { width: 12px; height: 12px; background: var(--ink); }
.eyebrow--go i { background: var(--go); } .eyebrow--stop i { background: var(--stop); } .eyebrow--warn i { background: var(--tag); outline: 1.5px solid var(--ink); outline-offset: -1.5px; }

.foot { border-top: 1px solid var(--rule); padding-block: var(--s6) var(--s8); font-size: 0.9375rem; color: var(--muted); }
.foot .wrap { display: flex; flex-wrap: wrap; gap: var(--s3) var(--s5); justify-content: space-between; }
.foot nav { display: flex; flex-wrap: wrap; gap: var(--s3) var(--s5); }
.foot a { color: var(--muted); }
.foot a:hover { color: var(--ink); }
`;

/**
 * A full page. `wide` widens the column (owner page, operator page).
 * `right` is optional HTML for the top bar (e.g. a sign-out button).
 */
export function layout(title, body, { wide = false, right = '', support = 'support@domaru.app', robots = true } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Domaru</title>
${robots ? '' : '<meta name="robots" content="noindex">'}
<meta name="referrer" content="no-referrer">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${STYLE}</style></head><body>
<header class="top"><div class="wrap${wide ? ' wrap--wide' : ''}"><a class="logo" href="/"><i aria-hidden="true"></i>Domaru</a><div class="top__right">${right}</div></div></header>
<main><div class="wrap${wide ? ' wrap--wide' : ''}">${body}</div></main>
<footer class="foot"><div class="wrap${wide ? ' wrap--wide' : ''}"><span>Questions? <a href="mailto:${esc(support)}">${esc(support)}</a></span>
<nav aria-label="Policies"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds and delivery</a></nav></div></footer>
</body></html>`;
}

/** A simple page with one message and an optional action. */
const TONES = { go: 'Done', stop: 'Something went wrong', warn: 'Waiting' };

/** A simple page with one message and an optional action. tone: go | stop | warn. */
export function messagePage(title, message, { action, tone } = {}) {
  return layout(title, `<div class="stack">
    ${TONES[tone] ? `<p class="eyebrow eyebrow--${tone}"><i aria-hidden="true"></i>${TONES[tone]}</p>` : ''}
    <h1 class="title">${esc(title)}</h1>
    <p class="lede">${esc(message)}</p>
    ${action ? `<div class="actions"><a class="btn btn--primary" href="${esc(action.href)}">${esc(action.label)}</a></div>` : ''}
  </div>`, { robots: false });
}

/** "Oct 22" from an ISO date or timestamp. */
export const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

/** Month-to-date spending against the monthly limit; `adding` shows a pending order on top. */
export function meter({ label, spentCents, limitCents, addingCents = 0 }) {
  if (limitCents == null) return `<div class="meter"><div class="meter__row"><span>${esc(label)}</span><b>${usd(spentCents)} spent, no monthly limit</b></div></div>`;
  const w = (c) => Math.max(0, Math.min(100, (c / Math.max(1, limitCents)) * 100));
  const over = spentCents + addingCents > limitCents;
  return `<div class="meter"><div class="meter__row"><span>${esc(label)}</span><b>${usd(spentCents + addingCents)} of ${usd(limitCents)}${addingCents ? ' with this order' : ''}</b></div>
    <div class="meter__track" role="img" aria-label="${esc(`${usd(spentCents)} spent of ${usd(limitCents)} this month`)}"><i${over && !addingCents ? ' class="over"' : ''} style="width:${w(spentCents).toFixed(1)}%"></i>${addingCents ? `<i class="add" style="width:${w(addingCents).toFixed(1)}%"></i>` : ''}</div></div>`;
}

/**
 * Small Markdown renderer for the policy pages: headings, paragraphs, lists,
 * blockquotes, tables, bold, italics and links. Bracketed placeholders like
 * [COMPANY LEGAL NAME] stay visible, highlighted, until someone fills them in.
 */
export function markdown(src) {
  const inline = (t) => {
    let s = esc(t);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
      const safe = /^(https?:|mailto:|\/|#)/.test(href) ? href : '#';
      return `<a href="${safe}">${text}</a>`;
    });
    s = s.replace(/\[([^\]]+)\](?!\()/g, '<mark class="blank">[$1]</mark>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  };
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      i++;
    } else if (line.startsWith('>')) {
      const block = [];
      while (i < lines.length && lines[i].startsWith('>')) block.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(block.join('\n'))}</blockquote>`);
    } else if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      const [head, ...rest] = body;
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, '');
        while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

export function policyPage(title, md) {
  return layout(title, `<article class="prose">${markdown(md)}</article>`);
}
