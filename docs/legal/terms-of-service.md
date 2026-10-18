# Domaru Terms of Service

> **DRAFT for lawyer review, written 2026-10-18. Not legal advice and not yet in effect.** Text in [square brackets] is a placeholder or a note for the reviewing lawyer and must be removed before publishing.

**Last updated:** [DATE]

These terms are an agreement between you and Rafiq Labs Inc., a Delaware corporation ("**Domaru**", "**we**", "**us**"). They cover the Domaru store at domaru.app, its API and MCP server, and any order or subscription placed through them (together, the "**Service**").

By signing in, connecting an assistant, adding a payment method, or placing an order, you agree to these terms, our [Privacy Policy](/privacy) and our [Refund and Delivery Policy](/refunds). If you don't agree, don't use the Service.

## 1. What Domaru is

Domaru is a store for everyday household supplies (paper goods, cleaning, laundry, kitchen and bath items) built so that an AI assistant can keep a home stocked for you, within limits you set.

**How we fill orders.** We buy the products you order from major retailers, such as Walmart and Amazon, and have them delivered directly to your address. The box, packing slip or tracking emails may show the retailer's name, and may show the retailer's price for the item. Our price includes the service we provide: subscriptions, restocking, spending limits, approvals and support. We are the seller to you. You don't need an account with the retailer, and you should contact us, not the retailer, about any problem with an order.

**We don't make the products.** Products are made by their manufacturers and sold as they come from the retailer. Follow the manufacturer's label, warnings and directions. Some products (for example bleach, detergent pods and drain cleaner) are hazardous if misused and must be kept away from children and pets.

## 2. Who can use Domaru

- You must be at least 18 and able to form a binding contract.
- We deliver only to addresses in the United States [LAWYER: confirm whether to exclude any states, PO boxes, APO/FPO or US territories].
- The Service is for personal and household use, and for businesses such as short-term rental hosts and small offices buying supplies for their own premises. You may not buy from Domaru to resell.

## 3. Your account and your assistant

**The owner.** The owner is the person who signs in to Domaru with their email address, using the sign-in link we email them. The email address you sign in with identifies the owner. The owner adds a payment method, accepts these terms and is responsible for the account.

**Your assistant.** You connect an AI assistant or app to Domaru by choosing "Connect Domaru" in it and signing in. Once connected, the assistant can browse, quote, order and manage subscriptions on your behalf.

By connecting an assistant, you authorize it to act for you on Domaru **within the spending limits and approval rules the owner sets**. Specifically:

1. **Orders inside your limits are authorized by you.** An order or subscription your connected assistant places, and which is within your limits, is treated as an order you placed. You are responsible for paying for it.
2. **Orders outside your limits wait for you.** Any order that exceeds a limit, or that your rules say needs approval, is held. It isn't charged unless the owner approves it. If no one approves it, it is not placed.
3. **Only the owner can change limits or approve held orders.** A connected assistant cannot approve orders, change your limits or change who the owner is. Those actions require the owner to be signed in on domaru.app.
4. **You can disconnect an assistant at any time** on domaru.app. Once disconnected, it can no longer see or place orders. Orders it placed before you disconnected it are not undone automatically; see our Refund and Delivery Policy.
5. **Keep your email account secure.** Anyone who can read the email account you sign in with can sign in to Domaru as the owner. Tell us right away at support@domaru.app if you think someone else has signed in or connected an assistant without your permission. We aren't responsible for orders placed before you told us through access you allowed or failed to protect.
6. **Your assistant is not Domaru.** The assistant or app you connect is provided by someone else under their own terms and privacy policy. We don't control what it decides to order, what it tells you, or how it stores your information. If it orders something within your limits that you didn't want, see our Refund and Delivery Policy.

You must give us accurate account, delivery and payment information and keep it up to date.

**Developer keys and test mode.** Developers building on Domaru may instead use API keys: an agent key, which works like a connected assistant, and an owner key, which works like the signed-in owner. Keep them secret; anyone who has them can act with their permissions, and the rules above apply to them the same way. Keys marked "test" (for example keys starting with `ck_test_` or `ok_test_`) are a sandbox. Nothing in test mode is charged or delivered, and test data may be deleted at any time.

## 4. Prices, quotes and taxes

- **The quote is the charge.** Before an order is placed, the Service shows the item prices, any delivery fee and estimated tax. The amount charged for that order will not exceed the quoted total. [LAWYER: tax is calculated by Stripe Tax at the time of the quote; confirm wording if the final tax can differ by a few cents.]
- Prices can change. A price change applies to orders quoted after the change. For subscriptions, see section 5.
- We collect sales tax where required.
- Prices are in US dollars.
- If we list an item at an obviously wrong price because of an error, we may cancel the order and refund you in full, even after you've been charged.

## 5. Subscriptions and automatic renewal

**A Domaru subscription renews automatically.** It places a new order and charges your payment method on each order date, at the cadence shown (for example every 28 days), **until you or your assistant pause, skip or cancel it.**

- **What you'll see before you subscribe:** the items, the price of each order, how often it repeats, the date of the first charge, and how to cancel. [LAWYER: several states, including California, require this disclosure "clearly and conspicuously" and the customer's affirmative consent before the first charge. Because an assistant may create the subscription, we plan to capture the owner's consent when the owner signs in and adds a payment method. Please confirm this is sufficient, or whether the owner must confirm each new subscription.]
- **Confirmation.** When a subscription starts, we email the owner a confirmation listing the items, saying that it renews automatically at the cadence shown until canceled, and explaining how to cancel.
- **Cancel any time.** You or your assistant can cancel, pause or skip a subscription at any time through the Service, or by emailing support@domaru.app. Cancellation takes effect immediately and stops future orders. An order that has already been charged and placed with the retailer isn't affected; see the Refund and Delivery Policy for that order.
- **Price changes.** If the price of a subscription item goes up, we'll tell the owner at least 7 days before the next order at the new price. If the new total exceeds the owner's limits, that order will be held for approval instead of charged.
- **Out of stock.** If an item is unavailable, we'll substitute only according to the substitution rules the owner has set. If there are none, we'll skip that item and not charge for it.
- **Failed payments.** If a charge fails, we'll let you know and retry. If it keeps failing, the subscription may be paused.

## 6. Payments

- Payments are processed by **Stripe**. Your full card or bank details go to Stripe, not to us. Stripe's [Services Agreement](https://stripe.com/legal/ssa) and [Privacy Policy](https://stripe.com/privacy) apply to how Stripe handles them.
- **Card payments.** By adding a card, you authorize us to charge it for orders and subscription renewals placed under these terms, including future charges made while you aren't present.
- **Bank (ACH) payments.** After your first delivery, we may offer payment by bank account at a discount. If you choose it, you authorize Rafiq Labs Inc. to debit the bank account you provide for each order and subscription renewal in the amount quoted, about [4] business days before the order is placed with the retailer. You can revoke this authorization by removing the bank account or emailing support@domaru.app at least [3] business days before the next debit. If a debit is returned, we won't place that order, and we may charge a returned-payment fee of up to [$X, or none] where the law allows. [LAWYER: confirm Nacha authorization wording; Stripe presents its own mandate text at signup too.]
- Charges appear on your statement as **DOMARU**.
- If you dispute a charge with your bank, please contact us first; we can usually fix it faster. We may pause an account while a dispute is open.

## 7. Delivery, ownership and risk

- Delivery dates are estimates from the retailer and carrier, not guarantees.
- Ownership of the products and the risk of loss pass to you when the order is delivered to your address.
- Problems with delivery (missing, late, damaged or wrong items), cancellations and returns are handled under our [Refund and Delivery Policy](/refunds).

## 8. Using the API and MCP server

If you or your assistant use the Domaru API or MCP server, you agree not to:

- access accounts, sign-ins or keys that aren't yours, or try to get around spending limits, approvals or rate limits;
- interfere with or overload the Service, or probe it for vulnerabilities except under a written agreement with us [or our security policy];
- use the Service to place fraudulent orders, test stolen payment methods, or buy for resale;
- copy the catalog or Service to build a competing product by scraping.

We may change, rate-limit or retire API versions and tools. We'll try to give reasonable notice of breaking changes.

If you build an assistant or app that connects people to Domaru, you are responsible for telling your users what your app does and for getting their consent to connect it. [Separate partner terms may apply.]

## 9. Suspending or closing accounts

You can close your account at any time by emailing support@domaru.app or through the Service. Closing cancels all subscriptions.

We may suspend or close an account, cancel pending orders, or refuse an order if we reasonably believe there is fraud, a disputed or failed payment, misuse of sign-ins or keys, abuse of our refund policy, a breach of these terms, or if a retailer can't fill the order. If we cancel an order you've paid for, we'll refund it.

## 10. Changes to the Service and these terms

We may update these terms. If a change is material, we'll notify the owner by email or through the Service at least [14] days before it takes effect. Continuing to use the Service after that means you accept the new terms. If you don't, you may cancel. Changes don't apply to orders already placed.

## 11. Disclaimers

Except as stated in these terms and our Refund and Delivery Policy, the Service is provided "as is" and "as available". To the extent the law allows, we disclaim implied warranties of merchantability, fitness for a particular purpose and non-infringement. We don't warrant that the Service will be uninterrupted or error-free, or that an assistant will make the choices you would.

Products carry only the manufacturer's warranty, if any. Nothing in these terms limits rights you have under the law that can't be waived. [LAWYER: Magnuson-Moss / state implied warranty interplay for a reseller of consumer goods.]

## 12. Limitation of liability

To the extent the law allows:

- Domaru is not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits or data.
- Our total liability for any claim relating to the Service is limited to the greater of the amount you paid us in the 12 months before the claim, or $100.

These limits don't apply to liability that the law doesn't allow to be limited, such as for gross negligence, fraud or personal injury caused by our negligence in states where that applies.

## 13. Indemnity

If you use the Service for a business, or if you build an app or assistant that connects to it, you agree to defend and indemnify Domaru against claims by third parties arising from your breach of these terms or your app's actions. [LAWYER: consider limiting indemnity to business and developer users only; consumer indemnities are disfavored.]

## 14. Disputes

**Talk to us first.** Most problems are fixed fastest by emailing support@domaru.app. If we can't resolve a dispute informally within 30 days, either of us may proceed as below.

[LAWYER: choose one of the two options below.]

**[Option A: courts]** These terms are governed by the laws of the State of Arkansas, without regard to conflict-of-law rules. Any dispute will be resolved in the state or federal courts in Benton County, Arkansas, except that either of us may bring a claim in small-claims court where you live.

**[Option B: arbitration]** Any dispute will be resolved by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, except that either of us may bring an individual claim in small-claims court. **You and Domaru each give up the right to a jury trial and to participate in a class action.** You may opt out of this section by emailing support@domaru.app within 30 days of first accepting these terms. [Requires careful drafting: mass-arbitration fee exposure, opt-out mechanics, enforceability with agent-accepted terms.]

## 15. General

- These terms, the Privacy Policy and the Refund and Delivery Policy are the entire agreement between us about the Service.
- If any part is unenforceable, the rest still applies.
- Our not enforcing a term isn't a waiver.
- You may not transfer your account or these terms without our consent. We may transfer them as part of a merger, acquisition or sale of assets.
- We aren't responsible for delays caused by events outside our reasonable control, including retailer or carrier outages and severe weather.

## 16. Contact

Rafiq Labs Inc.
2233 Langford St, Pea Ridge, AR 72751
support@domaru.app
