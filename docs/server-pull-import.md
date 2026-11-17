# Bounded in-app Langfuse pull (local review candidate)

This opt-in implementation uses the existing API Lambda and storage. It does not
install the private-host architecture, create a worker, create/read saved provider
credentials, deploy infrastructure, or enable production by itself. The old
private-host paths and tests remain intact.

## Journey

1. In Agents, plan a specific Langfuse project, trace, environment and UTC window.
2. Request exact server review. Confirm the disclosed source/destination, fields,
   prompts/input/output and expiry. Review saves a bounded job proposal but never
   contacts Langfuse. Confirmation separately authorizes reading and storing that
   content, including a policy-sanitized durable checkpoint in protected metadata storage.
3. Enter the project's Langfuse public and secret read-key values once, then Start.
   Start creates or resumes that exact durable operation. While this page is visible,
   the client sequences bounded requests, each reading one page or advancing one
   storage phase. No single request runs the complete long job.
4. Credentials stay only in the active flow's memory and its in-flight HTTP requests.
   Inputs clear immediately on Start. Credentials clear when source capture finishes,
   on any error, Pause, hiding/leaving the page, scope/account change or consent expiry.
   No localStorage, sessionStorage, cookie, URL, credential broker or saved-secret
   record is used. Normal JS/HTTP memory is ephemeral, not a secure-erasure guarantee.
5. The page reports durable progress and stops at stored-byte readback, an explicit
   empty/no-matching-observations result, or a bounded failure. Empty results do not
   claim a run, destination batch, object or stored-byte verification. Source
   completeness and export are explicitly not certified.

Pause stops subsequent requests and aborts an in-flight request without claiming its
server-side effect was undone. After interruption, check durable status and explicitly
Resume; re-enter keys only if source capture is unfinished. For reload recovery, remain
in the original physical sign-in session, reconstruct exactly the same plan, review/
confirm and check durable status. Merely returning to the page never auto-resumes.

Successful steps are paced at least 1.5 seconds apart (at most 40 scheduled API
requests/minute, leaving room below the existing 60/minute limiter). There are at most
512 steps per active UI flow, above this scope's 10-page/100-batch maximum needs.
There is no background worker, hidden-tab execution, automatic retry of errors or
uncertain effects, or automatic polling while paused. An error stops the sequence,
clears keys and requires an explicit status check before Resume becomes available.

## Composition and production prerequisites

`composeServerPullController` requires real metadata methods, immutable object
storage and an explicitly allowlisted application origin. The handler reads a
separate, nonsecret `SERVER_PULL_CONFIG` with exactly:

    {"mode":"bounded-server-pull-v1","origin":"https://supatrace.dev"}

Missing, malformed or legacy private-host configuration cannot enable this path.
This candidate does not modify CloudFormation, environment values, IAM, secrets or
any deployed resource. An authorized release must separately arrange and verify
this explicit configuration on the intended application origin. It must also verify
provider API read entitlement, a current authorized project/trace/window, current
least-privilege credentials supplied by the user, source-data approval, quota and
existing table/object access. Revoked historical credentials are not usable evidence.
No test here calls a real provider, AWS or hosted import endpoint.

## Limits and persistence

- Existing 15-second API Lambda, reserved concurrency 1; no increased budget assumed.
- Advance admits new work only inside a 9-second request window. Metadata/object
  awaits are capped at 500 ms; provider transport has a 3.5-second total and 1-second
  wire timeout, at most two requests (project verification plus one observation page).
  Session validation retains the existing bounded authenticator. No unbounded loop
  or retry sleep is introduced. These are conservative software limits, not a measured
  production latency guarantee. SDK operations can finish after a local await times out.
- At most 100 observations, 10 pages, 50 rows/page, 128 KiB source JSON and zero retries.
  Page bounds are source bounds, not a declaration that the trace is complete.
- At most 32 durable proposals per tenant, including terminal/revoked proposals.
  Sanitized source checkpoints are embedded in the protected journal, with an integrity hash
  and a 192 KiB maximum serialized record. This auxiliary metadata is not included
  in the batch-byte quota. There is no automatic cleanup, expiry deletion or capacity
  reclamation; expired consent does not delete its content or audit history.
- Existing destination reservation, commercial quota, deterministic conversion,
  immutable content-addressed storage, acceptance ordering and trace indexing are reused.
- Consent lasts one hour and is bound to its original physical session. Re-review
  does not renew it. Expired/revoked/session-changed operations cannot resume writes.
  Recovery across sign-out or beyond expiry needs a separately reviewed recovery
  feature; inventing new consent or replaying the old operation is not supported.

## Interruption and concurrency

Each journal mutation checks the session/account and previous version atomically.
An advance claims a 30-second durable lease. Concurrent advances cannot run the same
operation. Duplicate Start returns the same fingerprint-bound job; input changes
cannot overwrite its plan. Destination metadata transactions additionally check the
exact current journal version and consent expiry. Global session revocation is checked
atomically by merging the captured tenant `session_epoch` into the existing tenant
META quota/acceptance-sequence update. No second DynamoDB action targets that item.

Reservation, object write and ACK each have a durable consumed marker written before
the effect. If a response is lost, the lease is retained. After 30 seconds, explicit Resume
reads the consumed phase and reconciles the destination receipt/bytes, without
repeating that effect. If there is no conclusive receipt, it remains blocked for
manual investigation. An operation that was marked consumed but never actually
issued may therefore remain blocked; availability is deliberately traded for no
uncertain-write replay. Check status before explicitly resuming an interrupted browser action.
An in-flight object write cannot be atomically cancelled with a consent revocation;
revocation prevents subsequent checkpoint/ACK transitions and further steps, while
already-started writes may finish. Revocation does not delete data or revoke keys.

## Verification

New backend tests use injected synthetic fetch/storage through the actual API
composition. They cover plan/consent enforcement, page/row/byte/cursor bounds,
credential echoes, checkpoint reload, concurrent Start/advance, session changes,
revocation, interruption, unknown reservation/object/ACK outcomes, no replay and
stored-byte mismatch. UI module tests use the actual API and exercise resume,
one-click multi-page progress, repeated clicks, Pause, late replies, hidden-page and
scope/account changes, expiry, explicit recovery and key clearing. Defensive race tests
change the global session epoch immediately before destination transactions for both
zero and nonzero original epochs; reservation and ACK must commit nothing.

Real Agents browser tests at desktop/mobile widths are registered in `test:ui`.
They need a working Chromium executor; a written test is not a browser-pass receipt.
The review handoff records actual passed, failed and unavailable checks separately.

## Sanitization policy and checkpoint migration

In-app pull now requires `langfuse-structured-v1`. The policy and its disclosure
are included in the plan fingerprint and exact consent. `/api/imports/plan`
keeps the legacy/private-host plan contract. The Agents UI selects the separate
`/api/imports/pull/plan` endpoint when server pull is enabled. The server rejects
an unsanitized fingerprint at pull review; clients cannot select a raw policy.

Before a provider row can enter a checkpoint, its original project, environment,
exact trace and start-time window are validated. The sanitizer then removes
`projectId`, `userId`, `sessionId` (including empty values), `experiment_run_name`,
`scope.attributes.public_key` and `resourceAttributes.service.instance.id`.
Nested and dotted-key forms are covered, including corresponding OTEL attribute
key/value entries. Unneeded page-envelope metadata is discarded.

Top-level observation IDs, trace IDs and structured observation/parent/span,
dataset and dataset-item references are replaced with deterministic,
domain-separated SHA-256 pseudonyms. Parent links and overlap IDs remain stable
for the same source/destination/namespace and policy. No raw ID map is stored.
These unkeyed pseudonyms are not anonymization. Nested arbitrary business `id`
fields, input/output, prompts and other unlisted content remain unchanged and
may contain identifying text. This is structural redaction, not a general secret
or PII scanner; source-content review and scoped data-sharing approval are still
required. The private consent plan intentionally retains the source identifiers
needed to authorize future reads. Opaque cursors remain private resume control
data and are not emitted as observation events. Do not share the private plan or
checkpoint as an anonymous artifact.

The checkpoint uses schema version 2, the explicit policy ID, the new scope
fingerprint and cumulative raw-response byte count. Raw scope validation happens
before redaction. Every load/write revalidates sanitized row shapes, IDs, exact
trace pseudonym, environment, time window, cursor sequence and bounds. Raw byte
limits continue to apply even when redaction shrinks a page. Destination batches
are rebuilt only from this validated sanitized checkpoint, including after a
process reload. Displayed run IDs match the pseudonymized conversion.

Schema-v1/unknown-policy checkpoints and old consent are rejected, not silently
upgraded or replayed. Existing data is not automatically removed or rewritten.
An operator must review any historical raw checkpoint separately and create a
fresh policy-bound plan; previous stored objects/consent do not prove sanitized
acceptance. This changes import IDs relative to the raw path and is not a
cross-policy deduplication or historical cleanup migration.

The active credential-echo guard still runs **before** sanitization. If any
response contains the currently supplied public or secret read key, even in a
field this policy would remove, capture fails closed with no source checkpoint.
The fix does not relax credential protections or establish provider compatibility
for a key that is echoed by that source.

`tests/fixtures/langfuse-sanitization-f01.json` contains four synthetic observations.
Tests inject dummy prohibited values, not private raw IDs or credentials. They
cover pre-persistence removal, four observations/one trace/three parent links,
interruption/resume, raw-byte bounds, legacy rejection, source drift, active-key
echo rejection, actual journal/object boundaries and displayed run identity.
