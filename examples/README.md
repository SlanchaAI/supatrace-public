# SupaTrace examples

Three small apps that record what an agent did as SupaTrace events with the preview SDKs
in `packages/`. Each one runs in **spool mode**: the SDK validates the batch and writes it
to a local folder for you to review. Nothing is sent to SupaTrace until you upload a
reviewed file yourself with `agent/upload.py`.

| Example | Stack | Dry run (no network, no provider key) |
| --- | --- | --- |
| [`nextjs-ai-sdk`](nextjs-ai-sdk/) | Next.js route handler + Vercel AI SDK + `@supatrace/client` | `node examples/nextjs-ai-sdk/smoke.mjs` |
| [`python-agent`](python-agent/) | Python tool-calling agent on the OpenAI client + `supatrace` | `python3 examples/python-agent/agent.py --dry-run` |
| [`langgraph-agent`](langgraph-agent/) | LangGraph agent + `supatrace` | `python3 examples/langgraph-agent/agent.py --dry-run` |

What is true today:

- The SDKs are repository prototypes. They are not on PyPI or npm, so each example installs
  them from this private checkout. These examples are unavailable to outside users; use the
  [Home snippets](https://supatrace.dev/docs/quickstart/#home), stock OpenTelemetry exporters or
  reviewed script downloads today. SDK packages are coming.
- The OTLP/HTTP receiver is available on supatrace.dev for traces (protobuf and JSON),
  with no gRPC, metrics or logs. These examples choose source mode and spool events;
  the [OpenTelemetry guide](https://supatrace.dev/docs/frameworks/opentelemetry/#otlp) has stock exporter snippets.
- `tests/examples.test.mjs` runs every dry run with the network blocked and checks each
  spooled batch with the server's own validator. The dry runs use a scripted model. The
  real-provider paths need your own provider key and are not run in CI.
- There is no Deploy to Vercel button: a deployed app could not install the unpublished SDK.

To upload a spooled batch after you have read it, follow the
[setup guide](../public/agent-setup.html) to create `supatrace-access.json`, then:

```sh
python3 agent/upload.py ./spool/BATCH.json --config ./supatrace-access.json
```
