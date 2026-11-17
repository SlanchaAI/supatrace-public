# OTLP/HTTP ingest

SupaTrace accepts OpenTelemetry traces over OTLP/HTTP at `POST /v1/traces`. Any OpenTelemetry SDK, OpenLLMetry, OpenInference, the Vercel AI SDK, LangChain or LlamaIndex instrumentation that exports OTLP/HTTP can send spans with two environment variables. No SupaTrace package is needed.

## Quickstart

Create an ingest key on Home or the API keys page. Ingest keys from Home or API keys do not expire by default; keys from pairing an agent last 30 days. In a fresh shell, replace only `YOUR_INGEST_KEY`:

<!-- Stock exporter snippets are shared with the public guides through scripts/otlp-snippets.mjs. -->
```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://supatrace.dev
export OTEL_EXPORTER_OTLP_HEADERS="x-supatrace-key=YOUR_INGEST_KEY"
```

Both `x-supatrace-key: <key>` and `Authorization: Bearer <key>` are accepted. The environment-variable alternative is `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"`. Some SDKs require the space URL-encoded: `Authorization=Bearer%20YOUR_INGEST_KEY`, following the [OpenTelemetry header format](https://opentelemetry.io/docs/specs/otel/protocol/exporter/#specifying-headers-via-environment-variables).

### Try HTTP/JSON

This fake span calls no model provider. Replace the key before sending:

```sh
curl -X POST https://supatrace.dev/v1/traces \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_INGEST_KEY' \
  -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"11111111111111111111111111111111","spanId":"1111111111111111","name":"synthetic.example","startTimeUnixNano":"1794685870000000000","endTimeUnixNano":"1794685871000000000"}]}]}]}'
# Or replace Authorization with: -H 'x-supatrace-key: YOUR_INGEST_KEY'
```

### Python

```sh
pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

Save as `first-trace.py`:

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
with trace.get_tracer("first-trace-example").start_as_current_span("synthetic.chat") as span:
    span.set_attribute("gen_ai.provider.name", "example")
    span.set_attribute("gen_ai.request.model", "synthetic-model")
    print("Trace: otlp." + format(span.get_span_context().trace_id, "032x"))
provider.force_flush()
provider.shutdown()
```

```sh
python first-trace.py
```

### JavaScript / Node 22

```sh
npm install @opentelemetry/sdk-trace-base@2.12.1 @opentelemetry/exporter-trace-otlp-http@0.223.2 @opentelemetry/api@1.9.1
```

These compatible package versions keep the trace SDK and exporter on the same OpenTelemetry API version. Save as `first-trace.mjs` (ESM). The JS exporter reads the same two variables, appends `/v1/traces` to the base URL and sends HTTP/JSON:

```js
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter())],
});
trace.setGlobalTracerProvider(provider);
const span = trace.getTracer("first-trace-example").startSpan("synthetic.chat");
span.setAttribute("gen_ai.provider.name", "example");
span.setAttribute("gen_ai.request.model", "synthetic-model");
console.log("Trace: otlp." + span.spanContext().traceId);
span.end();
await provider.forceFlush();
await provider.shutdown();
```

```sh
node first-trace.mjs
```

The base URL makes both stock exporters append `/v1/traces`. Leave `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` overrides unset. Open Traces and find the printed `otlp.<traceid>` run. No model provider is called.

The key can write spans and cannot read traces. Spans land in the environment the key belongs to. Use `x-supatrace-key` or `Authorization: Bearer <key>` on the hosted ingest edge; no caller-computed body hash is needed. The management API under `/api/v1` uses a different edge path.

## Local development

Follow the [README setup](../README.md#run-locally). Choose **Team admin account** in its personal workspace, or **Owner account** for the seeded team. Seed upload keys are revoked, leaving room to create an ingest key under Free. Set the stock scripts' `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://127.0.0.1:3000`. Local data is in memory. No hosted account or key is needed.

The [synthetic first-trace recipe](self-hosting.md#send-and-read-one-trace) uses Node.js without installing an exporter.

## Hosted status

**Available** on https://supatrace.dev for traces over OTLP/HTTP, with protobuf or JSON and optional gzip. No gRPC, metrics or logs.

Stock exporters use the base endpoint and either `x-supatrace-key` or `Authorization: Bearer <key>`. The receiver is registered in the production handler (`src/aws-api.mjs`) and local development server. Langfuse SDK compatibility remains beta; see [Langfuse-compatible ingest](langfuse-compatible-ingest.md).

## What is accepted

| Item | Support |
| --- | --- |
| Encoding | `application/x-protobuf` (`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, the default for most SDKs) and `application/json` (`http/json`) |
| Compression | none or `gzip` |
| JSON details | 64-bit integers as strings or numbers; unknown fields are ignored. Attributes with an empty (null) value are dropped |
| Signals | traces only. `/v1/metrics` and `/v1/logs` are not served |
| gRPC | not supported. Use an OTLP/HTTP exporter |
| Request size | 512 KiB on the wire, 4 MiB after decompression, 2000 spans, 50 traces, 8 MiB once stored (each stored span carries its resource and scope) |
| Span size | 32 KiB stored per span, including its resource and scope. Longer spans are stored with string values over 256 characters truncated, and the response says so |
| Rate | the existing limits: 30 ingest requests a minute per workspace, 60 requests a minute per client address |

Spans of traces beyond the 50th in one export are rejected with a reason. An app that finishes many traces at once should set `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` to 50 or less.

## How spans are stored

Each trace becomes one run with the id `otlp.<trace id>`. Each span becomes one event in the existing version-1 batch format, stored through the same quota reservation, immutable object write and acceptance receipt as `POST /api/batches`. A retried export stores nothing twice.

The event keeps the original span, resource and scope under `data.otlp`, and a summary under `data.span`:

| Summary field | Read from |
| --- | --- |
| `model` | `gen_ai.response.model`, `gen_ai.request.model`, `llm.model_name`, `llm.response.model`, `llm.request.model`, `ai.model.id` |
| `provider` | `gen_ai.provider.name`, `gen_ai.system`, `llm.provider`, `llm.system`, `ai.model.provider` |
| `usage.input` / `usage.output` / `usage.total` | `gen_ai.usage.*_tokens`, `llm.token_count.*`, `llm.usage.*_tokens`, `ai.usage.*Tokens` |
| `reported_cost` | `gen_ai.usage.cost`, `llm.cost.total`, `llm.usage.total_cost`. Only a cost the instrumentation reported; SupaTrace applies no price table |
| `duration_ms` | span end minus start |
| `kind` | `llm`, `tool`, `agent`, `embedding` or `retrieval` from `openinference.span.kind` and `gen_ai.operation.name` |
| `status` | `error`, `ok` or `unset` from the span status |

The event kind is `error` for a failed span, `response` for a model call, `tool_call` for a tool span and `note` otherwise. The dashboard shows these events in the existing run view; a dedicated LLM span view is separate work.

## Responses

Responses follow the OTLP/HTTP specification, in the encoding of the request.

| Status | Meaning |
| --- | --- |
| 200, empty | every span stored |
| 200 with `partialSuccess` | some spans stored; `rejectedSpans` counts the rest and `errorMessage` gives each reason |
| 400 | body is not OTLP, or no span in it could be stored |
| 401 | `write_key_required`: neither key header is present. `invalid_write_key`: a supplied key is malformed, unknown, expired or revoked |
| 403 | storage quota reached or uploads blocked. Not retryable; exporters drop the batch |
| 413 / 415 | too large; unsupported content type or compression |
| 429 / 503 | rate limited or temporarily unavailable, with `Retry-After`. Exporters retry |

Error bodies are a `google.rpc.Status` (`code`, `message`); JSON bodies also carry the SupaTrace `error` code.
