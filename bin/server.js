#!/usr/bin/env -S node --no-warnings
// HTTP API + remote MCP endpoint.
//
// Environment:
//   PORT, DOMARU_DB        server port and SQLite file
//   PUBLIC_URL                  public base URL (required with Stripe, for card setup return pages)
//   STRIPE_SECRET_KEY           enables real Stripe payments (sk_test_... or sk_live_...)
//   FULFILLMENT                 mock (default) or manual (concierge: orders wait on the /admin page)
//   ADMIN_KEY                   enables the /admin operator page (password sign-in; use a long random value)
//   STRIPE_WEBHOOK_SECRET       enables POST /webhooks/stripe (disputes, card setups, bank debits)
//   RESEND_API_KEY              sends owner and support email through Resend (otherwise they are only logged on /admin/emails)
//   EMAIL_FROM                  sender, e.g. "Domaru <support@domaru.app>"
//   SUPPORT_EMAIL               support inbox shown to customers and agents (default support@domaru.app)
//   REFUND_NO_QUESTIONS_CENTS   refund or resend without proof up to this much per problem (default 4000)
//   CLAIM_LIMIT, CLAIM_WINDOW_DAYS  proof needed after this many claims in this many days (default 2 in 90)
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { StripePayments } from '../src/payments.js';
import { ResendMailer } from '../src/email.js';

const env = process.env;
const stripeKey = env.STRIPE_SECRET_KEY;
const payments = stripeKey ? new StripePayments({ secretKey: stripeKey, publicUrl: env.PUBLIC_URL }) : undefined;
const mode = payments?.livemode ? 'live' : 'test';
const fulfillment = env.FULFILLMENT ?? 'mock';

if (payments && !env.PUBLIC_URL) throw new Error('PUBLIC_URL is required when STRIPE_SECRET_KEY is set.');
if (mode === 'live' && (fulfillment !== 'manual' || !env.ADMIN_KEY)) {
  throw new Error('Live mode needs FULFILLMENT=manual and ADMIN_KEY so real orders reach a person.');
}

if (env.ADMIN_KEY && env.ADMIN_KEY.length < 24) throw new Error('ADMIN_KEY must be at least 24 characters.');
const num = (v) => (v == null || v === '' ? undefined : Number(v));
const support = Object.fromEntries(Object.entries({
  email: env.SUPPORT_EMAIL, from: env.EMAIL_FROM,
  no_questions_refund_cents: num(env.REFUND_NO_QUESTIONS_CENTS), claim_limit: num(env.CLAIM_LIMIT), claim_window_days: num(env.CLAIM_WINDOW_DAYS),
}).filter(([, v]) => v !== undefined));
const mailer = env.RESEND_API_KEY ? new ResendMailer({ apiKey: env.RESEND_API_KEY }) : undefined;
const port = Number(env.PORT ?? 8787);
const store = new Store({ dbPath: env.DOMARU_DB ?? 'domaru.db', payments, fulfillment, mode, mailer, support, publicUrl: env.PUBLIC_URL ?? `http://localhost:${port}` });
const server = await startServer(store, { port, baseUrl: env.PUBLIC_URL, adminKey: env.ADMIN_KEY, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET });
console.log(`Domaru API on http://localhost:${server.address().port}  (${mode} mode, payments: ${store.payments.name}, fulfillment: ${fulfillment})`);

// Deliver any email queued outside a request (scheduler runs, webhooks).
setInterval(() => store.flushEmails().catch((err) => console.error('email delivery failed', err)), 30_000);

// Live accounts run on the real clock, so renewals need a scheduler.
if (mode === 'live') {
  const tick = () => store.runAllDue().catch((err) => console.error('renewal run failed', err));
  tick();
  setInterval(tick, 15 * 60 * 1000);
}
