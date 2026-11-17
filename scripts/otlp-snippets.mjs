// Shared, verbatim stock-exporter examples for the two public onboarding pages.
export const OTLP_ENV = `export OTEL_EXPORTER_OTLP_ENDPOINT=https://supatrace.dev
export OTEL_EXPORTER_OTLP_HEADERS="x-supatrace-key=YOUR_INGEST_KEY"`;
export const OTLP_CURL = `curl -X POST https://supatrace.dev/v1/traces \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer YOUR_INGEST_KEY' \\
  -d '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"11111111111111111111111111111111","spanId":"1111111111111111","name":"synthetic.example","startTimeUnixNano":"1794685870000000000","endTimeUnixNano":"1794685871000000000"}]}]}]}'
# Or replace Authorization with: -H 'x-supatrace-key: YOUR_INGEST_KEY'`;
export const OTLP_PYTHON = `from opentelemetry import trace
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
provider.shutdown()`;
export const OTLP_JS = `import { trace } from "@opentelemetry/api";
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
await provider.shutdown();`;
const esc = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pre = (lang, code, run = '') => `<pre data-lang="${lang}"${run ? ` data-run="${run}"` : ''}><code>${esc(code)}</code></pre>`;
export function otlpExamples() {
  return `
<p>Create an ingest key on <a href="/app/">Home</a> or the <strong>API keys</strong> page. Ingest keys from Home or API keys do not expire by default; keys from pairing an agent last 30 days. In a fresh shell, set these two variables, replacing only <code>YOUR_INGEST_KEY</code>:</p>
${pre('sh', OTLP_ENV)}
<p>Both <code>x-supatrace-key: &lt;key&gt;</code> and <code>Authorization: Bearer &lt;key&gt;</code> are accepted. The environment-variable alternative is <code>OTEL_EXPORTER_<wbr>OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"</code>. Some SDKs require the space URL-encoded: <code>Authorization=Bearer%20YOUR_<wbr>INGEST_KEY</code>, following the <a href="https://opentelemetry.io/docs/specs/otel/protocol/exporter/#specifying-headers-via-environment-variables">OpenTelemetry header format</a>.</p>
<h3>Try HTTP/JSON</h3>
<p>This fake span calls no model provider. Replace the key before sending:</p>
${pre('sh', OTLP_CURL)}
<p>The base URL makes both stock exporters append <code>/v1/traces</code>. Leave any <code>OTEL_EXPORTER_OTLP_TRACES_ENDPOINT</code> and <code>OTEL_EXPORTER_OTLP_TRACES_HEADERS</code> overrides unset.</p>
<h3>Python</h3>
${pre('sh', 'pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http')}
<p>Save as <code>first-trace.py</code>. It sends one synthetic span over HTTP/protobuf and flushes before exit.</p>
${pre('python', OTLP_PYTHON, 'otlp')}
${pre('sh', 'python first-trace.py')}
<h3>JavaScript / Node 22</h3>
${pre('sh', 'npm install @opentelemetry/sdk-trace-base@2.12.1 @opentelemetry/exporter-trace-otlp-http@0.223.2 @opentelemetry/api@1.9.1')}
<p>These compatible package versions keep the trace SDK and exporter on the same OpenTelemetry API version. Save as <code>first-trace.mjs</code> (ESM). This JavaScript exporter reads the same two environment variables and appends <code>/v1/traces</code> to the base URL. It sends HTTP/JSON.</p>
${pre('js', OTLP_JS, 'otlp')}
${pre('sh', 'node first-trace.mjs')}
<p>Open <strong>Traces</strong> in the workspace and find the printed <code>otlp.&lt;traceid&gt;</code> run. These examples call no model provider.</p>
`;
}
