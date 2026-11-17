# Integrations view

**Integrations** in the dashboard shows what has arrived in the selected workspace and environment, grouped by source, and the state of import jobs. It is read-only. Setup guides stay in the public [integrations directory](https://supatrace.dev/integrations/); each source card links to its guide.

## What it shows

One card per source:

| Source | Traces counted |
| --- | --- |
| OpenTelemetry (OTLP) | Trace ids that start with `otlp.`: the OTLP receiver, and Langfuse SDK traces that carry a 32-hex OpenTelemetry trace id |
| Langfuse | `lf.`: Langfuse SDK ingest and Langfuse imports |
| Imported files and API pulls | `imp.`: provider exports converted by the local importers |
| Claude Code hooks | `claude-`: the opt-in command hook |
| SDK and direct uploads | Everything else uploaded with a write key |

Each card gives the number of retained traces, when the newest one was first received, and how many traces hold an error event. A source with no retained trace says that; it does not say the source never sent anything, because traces past retention are not counted.

**Import jobs** lists the workspace's Langfuse import jobs (the job ledger and in-app server pulls), newest first, with their recorded state and progress. Jobs are listed for the workspace owner in the Default environment, the same scope the import API uses.

## How the numbers are made

`GET /api/integrations` (signed-in session; `workspace` and `environment` query parameters as on other dashboard routes; any workspace role may read it) derives everything from rows that already exist. It writes nothing and adds no counter.

- **Source attribution is by trace id prefix.** Each ingest path names its traces with a fixed prefix. `POST /api/batches` lets the client choose the trace id, so a client that uses one of these prefixes is counted under that source.
- **One pass, bounded.** The route reads up to 800 retained traces. The traces are read in stored order (by trace id), not newest first. When the environment holds more, `scanned.truncated` is `true`; the page then says totals are a lower bound and words every time as "newest among the traces read". A source with no trace in a partial read is shown as "no trace among the traces read", not as never received.
- **Times are first-receipt times.** "Newest trace received" is when the newest trace's first batch was accepted. A later batch on an older trace does not move it. There is no per-source "last request" record.
- **Errors are trace content, not ingest failures.** A trace counts as an error trace when one of its events has kind `error`. Traces stored before error summaries were kept have no recorded error state; they are counted as `unknown_error_traces` and the card says so instead of calling them error-free. Rejected uploads (bad key, over allowance, invalid body) are not recorded per source and are not shown.
- Expired traces (past retention) are not counted.

The response holds counts, times and job ids. It does not include keys, trace ids, event content or an import job's source scope.

## Not included

- Connecting a source from this page. Keys are made under **API keys** and **Agents**; imports start from **Agents** or the local importers.
- A hosted integrations hub (OAuth connections to providers). That needs a product decision; see issue #94.
