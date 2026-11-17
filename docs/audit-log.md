# Audit log

Each workspace has an append-only log of administrative actions. The workspace owner reads it in the dashboard under **Audit log**, filters it, and exports it as JSON or CSV. Admins and viewers cannot read it. Personal access tokens cannot read it.

## What is recorded

| Action | When | Written |
| --- | --- | --- |
| `auth.sign_in` | A session is created for the account (any sign-in provider, after two-factor when it applies). Recorded in the account's own workspace. | After the session write |
| `key.create`, `key.rotate`, `key.revoke` | A key is created (in the dashboard or by approving an agent pairing), rotated or revoked. | In the same transaction |
| `token.create`, `token.revoke` | A personal access token is created or revoked. Recorded in the account's own workspace. | In the same transaction |
| `member.invite`, `member.accept`, `member.role_change`, `member.remove` | Membership changes. | In the same transaction |
| `workspace.sharing_enabled`, `environment.create` | Team sharing is turned on; an environment is created. | In the same transaction |
| `settings.mfa_enabled`, `settings.mfa_disabled` | Two-factor authentication is turned on or off for the account. | After the change |
| `billing.checkout_started`, `billing.portal_opened`, `billing.controls_enrolled`, `billing.reconciled` | The owner starts Checkout, opens the billing portal, enrolls billing controls or reconciles a purchase. | After the change |
| `billing.spend_cap_changed` | The owner turns the spend cap on or off. | In the same transaction |
| `export.started` | A trace, account or workspace export starts in the dashboard. | Reported by the browser |
| `audit.export` | The audit log is exported. | After the export is built |

"In the same transaction" means the event is one more item in the DynamoDB transaction that makes the change: both commit or neither does. "After the change" means the event is written right after the change succeeds, with one retry; if both writes fail the change stands and the function logs `audit_write_failed` with the action name only.

Exports are assembled in the browser from ordinary read requests, so the server cannot tell an export from reading. The dashboard reports the start of an export, and the log marks those rows `client_reported`. A person who calls the read API directly does not produce this event.

Not recorded yet: Stripe webhook plan changes, sign-out, and failed sign-in attempts.

## What an event holds

Time, the acting account ID, the action, a target, a few short details, the network address of the request, and whether the server or the browser reported it. A key or token appears as the first 12 hexadecimal characters of its ID. Events never hold a key, token, invitation link, session value or two-factor secret.

## Storage and retention

Events are items in the existing metadata table: partition `AUDIT#<workspace>`, sort key `EVENT#<inverted time>#<id>`, written only with `attribute_not_exists`. No code path updates or deletes them, and no setting turns the write path off. Each event carries a `ttl` 90 days after it is written; DynamoDB removes it after that, and the API stops returning it at that moment. The 90-day figure follows the proposed Team plan in epic #98 and is a proposal, not a published commitment.

## API

- `GET /api/audit?action=&actor=&from=&to=&limit=&after=`: owner only. `action` is an action name or its category (`member`, `key`, ...). `limit` is 1 to 200. `next` in the response is the cursor for `after`.
- `GET /api/audit/export?format=json|csv` with the same filters: owner only. A `to` date seeks straight to that time and a `from` date ends the scan, so a date range is found however many newer events exist. One export scans at most 5,000 events; the `X-Audit-Export-Complete` header and the JSON `complete` field say whether older events remain, and `X-Audit-Export-Next` or the JSON `next` field is the cursor to pass as `after` for the next file. The dashboard offers that as **Export part 2**, and so on, until the last part. CSV cells that start with `=`, `+`, `-` or `@` get a leading apostrophe.
- `POST /api/audit/events` `{"action":"export.started","kind":"trace|account|workspace","run_id":"..."}`: any member of the workspace, same-origin browser session only.
