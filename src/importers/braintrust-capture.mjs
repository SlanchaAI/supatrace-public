import {hash} from './langfuse.mjs';
import {convertConnectorFile} from './connector-files.mjs';
import {retryAfterMs} from './capture-retry.mjs';

import {normalizeBraintrustScope} from './braintrust-scope.mjs';
export {BRAINTRUST_ORIGINS} from './braintrust-scope.mjs';
const fail = code => { throw Error(code); };
const object = v => v && Object.getPrototypeOf(v) === Object.prototype;
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v);
export const validCursor = v => v === null || typeof v === 'string' && v.length > 0 && v.length <= 8192 && /^[\x20-\x7e]+$/.test(v) && !v.includes('\\');
export function planBraintrustCapture(spec) {
  const scope = normalizeBraintrustScope(spec);
  return {scope, fingerprint: hash({adapter: 'braintrust-api-v1', scope})};
}

// Project every page BEFORE checkpointing. A provider ignoring the requested fields
// cannot cause prompts, arbitrary metric/attribute values or names to reach disk.
export function projectBraintrustRow(row, scope) {
  if (!object(row) || row.project_id !== scope.sourceProject || !scope.rootSpanIds.includes(row.root_span_id) || !identifier(row.span_id) || !identifier(row.id)) fail('braintrust_row_scope_mismatch');
  if (row.span_parents != null && (!Array.isArray(row.span_parents) || row.span_parents.length > 32 || row.span_parents.some(v => !identifier(v)))) fail('braintrust_invalid_parents');
  const metrics = row.metrics ?? (row.span_attributes?.type === 'log' ? {} : null);
  if (!object(metrics) || metrics.start != null && (!Number.isFinite(metrics.start) || metrics.start <= 0)) fail('braintrust_invalid_timing');
  if (row.span_attributes != null && !object(row.span_attributes)) fail('braintrust_invalid_attributes');
  if (row.span_attributes?.type !== 'log' && (!Number.isFinite(metrics.end) || metrics.end <= 0 || metrics.start != null && metrics.end < metrics.start)) fail('braintrust_unfinished_span');
  if (scope.content === 'include') return JSON.parse(JSON.stringify(row));
  const result = {id: row.id, project_id: row.project_id, root_span_id: row.root_span_id, span_id: row.span_id, span_parents: row.span_parents ?? [], metrics: {}};
  if (row.created != null) {
    if (typeof row.created !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(row.created) || !Number.isFinite(Date.parse(row.created))) fail('braintrust_invalid_created');
    result.created = row.created;
  }
  for (const k of ['start', 'end', 'prompt_tokens', 'completion_tokens', 'prompt_cached_tokens', 'prompt_cache_creation_tokens', 'completion_reasoning_tokens']) if (metrics[k] != null) {
    const value = metrics[k];
    if (!Number.isFinite(value) || value < 0 || !['start', 'end'].includes(k) && !Number.isSafeInteger(value)) fail('braintrust_invalid_metric');
    result.metrics[k] = value;
  }
  const attrs = {};
  if (['llm', 'tool', 'log', 'score', 'automation', 'facet', 'classifier', 'preprocessor', 'review'].includes(row.span_attributes?.type)) attrs.type = row.span_attributes.type;
  if (row.span_attributes?.purpose === 'scorer') attrs.purpose = 'scorer';
  result.span_attributes = attrs;
  if (row._xact_id != null) { if (!identifier(row._xact_id)) fail('braintrust_invalid_revision'); result._xact_id = row._xact_id; }
  return result;
}
function validateState(state, plan) {
  const {scope, fingerprint} = plan;
  if (!object(state) || Object.keys(state).sort().join() !== 'complete,fingerprint,pages,version' || state.version !== 1 || state.fingerprint !== fingerprint || !Array.isArray(state.pages) || state.pages.length > scope.maxPages || typeof state.complete !== 'boolean') fail('braintrust_checkpoint_mismatch');
  let cursor = null, count = 0, bytes = 0;
  const seen = new Set();
  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    if (!object(page) || Object.keys(page).sort().join() !== 'cursorIn,cursorOut,hash,rows' || page.cursorIn !== cursor || !validCursor(page.cursorOut) || !Array.isArray(page.rows) || page.rows.length > scope.pageSize || i > 0 && cursor === null) fail('braintrust_invalid_checkpoint_page');
    const projected = page.rows.map(row => projectBraintrustRow(row, scope));
    if (hash(projected) !== hash(page.rows) || page.hash !== hash({cursorIn: page.cursorIn, cursorOut: page.cursorOut, rows: page.rows})) fail('braintrust_checkpoint_hash_mismatch');
    if (page.cursorOut !== null && (seen.has(page.cursorOut) || !page.rows.length)) fail('braintrust_cursor_cycle');
    if (page.cursorOut !== null) seen.add(page.cursorOut);
    count += page.rows.length; bytes += Buffer.byteLength(JSON.stringify(page)); cursor = page.cursorOut;
  }
  if (count > scope.maxRows || bytes > scope.maxBytes || state.complete !== (state.pages.length > 0 && cursor === null)) fail('braintrust_checkpoint_bounds_or_completion_invalid');
  return {cursor, count, bytes};
}

export function convertBraintrustCapture(state, spec) {
  const plan = planBraintrustCapture(spec); validateState(state, plan);
  if (!state.complete) fail('braintrust_capture_incomplete');
  const rows = state.pages.flatMap(p => p.rows), spans = new Map();
  const spanKey = (root, span) => JSON.stringify([root, span]);
  for (const row of rows) if (row.span_attributes?.type !== 'log') spans.set(spanKey(row.root_span_id, row.span_id), row);
  for (const root of plan.scope.rootSpanIds) {
    const row = spans.get(spanKey(root, root));
    if (!row || row.span_parents?.length) fail('braintrust_requested_root_missing');
  }
  for (const row of rows) for (const parent of row.span_parents ?? []) if (!spans.has(spanKey(row.root_span_id, parent))) fail('braintrust_parent_missing');
  const converted = convertConnectorFile(JSON.stringify({data: rows}), {format: 'braintrust', namespace: plan.scope.namespace, content: plan.scope.content});
  if (converted.report.rejected.length) fail('braintrust_conversion_rejected');
  return converted;
}

// Transport owns ephemeral credentials, per-wire authorization and total deadlines.
// Save-before-next-page: interrupted reads can repeat a GET-like query, never an upload.
export async function captureBraintrust(spec, {transport, checkpoint = null, saveCheckpoint, signal} = {}) {
  const plan = planBraintrustCapture(spec);
  if (!transport || typeof transport.checkpoint !== 'function' || typeof saveCheckpoint !== 'function') fail('braintrust_capture_dependencies_required');
  let state = checkpoint ? JSON.parse(JSON.stringify(checkpoint)) : {version: 1, fingerprint: plan.fingerprint, pages: [], complete: false};
  let totals = validateState(state, plan);
  while (!state.complete) {
    if (signal?.aborted) fail('braintrust_cancelled');
    if (state.pages.length >= plan.scope.maxPages || totals.count >= plan.scope.maxRows) fail('braintrust_capture_bound_incomplete');
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await transport.request(totals.cursor, signal);
      if (response.status === 200) break;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= plan.scope.maxRetries) fail('braintrust_source_request_failed');
      const delay = response.retryAfter === null ? 1000 * 2 ** attempt : retryAfterMs(response.retryAfter);
      await transport.wait(delay, signal);
    }
    const data = response.data;
    if (!object(data) || !Array.isArray(data.data) || data.data.length > plan.scope.pageSize) fail('braintrust_page_invalid');
    const bodyCursor = data.cursor ?? null, headerCursor = response.cursor ?? null;
    if (!validCursor(bodyCursor) || !validCursor(headerCursor) || bodyCursor !== null && headerCursor !== null && bodyCursor !== headerCursor) fail('braintrust_cursor_invalid_or_conflicting');
    const cursorOut = headerCursor ?? bodyCursor;
    const page = {cursorIn: totals.cursor, cursorOut, rows: data.data.map(row => projectBraintrustRow(row, plan.scope))};
    page.hash = hash(page);
    const candidate = {...state, pages: [...state.pages, page], complete: cursorOut === null};
    totals = validateState(candidate, plan);
    if (signal?.aborted) fail('braintrust_cancelled');
    await transport.checkpoint(JSON.parse(JSON.stringify(candidate)), saveCheckpoint, signal);
    state = candidate;
  }
  return {plan, checkpoint: state, converted: convertBraintrustCapture(state, plan.scope), coverage: 'requested-completed-traces-paginated-no-snapshot-guarantee'};
}
