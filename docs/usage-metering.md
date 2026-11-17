# Usage metering

SupaTrace counts usage per account per UTC calendar month and can report it to a
Stripe Billing Meter. This document describes the older sandbox reporter, which
accepts only test keys and has no deployed trigger or schedule. Hosted Base and
Pro subscriptions use live Stripe billing; Pro cap-off overage uses the mode-aware
reporter described in [plan billing](plan-billing.md).

## What is counted

One row per account per month, `TENANT#<account>` / `USAGE#YYYY-MM`, holds two sets
of counters.

**Reserved** (`spans`, `bytes`, `batches`), written by `reserveBatch` in the same
transaction as the batch marker. These are what the plan allowance checks. They
include uploads that are still pending and uploads that never finished.

**Accepted** (`accepted_spans`, `accepted_bytes`, `accepted_batches`), written by
`acceptReservedBatch` in the same transaction that flips the batch marker from pending
to accepted, into the month the batch was reserved in. These count stored batches
only. The Stripe meter reports accepted spans.

A span is one trace event. Replaying a batch finds the existing marker, so neither set
counts it twice. Stored bytes are the account's cumulative reserved total
(`used_bytes`); they are not a monthly figure.

"Account" is the workspace owner. Every environment of a workspace shares one row.

## `GET /api/usage`

`meters` holds the current month, up to eleven earlier months and the state of the
Stripe test meter for the current month:

```json
{"unit":"span","span_definition":"one_trace_event","period_kind":"calendar_month_utc",
 "current":{"period":"2026-11","reserved_spans":1200,"accepted_spans":1180,"reserved_bytes":480000,
            "accepted_bytes":472000,"accepted_batches":39,"stored_bytes":910000},
 "history":[{"period":"2026-10","reserved_spans":88000,"accepted_spans":88000,"reserved_bytes":31000000,
             "accepted_bytes":31000000,"accepted_batches":2100}],
 "stripe_test_meter":{"status":"not_reported","reported_spans":0}}
```

`monthly.spans_used` and `current.reserved_spans` are the same number, read once.
The Usage view lists accepted spans for the last three earlier months under "Spans
this month".

## Stripe test-mode reporter

`src/stripe-usage-meter.mjs` follows the existing stream-worker pattern
(`src/stripe-worker.mjs`): one KEYS_ONLY DynamoDB Streams record per invocation and a
partial-batch failure response. It listens to the metadata table, acts only on monthly
usage rows and acknowledges every other key. Entry point:
`aws/stripe-usage-meter-worker.mjs`.

For a usage row it sends one meter event carrying the spans not yet reported
(`value` = accepted spans minus reported spans) for the account's bound test Customer.

- **Test keys only.** The Stripe client comes from the sandbox runtime loader, which
  accepts a restricted test key (`rk_test_`) and refuses everything else, including
  `sk_live_` and `rk_live_`. The reporter also requires `livemode: false` on the
  runtime, the Customer binding and Stripe's response.
- **Idempotent within Stripe's window.** The identifier and value are stored
  (`METER#YYYY-MM` row) before Stripe is called and cleared after. A crash in between
  resends the same identifier, which Stripe deduplicates. Stripe only promises that
  for a rolling window of at least 24 hours, so a stored intent is resent for 12 hours
  at most. The identifier is derived from the report's sequence number, never from time.
- **Never guesses.** If a stored intent is older than 12 hours, if Stripe refuses a
  resent identifier, or if its response does not match, the month is held
  (`status: "held"`) and nothing more is sent for it until an operator reconciles
  against Stripe's meter. A held month can under-report. Double-reporting would need
  Stripe to drop an identifier inside its own documented window.
- Accounts with no bound test Customer are skipped.

Two limits to know before relying on it:

- The period is the UTC calendar month. A Stripe subscription has its own billing
  anchor; aligning them is part of activation.
- Only spans are reported. Stored bytes are counted and returned by the API but not
  sent to Stripe.

## Local proof

`scripts/local-billing.mjs` wires the reporter into the local harness with the real
Stripe SDK and an in-process transport that refuses any network call. `reportUsage`
drives the worker with a synthetic stream record. `tests/usage-metering.test.mjs` uses
it to show meter total = accepted spans, that a reservation whose upload never
finished is not reported, and that replays and retries add nothing.

## Operator actions to run it in AWS (not done)

1. Create a Billing Meter in the Stripe **test** account (sum aggregation, customer
   mapping on `stripe_customer_id`, value key `value`). Its event name goes in
   `eventName`.
2. Enable a KEYS_ONLY stream on the metadata table and add a function for
   `aws/stripe-usage-meter-worker.mjs` with batch size 1, partial batch responses and
   an event filter on sort keys beginning `USAGE#`. Both are template changes.
3. Give it `BILLING_METER_WORKER_CONFIG` (`enabled`, `streamArn`, `merchantId`,
   `environmentId`, `eventName`, `approvalRef`) and a worker
   `BILLING_WORKER_SANDBOX_CONFIG` whose `authorizedActions` include `usage.report`.
   The restricted test key needs write access to meter events only.
4. Live billing requires maintainer approval and needs its own reviewed path. This code refuses
   live keys by design.
