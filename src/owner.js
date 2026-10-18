// Pages for the household (the owner). No keys and no passwords: the owner
// signs in with an emailed link, connects their assistant, and approves held
// orders with one tap from an email.

import { layout, esc, usd, day, meter } from './ui.js';

const hidden = (fields) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
const addrText = (a) => [a.name, a.line1, a.line2, `${a.city}, ${a.region} ${a.postal_code}`].filter(Boolean).join('\n');
const dollars = (cents) => (cents == null ? '' : String(Math.round(cents) / 100));
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

function limitFields(policy) {
  const field = (name, label, cents) => `<label>${label}<span class="money"><span>$</span><input type="number" name="${name}" min="0" step="1" value="${esc(dollars(cents))}" placeholder="No limit"></span></label>`;
  return `<div class="grid2">
      ${field('approval_required_above', 'Ask me before orders over', policy.approval_required_above_cents)}
      ${field('monthly_limit', 'Monthly budget', policy.monthly_limit_cents)}
    </div>
    ${field('per_order_limit', 'Largest single order', policy.per_order_limit_cents)}`;
}

function limitsForm(back, policy) {
  return `<form class="form" method="post" action="/owner/policy">
    ${hidden({ back })}
    ${limitFields(policy)}
    <div class="actions"><button class="btn btn--sm">Save limits</button><span class="small muted">Leave a box empty for no limit.</span></div>
  </form>`;
}

const step = (done, n, title, body) => `<li class="step${done ? ' step--done' : ''}"><span class="step__mark" aria-hidden="true">${done ? '' : n}</span>
  <div class="step__body"><h3>${esc(title)}</h3>${body}</div></li>`;

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
      ${step(true, 3, 'Your spending limits', `<p class="muted small">Anything outside these waits for your OK. We email you Approve and Decline buttons. You can change them later.</p><div class="form">${limitFields(policy).replace(/<input /g, '<input form="allow" ')}</div>`)}
    </ol>
    <form class="panel form" id="allow" method="post" action="/oauth/authorize">
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

const OUTCOME = {
  approved: ['Approved', 'You approved this order. We are placing it now.', 'done'],
  rejected: ['Declined', 'You declined this order. Nothing was charged.', 'quiet'],
  withdrawn: ['Withdrawn', 'Your assistant took this request back. Nothing was charged.', 'quiet'],
};

/** The owner approval card from the Figma file: what, why, how much, and the two buttons. */
function approvalCard({ approval, order, ship_to, spend, policy }, actions, { eyebrow } = {}) {
  const pending = approval.status === 'pending';
  const [title, outcome, tone] = pending ? ['Held for you'] : OUTCOME[approval.status] ?? [approval.status, '', 'quiet'];
  const extras = order.amounts.shipping_cents + order.amounts.tax_cents;
  const month = new Date(`${(spend?.month ?? order.created_at.slice(0, 7))}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return `<article class="owner">
    <p class="owner__eyebrow">${esc(eyebrow ?? `Asked ${day(approval.created_at)}`)}</p>
    <p class="owner__title${tone ? ` owner__title--${tone}` : ''}">${esc(title)}</p>
    <ul class="owner__items">${order.lines.map((l) => `<li><span>${esc(l.name)} × ${l.quantity}</span><span>${usd(l.line_total_cents)}</span></li>`).join('')}</ul>
    <div><p class="owner__amount">${usd(order.amounts.total_cents)}</p>
      <p class="owner__note">${extras ? `Includes ${usd(extras)} shipping and tax. ` : ''}Ships to ${esc([ship_to?.name, ship_to?.line1, ship_to?.city].filter(Boolean).join(', '))}.</p></div>
    ${pending ? `<ul class="why">${approval.reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>` : `<p>${esc(outcome)}</p>`}
    ${pending ? actions : ''}
    ${spend && policy ? meter({ label: month, spentCents: spend.spent_cents, limitCents: policy.monthly_limit_cents, addingCents: pending ? order.amounts.total_cents : 0 }) : ''}
  </article>`;
}

const decideButtons = (action, extra, amount) => `<div class="owner__actions">
  <form method="post" action="${action('approve')}">${extra('approve')}<button class="btn btn--dark">Approve ${usd(amount)}</button></form>
  <form method="post" action="${action('reject')}">${extra('reject')}<button class="btn">Decline</button></form>
</div><p class="owner__note">Nothing is charged unless you approve.</p>`;

/** What the "Approve $X?" email opens. One tap, no sign-in needed: the link is the permission. */
export function approvalPage({ info, token }) {
  const { approval, account } = info;
  const pending = approval.status === 'pending';
  const actions = decideButtons(() => `/owner/approvals/${esc(approval.id)}/decide`, (decision) => hidden({ t: token, decision }), approval.amount_cents);
  const [title, lede] = pending ? ['Approve this order?', 'Your assistant wants to order these supplies. They are outside the limits you set, so they wait for you.']
    : approval.status === 'approved' ? ['Order approved', 'Your assistant can see that you said yes.']
    : approval.status === 'rejected' ? ['Order declined', "Your assistant can see that you said no, and won't place it again."]
    : ['Order request', 'A request from your assistant.'];
  return layout(title, `<div class="stack">
    <h1 class="title">${title}</h1>
    <p class="lede">${lede}</p>
    ${approvalCard(info, actions)}
    <p class="small muted">Want different limits? <a href="/owner">Sign in to your account</a> to change them.</p>
  </div>`, { robots: false });
}

const ORDER_STATE = (o) => {
  const sh = o.shipment;
  if (o.status === 'requires_approval') return ['Waiting for you', 'warn'];
  if (o.status === 'payment_failed') return ['Card declined', 'stop'];
  if (o.status === 'canceled') return ['Canceled', ''];
  if (o.status === 'refunded') return ['Refunded', ''];
  if (o.status === 'payment_pending') return ['Payment clearing', 'warn'];
  if (sh?.status === 'delivered') return [`Delivered ${day(sh.delivered_at)}`, 'go'];
  if (sh?.status === 'shipped') return [`Arriving ${day(sh.estimated_delivery_date)}`, 'go'];
  if (sh) return [`Arriving about ${day(sh.estimated_delivery_date)}`, 'warn'];
  return ['Paid', 'go'];
};
const stateLine = (o) => { const [label, tone] = ORDER_STATE(o); return `<span class="status-line${tone ? ` status-line--${tone}` : ''}"><i aria-hidden="true"></i>${esc(label)}</span>`; };
const itemsText = (lines, n = 3) => lines.slice(0, n).map((l) => (l.quantity > 1 ? `${l.name} × ${l.quantity}` : l.name)).join(', ') + (lines.length > n ? `, +${lines.length - n} more` : '');
const CASE = { open: ['Open', 'warn'], resend_sent: ['Replacement sent', 'go'], refunded: ['Refunded', 'go'], closed: ['Closed', ''] };
const KIND = { never_arrived: 'Never arrived', damaged: 'Arrived damaged', wrong_item: 'Wrong item', missing_item: 'Missing item', charged_wrong: 'Charged wrong', return: 'Sending back', other: 'Other problem' };

/** The owner's page: what needs them, what's coming, then settings. */
export function ownerPage({ account, approvals, addresses, paymentMethods, grants, orders, cases, subscriptions = [], testMode, flash, developerKey }) {
  const back = '/owner';
  const termsOk = account.owner.terms_version && account.owner.terms_current;
  const upcoming = subscriptions.filter((x) => x.next_order_date).sort((a, b) => a.next_order_date.localeCompare(b.next_order_date));
  const next = upcoming[0];
  const month = new Date(`${account.spend.month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const sign = (label, big, body, quiet) => `<div class="sign"><p class="sign__label">${esc(label)}</p><p class="sign__big${quiet ? ' sign__big--quiet' : ''}">${esc(big)}</p>${body}</div>`;
  const orderById = Object.fromEntries(orders.map((o) => [o.id, o]));

  return layout(account.name, `<div class="stack">
    <div class="hh"><h1 class="title">${esc(account.name)}</h1><p class="muted">Signed in as ${esc(account.email)}${testMode ? ' · <span class="badge badge--warn">Test mode</span>' : ''}</p></div>
    ${flash ? `<p class="notice notice--go">${esc(flash)}</p>` : ''}
    ${account.on_hold ? `<p class="notice notice--stop">Orders are paused on this account (${esc(account.on_hold.reason)}). Write to ${esc(account.support.email)} and we'll sort it out.</p>` : ''}
    ${termsOk ? '' : `<form class="notice form" method="post" action="/owner/terms">${hidden({ back })}
      <label class="check"><input type="checkbox" name="accept_terms" value="1" required><span>I agree to the <a href="/terms">Terms</a>, including automatic renewal of subscriptions until canceled.</span></label>
      <div class="actions"><button class="btn btn--primary btn--sm">Accept</button></div></form>`}
    ${developerKey ? `<div class="notice"><p><strong>Your developer owner key</strong> (shown once):</p><p class="mono">${esc(developerKey)}</p></div>` : ''}

    <section class="signage" aria-label="At a glance">
      ${sign(`Spent in ${month}`, usd(account.spend.spent_cents), meter({ label: 'Monthly budget', spentCents: account.spend.spent_cents, limitCents: account.policy.monthly_limit_cents }))}
      ${next ? sign('Next delivery', day(next.next_order_date), `<p>${esc(itemsText(next.items, 2))}<br><span class="muted">About ${usd(next.estimated_next_order.total_cents)}${next.status === 'paused' ? ', after the pause' : ''}</span></p>`)
    : sign('Next delivery', 'None', '<p class="muted">Ask your assistant to set up regular deliveries.</p>', true)}
      ${grants.length ? sign(grants.length > 1 ? 'Assistants' : 'Assistant', grants.length > 1 ? `${grants.length} connected` : grants[0].client_name, `<p class="muted">Shops within your limits. It can't approve its own orders.</p>`)
    : sign('Assistant', 'None', '<p class="muted">Use "Connect Domaru" in your assistant.</p>', true)}
    </section>

    ${approvals.length ? `<h2 class="section">Waiting for you</h2><div class="cards">${approvals.map((a) => approvalCard({ ...a, spend: account.spend, policy: account.policy },
    decideButtons((d) => `/owner/approvals/${esc(a.approval.id)}/${d}`, () => hidden({ back }), a.approval.amount_cents))).join('')}</div>` : ''}

    <h2 class="section">Coming up</h2>
    ${upcoming.length ? `<ul class="sched">${upcoming.map((x) => `<li>
      <span class="sched__date">${esc(day(x.next_order_date))}</span>
      <span class="sched__what">${esc(itemsText(x.items))}<span>${x.status === 'paused' ? (x.pause_until ? `Paused until ${esc(day(x.pause_until))}` : 'Paused') : `Every ${x.cadence_days % 7 === 0 ? `${x.cadence_days / 7} weeks` : `${x.cadence_days} days`}`}${x.status === 'past_due' ? ' · last payment failed' : ''}</span></span>
      <span class="sched__amt">${usd(x.estimated_next_order.total_cents)}</span></li>`).join('')}</ul>`
    : '<p class="muted">No regular deliveries yet. Your assistant sets these up.</p>'}

    <h2 class="section">Recent orders</h2>
    ${orders.length ? `<div class="panel table-scroll"><table class="lines orders"><thead><tr><th>Date</th><th>Items</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
      ${orders.map((o) => `<tr><td>${esc(day(o.created_at))}</td><td>${esc(itemsText(o.lines, 2))}</td><td>${stateLine(o)}</td><td class="num">${usd(o.amounts.total_cents)}${o.refunded_cents && o.status !== 'refunded' ? `<span class="sub">${usd(o.refunded_cents)} refunded</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No orders yet.</p>'}

    ${cases.length ? `<h2 class="section">Problems you reported</h2>${cases.map((c) => {
    const [label, tone] = CASE[c.status] ?? [c.status, ''];
    const o = orderById[c.order_id];
    return `<div class="panel stack--tight"><div class="panel__head"><h3>${esc(KIND[c.kind] ?? c.kind)}${o ? ` <span class="muted small">· ${esc(itemsText(o.lines.filter((l) => !c.skus?.length || c.skus.includes(l.sku)), 2))}, ${esc(day(o.created_at))}</span>` : ''}</h3><span class="badge${tone ? ` badge--${tone}` : ''}">${esc(label)}</span></div><p>${esc(c.what_happens_next)}</p></div>`;
  }).join('')}` : ''}

    <h2 class="section">Settings</h2>
    <div class="settings">
      <div class="panel"><h3>Spending limits</h3><p class="small muted" style="margin-bottom:1rem">Anything over these waits for your OK. We email you Approve and Decline buttons.</p>${limitsForm(back, account.policy)}</div>
      <div class="stack--tight">
        <div class="panel"><h3>Payment</h3><div class="stack--tight">
          ${paymentMethods.map((pm) => `<p><strong>${esc(cap(pm.brand))} •••• ${esc(pm.last4)}</strong>${pm.id === account.default_payment_method_id ? ' <span class="badge">Default</span>' : ''}${pm.type === 'bank' ? ' <span class="badge badge--go">2% off</span>' : ''}</p>`).join('') || '<p class="muted">No card yet.</p>'}
          ${paymentActions(back, { testMode, hasCard: paymentMethods.length > 0 })}
          ${account.bank_payments.offer ? `<form method="post" action="/owner/bank">${hidden({ back })}<button class="btn btn--primary btn--sm">Pay by bank, save 2%</button></form>` : ''}
        </div></div>
        <div class="panel"><h3>Assistants</h3>
          ${grants.length ? grants.map((g) => `<div class="panel__head"><div><p><strong>${esc(g.client_name)}</strong></p><p class="small muted">Connected ${esc(day(g.connected_at))}${g.last_used_at ? ` · last used ${esc(day(g.last_used_at))}` : ''}</p></div>
            <form method="post" action="/owner/grants/${esc(g.id)}/revoke">${hidden({ back })}<button class="btn btn--stop btn--sm">Disconnect</button></form></div>`).join('<hr class="divider">')
    : '<p class="muted">None connected. Use "Connect Domaru" in your assistant to add one.</p>'}
        </div>
      </div>
      <div class="panel"><h3>Delivery addresses</h3><div class="stack--tight">
        ${addresses.map((a) => `<div class="panel__head"><p class="addr">${esc(addrText(a))}</p>
          ${a.confirmed ? (a.id === account.default_address_id ? '<span class="badge">Default</span>' : '') : `<form method="post" action="/owner/addresses/${esc(a.id)}/confirm">${hidden({ back })}<button class="btn btn--sm">Confirm address</button></form>`}</div>`).join('<hr class="divider">')}
        <details><summary><strong>Add an address</strong></summary><div style="margin-top:1rem">${addressForm(back, { compact: true })}</div></details>
      </div></div>
      <div class="panel"><h3>Account</h3><div class="stack">
        <form class="form" method="post" action="/owner/email">${hidden({ back })}
          <label>Owner email<span class="hint">Approval requests and receipts go here</span><input type="email" name="email" value="${esc(account.email)}" required></label>
          <div class="actions"><button class="btn btn--sm">Change email</button></div></form>
        <form method="post" action="/owner/developer-key">${hidden({ back })}<p class="small muted">Building your own agent? <button class="linkbtn">Create a developer owner key</button>. Households don't need one.</p></form>
      </div></div>
    </div>
  </div>`, { wide: true, right: signOut, robots: false });
}
