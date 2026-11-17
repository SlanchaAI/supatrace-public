// Explicit OTLP/HTTP JSON file input, not a network receiver. No protobuf/gzip guessing.
import {ConversionError, isObject} from './vendor/hue/fields.mjs';
const fail = () => { throw new ConversionError('invalid_otlp_json'); };
const list = value => value === undefined ? [] : Array.isArray(value) ? value : fail();
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const id = (value, size) => typeof value === 'string' && new RegExp(`^[a-fA-F0-9]{${size}}$`).test(value) && !/^0+$/.test(value);
function nanos(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) fail();
  const n = BigInt(value);
  if (n <= 0n || n > 18446744073709551615n) fail();
  return n;
}
function any(value) {
  if (!isObject(value)) fail();
  const keys = Object.keys(value);
  if (keys.length !== 1) fail();
  const key = keys[0], v = value[key];
  if (key === 'stringValue' && typeof v === 'string' || key === 'boolValue' && typeof v === 'boolean') return;
  if (key === 'doubleValue' && typeof v === 'number' && Number.isFinite(v)) return;
  if (key === 'intValue' && (typeof v === 'string' && /^-?[0-9]{1,19}$/.test(v) || Number.isSafeInteger(v))) {
    const n = BigInt(v); if (n >= -9223372036854775808n && n <= 9223372036854775807n) return;
  }
  if (key === 'bytesValue' && typeof v === 'string' && Buffer.from(v, 'base64').toString('base64') === v) return;
  if (key === 'arrayValue' && isObject(v)) { for (const item of list(v.values)) any(item); return; }
  if (key === 'kvlistValue' && isObject(v)) { attrs(v.values); return; }
  fail();
}
function attrs(value) {
  const seen = new Set();
  for (const item of list(value)) {
    if (!isObject(item) || typeof item.key !== 'string' || !item.key || seen.has(item.key)) fail();
    seen.add(item.key); any(item.value);
  }
}
function attributesOwner(value) {
  if (!isObject(value)) fail();
  attrs(value.attributes);
  if (value.droppedAttributesCount !== undefined && !uint(value.droppedAttributesCount)) fail();
}
function schema(value) { if (value.schemaUrl !== undefined && typeof value.schemaUrl !== 'string') fail(); }
const field = (span, name) => span.attributes?.find(a => a.key === name)?.value;
function count(span, names) {
  for (const name of names) {
    const v = field(span, name), raw = v?.intValue ?? v?.doubleValue;
    if (raw === undefined) continue;
    const n = Number(raw); if (Number.isSafeInteger(n) && n >= 0) return n;
  }
}
export const otlpJson = {
  id: 'otlp',
  detect: value => isObject(value) && Array.isArray(value.resourceSpans),
  convert(value, context) {
    for (const resource of value.resourceSpans) {
      if (!isObject(resource)) fail(); schema(resource);
      if (resource.resource !== undefined) attributesOwner(resource.resource);
      for (const scope of list(resource.scopeSpans)) {
        if (!isObject(scope)) fail(); schema(scope);
        if (scope.scope !== undefined) {
          attributesOwner(scope.scope);
          for (const key of ['name', 'version']) if (scope.scope[key] !== undefined && typeof scope.scope[key] !== 'string') fail();
        }
        for (const span of list(scope.spans)) {
          attributesOwner(span);
          if (!id(span.traceId, 32) || !id(span.spanId, 16) || typeof span.name !== 'string' || !span.name) fail();
          const parent = span.parentSpanId;
          if (parent !== undefined && parent !== '' && !id(parent, 16)) fail();
          if (parent?.toLowerCase() === span.spanId.toLowerCase()) fail();
          if (span.kind !== undefined && (!Number.isInteger(span.kind) || span.kind < 0 || span.kind > 5)) fail();
          if (span.flags !== undefined && !uint(span.flags)) fail();
          for (const key of ['droppedEventsCount', 'droppedLinksCount']) if (span[key] !== undefined && !uint(span[key])) fail();
          if (span.traceState !== undefined && typeof span.traceState !== 'string') fail();
          const start = nanos(span.startTimeUnixNano), end = nanos(span.endTimeUnixNano);
          if (end < start) fail();
          if (span.status !== undefined && (!isObject(span.status) || span.status.code !== undefined && ![0, 1, 2].includes(span.status.code) || span.status.message !== undefined && typeof span.status.message !== 'string')) fail();
          for (const event of list(span.events)) {
            attributesOwner(event); nanos(event.timeUnixNano);
            if (typeof event.name !== 'string') fail();
          }
          for (const link of list(span.links)) {
            attributesOwner(link);
            if (!id(link.traceId, 32) || !id(link.spanId, 16) || link.flags !== undefined && !uint(link.flags)) fail();
          }
          const semantic = field(span, 'openinference.span.kind')?.stringValue;
          const operation = field(span, 'gen_ai.operation.name')?.stringValue;
          const kind = ({LLM: 'llm', TOOL: 'tool', AGENT: 'agent', EMBEDDING: 'embedding', RETRIEVER: 'retrieval'})[semantic]
            ?? (['chat', 'text_completion', 'generate_content'].includes(operation) ? 'llm' : undefined);
          const {scopeSpans: _scopes, ...resourceContext} = resource;
          const {spans: _spans, ...scopeContext} = scope;
          context.row({traceKey: span.traceId.toLowerCase(), spanKey: span.spanId.toLowerCase(),
            ...(parent ? {parentKey: parent.toLowerCase()} : {}), start, end, name: span.name, kind,
            ...(span.status?.code === 2 ? {error: {}} : {}),
            ...(kind === 'llm' ? {usage: {input: count(span, ['gen_ai.usage.input_tokens', 'llm.token_count.prompt']), output: count(span, ['gen_ai.usage.output_tokens', 'llm.token_count.completion'])}} : {}),
            record: {resource: resourceContext, scope: scopeContext, span}});
        }
      }
    }
  },
};
