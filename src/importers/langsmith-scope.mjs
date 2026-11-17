// Pure scope contract shared with the dashboard. No I/O or credentials.
export const LANGSMITH_ORIGINS = Object.freeze(['https://api.smith.langchain.com', 'https://eu.api.smith.langchain.com']);
const fail = code => { throw Error(code); };
const object = v => v && Object.getPrototypeOf(v) === Object.prototype;
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function timestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) fail('langsmith_invalid_timestamp');
  const milliseconds = Date.parse(match[1] + 'Z');
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || new Date(milliseconds).toISOString().slice(0, 19) !== match[1]) fail('langsmith_invalid_timestamp');
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
export function normalizeLangsmithScope(spec) {
  const defaults = {content: 'metadata', pageSize: 100, maxPages: 100, maxRows: 1000, maxBytes: 12 * 1024 * 1024, maxRetries: 2};
  const keys = ['origin', 'sourceWorkspace', 'sourceProject', 'destinationProject', 'namespace', 'traceIds', 'minStartTime', 'maxStartTime', ...Object.keys(defaults)];
  if (!object(spec) || Object.keys(spec).some(k => !keys.includes(k))) fail('langsmith_explicit_scope_required');
  const scope = {...defaults, ...spec};
  if (!LANGSMITH_ORIGINS.includes(scope.origin) || !uuid(scope.sourceProject) || !uuid(scope.sourceWorkspace) || !/^proj_[a-f0-9]{32}$/.test(scope.destinationProject ?? '') || typeof scope.namespace !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(scope.namespace)) fail('langsmith_invalid_scope');
  if (!Array.isArray(scope.traceIds) || !scope.traceIds.length || scope.traceIds.length > 25 || scope.traceIds.some(v => !uuid(v)) || new Set(scope.traceIds).size !== scope.traceIds.length) fail('langsmith_explicit_traces_required');
  if (!['metadata', 'include'].includes(scope.content)) fail('langsmith_content_policy_required');
  const start = timestamp(scope.minStartTime), end = timestamp(scope.maxStartTime);
  if (end <= start || end - start > 401n * 86400n * 1000000000n) fail('langsmith_invalid_time_window');
  for (const [k, max] of Object.entries({pageSize: 1000, maxPages: 1000, maxRows: 1000, maxBytes: 12 * 1024 * 1024, maxRetries: 5})) if (!Number.isInteger(scope[k]) || scope[k] < (k === 'maxRetries' ? 0 : 1) || scope[k] > max) fail('langsmith_invalid_bounds');
  scope.traceIds = [...scope.traceIds].sort();
  return scope;
}
