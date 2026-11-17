# supatrace (JavaScript)

Alpha JavaScript client for [SupaTrace](https://supatrace.dev). ESM only.
Requires Node.js 22 or later. No runtime dependencies in the base package.

## Install

```sh
npm install supatrace
```

## Send your first trace

In SupaTrace, create an ingest key from Home or API keys. Install the optional
OpenTelemetry Protocol (OTLP) exporter and set the key in your shell:

```sh
npm install @opentelemetry/api@1.9.0 @opentelemetry/sdk-trace-base@2.12.1 @opentelemetry/exporter-trace-otlp-http@0.223.2 @opentelemetry/resources@2.12.1
export SUPATRACE_API_KEY='YOUR_INGEST_KEY'
```

Save this as `quickstart.mjs` and run `node quickstart.mjs`. It sends one trace to
`https://supatrace.dev/v1/traces`. Open Traces in the same workspace to find
`hello-supatrace`.

```js
import { init } from "supatrace";

const trace = init("hello-supatrace", {
  mode: "otlp",
  endpoint: process.env.SUPATRACE_OTLP_ENDPOINT || "https://supatrace.dev",
  apiKey: process.env.SUPATRACE_API_KEY,
});
if (!trace.capture.sending) {
  throw new Error("OTLP is inactive; check the install, endpoint and ingest key");
}
trace.span("hello-supatrace");
await trace.flush().flushed;
await trace.close().shutdown;
```

The exporter authenticates with `x-supatrace-key` and `Authorization: Bearer`.
It sends OTLP/HTTP JSON. An ingest key selects its workspace and environment;
no project ID is needed for this quickstart.

## Local mode and configuration

`init()` defaults to `mode: "source"`. It sends nothing, even when a key and
endpoint exist in the environment. `trace.span(name)` or `trace.batch(events)`
writes a local JSON batch to `~/.supatrace/pending` for review.
`trace.batch(events, { dryRun: true })` validates without writing.
`build()` is an alias for `batch()`.

OTLP sending requires explicit `mode: "otlp"`, an endpoint, a key and the optional
exporter. `trace.capture` reports whether a sender is active and why instrumentation
was skipped. Initialization and import do not create traces.

- `SUPATRACE_API_KEY`: ingest key; explicit `apiKey` takes precedence.
- `SUPATRACE_OTLP_ENDPOINT`: origin without `/v1/traces`; explicit `endpoint` takes precedence.
- `SUPATRACE_SERVICE`: service name; explicit service argument takes precedence.
- `SUPATRACE_SPOOL`: local spool directory; explicit `spool` takes precedence.
- `SUPATRACE_PROJECT`: project label for keys without an embedded project. Hosted ingest uses the key's scope.
- `SUPATRACE_CAPTURE_CONTENT=1`: opt into provider prompt/output capture; explicit `captureContent` takes precedence.

Prompt/output capture is off by default. Attributes passed to `span()` and data
passed to `batch()` are recorded as supplied; keep secrets out of those values.

## Trace a provider client

`trace.instrument(client)` returns a traced view of one OpenAI or Anthropic client.
Use the returned client; the original client and global modules are unchanged.
Supported calls: OpenAI `chat.completions.create` and `responses.create`, Anthropic
`messages.create`. Source mode spools them; OTLP mode exports them.
Streaming records when the stream opens without consuming chunks, output or token usage.
Provider protocol tests use fake clients; this package makes no claim of live provider verification.

## Command line

`npx supatrace --help` lists `login`, `init`, `tail`, `dev` and `logout`.
`login` saves a read-only personal access token from Settings. `init` pairs a folder
and writes its key to `.env.local` with owner-only permissions; keys are not printed.
`tail` reads traces. `dev` requires a SupaTrace source checkout; a local viewer is
not included in this package. CLI origin can be set with `SUPATRACE_ORIGIN`;
`SUPATRACE_ACCESS_TOKEN` supplies the token for login or tail.
Self-hosted origins are unsupported by the CLI. It accepts only supatrace.dev,
supatrace.tech and loopback HTTP origins for local development.

## License

Apache-2.0. Copyright 2026 Slancha, Inc. See LICENSE.
