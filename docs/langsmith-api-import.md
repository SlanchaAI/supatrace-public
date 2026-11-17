# LangSmith historical API import

This local operator importer reads **completed runs belonging to 1–25 explicitly selected trace IDs and a time window in one LangSmith workspace/project**, on the GCP US or EU API. It follows the current `/api/v2/runs/query` cursor contract, validates ancestry among the returned runs, checkpoints privately and stages the existing private uploader manifest. The Agents dashboard can prepare the spec for the local command; applications can also call the importer directly. Recurring sync, arbitrary project discovery and live capture are separate work.

The implementation reuses Kitaru's completed-root check and per-trace fetch approach, the existing Hue LangSmith converter, and SupaTrace's guarded transport/private workspace/uploader pattern. Kitaru's pinned `list_runs` call targets the legacy API; it is **not** used unchanged. The current v2 request and response contract was independently checked against LangSmith JavaScript **0.11.8**, commit `c888239c8e790b2a48727def5b11533b1cf7280f`. There is no new SDK/runtime dependency. See [source pins and modifications](../src/importers/vendor/kitaru/langsmith-provenance.json), [Apache license](../src/importers/vendor/kitaru/LICENSE), the converter's [MIT notice](../src/importers/vendor/hue/LICENSE), and [SBOM](connector-sbom.cdx.json).

## Prepare a scope in the dashboard

In **Agents → Import from LangSmith**, select GCP US or EU and enter the source workspace/project UUIDs, 1–25 completed trace UUIDs, a stable namespace and both UTC time bounds. Enter explicit timestamps ending in `Z`; browser timezone does not change them. The destination is the signed-in SupaTrace project and cannot be edited. Metadata is the default; retaining original returned content requires the separate content choice.

Choose **Review LangSmith scope**, inspect the full JSON and coverage limit, then confirm review to enable Download import spec or Copy spec. Any form edit, account invalidation, sign-out or page suspension discards the prepared spec. Source IDs remain private data even though the file contains no credential. The form makes no provider/job request and persists nothing to browser storage.

The browser validator is generated from the runtime's pure contract by `node scripts/sync-langsmith-scope.mjs`; a test requires exact equality. Existing runtime fingerprints and checkpoint semantics are unchanged. Both form and runner reject invalid or reversed UTC windows, more than 401 days, duplicate/malformed IDs and out-of-range limits.

The downloaded file is a usable input to the runner below, not an access grant or background import. The UI links to pinned importer code and this credential/recovery guide. The approved source credential bridge and separate destination upload authorization are still required. It never asks for an API key in the browser. Two local Chromium journeys at desktop/320px exercise an actual spec download, synthetic paginated source, private staging/uploader, SupaTrace storage and saved export. These tests use disposable local accounts/files; real LangSmith permissions, authoritative source membership and hosted readback remain unverified.

## Run an explicit import

Prepare a non-secret spec with the reviewed scope:

```json
{
  "origin": "https://api.smith.langchain.com",
  "sourceWorkspace": "12345678-1234-1234-1234-123456789def",
  "sourceProject": "12345678-1234-1234-1234-123456789abc",
  "traceIds": ["10000000-0000-0000-0000-000000000001"],
  "minStartTime": "2026-11-04T00:00:00Z",
  "maxStartTime": "2026-11-05T00:00:00Z",
  "destinationProject": "proj_11111111111111111111111111111111",
  "namespace": "langsmith-reviewed-project",
  "content": "metadata",
  "pageSize": 100,
  "maxPages": 100,
  "maxRows": 1000,
  "maxBytes": 12582912,
  "maxRetries": 2
}
```

IDs above are examples, not configured access. Use a stable namespace distinct for each source project and region. Both UTC time bounds are mandatory, at most 401 days apart. Every returned run must start at/after the lower bound and finish strictly before the upper bound; the requested root must be present. Only completed `SUCCESS`/`ERROR` runs with valid returned ancestor chains can stage. An empty or inaccessible selected trace fails instead of silently importing fewer traces.

The API filters each run's start time, so a descendant outside the window can be omitted even when its root is returned and completed. Root timing does not prove whole-trace membership. The checkpoint's `complete` means selected pagination ended; the conversion report, runtime result and CLI receipt explicitly say `traceMembershipVerified:false`. Reconcile against an authoritative source run inventory before claiming a whole-trace import. The importer neither silently broadens the approved time window nor claims that pagination proves membership.

```text
node agent/import_langsmith.mjs spec.json /absolute/private/workspace --fetch --stage
```

Pipe an **existing approved credential bridge** into stdin. The bridge must supply one JSON lease with `origin`, `workspaceId`, `projectId`, `apiKey`, and numeric `expiresAt` (Unix milliseconds), then close the pipe. The lease is limited to five minutes, 4 KiB and a 30-second input wait. It is a local handling deadline; this importer does not issue, revoke or shorten the provider key itself. Do not put credentials in the spec, arguments, environment, credential files or chat. This work neither discovers credentials nor creates grants. The command requires both action flags, prints counts only, and performs no upload.

Applications can call `runPrivateLangsmithImport(spec, {directory, fetchImpl, credentialProvider, authorize, bounds, signal})`. Source verification, each page and staging need affirmative authorization of the exact fingerprint, region, workspace/project, selected traces, time window, destination and content policy. The fetch and credential dependencies are explicit; the production caller must supply the approved bridge, not a test stub.

## Content and API behavior

Metadata is the default. Requests select IDs, ancestor IDs, run type/status, timestamps and own-run token fields. A strict projection strips unexpected names, prompts, errors, tags, arbitrary attributes and custom token-detail fields **before checkpoints touch disk**. Identifiers, cursors and timing are still sensitive; this is not anonymization.

Retaining content requires `"content":"include"` and `--include-content`, or explicit application consent. It adds names, input/output, errors, extra/metadata, ordered events, tags, dotted order, thread/example IDs and manifest. Returned selected rows are retained exactly by the converter. It does not request or download attachments, signed URLs, feedback, costs or every provider field. Existing 32 KiB per-event intake limits apply; oversized content fails the whole stage, while a new metadata-only scope may fit.

Before every page, `GET /api/v1/sessions/{project}` verifies both `id` and `tenant_id`. Both requests use `x-api-key` and the explicit `x-tenant-id`. Redirects and non-allowlisted/custom hosts are refused. V2 queries set `include_subtree_usage:false`, uppercase selects, explicit bounds and one trace ID; `items`/`next_cursor` drives pagination. Parent IDs are the ordered root-to-direct-parent array. The existing converter derives direct parents and nanosecond times without changing source records. Only LLM runs contribute normalized usage, preventing parent aggregates from double counting.

References checked November 5, 2026: [query documentation](https://docs.langchain.com/langsmith/export-traces), [v2 migration and response fields](https://docs.langchain.com/langsmith/smithdb-sdk-migration-query-runs), [region/workspace settings](https://docs.langchain.com/langsmith/create-account-api-key), and the pinned SDK contract linked in provenance. Other regions and self-hosted deployments are outside this increment.

## Recovery and limits

The runtime checkpoints before requesting the next page, with scope/hash validation on resume. Checkpoints with finished pagination can restage without source requests. Identical duplicates deduplicate; changed duplicates, missing roots/ancestors, inconsistent returned trees, malformed data, cursor cycles and partial limits prevent staging. Roots and children may arrive in any order. A provider query is not a point-in-time snapshot; later writes or edits remain possible.

Wire bounds are 30 seconds per operation, five minutes total, 300 requests including source verification, 2 MiB per response and 16 MiB total. Row/page/checkpoint limits also apply. Bounded retries handle `429` and selected `5xx`, with strict `Retry-After`. Timeouts, cancellation or a failed checkpoint stop pagination. Public errors never include provider bodies or raw exceptions. SIGINT/SIGTERM cancel pending work. A stale workspace lock or interrupted atomic temporary file requires reconciliation; neither is silently cleared. The local receipt explicitly provides no fsync/power-loss durability guarantee.

Upload remains a separately authorized operation through `agent/private_upload_runtime.py`, bound to the stage receipt's destination, fingerprint, conversion and manifest hashes. Existing authentication, quotas and ambiguous-acknowledgment fencing are unchanged. Never replay an unresolved attempted upload.

## Acceptance boundary

Deterministic tests exercise synthetic v2 pages, real response streams and private disk checkpoints, then the existing Python uploader, actual local SupaTrace API/storage and account export. They verify metadata privacy, original selected-row equality, ancestry/timing/usage, paging/resume, duplicates, limits, retry/error/cancellation and interrupted writes. This is source/local acceptance, not real LangSmith or hosted acceptance.

Remaining gates: an approved source region/workspace/project, explicit completed trace IDs/window, an existing scoped temporary credential bridge, reviewed content policy and authorized destination upload/readback. Verify actual provider behavior and source-to-hosted-export reconciliation before calling the connector delivered. No source credentials, hosted activation, deployment or new persistent grants were created by this implementation.
