// Pages for the household (the owner). No keys and no passwords: the owner
// signs in with an emailed link, connects their assistant, and approves held
// orders with one tap from an email.

import { layout, esc, usd } from './ui.js';

const hidden = (fields) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
const addrText = (a) => [a.name, a.line1, a.line2, `${a.city}, ${a.region} ${a.postal_code}`].filter(Boolean).join('\n');
const dollars = (cents) => (cents == null ? '' : String(Math.round(cents) / 100));
const STATUS = {
  paid: ['Paid', 'go'], payment_pending: ['Payment clearing', 'warn'], requires_approval: ['Waiting for you', 'warn'], payment_failed: ['Payment failed', 'stop'],
  canceled: ['Canceled', ''], refunded: ['Refunded', ''], pending: ['Processing', 'warn'],
};
const badge = (status) => {
  const [label, tone] = STATUS[status] ?? [status, ''];
  return `<span class="badge${tone ? ` badge--${tone}` : ''}">${esc(label)}</span>`;
};

const signOut = '<form method="post" action="/owner/signout"><button class="linkbtn">Sign out</button></form>';

export function signInPage({ next = '/owner', error, clientName } = {}) {
  const title = clientName ? `Connect ${clientName}` : 'Sign in';
  return layout(title, `<div class="stack">
    <h1 class="title">${esc(clientName ? `Connect Domaru to ${clientName}` : 'Sign in to Domaru')}</h1>
    <p class="lede">${clientName
    ? `${esc(clientName)} wants to keep your home stocked through Domaru. First, confirm it's you. We'll email you a link; there's no password.`
    : "We'll email you a link to sign in. There's no password to remember."}</p>
    ${error ? `<p class="notice notice--stop">${esc(error)}</p>` : ''}
    <form class="form panel" method="post" action="/auth/signin">
      ${hidden({ next })}
      <label>Email<input type="email" name="email" autocomplete="email" inputmode="email" required autofocus></label>
      <button class="btn btn--primary btn--block">Email me a sign-in link</button>
      <p class="small muted">New to Domaru? The same link sets up your household.</p>
    </form>
  </div>`, { robots: false });
}

export function checkEmailPage({ email }) {
  return layout('Check your email', `<div class="stack">
    <h1 class="title">Check your email</h1>
    <p class="lede">We sent a sign-in link to <strong>${esc(email)}</strong>. It works once, for 30 minutes. You can close this tab after you tap it.</p>
    <p class="muted">Nothing there? Check spam, or <a href="javascript:history.back()">try another address</a>.</p>
  </div>`, { robots: false });
}

function addressForm(back, { compact = false } = {}) {
  return `<form class="form" method="post" action="/owner/addresses">
    ${hidden({ back })}
    <div class="grid2">
      <label>Full name<input type="text" name="name" autocomplete="name" required></label>
      <label>Phone <span class="muted">for the carrier</span><input type="text" name="phone" autocomplete="tel" inputmode="tel"></label>
    </div>
    <label>Street address<input type="text" name="line1" autocomplete="address-line1" required></label>
    <label>Apartment, suite <span class="muted">optional</span><input type="text" name="line2" autocomplete="address-line2"></label>
    <div class="grid2">
      <label>City<input type="text" name="city" autocomplete="address-level2" required></label>
      <div class="grid2">
        <label>State<input type="text" name="region" autocomplete="address-level1" maxlength="2" required placeholder="AR"></label>
        <label>ZIP<input type="text" name="postal_code" autocomplete="postal-code" inputmode="numeric" required></label>
      </div>
    </div>
    <div class="actions"><button class="btn${compact ? ' btn--sm' : ''}">Save address</button></div>
  </form>`;
}

function paymentActions(back, { testMode, hasCard }) {
  return `<div class="actions">
    <form method="post" action="/owner/card">${hidden({ back })}<button class="btn${hasCard ? ' btn--quiet btn--sm' : ''}">${hasCard ? 'Use a different card' : 'Add a card'}</button></form>
    ${testMode ? `<form method="post" action="/owner/test-card">${hidden({ back })}<button class="linkbtn small">Test mode: use a test card</button></form>` : ''}
  </div>
  <p class="small muted">Cards are saved on Stripe's secure page. Domaru never sees the full number.</p>`;
}

function limitsForm(back, policy) {
  return `<form class="form" method="post" action="/owner/policy">
    ${hidden({ back })}
    <div class="grid2">
      <label>Ask me before orders over<span class="money"><span>$</span><input type="number" name="approval_required_above" min="0" step="1" value="${esc(dollars(policy.approval_required_above_cents))}" placeholder="No limit"></span></label>
      <label>Never more than this a month<span class="money"><span>$</span><input type="number" name="monthly_limit" min="0" step="1" value="${esc(dollars(policy.monthly_limit_cents))}" placeholder="No limit"></span></label>
    </div>
    <label>Never more than this in one order<span class="money"><span>$</span><input type="number" name="per_order_limit" min="0" step="1" value="${esc(dollars(policy.per_order_limit_cents))}" placeholder="No limit"></span></label>
    <div class="actions"><button class="btn btn--quiet btn--sm">Save limits</button><span class="small muted">Leave a box empty for no limit.</span></div>
  </form>`;
}

const step = (done, n, title, body) => `<li class="step${done ? ' step--done' : ''}"><span class="step__mark" aria-hidden="true">${done ? '' : n}</span>
  <div class="step__body"><h3>${esc(title)}${done ? ' <span class="badge badge--go">Done</span>' : ''}</h3>${body}</div></li>`;

/** The page an assistant's "Connect Domaru" sends the owner to. */
export function connectPage({ client, account, checklist, addresses, paymentMethods, policy, oauth, back, testMode, error }) {
  const addr = addresses.find((a) => a.confirmed);
  const pm = paymentMethods.find((x) => x.id === account.default_payment_method_id);
  const ready = checklist.address && checklist.payment_method;
  return layout(`Connect ${client.name}`, `<div class="stack">
    <h1 class="title">Connect ${esc(client.name)}</h1>
    <p class="lede">${esc(client.name)} will order household supplies for you within the limits below. It can't approve its own orders or change your limits, and you can disconnect it any time.</p>
    ${error ? `<p class="notice notice--stop">${esc(error)}</p>` : ''}
    <ol class="steps">
      ${step(!!addr, 1, 'Where should orders go?', addr
    ? `<p class="addr">${esc(addrText(addr))}</p><details><summary class="small">Use a different address</summary>${addressForm(back, { compact: true })}</details>`
    : addressForm(back))}
      ${step(!!pm, 2, 'How will you pay?', pm
    ? `<p><strong>${esc(cap(pm.brand))} •••• ${esc(pm.last4)}</strong></p>${paymentActions(back, { testMode, hasCard: true })}`
    : paymentActions(back, { testMode, hasCard: false }))}
      ${step(true, 3, 'Your spending limits', `<p class="muted small">These start at Domaru's defaults. Anything over them waits for your OK by email.</p>${limitsForm(back, policy)}`)}
    </ol>
    <form class="panel form" method="post" action="/oauth/authorize">
      ${hidden(oauth)}
      <label class="check"><input type="checkbox" name="accept_terms" value="1" required${checklist.terms ? ' checked' : ''}>
        <span>I agree to the <a href="/terms" target="_blank">Terms</a>, including <strong>automatic renewal</strong>: subscriptions my assistant starts keep renewing until I or my assistant cancel them. See the <a href="/privacy" target="_blank">Privacy Policy</a> and <a href="/refunds" target="_blank">Refund and Delivery Policy</a>.</span></label>
      <div class="actions">
        <button class="btn btn--primary" name="decision" value="allow"${ready ? '' : ' disabled'}>Allow ${esc(client.name)}</button>
        <button class="btn btn--quiet" name="decision" value="deny" formnovalidate>Cancel</button>
      </div>
      ${ready ? '' : '<p class="small muted">Add an address and a card first.</p>'}
    </form>
  </div>`, { right: signOut, robots: false });
}

const cap = (s) => String(s ?? '').replace(/^\w/, (c) => c.toUpperCase());

function approvalCard({ approval, order, ship_to }, actions) {
  return `<div class="panel stack--tight">
    <div class="panel__head"><p class="big">${usd(approval.amount_cents)}</p>${badge(order.status)}</div>
    <ul class="reasons">${approval.reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>
    <table class="lines"><thead><tr><th>Item</th><th class="num">Price</th></tr></thead><tbody>
      ${order.lines.map((l) => `<tr><td>${l.quantity} × ${esc(l.name)}</td><td class="num">${usd(l.line_total_cents)}</td></tr>`).join('')}
      <tr><td class="muted">Shipping and tax</td><td class="num">${usd(order.amounts.shipping_cents + order.amounts.tax_cents)}</td></tr>
      <tr class="total"><td>Total</td><td class="num">${usd(order.amounts.total_cents)}</td></tr>
    </tbody></table>
    <p class="small muted">Ships to</p><p class="addr">${esc(addrText(ship_to))}</p>
    ${actions}
  </div>`;
}

/** What the "Approve $X?" email opens. One tap, no sign-in needed: the link is the permission. */
export function approvalPage({ info, token }) {
  const { approval, account } = info;
  const pending = approval.status === 'pending';
  const outcome = { approved: 'You approved this order. It is on its way to being placed.', rejected: 'You declined this order. Nothing was charged.', withdrawn: 'Your assistant took this request back. Nothing was charged.' }[approval.status];
  const actions = pending ? `<div class="actions">
      <form method="post" action="/owner/approvals/${esc(approval.id)}/decide">${hidden({ t: token, decision: 'approve' })}<button class="btn btn--primary">Approve ${usd(approval.amount_cents)}</button></form>
      <form method="post" action="/owner/approvals/${esc(approval.id)}/decide">${hidden({ t: token, decision: 'reject' })}<button class="btn btn--stop">Decline</button></form>
    </div><p class="small muted">Nothing is charged unless you approve.</p>` : `<p class="notice${approval.status === 'approved' ? ' notice--go' : ''}">${esc(outcome)}</p>`;
  return layout(pending ? `Approve ${usd(approval.amount_cents)}?` : 'Order request', `<div class="stack">
    <h1 class="title">${pending ? `Approve ${usd(approval.amount_cents)}?` : 'Order request'}</h1>
    <p class="lede">${esc(account)}'s assistant wants to place this order. It needs your OK because:</p>
    ${approvalCard(info, actions)}
  </div>`, { robots: false });
}

/** The owner's page: approvals first, then limits, addresses, payment, assistants, orders. */
export function ownerPage({ account, approvals, addresses, paymentMethods, grants, orders, cases, testMode, flash, developerKey }) {
  const back = '/owner';
  const termsOk = account.owner.terms_version && account.owner.terms_current;
  return layout(account.name, `<div class="stack">
    <div class="stack--tight"><h1 class="title">${esc(account.name)}</h1><p class="muted">${esc(account.email)}</p></div>
    ${flash ? `<p class="notice notice--go">${esc(flash)}</p>` : ''}
    ${account.on_hold ? `<p class="notice notice--stop">Orders are paused on this account (${esc(account.on_hold.reason)}). Write to ${esc(account.support.email)} and we'll sort it out.</p>` : ''}
    ${termsOk ? '' : `<form class="notice form" method="post" action="/owner/terms">${hidden({ back })}
      <label class="check"><input type="checkbox" name="accept_terms" value="1" required><span>I agree to the <a href="/terms">Terms</a>, including automatic renewal of subscriptions until canceled.</span></label>
      <div class="actions"><button class="btn btn--primary btn--sm">Accept</button></div></form>`}
    ${developerKey ? `<div class="notice"><p><strong>Your developer owner key</strong> (shown once):</p><p class="mono">${esc(developerKey)}</p></div>` : ''}

    <h2 class="section">Waiting for you</h2>
    ${approvals.length ? approvals.map((a) => approvalCard(a, `<div class="actions">
      <form method="post" action="/owner/approvals/${esc(a.approval.id)}/approve">${hidden({ back })}<button class="btn btn--primary btn--sm">Approve</button></form>
      <form method="post" action="/owner/approvals/${esc(a.approval.id)}/reject">${hidden({ back })}<button class="btn btn--stop btn--sm">Decline</button></form></div>`)).join('')
    : '<p class="muted">Nothing needs your OK right now.</p>'}

    <h2 class="section">Spending limits</h2>
    <div class="panel">${limitsForm(back, account.policy)}
      <p class="small muted" style="margin-top:0.75rem">Spent this month: <strong>${usd(account.spend.spent_cents)}</strong></p></div>

    <h2 class="section">Assistants</h2>
    ${grants.length ? grants.map((g) => `<div class="panel panel__head"><div><h3>${esc(g.client_name)}</h3><p class="small muted">Connected ${esc(g.connected_at.slice(0, 10))}${g.last_used_at ? ` · last used ${esc(g.last_used_at.slice(0, 10))}` : ''}</p></div>
      <form method="post" action="/owner/grants/${esc(g.id)}/revoke">${hidden({ back })}<button class="btn btn--stop btn--sm">Disconnect</button></form></div>`).join('')
    : '<p class="muted">No assistants connected. Use "Connect Domaru" in your assistant to add one.</p>'}

    <h2 class="section">Delivery addresses</h2>
    ${addresses.map((a) => `<div class="panel panel__head"><p class="addr">${esc(addrText(a))}</p>
      ${a.confirmed ? (a.id === account.default_address_id ? '<span class="badge">Default</span>' : '') : `<form method="post" action="/owner/addresses/${esc(a.id)}/confirm">${hidden({ back })}<button class="btn btn--sm">Confirm address</button></form>`}</div>`).join('')}
    <details class="panel"><summary><strong>Add an address</strong></summary><div style="margin-top:1rem">${addressForm(back, { compact: true })}</div></details>

    <h2 class="section">Payment</h2>
    <div class="panel stack--tight">
      ${paymentMethods.map((pm) => `<p><strong>${esc(cap(pm.brand))} •••• ${esc(pm.last4)}</strong>${pm.id === account.default_payment_method_id ? ' <span class="badge">Default</span>' : ''}${pm.type === 'bank' ? ' <span class="badge badge--go">2% off</span>' : ''}</p>`).join('') || '<p class="muted">No card yet.</p>'}
      ${paymentActions(back, { testMode, hasCard: paymentMethods.length > 0 })}
      ${account.bank_payments.offer ? `<form method="post" action="/owner/bank">${hidden({ back })}<button class="btn btn--primary btn--sm">${esc(account.bank_payments.offer.replace(/\.$/, ''))}</button></form>` : ''}
    </div>

    <h2 class="section">Recent orders</h2>
    ${orders.length ? `<div class="panel"><table class="lines"><thead><tr><th>Date</th><th>Order</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
      ${orders.map((o) => `<tr><td>${esc(o.created_at.slice(0, 10))}</td><td>${esc(o.lines.map((l) => l.name).slice(0, 2).join(', '))}${o.lines.length > 2 ? ` +${o.lines.length - 2}` : ''}</td><td>${badge(o.status)}</td><td class="num">${usd(o.amounts.total_cents)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No orders yet.</p>'}

    ${cases.length ? `<h2 class="section">Problems you reported</h2>${cases.map((c) => `<div class="panel stack--tight"><div class="panel__head"><h3>${esc(c.kind.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()))}</h3><span class="badge${c.status === 'open' ? ' badge--warn' : ' badge--go'}">${esc(c.status.replace(/_/g, ' '))}</span></div><p>${esc(c.what_happens_next)}</p></div>`).join('')}` : ''}

    <h2 class="section">Account</h2>
    <div class="panel stack">
      <form class="form" method="post" action="/owner/email">${hidden({ back })}
        <label>Owner email <span class="muted">approval requests and receipts go here</span><input type="email" name="email" value="${esc(account.email)}" required></label>
        <div class="actions"><button class="btn btn--quiet btn--sm">Change email</button></div></form>
      <hr class="divider">
      <form method="post" action="/owner/developer-key">${hidden({ back })}<p class="small muted">Building your own agent? <button class="linkbtn">Create a developer owner key</button>. Households don't need one.</p></form>
    </div>
  </div>`, { wide: true, right: signOut, robots: false });
}
