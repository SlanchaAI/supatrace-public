# Langfuse-compatible ingest

An app that already uses a Langfuse SDK can send its traces to SupaTrace by changing the host and keys. This is an ingest shim, not a Langfuse API clone: the endpoints below are the only ones served.

## Quickstart

```sh
export LANGFUSE_HOST="https://supatrace.dev"     # LANGFUSE_BASEURL for the JS SDK
export LANGFUSE_PUBLIC_KEY="pk-supatrace"          # any non-empty value; not a credential
export LANGFUSE_SECRET_KEY="<SupaTrace write key>"
```

Ingest keys from the Home card or API keys page do not expire by default; keys from pairing an agent last 30 days.

The SDK sends HTTP Basic auth with the public key as username and the secret key as password. SupaTrace authenticates the password as a write key and ignores the username. The write key can also be sent as `Authorization: Bearer` or `x-supatrace-key`.

To try it against the local development server, run `npm run dev` and use `http://127.0.0.1:3000` as the host.

## Endpoints served

| Endpoint | Used by | Behaviour |
| --- | --- | --- |
| `POST /api/public/ingestion` | Langfuse Python SDK v2, JS SDK v3 (`langfuse` package) and other batch-ingestion clients | Stores accepted events; answers `207` with `successes` and `errors` per event id |
| `POST /api/public/otel/v1/traces` | Langfuse Python SDK v3 and later, JS SDK v4 and later (OpenTelemetry based) | The [OTLP receiver](otlp-ingest.md) with Basic auth. Protobuf or JSON, gzip accepted |
| `GET /api/public/projects` | `auth_check()` | The project the key belongs to: its id and name only. This is the one thing a write-only key (publishable or pairing) can read. It returns no traces, events, keys or usage |
| `GET /api/public/health` | health probes | `{"status":"OK"}` |

Every other `/api/public/*` path answers `404` with a message naming this list. That includes `POST /api/public/scores` (used by `create_score` in the Python SDK v5), prompts, datasets, sessions, media, comments, annotation queues and every read API. Calling them through the SDK logs an error; tracing is unaffected.

## Ingestion event types

| Type | Stored |
| --- | --- |
| `trace-create` | yes, one event per call. A later `trace-create` for the same trace (the SDK's trace update) is a second event |
| `span-create`, `generation-create`, `event-create`, `observation-create`, `agent-create`, `tool-create`, `chain-create`, `retriever-create`, `evaluator-create`, `embedding-create`, `guardrail-create` | yes |
| `span-update`, `generation-update`, `observation-update` | yes, as their own event marked `update`. They are **not merged** into the observation they update |
| `score-create` | yes, as an event on the trace. Scores are not aggregated or shown as scores |
| `sdk-log` | acknowledged and discarded |
| anything else | rejected in `errors` with status 400 and the list of accepted types |

Each trace becomes one run: `lf.<trace id>`, or `otlp.<trace id>` when the id is a 32-character OpenTelemetry trace id, so batch events and OTLP spans of one trace share a run. Each stored event keeps the Langfuse body under `data.langfuse` and a summary under `data.span` (trace and observation ids, parent, start, end, duration, model, token usage, reported cost, level). A `generation-create` is a `response` event, a `tool-create` a `tool_call`, an event with `level: "ERROR"` an `error`, everything else a `note`.

Trace duration uses the earliest-starting root observation’s own start and end, joining create/update events across uploads. Child updates without a parent ID retain the parent recorded on create. Missing or unfinished roots and older stored runs without timing metadata use the full span range.

Timing retains the full accepted observation ID (up to 200 characters), independently of the waterfall’s 128-character display limit.

OTLP spans from Langfuse SDKs are summarised from `langfuse.observation.type`, `langfuse.observation.model.name`, `langfuse.observation.usage_details` and `langfuse.observation.cost_details`.

## Limits and errors

- 512 KiB per request on the wire, 1000 events, 50 traces. 32 KiB per stored event; a larger body is stored with string values over 256 characters truncated, and rejected if it is still too large.
- The existing rate limits apply: 30 ingest requests a minute per workspace, 60 a minute per client address. `429` carries `Retry-After`.
- A reached storage quota is a per-event error with status 403 in the `207` body.
- `401` for a missing or unknown key, with `{"error":"UnauthorizedError","message":...}`.
- A resent batch stores nothing twice.

## What was tested

`tests/langfuse-ingest.test.mjs` replays the request bodies captured from the stock Langfuse JS SDK 3.39.2 (batch ingestion) and Python SDK 5.2.0 (OTLP) against the real handler. Both SDKs were also run against the local development server with only the three environment variables set. Other SDK versions and integrations are untested.

## Hosted status

**Beta.** The hosted routes answer on https://supatrace.dev through the ingest edge, which supports HTTP Basic auth without a caller-computed body hash. SDK compatibility needs a test against the intended SDK version. The [OTLP/HTTP receiver](otlp-ingest.md) is available for traces.
