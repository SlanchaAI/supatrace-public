# Customer Billing page

The dashboard now has a first-class `#billing` route, visible navigation and a
workspace-scoped plan/payment-availability page. `#usage` remains reserved capacity
with a Billing link. Home also links to Billing.

## What the page does

- Uses the existing validated, scope-pinned Usage response for plan and quota
  state. Refresh/cancel/error recovery clears both views rather than maintaining
  a second plan cache.
- Shows owner-management guidance to members and directs owners to Default when
  another environment is selected. It never substitutes personal billing data
  while showing a team workspace.
- Shows a concrete unavailable state when no approved catalog is returned. No
  prices, card details, invoice records or subscription claims are fabricated.
- Shows Base and Pro subscriptions billed through Stripe on the hosted service.
  The plan applies after payment is confirmed. Owners can manage subscriptions,
  payment details and invoices through Stripe. Sandbox billing history remains
  read-only when the sandbox controls are used.
- Preserves tab-local, same-request Checkout recovery. Cancelling or navigating
  suppresses stale redirects but does not claim to cancel the server's intent.
- Handles old `?billing=success|cancelled#usage` returns on Billing. A return URL
  never confirms payment or grants access; explicit unrelated routes still win.
- Fences late redirects when identity or workspace permissions need rechecking.
  Normal Back/Forward and direct `#billing` navigation use the existing router.

## Verification

`tests/commercial-ui.test.mjs` and the existing Usage/identity tests cover state,
owner/environment gates, unavailable catalogs, stale reads, duplicate actions,
safe redirects, same-request recovery, cancellation, returns and revoked identity.

`tests/billing-page-browser.test.mjs` is part of `npm run test:ui`. It covers
1280/390/320px layouts, default-off/runtime unavailable, loading/failure/retry,
owner/admin/viewer visibility, Default guidance, Back/Forward, repeated clicks,
pending Checkout/Portal scope changes, epoch revocation and untrusted returns.
It writes synthetic-only screenshots under `test-artifacts/billing/` when a
permitted local browser is available, and `npm run screenshots` captures the
Billing view into the CI artifact directory alongside the other signed-in views.
Existing browser tests were moved to the new destination without removing their
safety assertions.

Run browser tests in a supported Chromium environment. Source and unit checks do not establish rendered behavior or provider payment correctness.

## Hosted and local billing

Hosted plans are billed by Stripe in live mode. The local server uses synthetic
billing and charges no cards. Stripe test-mode and sandbox controls retain their
mode-specific labels. See [plan billing](plan-billing.md) for payment confirmation,
subscription management and mode separation.
