# Plan billing (Stripe test mode)

Base ($9.99/month) and Pro ($25.99/month) are bought through Stripe Checkout and changed in Billing and cancelled in the Stripe customer portal. Enterprise is assigned by an operator. Everything here runs in Stripe **test mode**: no real card is charged. Live mode is refused by the code and is a separate decision.

The plan table, limits and feature flags are in [plan-catalog.md](plan-catalog.md). The code is `src/plan-billing.mjs`; the dashboard part is `public/app/plan-billing.js`.

## How a plan changes

1. The owner opens **Billing** and selects **Upgrade to Base** or **Upgrade to Pro**. `POST /api/billing/subscribe` creates a Stripe customer for the organization (once) and a Checkout Session, and returns its URL.
2. The owner pays on Stripe's page and is sent back to `/app/?checkout=success#billing`.
3. The dashboard calls `POST /api/billing/sync`. Opening Billing also re-reads the subscription (at most once a minute for an organization, waiting at most three seconds for Stripe), which picks up a payment whose redirect was lost. The server lists the subscriptions of the organization's own Stripe customer and writes the plan they pay for to `plan_id` on the organization's account row. Limits and feature gates read that row, so they change at once.
4. **Change to Base/Pro** confirms the monthly price and immediate proration, then calls owner-only `POST /api/billing/change`. The server changes the existing fixed-price item, preserving usage items. `pending_if_incomplete` keeps the old plan until payment succeeds; a pending payment opens its hosted Stripe invoice. **Manage subscription** opens the Stripe customer portal (`POST /api/billing/manage`) to cancel, manage payment details or see invoices. On return the dashboard syncs again. Stripe cannot update usage-based subscriptions in its portal (https://docs.stripe.com/customer-management).
5. Stripe also sends signed events to `POST /api/billing/webhook`. An event only says which organization to look at; the plan still comes from reading the subscription back. This is how a cancellation or a failed renewal reaches an organization nobody has open.

Nothing a browser sends moves a plan. A Checkout Session that was opened and not paid changes nothing.

If Stripe's return redirect is lost and Billing was opened immediately before payment, the automatic check can show the previous plan for up to one minute. Wait 60 seconds and reopen Billing; the subscription is read again. An unavailable or slow provider leaves the last verified plan visible, rather than treating an unconfirmed payment as an upgrade.

| Subscription status in Stripe | Plan in force |
| --- | --- |
| `active`, `trialing` | the plan of its price |
| `past_due` | kept while Stripe retries the card |
| `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `paused`, none | Free |

Back on Free nothing is deleted: members, environments, keys and drains over the Free limits stay, creating more is refused, and paid features lock.

## Safeguards

- Only a Stripe test key (`sk_test_` or `rk_test_`) composes the runtime. A live key leaves billing unavailable.
- Every Stripe object read must have `livemode: false`; a signed event with `livemode: true` is refused.
- The Stripe prices are found by lookup key (`supatrace_base_monthly`, `supatrace_pro_monthly`) and must match the plan table's amount, currency and interval, or Checkout is refused (`plan_billing_price_mismatch`).
- One subscription per organization: a second Checkout is refused (`subscription_exists`).
- Billing routes are owner-only and Default-environment-only, need the application's own Origin on POST, and are rate limited.
- A plan assigned by an operator is never changed by Stripe.
- Webhook events for other products on the same Stripe account, or naming an organization whose Stripe customer they are not about, are acknowledged and ignored.

## Enterprise (operator)

```sh
node scripts/set-plan.mjs supatrace-alpha-metadata <organization-id> enterprise            # dry run
node scripts/set-plan.mjs supatrace-alpha-metadata <organization-id> enterprise --execute
node scripts/set-plan.mjs supatrace-alpha-metadata <organization-id> none --execute        # back to Free
```

The organization id is the workspace id shown in Settings. The script needs AWS credentials that may update the metadata table and writes an audit event with the change.

## Switching it on for a deployment (operator)

The runtime is off until the function has `PLAN_BILLING_SECRET_ARN`. Stripe test-mode objects that must exist (they do in the Slancha test account): products "SupaTrace Base" and "SupaTrace Pro" with a tax code, their monthly prices with the lookup keys above, and a customer portal configuration with `metadata.app = supatrace` that allows switching between the two prices and cancelling.

1. Store the Stripe **test** secret key in Secrets Manager.
2. Add that secret's ARN to the function role and its permissions boundary, and set `PLAN_BILLING_SECRET_ARN` on the function (stack parameters; see `aws/DEPLOYMENT.md`).
3. For events: create a Stripe test webhook endpoint for the billing ingress URL with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`; store its signing secret and set `PLAN_BILLING_WEBHOOK_SECRET_ARN`.

Without step 3 plans still change when the owner returns from Stripe or opens Billing; a cancellation made while nobody has the dashboard open is picked up the next time Billing is opened.

## Local development against the real Stripe test account

```sh
SUPATRACE_DEV_STRIPE_TEST_KEY=sk_test_... node scripts/dev.mjs --port 3411
```

Sign in as the owner at `/__local__/`, open Billing and upgrade with the test card `4242 4242 4242 4242`. The dev server's application origin is `https://supatrace.dev`, so Stripe returns there; open the same path on the local port.

## Pro overage (TEST only)

Before cap-off, the server verifies the paid Pro subscription, attaches the monthly TEST metered price `supatrace_pro_overage_monthly`, and pins the customer/subscription binding. The price is USD 0.0005 cents per accepted span ($5 per million), summed by the active `supatrace_pro_overage` meter. Cap-off is refused when this configuration is unavailable. Enterprise overage needs a negotiated contract and cannot use this self-serve price.

`acceptReservedBatch` atomically records only accepted spans beyond the monthly allowance in a durable ledger and queues `PLAN_OVERAGE#JOBS`. Reservations and retries never add charges. The dedicated EventBridge `supatrace-plan-overage` rule calls the API Lambda every five minutes; `src/plan-overage.mjs` reports the unreported delta with a persisted deduplication identifier. Plan/cap/subscription changes fence the acceptance transaction. Turning the cap back on remains available during a Stripe outage.

Failed reports remain queued and trigger the Lambda error alarm. An ambiguous report older than 12 hours is held for operator reconciliation, before Stripe's deduplication window expires; it is never blindly replayed. Inspect the ledger's persisted identifier against TEST meter events and reconcile `reported_spans` before releasing a held job. Account erasure waits for queued reporting and Stripe aggregation before generating a final TEST usage invoice and deleting the customer.

## Not built
- No annual prices, coupons, trials or tax registration.
- The older sandbox rehearsal (`src/stripe-billing.mjs` and the worker functions) is unchanged and still drives the synthetic Checkout in `npm run dev`.
