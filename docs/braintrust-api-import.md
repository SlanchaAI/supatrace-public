# Braintrust historical API import

This is an explicit local operator import for **1–25 completed Braintrust trace IDs in one project**, using the US or EU hosted API. It fetches authenticated API pages, checkpoints privately, converts through the shared Braintrust file adapter, and produces the existing private uploader manifest. It does not upload automatically or add a hosted connector, recurring sync, live instrumentation, project discovery, experiment import, or time-window search.

The query builder adapts Kitaru's Apache-2.0 Braintrust importer **0.4.0**, pinned at `82fd53d16f406fff92eb19a68f088dfa68488af3`. [Provenance, source hashes and modification notice](../src/importers/vendor/kitaru/provenance.json), [license](../src/importers/vendor/kitaru/LICENSE), and [SBOM](connector-sbom.cdx.json) travel with the source and packaged runtime. There is no Kitaru SDK/runtime dependency. The existing Hue Braintrust converter retains its separate MIT notice.

## Explicit entrypoints

In the dashboard's **Agents → Import from Braintrust** card, choose the source region, project UUID, completed root span IDs and a stable namespace. The destination is the signed-in SupaTrace project. Metadata is the default; original content requires a separate opt-in. Review the full JSON, check the review acknowledgment, then download `braintrust-import.json` or copy it. This produces the actual local runner spec without sending source scope to a server, requesting credentials or starting an import. Scope edits and account invalidation clear the prepared artifact.

The dashboard and runner share one scope contract: `src/importers/braintrust-scope.mjs`. Run `node scripts/sync-braintrust-scope.mjs` after changing it; a test requires the committed browser copy to match exactly. The dashboard links to the tested importer source and this operator guide. Users still need an existing approved credential bridge; the UI does not create or substitute one.

`runPrivateBraintrustImport(spec, {directory, fetchImpl, credentialProvider, authorize, bounds, signal})` is the application/operator integration. Each source-project verification, trace-page read and destination-stage action passes an authorization descriptor containing the exact scope, content policy, fingerprint and bounds. The caller supplies the action authorization and an existing approved ephemeral credential bridge. The implementation discovers no credentials and creates no grants.

The command-line entrypoint reads a small **non-secret** spec file and an ephemeral JSON credential lease from a pipe:

```text
node agent/import_braintrust.mjs spec.json /absolute/private/workspace --fetch --stage
```

Connect the approved credential bridge's stdout to this command's stdin. Do not put a token in shell arguments, an environment variable, shell history, the spec, or a credential file. The pipe must close after a JSON object containing `origin`, `projectId`, `apiKey`, and numeric `expiresAt` (Unix milliseconds). The lease must be valid now and expire within five minutes. Input is limited to 4 KiB and 30 seconds. The command's flags authorize only the spec's source read and local staging; it prints counts and a local persistence outcome, never the credential or source rows.

Example spec (replace both project IDs and the root ID with the reviewed scope):

```json
{
  "origin": "https://api.braintrust.dev",
  "sourceProject": "12345678-1234-1234-1234-123456789abc",
  "destinationProject": "proj_11111111111111111111111111111111",
  "namespace": "braintrust-reviewed-project",
  "rootSpanIds": ["reviewed-root-span-id"],
  "content": "metadata",
  "pageSize": 100,
  "maxPages": 100,
  "maxRows": 1000,
  "maxBytes": 12582912,
  "maxRetries": 2
}
```

The namespace must be stable and distinct for each source project. It controls deterministic event identity. The workspace is bound to the full plan and destination; a different content policy, root list or limit requires a different workspace. Do not reuse identities with changed source history.

## Privacy and API compatibility

The metadata query requests only IDs, parent IDs, creation time, metrics, span attributes and revision. It does not request input, output, errors, arbitrary user metadata, comments or tags. Metric/attribute objects may contain custom fields in the response; those are filtered **before checkpoint or staging**. Only known numeric timing/token fields and known span/scoring types remain. Error status is unavailable in this projection. Source identifiers, opaque pagination cursors, revisions and timestamps remain sensitive; metadata mode is not anonymization.

Full original rows require both `"content":"include"` and CLI `--include-content`, or an affirmative content-scoped application authorization. Full mode can retain prompts, outputs, errors, tags and other private fields. It uses the same guarded staging/uploader semantics as file imports.

The source project is verified with `GET /v1/project/{id}` before every page. Queries go only to `POST /btql` on the selected allowlisted origin. The derived Kitaru query uses `_pagination_key` ordering and a cursor clause. Braintrust still documents legacy BTQL syntax; current query docs return pagination in `x-bt-cursor`, while the pinned importer reads a body `cursor`. Both are supported, and disagreement is refused. Large responses that redirect to cloud storage are deliberately refused; reduce page size in a new workspace. Authorization is never forwarded to a redirect target. Self-hosted origins are not supported by this slice.

References checked November 5, 2026: [query and pagination](https://docs.braintrust.dev/api-reference/query), [supported syntax](https://www.braintrust.dev/docs/reference/sql), and [pinned project/log schemas](https://github.com/braintrustdata/braintrust-openapi/blob/d6592894a918c7f393b81f91b1196059bd3f8a47/openapi/spec.json).

## Recovery and limits

Pages are validated and checkpointed before the next request. Restart resumes from the last committed cursor; a complete checkpoint requires no further source network calls. Missing roots, unfinished spans, missing parents, changed duplicate rows, cursor cycles, malformed data and exceeded limits prevent staging. Identical duplicates are deduplicated by the shared converter. Root and child rows can arrive in any order. Standalone log rows may use their `created` timestamp without metrics.

Reads are bounded by rows/pages/checkpoint bytes plus wire limits: 30 seconds per operation, five minutes total, 300 requests including project checks, 2 MiB per response and 16 MiB total response bytes. `429` and selected `5xx` statuses have bounded retries and strict `Retry-After` handling. Network errors and ambiguous read timeouts stop the run; an operator can restart the read from its saved checkpoint. Error bodies and raw provider exceptions are not exposed. SIGINT/SIGTERM cancel reads and staging.

The existing exclusive workspace lock and atomic checkpoint/staging protocol are retained. A stale lock or leftover atomic temp file requires reconciliation; neither is silently removed. The local stage receipt says `local-files-verified-no-fsync-guarantee`; this is not a power-loss durability promise. A paginated read of completed traces is not a point-in-time provider snapshot, and later source mutations can still occur.

The final stage uses the unchanged private upload manifest, authentication, quota and ambiguous-acknowledgment rules. Upload remains a separate authorized operation through `agent/private_upload_runtime.py`; inspect the stage receipt and bind the uploader to its fingerprint/conversion/manifest hashes. Never replay an unresolved attempted upload.

## Evidence and remaining acceptance

Deterministic tests use synthetic provider responses with real fetch response streams, private checkpoint files, the unchanged Python uploader, the actual SupaTrace API/storage adapter, and account export. They verify exact original row/parent preservation in content mode, absence of content in metadata mode, accepted restart with zero uploads, rate limits, malformed/oversized inputs, credential scope/echo, cancellation, failed checkpoint writes and stale locks. The suite also retains the separate pinned real OpenInference four-span local capture proof.

The dashboard handoff is also exercised in disposable Chromium at desktop and narrow mobile widths: download the actual form-generated spec, feed it to the importer using synthetic source responses, upload through the retained Python runtime, view the stored trace and download its exact export. Metadata mode and explicit original-content mode are covered. This uses a fresh synthetic browser download, not a user-owned file or the previously denied hosted export.

No real Braintrust credential or customer source was used. On November 5, the available Mac browser reached Braintrust sign-in, no connected Braintrust tool was available, and existing project receipts established fixture exports rather than API access. SLA-41 records the paid startup offer as unredeemed/canceled. No offer, account, credential or grant was activated. Real-provider acceptance requires the approved project-log source UUID, 1–25 completed root span IDs, region, scoped ephemeral credential bridge and destination authorization. Experiment exports alone do not satisfy the project-log scope.

Real-provider response compatibility, hosted upload/readback and hosted handoff acceptance remain gates. This implementation alone does not activate any live connector. The earlier hosted export's saved-file read denial remains in force; no alternate file-read route was used.
