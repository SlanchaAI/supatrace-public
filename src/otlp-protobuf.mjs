// Minimal OTLP trace protobuf codec: decodes ExportTraceServiceRequest into the OTLP/JSON
// object shape (hex ids, decimal-string nanos) so one validator serves both encodings, and
// encodes the two small responses. Hand-written against opentelemetry-proto v1 trace.proto,
// common.proto and resource.proto; no protobuf dependency. Unknown fields are skipped.
export class ProtobufError extends Error {}
const bad = () => { throw new ProtobufError('invalid_protobuf'); };
const MAX_DEPTH = 24;
const utf8 = new TextDecoder('utf-8', {fatal: true});
function varint(buf, at) {
  let value = 0n, shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (at >= buf.length) bad();
    const byte = buf[at++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [BigInt.asUintN(64, value), at];
    shift += 7n;
  }
  bad();
}
/** Calls visit(fieldNumber, wireType, value) for each field. Values: 0 → BigInt, 1 → 8-byte view, 2 → byte view, 5 → 4-byte view. */
function fields(buf, visit) {
  let at = 0;
  while (at < buf.length) {
    let tag; [tag, at] = varint(buf, at);
    const number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number < 1) bad();
    let value;
    if (wire === 0) [value, at] = varint(buf, at);
    else if (wire === 1 || wire === 5) { const size = wire === 1 ? 8 : 4; if (at + size > buf.length) bad(); value = buf.subarray(at, at + size); at += size; }
    else if (wire === 2) { let size; [size, at] = varint(buf, at); if (size > BigInt(buf.length - at)) bad(); value = buf.subarray(at, at + Number(size)); at += Number(size); }
    else bad();
    visit(number, wire, value);
  }
}
const want = (wire, expected) => { if (wire !== expected) bad(); };
const text = bytes => { try { return utf8.decode(bytes); } catch { bad(); } };
const u32 = value => Number(value & 0xffffffffn);
const hex = bytes => Buffer.from(bytes).toString('hex');
const fixed64 = bytes => Buffer.from(bytes).readBigUInt64LE(0).toString();
function anyValue(buf, depth) {
  if (depth > MAX_DEPTH) bad();
  const out = {};
  fields(buf, (n, w, v) => {
    if (n === 1) { want(w, 2); out.stringValue = text(v); }
    else if (n === 2) { want(w, 0); out.boolValue = v !== 0n; }
    else if (n === 3) { want(w, 0); out.intValue = BigInt.asIntN(64, v).toString(); }
    else if (n === 4) { want(w, 1); out.doubleValue = Buffer.from(v).readDoubleLE(0); }
    else if (n === 5) { want(w, 2); const values = []; fields(v, (m, mw, item) => { if (m === 1) { want(mw, 2); values.push(anyValue(item, depth + 1)); } }); out.arrayValue = {values}; }
    else if (n === 6) { want(w, 2); const values = []; fields(v, (m, mw, item) => { if (m === 1) { want(mw, 2); values.push(keyValue(item, depth + 1)); } }); out.kvlistValue = {values}; }
    else if (n === 7) { want(w, 2); out.bytesValue = Buffer.from(v).toString('base64'); }
  });
  return out;
}
function keyValue(buf, depth = 0) {
  const out = {key: ''};
  fields(buf, (n, w, v) => {
    if (n === 1) { want(w, 2); out.key = text(v); }
    else if (n === 2) { want(w, 2); out.value = anyValue(v, depth); }
  });
  return out;
}
/** Shared attributes/dropped-count pair; `attr` and `dropped` are the field numbers in the owning message. */
function owner(out, attr, dropped, n, w, v) {
  if (n === attr) { want(w, 2); (out.attributes ??= []).push(keyValue(v)); return true; }
  if (n === dropped) { want(w, 0); out.droppedAttributesCount = u32(v); return true; }
  return false;
}
function status(buf) {
  const out = {};
  fields(buf, (n, w, v) => {
    if (n === 2) { want(w, 2); out.message = text(v); }
    else if (n === 3) { want(w, 0); out.code = u32(v); }
  });
  return out;
}
function spanEvent(buf) {
  const out = {name: ''};
  fields(buf, (n, w, v) => {
    if (owner(out, 3, 4, n, w, v)) return;
    if (n === 1) { want(w, 1); out.timeUnixNano = fixed64(v); }
    else if (n === 2) { want(w, 2); out.name = text(v); }
  });
  return out;
}
function link(buf) {
  const out = {};
  fields(buf, (n, w, v) => {
    if (owner(out, 4, 5, n, w, v)) return;
    if (n === 1) { want(w, 2); out.traceId = hex(v); }
    else if (n === 2) { want(w, 2); out.spanId = hex(v); }
    else if (n === 3) { want(w, 2); out.traceState = text(v); }
    else if (n === 6) { want(w, 5); out.flags = Buffer.from(v).readUInt32LE(0); }
  });
  return out;
}
function span(buf) {
  const out = {};
  fields(buf, (n, w, v) => {
    if (owner(out, 9, 10, n, w, v)) return;
    if (n === 1) { want(w, 2); out.traceId = hex(v); }
    else if (n === 2) { want(w, 2); out.spanId = hex(v); }
    else if (n === 3) { want(w, 2); out.traceState = text(v); }
    else if (n === 4) { want(w, 2); if (v.length) out.parentSpanId = hex(v); }
    else if (n === 5) { want(w, 2); out.name = text(v); }
    else if (n === 6) { want(w, 0); out.kind = u32(v); }
    else if (n === 7) { want(w, 1); out.startTimeUnixNano = fixed64(v); }
    else if (n === 8) { want(w, 1); out.endTimeUnixNano = fixed64(v); }
    else if (n === 11) { want(w, 2); (out.events ??= []).push(spanEvent(v)); }
    else if (n === 12) { want(w, 0); out.droppedEventsCount = u32(v); }
    else if (n === 13) { want(w, 2); (out.links ??= []).push(link(v)); }
    else if (n === 14) { want(w, 0); out.droppedLinksCount = u32(v); }
    else if (n === 15) { want(w, 2); out.status = status(v); }
    else if (n === 16) { want(w, 5); out.flags = Buffer.from(v).readUInt32LE(0); }
  });
  return out;
}
function scopeSpans(buf) {
  const out = {spans: []};
  fields(buf, (n, w, v) => {
    if (n === 1) { want(w, 2); const scope = {}; fields(v, (m, mw, item) => {
      if (owner(scope, 3, 4, m, mw, item)) return;
      if (m === 1) { want(mw, 2); scope.name = text(item); } else if (m === 2) { want(mw, 2); scope.version = text(item); }
    }); out.scope = scope; }
    else if (n === 2) { want(w, 2); out.spans.push(span(v)); }
    else if (n === 3) { want(w, 2); out.schemaUrl = text(v); }
  });
  return out;
}
function resourceSpans(buf) {
  const out = {scopeSpans: []};
  fields(buf, (n, w, v) => {
    if (n === 1) { want(w, 2); const resource = {}; fields(v, (m, mw, item) => { owner(resource, 1, 2, m, mw, item); }); out.resource = resource; }
    else if (n === 2) { want(w, 2); out.scopeSpans.push(scopeSpans(v)); }
    else if (n === 3) { want(w, 2); out.schemaUrl = text(v); }
  });
  return out;
}
/** ExportTraceServiceRequest bytes → {resourceSpans:[…]} in OTLP/JSON field names. Throws ProtobufError. */
export function decodeTraceRequest(bytes) {
  const out = {resourceSpans: []};
  try { fields(bytes, (n, w, v) => { if (n === 1) { want(w, 2); out.resourceSpans.push(resourceSpans(v)); } }); }
  catch (error) { if (error instanceof ProtobufError || error instanceof RangeError) bad(); throw error; }
  return out;
}
function encodeVarint(value) {
  const out = []; let v = BigInt.asUintN(64, BigInt(value));
  do { const byte = Number(v & 0x7fn); v >>= 7n; out.push(v ? byte | 0x80 : byte); } while (v);
  return Buffer.from(out);
}
const lengthDelimited = (number, bytes) => Buffer.concat([encodeVarint(number << 3 | 2), encodeVarint(bytes.length), bytes]);
const varintField = (number, value) => Buffer.concat([encodeVarint(number << 3), encodeVarint(value)]);
/** ExportTraceServiceResponse; full success is the empty message. */
export function encodeTraceResponse({rejectedSpans = 0, errorMessage = ''} = {}) {
  const partial = Buffer.concat([...(rejectedSpans ? [varintField(1, rejectedSpans)] : []), ...(errorMessage ? [lengthDelimited(2, Buffer.from(errorMessage))] : [])]);
  return partial.length ? lengthDelimited(1, partial) : Buffer.alloc(0);
}
/** google.rpc.Status, the OTLP/HTTP error body. */
export function encodeStatus(code, message) {
  return Buffer.concat([varintField(1, code), lengthDelimited(2, Buffer.from(message))]);
}
