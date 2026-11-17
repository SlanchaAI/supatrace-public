# Per-plan retention

Retention days are a plan property. They come from the approved plan table
(`PLANS` in `src/plans.mjs`, read through `src/plan-limits.mjs`): Free 7
days, Base 30, Pro 90, Enterprise 365, with Enterprise custom retention.

## What the code does

- **Stamped at accept time.** `acceptReservedBatch` writes `retention_days` and
  `retention_expires_at` (accept time plus the plan's retention) on the batch marker,
  and on the batch index row. The run row holds the newest expiry across its batches,
  so a run stays listed while any of its data is retained. A run that holds any batch
  without a stamp (stored before this change, or accepted for a commercially enrolled
  account) has no expiry, even when stamped batches are appended.
- **The plan at accept time decides.** A later upgrade or downgrade does not rewrite
  data that is already stored.
- **Honored on list, read and export.** `listRuns`, `listAcceptedBatchIndexes` and
  `getRun` skip rows past their expiry. Every trace list, trace page, the MCP bridge
  and the browser exports read through those three methods, so expired data is not
  listed, opened or exported.
- **Shown in the product.** `GET /api/usage` returns `retention` and
  `plan_limits.retention_days`. The Usage view has a Data retention card. Each run in
  `/api/runs` and `/api/runs/page` carries `expires_at`, and the trace list marks runs
  in their last seven days.

## Account and organization deletion

Account closure requires a recent browser session and typing DELETE. Owned organizations
must be transferred or deleted first. Closure atomically ends sessions, blocks keys
and personal access tokens, and queues erasure. Closed identities cannot reopen.
Organization deletion queues the same worker. The five-minute EventBridge rule calls
the API Lambda; jobs wait ten minutes for in-flight requests to finish. Each invocation
is bounded and persists progress for retry. TEST subscriptions are cancelled first;
legacy billing requires operator closure and live-mode customers are refused.

The worker removes every payload version and delete marker in the account’s default,
active and retired environment prefixes, then removes owned metadata and identity
indexes. It releases reserved bytes and account capacity atomically with completion.
A minimal non-login identity tombstone remains; no profile, credential or trace data
remains on that row. Recovery backups expire within 35 days. Test metadata and object restores before enabling physical erasure.

## Physical retention worker

The existing five-minute EventBridge account-erasure schedule also calls the retention worker in the API Lambda. `RETENTION_ERASURE_MODE=execute` is enabled on supatrace.dev; the template default remains `dry_run` and deploys preserve the operator value. The worker scans expired batch indexes in bounded pages, removes every S3 object version and delete marker, and transactionally removes the batch index while releasing workspace and service stored-byte counters exactly once. A minimal accepted-batch tombstone prevents concurrent workers from recreating erased accounting state. Monthly span usage is not reduced by expiry.

On November 15, production dry-run found one synthetic 739-byte expired batch. Execute removed all payload versions, its index and empty run. A repeated scheduled call processed zero batches and left both byte counters unchanged; a retained sibling remained readable in API and UI. Metadata and object restore proof preceded enablement.

## Boundaries

- Rows accepted before retention stamping have no automatic expiry. A later plan change does not rewrite existing timestamps.
- Commercially enrolled accounts outside the plan table receive no stamp.
- Project, environment, organization and account deletion are self-service and use the separate erasure queue described above. Individual trace deletion has no customer control.
- Expiry hides data immediately; bounded scheduled deletion can lag while pending work drains. Recovery backups expire within 35 days.
