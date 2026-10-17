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
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 8px; } h3 { font-size: 14px; margin: 14px 0 6px; }
a { color: var(--accent); }
.addr { font: inherit; white-space: pre-wrap; user-select: all; margin: 0; padding: 8px; border: 1px dashed var(--line); border-radius: 6px; }
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

/**
 * The concierge operator's page. Each paid order becomes one Walmart.com order
 * shipped straight to the customer: the card lists the exact Walmart items and
 * the delivery address to paste in, then a form to record the tracking number.
 */
export function fulfillmentPage({ awaiting, shipped, key }) {
  const q = `key=${encodeURIComponent(key)}`;
  const addressText = (a) => [a.name, a.line1, a.line2, `${a.city}, ${a.region} ${a.postal_code}`, a.phone].filter(Boolean).join('\n');

  const cart = (o) => {
    let cost = 0;
    const rows = o.lines.map((l) => {
      const src = l.source;
      if (!src) return `<tr><td>${l.quantity}</td><td>${esc(l.name)} <span class="muted">(no Walmart listing on file)</span></td><td></td></tr>`;
      cost += src.price_cents * l.quantity;
      return `<tr><td>${l.quantity}</td><td><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.item)}</a></td><td>${usd(src.price_cents * l.quantity)}</td></tr>`;
    }).join('');
    return { rows, cost };
  };

  const awaitingCards = awaiting.map((o) => {
    const { rows, cost } = cart(o);
    const a = o.ship_to;
    return `
    <div class="card">
      <div><strong>${esc(o.account.name)}</strong> <span class="muted">· ordered ${esc(o.created_at.slice(0, 10))} · paid ${usd(o.amounts.total_cents)} · ${esc(o.id)}</span></div>
      <div class="row">
        <div style="flex:2 1 320px">
          <h3>1. Add to your Walmart.com cart</h3>
          <table><tr><th>Qty</th><th>Walmart item</th><th>Walmart price</th></tr>${rows}
            <tr><td></td><td class="muted">Walmart subtotal, before tax</td><td>${usd(cost)}</td></tr></table>
        </div>
        <div style="flex:1 1 220px">
          <h3>2. Walmart delivery address</h3>
          <pre class="addr">${esc(addressText(a))}</pre>
          ${a.phone ? '' : '<p class="muted">No phone on file. Walmart asks for one; your own number works.</p>'}
          <p class="muted">${esc(o.account.email ?? '')}</p>
        </div>
      </div>
      <h3>3. Paste the tracking number once Walmart ships</h3>
      <form method="post" action="/admin/orders/${esc(o.id)}/ship?${q}">
        <select name="carrier"><option>Walmart</option><option>FedEx</option><option>UPS</option><option>USPS</option><option>OnTrac</option><option>Other</option></select>
        <input name="tracking_number" placeholder="Tracking or Walmart order number" required>
        <button>Mark shipped</button>
      </form>
    </div>`;
  }).join('');

  const shippedCards = shipped.map((o) => `
    <div class="card row">
      <div><strong>${esc(o.account.name)}</strong> <span class="muted">· ${esc(o.shipment.carrier)} ${esc(o.shipment.tracking_number)}</span></div>
      <form method="post" action="/admin/orders/${esc(o.id)}/deliver?${q}" style="margin:0"><button>Mark delivered</button></form>
    </div>`).join('');

  return page('Orders to fulfill', `
    <h1>Orders to fulfill</h1>
    <p class="muted">${awaiting.length} to order on Walmart.com · ${shipped.length} on the way. Place one Walmart order per card, delivered to the customer's address.</p>
    <h2>Order these</h2>${awaitingCards || '<p class="muted">All caught up.</p>'}
    <h2>On the way</h2>${shippedCards || '<p class="muted">Nothing in transit.</p>'}`);
}

export function messagePage(title, message) {
  return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}

// Draft policy pages, linked from UCP checkouts. Replace with reviewed text before launch.
export function termsPage() {
  return page('Terms of service', `<h1>Terms of service</h1><p class="muted">Draft. Consumables is in private testing; final terms will be published before launch.</p>
    <ul>
      <li>We buy household supplies from major retailers and arrange delivery to your address. The box may show the retailer's name.</li>
      <li>You see the full price, shipping and tax before anything is charged, and that is the amount charged.</li>
      <li>The account owner sets spending limits. Orders outside them wait for the owner's approval and are not charged until approved.</li>
      <li>You can pause, skip or cancel a subscription at any time before its next order date.</li>
    </ul>`);
}

export function privacyPage() {
  return page('Privacy', `<h1>Privacy</h1><p class="muted">Draft. Final policy will be published before launch.</p>
    <ul>
      <li>We keep your name, email, phone and delivery address to place and deliver your orders.</li>
      <li>We share your delivery address and phone with the retailer that delivers the order.</li>
      <li>Card details are held by our payment processor, Stripe. We never see or store full card numbers.</li>
      <li>We don't sell your information.</li>
    </ul>`);
}
