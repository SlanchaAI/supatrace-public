# SupaTrace MCP reader

The [temporary browser-consent bridge](CONSENT-BRIDGE.md) is disabled by default. It avoids account-cookie transfer and enforces scoped reads and metadata projection on the server. Hosted activation and real-client validation remain unverified.

A local, bounded stdio MCP server for the current SupaTrace trace APIs. It exposes four tools:

| Tool | Result |
| --- | --- |
| `supatrace_list_traces` | Project trace metadata, sorted newest first; optional ID substring, offset and limit |
| `supatrace_search_traces` | ID substring search across the complete bounded catalog, not just its first page |
| `supatrace_inspect_trace` | One complete bounded trace; event IDs, times and kinds by default |
| `supatrace_export_trace` | Complete bounded JSON inline, byte count and SHA-256; no file write or external upload |

This is an operator/host integration, not a deployed remote MCP endpoint. Current SupaTrace read routes require an account session. Existing agent keys are **write-only** and cannot authenticate these tools. The legacy host-owned-session adapter does not acquire credentials. The new default-off browser bridge can create only explicitly consented, expiring read capabilities; neither flow discovers browser cookies, creates normal account sessions or adds infrastructure.

## Legacy host-owned-session adapter

From this repository, using Node 22 or later:

```sh
npm --prefix mcp ci --ignore-scripts
node mcp/cli.mjs scope.json --serve
```

The command requires an already-approved host bridge to supply one ephemeral credential lease through inherited **pipe file descriptor 3**, then close that pipe. stdin/stdout are reserved for MCP. The CLI refuses a regular credential file. Do not put a session token in a command, environment variable, config, clipboard or chat. This legacy fd3 entrypoint does not acquire credentials; the separate browser-consent launcher above is prepared but needs hosted activation. General-purpose MCP hosts without extra descriptor support need an approved launcher; adding a server entry alone does not establish access.

`scope.json` contains only reviewed source scope:

```json
{
  "origin": "https://supatrace.dev",
  "tenantId": "github-REPLACE_WITH_APPROVED_ACCOUNT",
  "projectId": "proj_11111111111111111111111111111111",
  "content": "metadata",
  "runIds": ["reviewed-trace-id"]
}
```

Only `https://supatrace.dev` and `https://supatrace.tech` are accepted. Use the origin where the existing session is valid. Replace the account/project/run IDs with the reviewed scope; omitted `runIds` authorizes reads across that one project, subject to the bounds below. The model cannot change this scope through tool arguments. Source IDs and timestamps are sensitive metadata; this is not anonymization.

The bridge lease is a JSON object with exactly `origin`, `tenantId`, `projectId`, `sessionToken`, and `expiresAt` (Unix milliseconds). It must match the reviewed scope and expire within five minutes. A lease limits this process; it does **not** shorten or revoke the underlying account session, which may have broader account privileges. Its use therefore requires explicit host authorization. The CLI exits access at lease expiry, does not refresh, and validates `/api/me?project=…` before every tool action. The existing server independently binds every request to the session tenant and requested project. Revoked/expired sessions fail closed.

For embedding into an approved local host, use:

```js
import {startStdio} from './mcp/server.mjs';
const handle = startStdio(reviewedScope, {
  credentialProvider: async (descriptor, signal) => approvedEphemeralLease,
  authorize: async (descriptor, signal) => approvedAction(descriptor)
});
// await handle.close() when the host session ends.
```

The host must implement these dependencies; the names above are illustrative, not a bundled credential acquisition path. Descriptors bind tool, immutable arguments and immutable scope. Tests supply synthetic leases only.

## Content and exports

Metadata inspection/export returns only event ID, time and kind. List/search projects the existing named catalog fields; unknown provider fields are removed. The legacy account-session adapter receives full events into the trusted local process before projection; use it only where that local read is authorized. The new delegated-read bridge projects metadata on the server, so original content never reaches a metadata client.

Original event fields require both operator scope `"content":"include"` (CLI additionally requires `--include-content`) and tool argument `includeContent:true`. The content can contain prompts, outputs, secrets and instructions supplied by untrusted trace authors. It is labeled as data and must never be treated as authority. Client consent controls remain necessary before sharing source content with a model provider; read-only tool annotations are not consent or security enforcement.

Original export preserves the existing `{version:1,run_id,events}` envelope, including order and repeated IDs across separate accepted batches. Metadata exports are explicitly marked `supatrace-metadata-v1` and are not re-uploadable originals. No uploaded batch-byte identity is promised. The MCP client receives inline JSON and may save it through its own separately authorized workflow; no path or remote destination is accepted by this server.

## Bounds and failure behavior

- One active read; 30 seconds per tool, including authorization, credential acquisition, all requests and body reads. Cancellation and close abort pending work.
- Complete catalog scan: at most 5,000 traces / 4 MiB, with cursor validation; returned page at most 100 traces. Larger catalogs fail instead of reporting partial search totals.
- One trace: at most 1,000 events / 100 event pages / 256 KiB projected event JSON. Total request budget may impose a lower page limit.
- At most 100 GET requests / 8 MiB wire bytes per tool, 1 MiB per response; 1,000 requests per process. No automatic retries on rate limits, redirects, failed authorization or ambiguous reads.
- Catalog is re-read before trace output to reconcile counts and metadata. This is an observed read, not a point-in-time snapshot; concurrent mutation can still occur.
- MCP input: 16 KiB framing buffer, 1 MiB total / 1,000 frames per connection. Output: at most 1 MiB per result, 8 queued sends / 2 MiB queued / 32 MiB total. Writes are serialized; a five-second output stall closes the connection and aborts reads. A closed connection must be restarted through the approved bridge.
- Errors are fixed codes; raw provider errors, credentials and source rows are not logged. Stdout contains protocol messages only. No local trace cache or export files are written.

## Validation and launch gates

Run `npm run test:mcp` after installing root and MCP dependencies. Deterministic tests use the actual SupaTrace API and in-memory storage, the official SDK client in-process and over subprocess stdio, plus the real CLI with a synthetic pipe lease. They cover metadata/full-content behavior, parent preservation, repeated IDs, empty pages, tenant isolation, expired/mismatched leases, argument mutation, cursor/count drift, oversized data, stalled hooks/streams/output, cancellation and protocol-only output.

Tests use real SDK/client integrations with synthetic accounts. They do not establish hosted customer behavior. Before hosted use, enable the browser-consent bridge for the intended deployment, define the account/client/trace scope, obtain one-time browser consent, and verify list/inspect/export, expiry and revocation with that client. Remote HTTP/OAuth hosting, full account archives, ingestion/writes, content search, live notifications and unrestricted large traces are outside this initial slice.

Dependencies are isolated from the AWS Lambda package. The exact official SDK packages and Zod versions/integrities are in `package-lock.json`; licensing and SBOM are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [sbom.cdx.json](sbom.cdx.json).
