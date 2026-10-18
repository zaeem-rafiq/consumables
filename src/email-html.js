// The HTML version of every email, built from the plain-text body the store
// queues. Both versions go out together, so mail apps that block HTML still
// read the text. Email-safe on purpose: tables, inline styles, system fonts
// (mail apps don't load web fonts reliably), one dark button per email.
//
// The text body is read line by line:
//   - a line that is only a URL becomes the button (the line before it, if it
//     ends with ":", is the lead-in)
//   - "- reason" lines become a list with red markers
//   - "2 x Paper Towels  $17.99" lines become an item table
//   - everything after "--" is the footer

import { esc } from './ui.js';

const BUTTON = {
  sign_in: 'Sign in to Domaru',
  owner_invite: 'Sign in to Domaru',
  email_changed: 'Sign in to Domaru',
  approval_requested: 'Review and approve',
};

const INK = '#141414';
const PAPER = '#f6f6f3';
const MUTED = '#6b6b66';
const LINE = '#dcdcd6';
const STOP = '#c4211a';
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const DISPLAY = "'Barlow Condensed', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

const URL_LINE = /^https?:\/\/\S+$/;
const ITEM_LINE = /^(\d+) x (.+?)\s{2,}(\$[\d,]+\.\d\d)$/;

const p = (html, style = '') => `<p style="margin:0 0 16px;font:16px/1.5 ${SANS};color:${INK};${style}">${html}</p>`;

function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="background:${INK};border-radius:4px">`
    + `<a href="${esc(href)}" style="display:inline-block;padding:14px 24px;font:600 16px/1 ${SANS};color:#ffffff;text-decoration:none">${esc(label)}</a>`
    + '</td></tr></table>'
    + p(`Or paste this link into your browser:<br><a href="${esc(href)}" style="color:${MUTED};word-break:break-all">${esc(href)}</a>`, `font-size:13px;color:${MUTED}`);
}

function items(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-top:1px solid ${LINE}">`
    + rows.map(([, qty, name, price]) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${LINE};font:15px/1.4 ${SANS};color:${INK}">${esc(name)} <span style="color:${MUTED}">× ${esc(qty)}</span></td>`
      + `<td align="right" style="padding:10px 0;border-bottom:1px solid ${LINE};font:15px/1.4 ${SANS};color:${INK};white-space:nowrap">${esc(price)}</td></tr>`).join('')
    + '</table>';
}

function reasons(rows) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">`
    + rows.map((r) => `<tr><td valign="top" style="padding:7px 10px 0 0"><div style="width:8px;height:8px;background:${STOP}"></div></td><td style="padding:0 0 6px;font:15px/1.5 ${SANS};color:${INK}">${esc(r)}</td></tr>`).join('')
    + '</table>';
}

/** HTML for one queued email: { kind, subject, body }. */
export function renderEmail({ kind, subject, body }) {
  const all = String(body ?? '').split('\n');
  const cut = all.lastIndexOf('--');
  const lines = cut >= 0 ? all.slice(0, cut) : all;
  const footer = cut >= 0 ? all.slice(cut + 1).join(' ').trim() : '';

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (URL_LINE.test(line)) { out.push(button(BUTTON[kind] ?? 'Open', line)); continue; }
    if (line.startsWith('- ')) {
      const group = [];
      while (i < lines.length && lines[i].trim().startsWith('- ')) group.push(lines[i++].trim().slice(2));
      i--; out.push(reasons(group)); continue;
    }
    if (ITEM_LINE.test(line)) {
      const group = [];
      while (i < lines.length && ITEM_LINE.test(lines[i].trim())) group.push(ITEM_LINE.exec(lines[i++].trim()));
      i--; out.push(items(group)); continue;
    }
    out.push(p(esc(line)));
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${PAPER}">
<div style="display:none;max-height:0;overflow:hidden">${esc(lines.find((l) => l.trim() && !URL_LINE.test(l.trim())) ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:14px;height:14px;background:#ffd60a;border:2px solid ${INK}"></td>
<td style="padding-left:8px;font:900 18px/1 ${DISPLAY};letter-spacing:.02em;text-transform:uppercase;color:${INK}">Domaru</td></tr></table></td></tr>
<tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:4px;padding:32px 28px">
<h1 style="margin:0 0 20px;font:900 28px/1.1 ${DISPLAY};text-transform:uppercase;color:${INK}">${esc(subject)}</h1>
${out.join('\n')}
</td></tr>
${footer ? `<tr><td style="padding:16px 4px;font:12px/1.5 ${SANS};color:${MUTED}">${esc(footer)}</td></tr>` : ''}
</table></td></tr></table></body></html>`;
}
