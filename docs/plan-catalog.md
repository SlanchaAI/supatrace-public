# SupaTrace plan catalog

The plan catalog defines: Base $9.99/month, Pro $25.99/month, Enterprise priced like Supabase Enterprise. Supabase lists Enterprise as "custom pricing" with no self-serve checkout (supabase.com/pricing, read 2026-11-15), so SupaTrace Enterprise is "Custom" with a contact-sales button.

The plan table defines all limits and the existing feature split below; the $0 Free tier stays, with two projects per organization. Pro cap-off overage remains $5 per 1M spans. See [local development](local-development.md).

## Plans

| | Free | Base | Pro | Enterprise |
| --- | --- | --- | --- | --- |
| Price | $0 | $9.99/month | $25.99/month | Custom, contact sales |
| Checkout | none | Stripe Checkout | Stripe Checkout | none; an operator sets the plan |
| Spans per month | 50,000 | 1,000,000 | 5,000,000 | 50,000,000 |
| Stored data | 1 GB | 10 GB | 50 GB | 500 GB |
| Retention | 7 days | 30 days | 90 days | 365 days |
| At the allowance | uploads stop | uploads stop | uploads stop; owner may turn the spend cap off ($5 per 1M spans past it) | uploads stop; custom contract, no self-serve overage |
| Seats per organization | 2 | 5 | 10 | 20 |
| Environments per project | 2 | 3 | 10 | 20 |
| Active API keys | 2 | 10 | 25 | 100 |
| Projects per organization | 2 | 3 | 10 | 20 |
| Created organizations per owner (highest owned plan) | 1 | 3 | 5 | 10 |
| Service-wide cap (all organizations together) | 1,000 accounts, 50 GiB | | | |

Billing is monthly, per organization. No annual price. The 1,000-account and 50-GiB service-wide caps remain TEST-mode launch safety caps (`aws/handler.mjs` SERVICE_CAPS). Both must be raised before LIVE Stripe is activated: 50 GiB is below one 500-GB Enterprise allowance. This approval does not activate live billing or authorize deployment.

The highest plan among actively owned organizations, including the personal workspace, sets the owner’s creation allowance. The personal workspace does not consume a created-organization slot. Membership in someone else’s organization grants no allowance. A new organization starts Free and bills separately; a downgrade prevents further creation above the lower cap without hiding existing organizations. Ownership transfer applies the recipient’s allowance, including the incoming organization’s plan.

Some limits are lower than a buyer may expect, and each is a product constraint, not a pricing choice:

- **Project quotas apply within each organization.** Project creation shares billing and usage; keys, traces and environments remain isolated.
- **Seats top out at 20 and environments at 20.** The member list and environment list are single pages of 20. Enterprise has the largest counts those pages hold.
- **Enterprise numbers are fixed defaults.** A per-contract override (for example 200,000,000 spans) is a one-line change to the plan table today, not an operator setting.

## Feature flags

One table in `src/plans.mjs` decides every flag; `src/entitlements.mjs` reads it. The API checks it on each gated route and the dashboard reads the same answer from `GET /api/entitlements`.

| Flag | Free | Base | Pro | Enterprise | Supabase plan that first has it | Enforced where |
| --- | --- | --- | --- | --- | --- | --- |
| `email_support` | no | yes | yes | yes | Pro | support@supatrace.dev; receiving proven in production |
| `usage_alerts` (email at 80% and 100%) | no | yes | yes | yes | Pro | alert email is sent only with the flag; the in-app banner is for everyone |
| `spend_cap` (turn the cap off) | no | no | yes | yes | Pro | `POST /api/billing/spend-cap` |
| `trace_drains` (data export to your systems) | no | no | yes | yes | Pro (log drains) | create, test, flush and delivery |
| `audit_log` (view) | no | no | yes | yes | Team | `GET /api/audit` |
| `rbac_roles` (Developer, Read-only, environment limits) | no | no | yes | yes | Team | invite and role change |
| `priority_support` | no | no | yes | yes | Team | support@supatrace.dev; receiving proven in production |
| `sso_saml` | no | no | no | yes | Team ("Contact Us") | SSO settings, SSO sign-in, "require SSO" |
| `scim` | no | no | no | yes | Enterprise | SCIM token and the SCIM API |
| `audit_log_export` | no | no | no | yes | Team | `GET /api/audit/export` |
| `custom_roles` | no | no | no | yes | Enterprise | defining a role, giving it to a member; a named role is a permission level (Admin, Developer, Read-only) plus an optional environment limit |
| `enforce_mfa` | no | no | no | yes | Team | "require two-factor" rule |
| `custom_retention` | no | no | no | yes | Enterprise | `POST /api/billing/retention` (1 to 3,650 days, for traces accepted from then on) |
| `sla` | no | no | no | yes | Enterprise (uptime SLA) | contract inquiry delivered to support; signed terms require operator agreement |

Workspace export as JSON stays on every plan, so a customer can always take their data out.

## How the numbers were derived

Supabase's gradient is Free $0, Pro $25, Team $599, Enterprise custom. SupaTrace has two paid self-serve prices close together ($9.99 and $25.99), so Base takes the Supabase Pro quantity step at a smaller size and Pro takes Supabase Pro quantities plus the Team feature set that needs no contract (audit log, roles). Features Supabase sells only with a contract or at $599 (SSO, SCIM, SLA) are Enterprise.

- Retention follows Supabase log retention ratios (1, 7, 28, 90 days) scaled to trace data: 7, 30, 90, 365.
- Spans per month grow 20x from Free to Base and 5x from Base to Pro. The earlier proposal on issue #98 was 100,000 (Free) and 2,000,000 (Pro at $25).

## Over the limit

- Spans or stored data: the upload is refused with HTTP 429, a code that names the limit (`monthly_span_allowance_exceeded`, `stored_bytes_allowance_exceeded`, `spend_cap_reached`), the plan, the limit, the reset date and the upgrade link. Nothing already stored is dropped. The dashboard shows a banner at 80% and 100%.
- Seats, environments, API keys: the create request is refused with HTTP 402 `plan_limit_reached`, the limit, the count in use and the next plan with room. Existing items stay.
- A feature the plan lacks: HTTP 402 `plan_upgrade_required` with the feature and the plan that unlocks it. The dashboard locks the panel and shows the same sentence with a link to Billing.
- Downgrade: nothing is deleted. Members, environments, keys and drains over the new plan stay and keep working; creating more is refused. Features of the higher plan lock again. Retention shortens only for data stored after the downgrade.
- Overage on paid Pro with the cap off is metered at $5 per million accepted spans beyond the allowance, in Stripe TEST mode only. See [plan-billing.md](plan-billing.md) for the durable reporter and reconciliation procedure. Enterprise remains custom; no self-serve Enterprise overage price is authorized.

## Stripe (test mode only)

| Plan | Product | Price lookup key | Amount |
| --- | --- | --- | --- |
| Base | SupaTrace Base | `supatrace_base_monthly` | $9.99/month |
| Pro | SupaTrace Pro | `supatrace_pro_monthly` | $25.99/month |

Both objects have `livemode: false`. No live product, price or key exists. Live billing requires separate configuration and approval.

## Changing a plan

- A number or a flag: edit `PLANS` in `src/plans.mjs`, run `node scripts/site-pages.mjs --write`, and update the literal table in `tests/site-pages.test.mjs`. `tests/entitlements.test.mjs` checks every gate against the table.
- A new feature flag: add it to `FEATURES` and to each plan's list, call `requireFeature(planId, flag)` where the server acts, add the panel's element id to `GATES` in `public/app/entitlements.js`, and add a test next to the others.
- An organization's plan is `plan_id` on its account row (`TENANT#<id>` / `META`). Anything unknown or missing is Free.
