# Spend cap and usage alerts

Both read the approved plan table (`PLANS` in `src/plans.mjs`, through
`src/plan-limits.mjs`). Billing is test mode
only: no real money is charged. Hosted Pro cap-off reports billable accepted spans to the TEST meter at $5 per million.

## Spend cap

Free and Base stop at their included spans. Paid Pro can opt into metered overage; Enterprise overage requires a negotiated contract. For Pro the workspace has a spend cap:

- **On:** uploads stop when the month's included spans are used up. Rejection:
  `429 spend_cap_reached`, with the limit, usage, `resets_at` and `cost_control_url`.
- **Off:** uploads continue. Only accepted spans past the allowance are reported to the verified TEST meter. Missing billing configuration refuses cap-off.

Pro defaults to cap on (`spend_cap: 'on_by_default'`).
Free has no cap to change; it stops at the allowance with
`429 monthly_span_allowance_exceeded`.

The owner changes it with `POST /api/billing/spend-cap` and body `{"enabled": true}` or
`{"enabled": false}`, or with the button in Billing → Cost control. The route is
owner-only and Default-environment-only, like every `/api/billing/` route. A plan
without the entitlement answers `402 plan_upgrade_required`. Unconfigured TEST metering answers `503 overage_test_billing_unavailable`.

Enforcement is in the reservation transaction. With the cap on, the monthly counter
update carries the span ceiling; with it off, it does not. The transaction pins the
plan and the cap value it read, so a cap switched on, or a downgrade, during a request
fails closed.

The stored-byte allowance and the global safety caps apply whether the cap is on or
off.

## Usage alerts

At 80% and at 100% of the month's included spans:

- **In-app banner.** The dashboard derives it from the live counts on every usage
  refresh, so it does not depend on a notification row.
- **Notification record.** The upload that crosses a threshold writes one row per
  account, month and level (`NOTICE#YYYY-MM#USAGE#080` or `#100`). `GET /api/usage`
  lists the month's records in `alerts`. Writing it is best effort and never fails the
  upload. Near a threshold the reservation re-reads the committed count, so uploads
  that cross it together still produce the record. Batches accepted through the server-pull importer do not write records; the
  next ordinary upload does.
- **Email.** Sent after the batch is accepted, with a three-second limit, so an email
  outage cannot hold or fail an upload. Sent once per record, only when the existing SES path is configured
  (`EMAIL_FROM` and the sender) and the account signed in with an email address (email
  or SSO sign-in). The record's `email` field says what happened: `sent`, `failed`,
  `not_configured` or `no_address`. GitHub, Google and ChatGPT accounts have no stored
  address and get no email.

## Deployment configuration

- Deploy the API before using these controls. Email alerts require `EMAIL_FROM`.
- Turning the cap off has a cost only once live billing exists. That is a separate,
  approved change.
