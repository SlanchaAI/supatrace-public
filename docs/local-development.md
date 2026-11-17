# Integrated local development

Start with the [README](../README.md#run-locally) and the [first-trace recipe](self-hosting.md#send-and-read-one-trace). Use **Team admin account** in its personal workspace for a new ingest key. The Owner account can also create a key for the seeded team: seed upload keys are revoked after use, leaving room under Free.

Use Node 22 (`.nvmrc`) and Python 3.12. From this repository:

```sh
npm ci --ignore-scripts
npm --prefix mcp ci --ignore-scripts
npm run dev
```

Open `http://127.0.0.1:3000/__local__/`. Use `npm run dev -- --port 3001` if the
port is occupied. The server binds loopback only. Stop it with Ctrl-C; all demo
state resets. No AWS account, identity-provider login or Stripe key is needed.
This command imports the existing real-handler loopback harness, MemoryDynamo,
immutable object adapter and a synthetic Stripe SDK transport. It does not read
local session directories, discover keys, provision resources or call providers.
The developer sign-in/Checkout routes exist only in this local composition.
Production entrypoints do not import them.

For the complete synthetic private import, choose the owner and open
http://127.0.0.1:3000/__local__/imports. Start one fixed parent/child fixture, watch
the protected worker's stored-batch progress and download its verified import-only
archive. Reload inspects the same job; cancellation or an uncertain outcome does
not create another attempt. Source fixtures explicitly contain inputs and prompts.
No provider connection or key is used. The AWS substitutes remain in-memory; this
is local integration, not hosted durability or live acceptance. Dispatch and recovery are covered by the private-import lifecycle tests.

The seed runs the actual authenticated workspace, invitation, environment,
pairing and upload APIs. There are three clearly synthetic accounts:

| Account | Role in Local demo team |
| --- | --- |
| github-4242 | Owner |
| github-5252 | Admin |
| github-6262 | Viewer |

Each also retains its own personal workspace. Default, Development and Production
contain two identically named runs each, with different synthetic content. In
Settings, switch the selected workspace/environment. Switching reloads the page
and discards old read state; finish/cancel exports and pending mutations first.
Refresh Traces after a new upload, inspect events and export original or account
JSON. Non-default exports include the destination environment ID.

The owner can invite an existing account ID, select Viewer or Admin, and manually
share the resulting one-use, 24-hour link. The link is bound to that exact account;
nothing is emailed or sent automatically. Test wrong-account acceptance and removal.
Admins can create environments and approve environment-specific keys; viewers can
read/export but cannot manage keys, environments, membership or billing. Account
ID, MFA and logout always refer to the signed-in actor, including while viewing a
team workspace.

For local billing, choose the **owner's Default environment**, open Billing, select
**Synthetic paid** and open sandbox Checkout. A loopback-only simulator completes
one synthetic Checkout, produces a signed event, captures it in the isolated inbox,
invokes the separately composed worker and returns to the authenticated preview.
The actual Stripe SDK runs against injected HTTP responses. No request reaches
Stripe and no real payment occurs. Reconciled synthetic Checkout changes the
in-memory plan and its upload limits for this local process. It does not activate
hosted paid access. Its synthetic $2 amount is test data, not approved commercial pricing.
Returning from Checkout alone is not fulfillment; the signed-event reconciliation
is what produces the preview. Its finite lease can expire; refresh Billing to inspect
current state. Existing subscription/risk lifecycle tests remain part of `npm test`.
Automatic tax is off; real activation requires reviewed tax and registration setup.

## Scope and persistence

The existing provider-account tenant remains the deterministic workspace storage,
quota and billing owner. Enabling team sharing explicitly exposes its existing
traces to accepted members across its environments. Existing records and keys map
to Default; there is no bulk migration or new allowance. A user owns one workspace
and can join up to 19 others. Each workspace has up to 20 member identity slots and
20 environments, including Default. Removed memberships retain their audit slot;
there is no hidden TTL cleanup or credential resurrection on rejoin.

New environment keys, batch/run indexes, object hashes, cursors, exports and agent
acknowledgments bind the destination environment. Identical run/batch IDs can exist
in separate environments. Storage reservations and key slots remain shared under
the existing owner/global limits. Role reductions invalidate issued membership
versions permanently; old keys do not regain authority after rejoin/promotion.
Revoke an obsolete key in API keys to release its bounded lease slot. Key status
shows `access removed` when its issuing membership generation is no longer valid.
Wrong-environment key revocation is rejected. In-flight work can be uncertain;
there is no blanket exactly-once or instantaneous-recall guarantee.

For an environment-scoped connection:

```sh
python3 agent/connect.py --project PROJECT_ID --environment development --config ./development-access.json
python3 agent/upload.py reviewed-batch.json --config ./development-access.json --spool ./pending
```

The verification link selects the intended authorized project/environment. Keep
separate configs; changing the environment of an existing config or capture/upload
journal is rejected. Pending cleanup requires a matching batch/hash/project and
non-default environment acknowledgment. These commands target a specifically
approved hosted connection; the local demo seeds synthetic connections internally.
They do not discover or create real provider credentials.

Provider API handoff UI and MCP remain limited to the existing owned Default scope;
they do not silently inherit newly shared workspaces or environments. Private upload
callers must explicitly bind non-default environment IDs in scope, credentials,
request, acknowledgment and receipt journal. Source-provider environment filters
remain separate from these destination environments. Automatic live import still
requires the approved source/destination broker, private execution path and genuine
hosted acceptance; this local workflow does not activate it.

Billing bindings remain with the original owner and are workspace-wide. Billing
operations in another member's workspace or a non-default destination environment
are rejected before provider calls. A Stripe sandbox environment ID is distinct
from an app destination environment ID. Customer/Checkout/Portal permissions are
not implied by entitlement preview or worker reconciliation authority.

## Verification

```sh
npm test
npm run test:integrated
npm run test:ui
npm run test:mcp
```

The browser suites need a Chromium or Chrome executable. `tests/browser.mjs` picks one in this order:

1. `PLAYWRIGHT_CHROMIUM_PATH` (or `CHROME_PATH`, `CHROMIUM_PATH`) when set. It is used as given and nothing else is tried.
2. The browser Playwright installed for this `playwright-core` version (`npx playwright-core install chromium`).
3. Any browser already in Playwright's cache: `~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` (or `$XDG_CACHE_HOME`) on Linux, or `PLAYWRIGHT_BROWSERS_PATH`. Headless shells first, newest build first.
4. An installed application: on macOS Google Chrome, Chromium or Chrome for Testing in `/Applications` or `~/Applications`; on Linux `google-chrome`, `chromium` or `chromium-browser` in `/usr/bin`, or the Chromium snap.

When none is found the error names the places searched. A cached or installed browser of another version than Playwright expects usually works; if a suite fails only with such a fallback, set `PLAYWRIGHT_CHROMIUM_PATH` or install the matching Chromium. The macOS paths are covered by a test with a simulated file system; they have not been exercised on a Mac in CI, which runs Linux.

Browser tests use the existing production CSP and block outside requests. The UI
suite runs serially to avoid the reproduced local Chrome contention timeouts.
On macOS, use a canonical physical `TMPDIR` (for example `/private/tmp/...`) for
hook tests; do not weaken the private-path/symlink checks. Optional real OTel fixture
coverage requires the existing `SUPATRACE_REAL_OTLP_FILE` path. A skipped external
fixture does not establish provider compatibility.

## Evaluation boundaries

Local tests use synthetic accounts and in-memory storage. They do not establish
hosted invitations, provider capture/import, payment-provider delivery, or
durable erasure. Hosted features require their documented deployment settings
and authorization. See [projects](projects.md), [organizations](organizations.md),
[roles and security](roles-and-security.md), and [retention](retention.md) for the
current service model.

The local private-import page now requires Review, explicit input/output-and-prompt
consent, then a separate Run action. It uses the actual protected Start/mailbox
controller and one synthetic worker; consent revocation denies subsequent Start
and download without deleting saved bytes or replaying the job. Review the consent controls before importing.
