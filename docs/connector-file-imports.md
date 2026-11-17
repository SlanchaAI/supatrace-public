# Explicit provider file imports

These preview tools prepare a **local file → private staging workspace** for an authorized uploader. The upload integration requires deployment-specific hooks; it is not a runnable customer import flow. It does not authenticate to provider APIs or start live capture. Node 22 and Python 3.12 are required. No new npm runtime dependency is needed for conversion/staging.

## Prepare an import

The [first-trace guide](../public/agent-setup.html#file-imports) includes a local command builder for these eight formats. It validates explicit paths, namespace and destination project, shell-quotes each argument, and clears its command when a choice changes. It does not read a file, save settings, run a command or upload. Use the command from a reviewed repository checkout on macOS/Linux; the standalone Python downloads do not include these converters. The builder defaults to metadata and requires a separate content opt-in and explicit JSONL choice.

From this repository, supply one explicit file, its format, a stable source-project namespace, the destination project shown in SupaTrace, and a private job directory:

```sh
node agent/import_traces.mjs ./reviewed-export.json langsmith source-project-name proj_REPLACE_WITH_32_HEX_CHARACTERS ./private-import
```

The default is **metadata only**. It includes source trace/span/parent IDs, exact nanosecond timing, known span kinds, error status and model-call token counts. It omits names, prompts, responses, tools, error messages, user metadata, arbitrary attributes, resource/scope values and source records. IDs and timing can still be sensitive; this is not anonymization. The original input file remains unchanged.

To retain source JSON values, explicitly add `--include-content` for this import. Original fields may include secrets. This opt-in also retains OTLP resource/scope attributes, scope name/version, schema URLs, events and links. Original JSON formatting/object-key order is not retained. Add `--jsonl` only for newline-delimited JSON; encoding is never guessed.

Supported file shapes:

| Format argument | Explicit file shape | Evidence |
| --- | --- | --- |
| `langsmith` | Run arrays/JSONL, `runs`/`items` pages, nested `child_runs` | Pinned Hue parser + synthetic storage/export round trip |
| `braintrust` | Span rows, `events`/`data` pages; standalone log rows require stable `id` | Pinned Hue parser + synthetic storage/export round trip |
| `weave` | Call arrays/JSONL, `calls`/`call` envelopes | Pinned Hue parser + synthetic storage/export round trip |
| `opik` | `{trace, spans}`, span rows/`content` pages | Pinned Hue parser + synthetic storage/export round trip |
| `datadog` | LLM Observability `{data:[{type:"span",attributes:…}]}` exports | Pinned Hue parser + synthetic storage/export round trip |
| `mlflow` | `Trace.to_dict()` / `traces` envelopes, MLflow 2/3 IDs | Pinned Hue parser + synthetic storage/export round trip |
| `helicone` | Request logs/`data` pages, JSON/JSONL; no CSV | Pinned Hue parser + synthetic storage/export round trip; no fabricated parent tree |
| `otlp` | OTLP/HTTP JSON `resourceSpans[].scopeSpans[].spans[]` | Synthetic envelope tests + four real local OpenInference LangChain spans |

Langfuse's existing observations-v2 capture/import path remains available through `agent/import_langfuse.mjs` and `src/importers/private-langfuse-runtime.mjs`. It is a separate format and workflow. Phoenix, Logfire, OpenLIT and other OpenTelemetry producers may supply standards-compatible OTLP JSON, but their native exports, API access and live agents are not established by this result. Unsupported shapes are rejected rather than auto-detected or advertised as supported.

## Inspect, upload and read back

Inspect one explicit staged workspace offline from the repository root:

```sh
python3 agent/private_upload_runtime.py status --directory /absolute/private/import --origin https://supatrace.dev --project proj_REPLACE_WITH_32_HEX_CHARACTERS
```

Use the origin and project you reviewed in SupaTrace. This bounded check takes the existing temporary workspace lock and removes only its own lock afterward. It validates private permissions, stage binding, manifest, pending hashes and any upload journal using the same rules as the uploader. It does not request credentials, contact a server, change receipts, delete pending batches, reconcile ambiguous writes or authorize uploading. An existing active/abandoned lock is refused and preserved; do not delete it to bypass recovery checks.

The JSON summary contains counts only: `awaiting-approved-upload` means local pending batches; `reconciliation-required` means an attempting/unacknowledged batch must not be replayed; `all-uploader-acknowledgments-verified` means every local journal entry contains the expected acknowledgment tuple. Exit zero means the status check succeeded, not that the import completed; inspect the outcome and counts. Local receipts are not independent server evidence and can be altered by their owner. `hosted_readback_verified` remains false even with all acknowledgments. Missing pending files without valid acknowledgments, corrupt state or scope mismatch fail without a partial success summary. Use authorized storage/export readback to establish actual acceptance before clearing a recovery gate.

Successful preparation reports `uploaded:false`. Inspect the private `converted/report.json`, `converted/*.json`, `pending/import-manifest.json` and `stage-receipt.json`. Every accepted span has one stable batch; content-preserving exports retain graph information in `data`, while the current viewer remains flat. Backend export ordering follows batch IDs. Use exact `data.span.startTimeUnixNano` and parent IDs to reconstruct temporal/graph order. Arrays inside original records retain their order. File pagination markers never establish complete provider history.

The workspace is directly compatible with the existing `agent/private_upload_runtime.py::upload_staged_workspace` entrypoint. Its explicit scope uses:

```python
scope = {
    'origin': approved_origin,
    'project_id': receipt['destinationProject'],
    'fingerprint': receipt['fingerprint'],
    'conversion_hash': receipt['conversionHash'],
    'manifest_hash': receipt['manifestHash'],
    'max_batches': receipt['batches'],  # at most 1,000
    'max_requests': 1000,
    'max_total_bytes': 20 * 1024 * 1024,
    'total_timeout_ms': 300000,
}
result = upload_staged_workspace(
    private_directory, scope,
    credential_provider=approved_ephemeral_credential_provider,
    authorize=approved_destination_write_authorizer,
    transport=approved_redirect_refusing_https_transport,
)
```

Those three hooks are real dependencies, not permissive defaults. This change neither creates them nor reads credentials from environment/config/session directories. The existing secure operator runner can supply them; a customer-facing secure broker and runnable import UI remain integration gates. A successful uploader ACK is checked against batch ID, exact request hash and destination project. Authenticated `/api/runs` and paginated `/api/events`, then the existing account export, provide final readback. Do not claim completion from a local stage receipt or an upload attempt.

## Bounds and recovery

Input is at most 20 MiB and 24 nested levels, with at most 10,000 parsed rows/events and **1,000 output batches**, matching the retained private uploader. Converted output is capped at 19 MiB, leaving space below its 20 MiB transport budget; each event must satisfy the existing 32 KiB intake limit. There is no truncation or blob offloading. Malformed input, invalid UTF-8, changing/symlink inputs, unsupported formats, ambiguous versions, invalid timing, cycles or oversized events prevent staging the conversion. Missing parents are retained and reported as warnings for bounded exports.

Exact span duplicates dedupe; changed versions with the same IDs fail closed instead of choosing an unseen history version. Namespace and IDs are stable across overlaps. Content-policy changes retain the same batch identity and must not overwrite history. A workspace binds the exact source file, policy and destination; use the same input to resume. Do not mix jobs or manually edit a manifest. Only a verified stage receipt authorizes consideration by the separately authorized uploader.

Staging and upload share the existing exclusive lock. A stale lock or interrupted `.tmp` write requires reconciliation; there is no automatic takeover. Pending spool writes are fsynced by the existing sender, but the complete Node staging transaction is not a machine-crash durability guarantee. The runtime journals `attempting` before send. Lost ACK, process crash or rate-limit ambiguity remains pending and blocks replay until authenticated reconciliation. Accepted batches are not resent on restart. Export/disk failures are surfaced and do not become completed archives. No unlimited queue, exactly-once or no-loss claim is made.

## Open-source reuse and verification

Seven provider parsers are derived from Hue SDK commit `4ac88431eab76b4e12737c1b279dc58dbed87bf8` (MIT). The vendored LICENSE, source hash pins, generated hashes and exact adaptations are in `src/importers/vendor/hue/`. The offline `scripts/vendor-hue-importers.mjs EXPLICIT_UPSTREAM_DIRECTORY` build verifies source hashes before emitting modules. It requires Node >=22.13; generated modules do not require TypeScript or Hue's backend/dependencies. Helicone retains its source record rather than constructing Hue conversation messages. SupaTrace supplies bounded validation, privacy projection, IDs, grouping, staging and existing storage/export semantics. The component SBOM is `docs/connector-sbom.cdx.json`.

The new local framework proof reuses OpenInference LangChain 0.1.80 at `c8e596ec14b2ac64a5a6a1634c3fad3522172ab9`, LangChain core 0.3.79 and OpenTelemetry API/SDK 1.38.0. Installed OpenInference source blob IDs match the pinned upstream tree. The deterministic capture test uses that instrumentor pin. It does not establish compatibility with every framework version.

`tests/capture_langchain_otel.py OUTPUT.json` runs real instrumented RunnableSequence/tool code with all socket connections blocked, input 1 → output 3, one root and three children. It explicitly opts into synthetic content, then flushes an in-memory test exporter and writes a new fsynced OTLP JSON file. It does not implement a durable live collector. Generic protobuf JSON needs hex ID and integer enum conversion before it is OTLP JSON; the test does this explicitly. No endpoint-URL substitution is presented as an OTLP receiver.

Optional proof dependencies are hash-locked for Python 3.12/macOS arm64 in `tests/connector-proof-macos-arm64.lock`; wheels remain in the local evidence directory, not the application package. Other platforms need separately verified wheels. Run the proof and then:

```sh
SUPATRACE_REAL_OTLP_FILE=./synthetic-capture.json npm run test:connectors
```

Without that variable, the deterministic fixture/API tests still run and the real-capture acceptance test is explicitly skipped. CI does not silently claim fresh framework capture. The retained Python recovery suites cover shared lock/process interruption, ambiguous sends, disk failures and restart behavior. The new round-trip suite adds all supported file formats, original-envelope equality, cross-tenant isolation, accepted replay, lost ACK/rate-limit non-replay and failed export writes.

## Remaining delivery gates

These are local conversion and storage checks. They do not establish a hosted connector integration. A supported secure ephemeral provider/destination broker and private runner are still needed for a customer automatic-import flow. Kitaru historical API fetching, native Phoenix/Logfire conversion, harness hooks (Claude Code/Codex/Cursor/OpenCode), and OpenTelemetry Collector persistent transport remain separate work. The converters do not request provider credentials, fetch hosted data, grant persistent access, or start live capture.
