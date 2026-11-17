# Idle pause for Free projects (#113)

The 30-day window is a proposed default, pending maintainer confirmation. It lives in one place: `IDLE_PAUSE` in `src/plan-limits.mjs`.

## The rule

A project on the Free plan with no accepted upload for 30 days is paused. A paused project refuses new uploads until the workspace owner resumes it. Nothing is deleted by a pause, and the plan's retention period keeps deciding which traces are listed (see `docs/retention.md`). Paid plans (Pro, Team) and commercially managed accounts never pause.

The state is derived from the account row every time it is needed. No scheduler or worker moves a project to "paused", and no new AWS resource is involved. Activity is the latest of:

- `last_accepted_at`, stamped on the account row in the transaction that accepts an upload (a reservation alone is not activity);
- `resumed_at`, stamped by a resume;
- `plan_changed_at`, stamped when a test-mode subscription changes the plan;
- the account's `created_at`;
- `IDLE_PAUSE.introduced_at` (2026-11-14), so accounts that predate the rule are not paused for inactivity before it existed. The earliest possible pause is 2026-12-14.

States: `active`; `pausing_soon` for the last 3 days of the window; `paused` from day 30.

## Where it is enforced and shown

- Reservation (`reserveBatch`): a paused project gets `403 project_paused` with a message, `paused_at` and `resume_url`. Every ingest route (batches, OTLP, Langfuse) reserves through this path. An identical retry of an upload reserved before the pause still gets its reservation.
- `GET /api/usage` returns `lifecycle` (`state`, `pauses_at`, `last_upload_at`, `idle_days`, `warn_days`, `resume_url`), or `{state:"active", pauses_when_idle:false}` on exempt plans.
- `POST /api/billing/resume` with body `{}` resumes. It is owner-only and default-environment-only by the same gate as the other billing actions, and it is idempotent.
- Dashboard: a banner on every view warns during the last 3 days and, when paused, carries a **Resume project** button for the owner. Usage states the rule and the next pause date.
- The agent uploader explains the refusal (`agent/upload.py`).

## Notice

The first upload refused by a pause writes one notification row (`NOTICE#PAUSE#<paused_at>`), once per pause. An email is sent only when the existing SES path is configured (`EMAIL_FROM` and `sendEmail`) and the account signed in with an email address; otherwise the row records `not_configured` or `no_address`. The send is bounded to 3 seconds and never changes the 403.

## What this does not do

- There is no warning email three days before the pause. That needs a scheduled job, which this change does not add; the in-dashboard banner is the advance warning. The notice email goes out when an upload is first refused.
- A project that never uploads again produces no notice at all, because nothing triggers one.
- Pausing does not stop reads, exports or sign-in, and does not free reserved bytes.
