import {
  createHash
} from 'node:crypto';
export const LIMITS = Object.freeze({
  bytes: 524288,
  events: 100,
  text: 32768
});
export class IntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const id = (value, field) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new IntakeError(
    'invalid_id', `Invalid ${field}`);
  return value;
};

function depthCheck(root) {
  const stack = [
    [root, 0]
  ];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))))
    throw new IntakeError('unsupported_number', 'Non-finite or unsafe integer values must be encoded as strings');
    if (d > 32) throw new IntakeError('too_deep', 'JSON nesting exceeds 32');
    if (v && typeof v === 'object')
      for (const child of Object.values(v)) stack.push([child, d + 1]);
  }
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function parseBatch(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.bytes) throw new IntakeError('too_large',
    'Batch exceeds 512 KiB');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new IntakeError('invalid_json', 'Invalid JSON');
  }
  depthCheck(body);
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.version !== 1) throw new IntakeError(
    'invalid_version', 'Expected version 1');
  if (Object.keys(body).some(k => !['version', 'batch_id', 'run_id', 'events'].includes(k))) throw new IntakeError(
    'unknown_field', 'Unexpected batch field');
  id(body.batch_id, 'batch_id');
  id(body.run_id, 'run_id');
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > LIMITS.events)
  throw new IntakeError('invalid_count', 'Expected 1–100 events');
  const seen = new Set();
  const events = body.events.map(e => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new IntakeError('invalid_event',
      'Expected event object');
    if (Object.keys(e).some(k => !['id', 'time', 'kind', 'name', 'data'].includes(k))) throw new IntakeError(
      'unknown_field', 'Unexpected event field');
    id(e.id, 'event id');
    if (seen.has(e.id)) throw new IntakeError('duplicate_event', 'Duplicate event id');
    seen.add(e.id);
    if (typeof e.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(e.time) || !Number
      .isFinite(Date.parse(e.time))) throw new IntakeError('invalid_time', 'Expected ISO timestamp with timezone');
    if (!['request', 'tool_call', 'tool_result', 'response', 'error', 'note'].includes(e.kind))
    throw new IntakeError('invalid_kind', 'Unsupported event kind');
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 200) throw new IntakeError('invalid_name',
      'Name must contain 1–200 characters');
    if (e.data === undefined || Buffer.byteLength(JSON.stringify(e.data)) > LIMITS.text) throw new IntakeError(
      'invalid_data', 'Data must be JSON, at most 32 KiB');
    return {
      id: e.id,
      time: new Date(e.time).toISOString(),
      kind: e.kind,
      name: e.name,
      data: e.data
    };
  });
  const normalized = {
    version: 1,
    batch_id: body.batch_id,
    run_id: body.run_id,
    events
  };
  return {
    batch: normalized,
    content_hash: hash(normalized)
  };
}
