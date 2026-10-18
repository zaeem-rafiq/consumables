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
export function messagePage(title, message, { action, tone } = {}) {
  return layout(title, `<div class="stack">
    <h1 class="title">${esc(title)}</h1>
    <p class="lede">${esc(message)}</p>
    ${tone ? '' : ''}${action ? `<div class="actions"><a class="btn btn--primary" href="${esc(action.href)}">${esc(action.label)}</a></div>` : ''}
  </div>`, { robots: false });
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
