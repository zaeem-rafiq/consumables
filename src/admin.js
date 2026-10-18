// The operator's pages (concierge fulfillment and support). Each paid order
// becomes one Walmart.com order shipped straight to the customer: the card
// lists the exact Walmart items and the delivery address to paste in. Problems,
// refunds, Walmart cancellations and chargebacks are handled from here too.
// Sign-in is a password form that sets a cookie; nothing secret goes in a URL.

import { layout, esc, usd } from './ui.js';

const addressText = (a) => [a.name, a.line1, a.line2, `${a.city}, ${a.region} ${a.postal_code}`, a.phone].filter(Boolean).join('\n');
const signOut = '<a href="/admin/emails">Email log</a><form method="post" action="/admin/logout"><button class="linkbtn">Sign out</button></form>';
const KIND = { never_arrived: 'Never arrived', damaged: 'Damaged', wrong_item: 'Wrong item', missing_item: 'Missing item', charged_wrong: 'Charged wrong', other: 'Other' };

export function adminLoginPage({ error } = {}) {
  return layout('Operator sign-in', `<div class="stack">
    <h1 class="title">Operator sign-in</h1>
    ${error ? `<p class="notice notice--stop">${esc(error)}</p>` : ''}
    <form class="panel form" method="post" action="/admin/login">
      <label>Admin password<input type="password" name="key" autocomplete="current-password" required autofocus style="width:100%;min-height:48px;padding:0.625rem 0.875rem;font:inherit;border:1.5px solid var(--rule);border-radius:4px;background:var(--surface);color:var(--ink)"></label>
      <button class="btn btn--primary btn--block">Sign in</button>
    </form>
  </div>`, { robots: false });
}

function cart(o) {
  let cost = 0;
  const rows = o.lines.map((l) => {
    const src = l.source;
    if (!src) return `<tr><td>${l.quantity}</td><td>${esc(l.name)} <span class="muted">(no Walmart listing on file)</span></td><td class="num"></td></tr>`;
    cost += src.price_cents * l.quantity;
    const amazon = `https://www.amazon.com/s?k=${encodeURIComponent(l.name)}`;
    return `<tr><td>${l.quantity}</td><td><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.item)}</a>${o.shipment?.retailer_canceled_at ? ` · <a href="${esc(amazon)}" target="_blank" rel="noopener">Find on Amazon</a>` : ''}</td><td class="num">${usd(src.price_cents * l.quantity)}</td></tr>`;
  }).join('');
  return `<table class="lines"><thead><tr><th>Qty</th><th>Walmart item</th><th class="num">Walmart price</th></tr></thead><tbody>${rows}
    <tr class="total"><td></td><td>Walmart subtotal, before tax</td><td class="num">${usd(cost)}</td></tr></tbody></table>`;
}

const flags = (o) => [
  o.resend_of ? '<span class="badge">Free resend</span>' : '',
  o.shipment?.late ? '<span class="badge badge--stop">Late</span>' : '',
  o.shipment?.retailer_canceled_at ? '<span class="badge badge--stop">Walmart canceled</span>' : '',
  o.cases?.some((c) => c.status === 'open') ? '<span class="badge badge--warn">Open problem</span>' : '',
  o.account.hold_reason ? '<span class="badge badge--stop">On hold</span>' : '',
].join(' ');

function orderCard(o) {
  const placed = o.shipment.status === 'placed';
  return `<div class="panel stack--tight">
    <div class="panel__head"><h3><a href="/admin/orders/${esc(o.id)}">${esc(o.account.name)}</a> ${flags(o)}</h3><span class="small muted">${esc(o.created_at.slice(0, 10))} · paid ${usd(o.amounts.total_cents)} · <span class="mono">${esc(o.id)}</span></span></div>
    ${o.shipment.retailer_canceled_at ? '<p class="notice notice--stop">Walmart canceled this. Order it on Amazon today at no extra cost to the customer, or refund the items from the order page.</p>' : ''}
    <div class="grid2">
      <div class="stack--tight"><p class="small muted">${placed ? `Placed on Walmart${o.shipment.retailer_order_id ? ` · ${esc(o.shipment.retailer_order_id)}` : ''}` : '1. Add to your Walmart.com cart'}</p>${cart(o)}</div>
      <div class="stack--tight"><p class="small muted">2. Walmart delivery address</p><p class="addr panel" style="user-select:all">${esc(addressText(o.ship_to))}</p>
        ${o.ship_to.phone ? '' : '<p class="small muted">No phone on file. Walmart asks for one; your own number works.</p>'}</div>
    </div>
    <div class="actions">
      ${placed ? '' : `<form class="actions" method="post" action="/admin/orders/${esc(o.id)}/place"><input type="text" name="retailer_order_id" placeholder="Walmart order number" style="max-width:16rem"><button class="btn btn--sm">Mark placed</button></form>`}
      <form class="actions" method="post" action="/admin/orders/${esc(o.id)}/ship">
        <select name="carrier" style="max-width:9rem"><option>Walmart</option><option>FedEx</option><option>UPS</option><option>USPS</option><option>OnTrac</option><option>Amazon</option><option>Other</option></select>
        <input type="text" name="tracking_number" placeholder="Tracking number" required style="max-width:16rem">
        <button class="btn btn--primary btn--sm">Mark shipped</button>
      </form>
    </div>
  </div>`;
}

function caseCard(c) {
  return `<div class="panel stack--tight">
    <div class="panel__head"><h3>${esc(KIND[c.kind] ?? c.kind)} · <a href="/admin/orders/${esc(c.order_id)}">${esc(c.account.name)}</a></h3>
      <span>${c.needs_proof ? `<span class="badge badge--warn">${c.proof_reason === 'repeat_claims' ? 'Repeat claims: proof first' : 'Over limit: proof first'}</span>` : '<span class="badge badge--go">No questions</span>'} <span class="small muted">${usd(c.value_cents)}</span></span></div>
    ${c.note ? `<p>“${esc(c.note)}”</p>` : ''}
    ${c.photo_url ? `<p><a href="${esc(c.photo_url)}" target="_blank" rel="noopener noreferrer">Photo</a></p>` : ''}
    ${c.preferred ? `<p class="small muted">They prefer a ${esc(c.preferred)}.</p>` : ''}
    <form class="actions" method="post" action="/admin/cases/${esc(c.id)}/resolve">
      <span class="money" style="max-width:8rem"><span>$</span><input type="number" name="amount" step="0.01" min="0.01" placeholder="${(c.value_cents / 100).toFixed(2)}"></span>
      <button class="btn btn--sm" name="action" value="refund">Refund</button>
      <button class="btn btn--sm" name="action" value="resend">Resend free</button>
      <button class="btn btn--quiet btn--sm" name="action" value="close">Close</button>
    </form>
  </div>`;
}

export function fulfillmentPage({ awaiting, placed, shipped, cases, late }) {
  const shippedRows = shipped.map((o) => `<tr><td><a href="/admin/orders/${esc(o.id)}">${esc(o.account.name)}</a> ${flags(o)}</td><td>${esc(o.shipment.carrier ?? '')} <span class="mono">${esc(o.shipment.tracking_number ?? '')}</span></td><td>${esc(o.shipment.estimated_delivery_date)}</td>
    <td class="num"><form method="post" action="/admin/orders/${esc(o.id)}/deliver"><button class="btn btn--sm">Delivered</button></form></td></tr>`).join('');
  return layout('Orders', `<div class="stack">
    <div class="stack--tight"><h1 class="title">Orders</h1>
    <p class="muted">${awaiting.length} to buy · ${placed.length} placed · ${shipped.length} on the way · ${cases.length} open problem${cases.length === 1 ? '' : 's'} · ${late.length} late</p>
    <form class="actions" method="get" action="/admin/find"><input type="text" name="order" placeholder="Find an order (ord_...)" style="max-width:20rem"><button class="btn btn--quiet btn--sm">Open</button></form></div>
    ${cases.length ? `<h2 class="section">Problems</h2>${cases.map(caseCard).join('')}` : ''}
    <h2 class="section">Buy these on Walmart</h2>
    <p class="small muted">One Walmart order per card, delivered to the customer's address. Mark it placed once bought: after that the customer can no longer cancel.</p>
    ${awaiting.map(orderCard).join('') || '<p class="muted">All caught up.</p>'}
    ${placed.length ? `<h2 class="section">Placed, waiting to ship</h2>${placed.map(orderCard).join('')}` : ''}
    <h2 class="section">On the way</h2>
    ${shipped.length ? `<div class="panel"><table class="lines"><thead><tr><th>Customer</th><th>Tracking</th><th>Expected</th><th></th></tr></thead><tbody>${shippedRows}</tbody></table></div>` : '<p class="muted">Nothing in transit.</p>'}
  </div>`, { wide: true, right: signOut, robots: false });
}

export function adminOrderPage(o) {
  const sh = o.shipment;
  return layout(`Order ${o.id}`, `<div class="stack">
    <p><a href="/admin">← All orders</a></p>
    <div class="stack--tight"><h1 class="title">${esc(o.account.name)}</h1><p class="muted"><span class="mono">${esc(o.id)}</span> · ${esc(o.account.email ?? '')} ${flags(o)}</p></div>
    ${o.account.hold_reason ? `<div class="notice notice--stop actions"><span>Account on hold: ${esc(o.account.hold_reason)}.</span><form method="post" action="/admin/accounts/${esc(o.account.id)}/release"><button class="btn btn--sm">Release hold</button></form></div>` : ''}
    ${o.dispute ? `<p class="notice notice--stop">Chargeback ${esc(o.dispute.status ?? '')}: ${esc(o.dispute.reason ?? '')} (${usd(o.dispute.amount_cents ?? 0)}). Answer it in the Stripe dashboard.</p>` : ''}
    <div class="panel"><dl class="kv">
      <dt>Status</dt><dd>${esc(o.status)}${sh ? ` · shipment ${esc(sh.status)}` : ''}</dd>
      <dt>Total</dt><dd>${usd(o.amounts.total_cents)}${o.refunded_cents ? ` · refunded ${usd(o.refunded_cents)}` : ''}</dd>
      <dt>Ordered</dt><dd>${esc(o.created_at.slice(0, 10))}${o.ship_date ? ` · ship date ${esc(o.ship_date)}` : ''}</dd>
      ${sh ? `<dt>Expected</dt><dd>${esc(sh.estimated_delivery_date)}${sh.late ? ' <span class="badge badge--stop">Late</span>' : ''}</dd>` : ''}
      ${sh?.tracking_number ? `<dt>Tracking</dt><dd>${esc(sh.carrier)} <span class="mono">${esc(sh.tracking_number)}</span></dd>` : ''}
      ${o.resend_of ? `<dt>Resend of</dt><dd><a href="/admin/orders/${esc(o.resend_of)}">${esc(o.resend_of)}</a></dd>` : ''}
      <dt>Ship to</dt><dd class="addr">${esc(addressText(o.ship_to))}</dd>
    </dl></div>
    ${sh && ['awaiting_fulfillment', 'placed'].includes(sh.status) ? orderCard(o) : `<div class="panel">${cart(o)}</div>`}
    ${o.cases.length ? `<h2 class="section">Problems</h2>${o.cases.map((c) => (c.status === 'open' ? caseCard({ ...c, account: o.account }) : `<div class="panel"><strong>${esc(KIND[c.kind])}</strong> · ${esc(c.status.replace(/_/g, ' '))} · ${esc(c.what_happens_next)}</div>`)).join('')}` : ''}
    <h2 class="section">Actions</h2>
    <div class="panel stack">
      ${o.refundable_cents > 0 ? `<form class="actions" method="post" action="/admin/orders/${esc(o.id)}/refund">
        <span class="money" style="max-width:9rem"><span>$</span><input type="number" name="amount" step="0.01" min="0.01" max="${(o.refundable_cents / 100).toFixed(2)}" placeholder="${(o.refundable_cents / 100).toFixed(2)}"></span>
        <input type="text" name="reason" placeholder="Reason" style="max-width:16rem"><button class="btn btn--sm">Refund</button>
        <span class="small muted">Empty amount refunds the rest (${usd(o.refundable_cents)}).</span></form>` : '<p class="muted small">Nothing left to refund.</p>'}
      ${sh && sh.status !== 'canceled' ? `<form class="actions" method="post" action="/admin/orders/${esc(o.id)}/problem">
        <select name="problem" style="max-width:12rem"><option value="lost">Lost or stuck</option><option value="damaged">Damaged</option><option value="wrong_item">Wrong item</option></select>
        <input type="text" name="note" placeholder="Note" style="max-width:16rem"><button class="btn btn--quiet btn--sm">Mark problem</button></form>` : ''}
      ${sh && ['placed', 'awaiting_fulfillment'].includes(sh.status) ? `<form method="post" action="/admin/orders/${esc(o.id)}/retailer-canceled"><button class="btn btn--stop btn--sm">Walmart canceled it</button></form>` : ''}
    </div>
    ${o.refunds.length ? `<h2 class="section">Refunds</h2><div class="panel"><table class="lines"><tbody>${o.refunds.map((r) => `<tr><td>${esc(r.created_at.slice(0, 10))}</td><td>${esc(r.reason)}</td><td>${esc(r.status)}</td><td class="num">${usd(r.amount_cents)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`, { wide: true, right: signOut, robots: false });
}

export function emailLogPage(emails) {
  return layout('Email log', `<div class="stack">
    <p><a href="/admin">← All orders</a></p>
    <h1 class="title">Email log</h1>
    <p class="muted">Every email the store sent or queued, newest first. Without an email provider configured they are only recorded here.</p>
    ${emails.map((e) => `<details class="panel"><summary><strong>${esc(e.subject)}</strong> <span class="small muted">to ${esc(e.to)} · ${esc(e.created_at.slice(0, 16).replace('T', ' '))} · ${esc(e.status)}</span></summary><pre style="white-space:pre-wrap;font:inherit;margin:1rem 0 0">${esc(e.body)}</pre></details>`).join('') || '<p class="muted">No email yet.</p>'}
  </div>`, { wide: true, right: signOut, robots: false });
}
