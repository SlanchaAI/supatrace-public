# Temporary browser consent bridge

This optional bridge serves the existing stdio MCP reader. Hosted activation and real-account validation are **not verified**. The bridge is off unless the backend explicitly receives `MCP_BRIDGE_ENABLED=true`. The existing AWS template exposes `McpBridgeEnabled`, default `false`, mapped to that environment flag. This parameter/env mapping is the only template change; no new resource, IAM, secret, CSP or header policy is added. Normal release parameter generation uses `false` for a newly introduced parameter and preserves a previously reviewed value. The existing manual Deploy workflow now exposes `mcp_bridge_enabled` choices `preserve` (default), `true`, and `false`; a push always preserves the current/default setting. Activation still requires an explicitly reviewed `true` choice for the exact release. See [deployment validation](#deployment-validation).

## Client flow

Install the pinned MCP dependencies with `npm --prefix mcp ci --ignore-scripts` and use Node 22. Supply a non-secret scope file:

```json
{
  "origin": "https://supatrace.dev",
  "tenantId": "REPLACE_WITH_INTENDED_ACCOUNT_ID",
  "projectId": "proj_REPLACE_WITH_32_HEX_CHARACTERS",
  "content": "metadata",
  "runIds": ["REPLACE_WITH_REVIEWED_TRACE_ID"]
}
```

This bridge requires **1–20 explicit trace IDs**. The project must belong to the exact account; origin is one of the two existing SupaTrace domains. A client launch command is:

```sh
node mcp/connect.mjs ./scope.json --client "Name of my actual MCP app"
```

Configure that command/arguments in the intended stdio host. The host must display its server's stderr approval link. Protocol initialization/tool discovery can complete while consent is pending; trace calls are refused until approval. If the client hides stderr, this launcher is not a finished onboarding solution for that client.

The process generates a random capability in memory, registers only its hash and prints a **non-secret approval URL/code** on stderr. The browser page at `/mcp/` uses the existing HttpOnly login without exposing or transferring its account cookie. The person reviews the code, self-reported client label, exact origin/account/project/trace IDs, content policy and expiration, then explicitly approves. The consent hash and unique request generation bind the approval to the displayed scope. A stale page cannot approve a replacement scope. The client label is not authenticated identity: the person must verify the actual host/model destination.

Metadata is the default and is projected **on the server**: trace IDs, timing, status, counters and agent identifiers, plus event IDs, time and kind. Original names, prompts, responses, tools and arbitrary data never reach a metadata reader. For original content, the scope must say `include`, the launch command must add `--include-content`, the browser requires a second unchecked content confirmation, and each inspect/export tool call must request `includeContent:true`. Original trace data can contain secrets and is untrusted input, never instructions.

A distinct `__Host-supatrace-mcp` capability authenticates only `/api/mcp/read/me`, `/api/mcp/read/runs/page` and `/api/mcp/read/events`. It cannot sign in to ordinary account APIs, upload, approve other grants, change billing or manage the account. Trace list/search covers only the explicitly granted set. Existing MCP per-tool request/byte/event limits and observed-read reconciliation still apply. This is a local stdio server, not an Internet-facing MCP HTTP/OAuth service.

## Lifetime and revocation

Requests expire at most five minutes after registration, capped by the approving parent session's expiry. There is no refresh, silent renewal or normal account `SESSION` creation. Temporary hash/scope rows use fixed 1,000-slot request/code namespaces in the existing metadata table; expired rows may physically remain until reuse/TTL deletion, but every request enforces expiry directly. Capability plaintext is never stored in that table or written to disk/config/logs.

Every server read checks the capability generation, exact scope and live parent session before access and after storage awaits. Parent logout, session-epoch invalidation, expiry, browser revoke or client stop prevents further authorized reads. An expired in-flight read cannot borrow a newly approved generation with the same hash. Revocation cannot retract content already delivered or eliminate every race after the last authorization check.

The page has a decline/revoke action. Process EOF, SIGINT/SIGTERM, expiry and explicit close abort pending local reads, close stdio and attempt a bounded server-side stop. If that stop cannot be delivered, server expiry and parent-session revocation remain authoritative. Ambiguous initial registration may leave an unapproved request until its bounded expiry. No unrestricted durability, exactly-once revocation or data-retraction guarantee is made.

For embedding, `connectBridge()` returns dependencies including `lifecycleSignal`; pass **all** of those dependencies to `createTraceReader()` and close the bridge when done. Closing the bridge aborts active readers even when a test/custom transport ignores its AbortSignal. The old `cli.mjs` fd3 integration remains available for an independently approved host-owned account-session supplier; it does not acquire credentials or implement browser consent, and its wrapper deadline does not revoke that broader session. Do not copy browser cookies to use it.

## Deployment validation

Source tests use synthetic accounts and actual API/storage, the official SDK both in-memory and in subprocess stdio, and disposable Chromium browser profiles. They cover list/inspect/export equality, server metadata projection, immutable scope/consent, origin/account/project/trace/content denial, forbidden writes, replay, parent expiry/logout/epoch revocation, request reuse, cancellation and generation changes during a read. They do not establish behavior for a live account and client.

Before activation, the release owner must approve the exact candidate commit plus the `McpBridgeEnabled=true` stack parameter configuration for the existing pre-production backend. This enables the new `/api/mcp/*` routes and temporary read capabilities; it is an auth-surface change even though no IAM or new resource is needed. Use the reviewed change-set parameter file in the existing release path; do not bypass it with a direct Lambda configuration edit. Then identify the actual stdio client/model destination, SupaTrace origin, account/project, 1–20 permitted trace IDs and metadata/content scope. The human grants that one five-minute request in their signed-in browser. No credentials should be pasted into chat or extracted from the browser.

Before hosted use, verify that the actual client lists/searches only approved traces, inspects and retrieves an export reconciled to canonical stored data, fails cross-project/out-of-scope/content escalation, and fails after expiry and explicit revocation. Record deployed commit, exact scope, tool results and non-secret timestamps; keep returned private content out of public CI artifacts. Hosted activation and this validation remain unverified until completed.
