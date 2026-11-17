# Logs

**Logs** in the dashboard lists upload attempts recorded for the selected workspace and environment, newest first, with the reason when one was refused. The same rows are served by `GET /api/logs` (signed-in session) and `GET /api/v1/logs` (personal access token). Any member of the workspace can read them, in the environments that member may open; a read-only member, who cannot list keys, gets rows without the key prefix.

## What is recorded

One row for each ingest request that reached a workspace, on every ingest route:

| Route | Requests |
| --- | --- |
| `batches` | `POST /api/batches` (SDK, CLI, importers, Claude Code hook) |
| `otlp` | `POST /v1/traces`, `POST /api/otlp/v1/traces`, `POST /api/public/otel/v1/traces` |
| `langfuse` | `POST /api/public/ingestion` |

Each row holds the time, route, outcome, HTTP status, reason code, counts (batches, events and bytes that the request stored or that were already stored by an earlier identical request, with `repeated_batches` saying how many batches were already there; and refused events, which is unknown and `null` when the request was refused before its events were read), the trace id when the request stored events for exactly one trace (`stored_trace_id`; a trace whose events were all refused is not named, so a rejected request has none), and the first 12 characters of the key id. It never holds a key, event content or a network address. Refusal messages are fixed text; the one message that would quote the sender's event type is logged without the quote. The stored trace id is the sender's own identifier, as shown in Traces.

| Outcome | Meaning |
| --- | --- |
| `accepted` | Nothing in the request was refused: its events were stored, or were already stored by an earlier identical request. A Langfuse request that holds only `sdk-log` events, which are acknowledged and not stored, is accepted with zero stored events |
| `partial` | Some events were stored and some were not. Reason `partly_stored` when the request was answered as a success with refusals, and `detail` counts the refusal messages. When the request failed after storing part of itself, the reason is the error code the sender received |
| `rejected` | The request stored nothing. `reason` is the error code the sender received, or `no_event_stored` when a Langfuse request answered 207 with every event refused |

Reason codes include `rate_limit`, `payload_hash_required`, `invalid_json`, `unknown_field`, `idempotency_conflict`, `monthly_span_allowance_exceeded`, `stored_bytes_allowance_exceeded`, `spend_cap_reached`, `project_paused`, `environment_unavailable`, `invalid_otlp`, `no_valid_spans` and `invalid_langfuse_batch`. The response carries a plain-language `message` for each known code.

## What is not recorded

- **Requests without a valid key.** A request with no key, or a key that is unknown, expired or revoked, cannot be tied to a workspace. The sender gets `401` and no row is written. A wrong `Content-Type` on the OTLP and Langfuse routes is refused before the key is read, so it is not recorded either.
- **Refusals past 30 a minute for one workspace.** A sender stuck in a retry loop does not fill the log.
- **Rows the log write lost.** The upload's answer waits at most 400 ms for the log write and never fails because of it, so a row can be missing.
- Rows older than 7 days. Read requests to the dashboard API are not logged here; account changes are in the [audit log](audit-log.md).

## Reading the log

```sh
curl -H "X-Supatrace-Key: $TOKEN" "https://supatrace.dev/api/v1/logs?stream=issues&route=otlp"
```

| Parameter | Meaning |
| --- | --- |
| `stream` | `issues` (default): rejected and partly stored requests. `accepted`: fully stored requests. The two are separate lists so that a busy workspace's accepted uploads do not bury its refusals |
| `route` | `batches`, `otlp` or `langfuse` |
| `reason` | An exact reason code |
| `from`, `to` | ISO 8601 times |
| `limit` | 1 to 200, default 50 |
| `after` | The previous response's `next` |
| `workspace`, `environment` | As on other routes |

One request reads at most 1,000 rows. When it stops there with rows left, `truncated` is `true` and `next` continues the read. An empty `attempts` with `truncated: true` means no match among the rows read so far, not that none exists.

## Storage

Rows live in the application table under `INGESTLOG#<workspace>#<environment>` and carry the table's `ttl` attribute, so no stack parameter or new resource is needed. An accepted request adds one write. A refused or partly stored request adds two: the per-minute counter and the row.
