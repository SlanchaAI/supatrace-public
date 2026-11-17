"""Real pinned instrumentation, deterministic synthetic work, all networking blocked.

Writes explicit OTLP JSON to the supplied new file; no session discovery or uploader.
The SDK's in-memory exporter is test-only and is not a durable live capture design.
"""
import json
import os
import socket
import sys
from pathlib import Path
os.environ['LANGSMITH_TRACING'] = 'false'
os.environ['LANGCHAIN_TRACING_V2'] = 'false'
os.environ['OTEL_SDK_DISABLED'] = 'false'

def no_network(*args, **kwargs):
    raise AssertionError('network forbidden in deterministic capture')
socket.socket.connect = no_network
socket.create_connection = no_network

from google.protobuf.json_format import MessageToDict
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool
from openinference.instrumentation import TraceConfig
from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans

@tool
def plus_one(value: int) -> int:
    """Add one to a synthetic integer."""
    return value + 1

provider = TracerProvider(resource=Resource({'service.name': 'supatrace-synthetic-proof'}))
exporter = InMemorySpanExporter()
provider.add_span_processor(SimpleSpanProcessor(exporter))
instrumentor = LangChainInstrumentor()
# Explicit synthetic opt-in is scoped to this test. Product imports default to metadata.
instrumentor.instrument(tracer_provider=provider, config=TraceConfig(hide_inputs=False, hide_outputs=False))
try:
    pipeline = RunnableLambda(lambda value: {'value': value + 1}) | plus_one | RunnableLambda(lambda value: value)
    result = pipeline.invoke(1)
    assert result == 3
    assert provider.force_flush(timeout_millis=5000)
    spans = exporter.get_finished_spans()
    assert len(spans) == 4, [(s.name, s.parent) for s in spans]
    assert len({s.context.trace_id for s in spans}) == 1
    roots = [s for s in spans if not s.parent]
    assert len(roots) == 1 and all(s.parent.span_id == roots[0].context.span_id for s in spans if s.parent)
    # Protobuf's generic JSON uses base64 IDs and enum names. OTLP JSON specifically
    # requires hex IDs and integer enums; adapt only those fields before serialization.
    value = MessageToDict(encode_spans(spans), use_integers_for_enums=True)
    import base64
    for resource in value['resourceSpans']:
        for scope in resource['scopeSpans']:
            for span in scope['spans']:
                for key in ('traceId', 'spanId', 'parentSpanId'):
                    if key in span:
                        span[key] = base64.b64decode(span[key]).hex()
                for link in span.get('links', []):
                    for key in ('traceId', 'spanId'):
                        link[key] = base64.b64decode(link[key]).hex()
    with open(sys.argv[1], 'x', encoding='utf8') as stream:
        json.dump(value, stream, separators=(',', ':'))
        stream.flush(); os.fsync(stream.fileno())
    print(json.dumps({'input': 1, 'output': result, 'spans': len(spans), 'network': 'blocked', 'instrumentor': '0.1.80'}))
finally:
    instrumentor.uninstrument()
    provider.shutdown()
