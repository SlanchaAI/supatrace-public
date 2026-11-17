# Plan billing

Base ($9.99/month) and Pro ($25.99/month) are bought through Stripe Checkout and changed in Billing and cancelled in the Stripe customer portal. Enterprise is assigned by an operator. Hosted subscriptions use Stripe live billing. The secret key selects Stripe test or live mode. Test mode charges no real card. A test key preserves the existing test behavior; a live key enables real payments.

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

- Secret and restricted keys compose the runtime: `sk_test_` or `rk_test_` selects test; `sk_live_` or `rk_live_` selects live. Public, empty and malformed keys leave billing unavailable. There is no mode environment variable or stack parameter.
- Every Stripe object read and signed event must have `livemode` equal to the runtime mode. Mixed objects are refused. Webhook signature verification remains required. Keys are never logged.
- Customers carry `stripe_mode`. Unmarked legacy customers belong to test mode. Paid plans use `stripe_test` or `stripe_live`; other-mode plans count as Free. Reads never mutate them. An explicit purchase preserves previous billing fields under `stripe_previous_test` or `stripe_previous_live` before binding the new customer. Returning to a mode reuses its saved customer and checks for an existing subscription before opening Checkout. Operator plans stay unchanged. Overage ledgers carry their own mode; live ledger keys have a `live#` segment. Other-mode ledgers cannot be reported. Monthly counters and usage notices are separate by mode; legacy rows and unmarked pending uploads remain test usage. Returning to a mode restores its saved subscription and overage bindings. Erasure holds if outstanding usage lacks a settlement price. Test-only state does not block deletion in live mode. Current or archived live billing blocks deletion after rollback until the lead closes it with live credentials; erasure never discards that binding.
- Live Checkout collects billing addresses with `billing_address_collection: auto` and disables promotion codes.
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

The runtime is off until the function has `PLAN_BILLING_SECRET_ARN`. Objects in the selected Stripe mode that must exist: products "SupaTrace Base" and "SupaTrace Pro" with a tax code, their monthly prices with the lookup keys above, and a customer portal configuration with `metadata.app = supatrace` that allows switching between the two prices and cancelling.

1. Store the Stripe secret or restricted key for the selected mode in Secrets Manager.
2. Add that secret's ARN to the function role and its permissions boundary, and set `PLAN_BILLING_SECRET_ARN` on the function (stack parameters; see `aws/DEPLOYMENT.md`).
3. For events: create a Stripe webhook endpoint in that mode for the billing ingress URL with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`; store its signing secret and set `PLAN_BILLING_WEBHOOK_SECRET_ARN`.

Without step 3 plans still change when the owner returns from Stripe or opens Billing; a cancellation made while nobody has the dashboard open is picked up the next time Billing is opened.

## Local development against the real Stripe test account

```sh
SUPATRACE_DEV_STRIPE_TEST_KEY=sk_test_... node scripts/dev.mjs --port 3411
```

Live keys are refused by both dev entry points before provider construction. Sign in as the owner at `/__local__/`, open Billing and upgrade with the test card `4242 4242 4242 4242`. The dev server's application origin is `https://supatrace.dev`, so Stripe returns there; open the same path on the local port.

## Pro overage

Before cap-off, the server verifies the paid Pro subscription, attaches the monthly metered price in the runtime mode `supatrace_pro_overage_monthly`, and pins the customer/subscription binding. The price is USD 0.0005 cents per accepted span ($5 per million), summed by the active `supatrace_pro_overage` meter. Cap-off is refused when this configuration is unavailable. Enterprise overage needs a negotiated contract and cannot use this self-serve price.

`acceptReservedBatch` atomically records only accepted spans beyond the monthly allowance in a durable ledger and queues `PLAN_OVERAGE#JOBS`. Reservations and retries never add charges. The dedicated EventBridge `supatrace-plan-overage` rule calls the API Lambda every five minutes; `src/plan-overage.mjs` reports the unreported delta with a persisted deduplication identifier. Plan/cap/subscription changes fence the acceptance transaction. Turning the cap back on remains available during a Stripe outage.

Failed reports remain queued and trigger the Lambda error alarm. An ambiguous report older than 12 hours is held for operator reconciliation, before Stripe's deduplication window expires; it is never blindly replayed. Inspect the ledger's persisted identifier against meter events in the ledger's mode and reconcile `reported_spans` before releasing a held job. Account erasure waits for queued reporting and Stripe aggregation before generating a final usage invoice in that mode and deleting the customer.

## Going live and rolling back

The lead stages Stripe objects and secrets, then controls the flip. Merging this code changes nothing in production while the secret holds a test key. Legal and marketing wording is proposed in [live-billing-copy-changes.md](live-billing-copy-changes.md) for a separate approved flip-time change.

Required objects in **live mode**:

- Base and Pro products and active USD monthly licensed prices with lookup keys `supatrace_base_monthly` (999 cents) and `supatrace_pro_monthly` (2599 cents).
- An active monthly metered price with lookup key `supatrace_pro_overage_monthly`, at USD 0.0005 cents per span, attached to the active meter whose event name is `supatrace_pro_overage`. The meter sums `value` and maps customers by `stripe_customer_id`.
- An active customer portal configuration with `livemode: true` and `metadata.app=supatrace`, allowing cancellation, payment details and invoice access. The app changes plan prices in place and preserves metered items.
- A webhook endpoint for `POST /api/billing/webhook` subscribing to all six events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

Put the live secret or restricted key in `supatrace-plan-billing-test-key` and the matching live endpoint signing secret in `supatrace-plan-billing-test-webhook`. These names are historical. Their ARNs are the existing stack parameters that supply `PLAN_BILLING_SECRET_ARN` and `PLAN_BILLING_WEBHOOK_SECRET_ARN`; no new secret name, parameter or mode flag is needed. The app picks up a new secret version within five minutes through its secret cache. Stage both matching secrets before directing live traffic. During a mismatch, webhook verification fails closed.

A restricted key needs these permissions: customers **write**, Checkout Sessions **write**, billing portal **write**, subscriptions **write**, prices **read**, products **read**, invoices **read**, billing meters **read**, meter events **write**, billing meter event summaries **read**. Keep unrelated permissions disabled.

**One-step rollback:** restore the prior secret versions, moving `AWSPREVIOUS` back to `AWSCURRENT` with `aws secretsmanager update-secret-version-stage`, for the key and webhook secrets as one rollback operation. For each secret, use its previous and current version IDs:

```sh
aws secretsmanager update-secret-version-stage --secret-id SECRET_NAME --version-stage AWSCURRENT --move-to-version-id PREVIOUS_VERSION_ID --remove-from-version-id CURRENT_VERSION_ID
```

Alternatively, put the test key and test webhook signing secret back in those same secrets. No deploy or mode parameter change is needed. Allow the five-minute cache window. Other-mode billing state remains stored and is ignored; operator plans are unchanged. Existing live subscriptions remain in Stripe and require lead reconciliation if live traffic is rolled back.

## Not built
- No annual prices, coupons, trials or tax registration.
- The older sandbox rehearsal (`src/stripe-billing.mjs` and the worker functions) is unchanged and still drives the synthetic Checkout in `npm run dev`.
