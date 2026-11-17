# supatrace (Python)

Alpha Python client for [SupaTrace](https://supatrace.dev). Requires Python 3.10 or later.
The base package has zero required dependencies.

## Install

```sh
pip install supatrace
```

## Send your first trace

In SupaTrace, create an ingest key from Home or API keys. Install the optional
OpenTelemetry Protocol (OTLP) exporter and set the key in your shell:

```sh
pip install 'supatrace[otlp]'
export SUPATRACE_API_KEY='YOUR_INGEST_KEY'
```

Run this Python code. It sends one trace to `https://supatrace.dev/v1/traces`.
Open Traces in the same workspace to find `hello-supatrace`.

```python
import os
import supatrace

trace = supatrace.init(
    service="hello-supatrace",
    mode="otlp",
    endpoint=os.environ.get("SUPATRACE_OTLP_ENDPOINT", "https://supatrace.dev"),
    api_key=os.environ["SUPATRACE_API_KEY"],
)
if not trace.capture["sending"]:
    raise RuntimeError("OTLP is inactive; check the install, endpoint and ingest key")
trace.span("hello-supatrace")
trace.flush()
trace.close()
```

The exporter authenticates with `x-supatrace-key` and `Authorization: Bearer`.
It sends OTLP/HTTP protobuf. An ingest key selects its workspace and environment;
no project ID is needed for this quickstart.

## Local mode and configuration

`supatrace.init()` defaults to `mode="source"`. It sends nothing, even when a key
and endpoint exist in the environment. `trace.span(name)` or `trace.batch(events)`
writes a local JSON batch to `~/.supatrace/pending` for review.
`trace.batch(events, dry_run=True)` validates without writing.

OTLP sending requires explicit `mode="otlp"`, an endpoint, a key and the optional
exporter. `trace.capture` reports whether a sender is active and why instrumentation
was skipped. Initialization and import do not create traces.

- `SUPATRACE_API_KEY`: ingest key; explicit `api_key=` takes precedence.
- `SUPATRACE_OTLP_ENDPOINT`: origin without `/v1/traces`; explicit `endpoint=` takes precedence.
- `SUPATRACE_SERVICE`: service name; explicit `service=` takes precedence.
- `SUPATRACE_SPOOL`: local spool directory; explicit `spool=` takes precedence.
- `SUPATRACE_PROJECT`: project label for keys without an embedded project. Hosted ingest uses the key's scope.
- `SUPATRACE_CAPTURE_CONTENT=1`: opt into provider prompt/output capture; explicit `capture_content=` takes precedence.

Prompt/output capture is off by default. Attributes passed to `span()` and data
passed to `batch()` are recorded as supplied; keep secrets out of those values.
Python provider auto-instrumentation requires separately installed instrumentor
packages. This quickstart records an explicit span and calls no model provider.

## License

Apache-2.0. Copyright 2026 Slancha, Inc. See LICENSE.
