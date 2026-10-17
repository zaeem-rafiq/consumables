// HTML pages for humans: the operator's daily fulfillment page and the
// "card saved" page shown after Stripe's card setup.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

const STYLE = `
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --card:#fff; --line:#e7e5e4; --accent:#15803d; }
@media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --card:#292524; --line:#44403c; --accent:#4ade80; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px; font:15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
main { max-width: 900px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 8px; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 12px 0; }
.row { display: flex; flex-wrap: wrap; gap: 16px; justify-content: space-between; }
ul { margin: 6px 0; padding-left: 20px; }
form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
input, select, button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
button { background: var(--accent); color: #fff; border: 0; cursor: pointer; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

/** The concierge operator's page: what to buy, where to ship it, and forms to record tracking. */
export function fulfillmentPage({ awaiting, shipped, key }) {
  const q = `key=${encodeURIComponent(key)}`;
  const totals = new Map();
  for (const o of awaiting) for (const l of o.lines) totals.set(l.name, (totals.get(l.name) ?? 0) + l.quantity);

  const shoppingList = totals.size
    ? `<div class="card"><table><tr><th>Qty</th><th>Item</th></tr>${[...totals].sort((a, b) => a[0].localeCompare(b[0])).map(([n, qty]) => `<tr><td>${qty}</td><td>${esc(n)}</td></tr>`).join('')}</table></div>`
    : '<p class="muted">Nothing to buy right now.</p>';

  const address = (a) => `${esc(a.name)}<br>${esc(a.line1)}${a.line2 ? `<br>${esc(a.line2)}` : ''}<br>${esc(a.city)}, ${esc(a.region)} ${esc(a.postal_code)}`;

  const awaitingCards = awaiting.map((o) => `
    <div class="card">
      <div class="row">
        <div><strong>${esc(o.account.name)}</strong> <span class="muted">· ordered ${esc(o.created_at.slice(0, 10))} · paid ${usd(o.amounts.total_cents)} · ${esc(o.id)}</span>
          <ul>${o.lines.map((l) => `<li>${l.quantity} × ${esc(l.name)}</li>`).join('')}</ul></div>
        <div class="muted">${address(o.ship_to)}</div>
      </div>
      <form method="post" action="/admin/orders/${esc(o.id)}/ship?${q}">
        <select name="carrier"><option>UPS</option><option>USPS</option><option>FedEx</option><option>Amazon</option><option>Other</option></select>
        <input name="tracking_number" placeholder="Tracking number" required>
        <button>Mark shipped</button>
      </form>
    </div>`).join('');

  const shippedCards = shipped.map((o) => `
    <div class="card row">
      <div><strong>${esc(o.account.name)}</strong> <span class="muted">· ${esc(o.shipment.carrier)} ${esc(o.shipment.tracking_number)}</span></div>
      <form method="post" action="/admin/orders/${esc(o.id)}/deliver?${q}" style="margin:0"><button>Mark delivered</button></form>
    </div>`).join('');

  return page('Orders to fulfill', `
    <h1>Orders to fulfill</h1>
    <p class="muted">${awaiting.length} to buy and ship · ${shipped.length} on the way</p>
    <h2>Shopping list</h2>${shoppingList}
    <h2>Ship these</h2>${awaitingCards || '<p class="muted">All caught up.</p>'}
    <h2>On the way</h2>${shippedCards || '<p class="muted">Nothing in transit.</p>'}`);
}

export function messagePage(title, message) {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}
