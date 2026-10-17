#!/usr/bin/env -S node --no-warnings
// HTTP API + remote MCP endpoint.
//
// Environment:
//   PORT, CONSUMABLES_DB        server port and SQLite file
//   PUBLIC_URL                  public base URL (required with Stripe, for card setup return pages)
//   STRIPE_SECRET_KEY           enables real Stripe payments (sk_test_... or sk_live_...)
//   FULFILLMENT                 mock (default) or manual (concierge: orders wait on the /admin page)
//   ADMIN_KEY                   enables the /admin fulfillment page (/admin?key=...)
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';
import { StripePayments } from '../src/payments.js';

const env = process.env;
const stripeKey = env.STRIPE_SECRET_KEY;
const payments = stripeKey ? new StripePayments({ secretKey: stripeKey, publicUrl: env.PUBLIC_URL }) : undefined;
const mode = payments?.livemode ? 'live' : 'test';
const fulfillment = env.FULFILLMENT ?? 'mock';

if (payments && !env.PUBLIC_URL) throw new Error('PUBLIC_URL is required when STRIPE_SECRET_KEY is set.');
if (mode === 'live' && (fulfillment !== 'manual' || !env.ADMIN_KEY)) {
  throw new Error('Live mode needs FULFILLMENT=manual and ADMIN_KEY so real orders reach a person.');
}

const store = new Store({ dbPath: env.CONSUMABLES_DB ?? 'consumables.db', payments, fulfillment, mode });
const server = await startServer(store, { port: Number(env.PORT ?? 8787), baseUrl: env.PUBLIC_URL, adminKey: env.ADMIN_KEY });
console.log(`Consumables API on http://localhost:${server.address().port}  (${mode} mode, payments: ${store.payments.name}, fulfillment: ${fulfillment})`);

// Live accounts run on the real clock, so renewals need a scheduler.
if (mode === 'live') {
  const tick = () => store.runAllDue().catch((err) => console.error('renewal run failed', err));
  tick();
  setInterval(tick, 15 * 60 * 1000);
}
