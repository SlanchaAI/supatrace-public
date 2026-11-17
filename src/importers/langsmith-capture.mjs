import {hash} from './langfuse.mjs';
import {convertConnectorFile} from './connector-files.mjs';
import {retryAfterMs} from './capture-retry.mjs';
import {traceHasEnded} from './vendor/kitaru/langsmith-query.mjs';

import {normalizeLangsmithScope, timestamp} from './langsmith-scope.mjs';
export {LANGSMITH_ORIGINS} from './langsmith-scope.mjs';
const fail = code => { throw Error(code); };
const object = v => v && Object.getPrototypeOf(v) === Object.prototype;
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const validCursor = v => v === null || typeof v === 'string' && v.length > 0 && v.length <= 8192 && /^[\x20-\x7e]+$/.test(v) && !v.includes('\\');
export function planLangsmithCapture(spec) {
  const scope = normalizeLangsmithScope(spec);
  return {scope, fingerprint: hash({adapter: 'langsmith-api-v2-v1', scope})};
}

// Strict projection BEFORE checkpointing, even if the server ignores selects.
export function projectLangsmithRow(row, scope, traceId) {
  if (!object(row) || row.project_id !== scope.sourceProject || row.trace_id !== traceId || !scope.traceIds.includes(traceId) || !uuid(row.id)) fail('langsmith_row_scope_mismatch');
  if (!Array.isArray(row.parent_run_ids) || row.parent_run_ids.length > 128 || row.parent_run_ids.some(v => !uuid(v)) || new Set(row.parent_run_ids).size !== row.parent_run_ids.length || row.parent_run_ids.includes(row.id)) fail('langsmith_invalid_ancestors');
  if (typeof row.is_root !== 'boolean' || row.is_root !== (row.id === traceId) || row.is_root !== (row.parent_run_ids.length === 0) || !row.is_root && row.parent_run_ids[0] !== traceId) fail('langsmith_invalid_root');
  if (!['LLM', 'CHAIN', 'TOOL', 'RETRIEVER', 'EMBEDDING', 'PROMPT', 'PARSER'].includes(row.run_type)) fail('langsmith_invalid_run_type');
  if (!['SUCCESS', 'ERROR'].includes(row.status) || row.end_time == null) fail('langsmith_unfinished_run');
  const start = timestamp(row.start_time), end = timestamp(row.end_time);
  // Bound every returned run, including the root. This cannot establish whether
  // other descendants were omitted by the API's per-run start-time filter.
  if (end < start || start < timestamp(scope.minStartTime) || end >= timestamp(scope.maxStartTime)) fail('langsmith_row_outside_window');
  const result = Object.fromEntries(['id', 'project_id', 'trace_id', 'parent_run_ids', 'is_root', 'run_type', 'status', 'start_time', 'end_time'].map(k => [k, row[k]]));
  for (const k of ['prompt_tokens', 'completion_tokens']) if (row[k] != null) {
    if (!Number.isSafeInteger(row[k]) || row[k] < 0) fail('langsmith_invalid_usage');
    result[k] = row[k];
  }
  for (const [k, allowed] of [['prompt_token_details', ['cache_read', 'cache_creation', 'cache_write', 'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']], ['completion_token_details', ['reasoning']]]) if (row[k] != null) {
    if (!object(row[k]) || Object.hasOwn(row[k], 'raw') && !object(row[k].raw)) fail('langsmith_invalid_usage_details');
    result[k] = {raw: {}};
    for (const name of allowed) if (row[k].raw?.[name] != null) {
      if (!Number.isSafeInteger(row[k].raw[name]) || row[k].raw[name] < 0) fail('langsmith_invalid_usage');
      result[k].raw[name] = row[k].raw[name];
    }
  }
  // v2 is flat. Conflicting legacy ancestry/nested records are not accepted.
  if (row.child_runs != null || row.parent_run_id != null) fail('langsmith_legacy_structure_refused');
  return JSON.parse(JSON.stringify(scope.content === 'include' ? row : result));
}

function validateState(state, plan) {
  const {scope, fingerprint} = plan;
  if (!object(state) || Object.keys(state).sort().join() !== 'complete,fingerprint,pages,version' || state.version !== 1 || state.fingerprint !== fingerprint || !Array.isArray(state.pages) || state.pages.length > scope.maxPages || typeof state.complete !== 'boolean') fail('langsmith_checkpoint_mismatch');
  let cursor = null, traceIndex = 0, count = 0, bytes = 0;
  const seen = new Set();
  for (const page of state.pages) {
    if (!object(page) || Object.keys(page).sort().join() !== 'cursorIn,cursorOut,hash,rows,traceId' || page.traceId !== scope.traceIds[traceIndex] || page.cursorIn !== cursor || !validCursor(page.cursorOut) || !Array.isArray(page.rows) || page.rows.length > scope.pageSize) fail('langsmith_invalid_checkpoint_page');
    const projected = page.rows.map(row => projectLangsmithRow(row, scope, page.traceId));
    if (hash(projected) !== hash(page.rows) || page.hash !== hash({traceId: page.traceId, cursorIn: page.cursorIn, cursorOut: page.cursorOut, rows: page.rows})) fail('langsmith_checkpoint_hash_mismatch');
    const cursorKey = JSON.stringify([page.traceId, page.cursorOut]);
    if (page.cursorOut !== null && (seen.has(cursorKey) || !page.rows.length)) fail('langsmith_cursor_cycle');
    if (page.cursorOut !== null) seen.add(cursorKey);
    count += page.rows.length; bytes += Buffer.byteLength(JSON.stringify(page)); cursor = page.cursorOut;
    if (cursor === null) traceIndex++;
  }
  if (count > scope.maxRows || bytes > scope.maxBytes || state.complete !== (traceIndex === scope.traceIds.length)) fail('langsmith_checkpoint_bounds_or_completion_invalid');
  return {cursor, traceIndex, count, bytes};
}
export function convertLangsmithCapture(state, spec) {
  const plan = planLangsmithCapture(spec); validateState(state, plan);
  if (!state.complete) fail('langsmith_capture_incomplete');
  const rows = state.pages.flatMap(p => p.rows), spans = new Map();
  for (const row of rows) {
    const old = spans.get(row.id);
    if (old && hash(old) !== hash(row)) fail('langsmith_changed_duplicate');
    spans.set(row.id, row);
  }
  for (const traceId of plan.scope.traceIds) if (!traceHasEnded(rows.filter(r => r.trace_id === traceId), traceId)) fail('langsmith_requested_root_missing');
  for (const row of spans.values()) {
    for (let i = 0; i < row.parent_run_ids.length; i++) {
      const parent = spans.get(row.parent_run_ids[i]);
      if (!parent || parent.trace_id !== row.trace_id || hash(parent.parent_run_ids) !== hash(row.parent_run_ids.slice(0, i))) fail('langsmith_ancestor_missing_or_inconsistent');
    }
    const root = spans.get(row.trace_id);
    if (timestamp(row.start_time) < timestamp(root.start_time) || timestamp(row.end_time) > timestamp(root.end_time)) fail('langsmith_run_outside_root');
  }
  const converted = convertConnectorFile(JSON.stringify(rows), {format: 'langsmith', namespace: plan.scope.namespace, content: plan.scope.content});
  if (converted.report.rejected.length) fail('langsmith_conversion_rejected');
  converted.report.losses = converted.report.losses.filter(s => s !== 'API pagination/completeness is not established by a file.');
  converted.report.sourceCoverage = {paginationComplete: true, traceMembershipVerified: false};
  converted.report.losses.push('Only returned completed runs in the selected traces/time window are paginated. Descendants outside the per-run time filter may be omitted; whole-trace membership is not verified. No point-in-time snapshot or later-write guarantee. Content mode retains returned selected fields, not attachments or every provider field.');
  return converted;
}

export async function captureLangsmith(spec, {transport, checkpoint = null, saveCheckpoint, signal} = {}) {
  const plan = planLangsmithCapture(spec);
  if (!transport || typeof transport.checkpoint !== 'function' || typeof saveCheckpoint !== 'function') fail('langsmith_capture_dependencies_required');
  let state = checkpoint ? JSON.parse(JSON.stringify(checkpoint)) : {version: 1, fingerprint: plan.fingerprint, pages: [], complete: false};
  let totals = validateState(state, plan);
  while (!state.complete) {
    if (signal?.aborted) fail('langsmith_cancelled');
    if (state.pages.length >= plan.scope.maxPages || totals.count >= plan.scope.maxRows) fail('langsmith_capture_bound_incomplete');
    const traceId = plan.scope.traceIds[totals.traceIndex];
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await transport.request(traceId, totals.cursor, signal);
      if (response.status === 200) break;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= plan.scope.maxRetries) fail('langsmith_source_request_failed');
      await transport.wait(response.retryAfter === null ? 1000 * 2 ** attempt : retryAfterMs(response.retryAfter), signal);
    }
    const data = response.data;
    if (!object(data) || !Array.isArray(data.items) || data.items.length > plan.scope.pageSize) fail('langsmith_page_invalid');
    const cursorOut = data.next_cursor === '' || data.next_cursor == null ? null : data.next_cursor;
    if (!validCursor(cursorOut)) fail('langsmith_cursor_invalid');
    const page = {traceId, cursorIn: totals.cursor, cursorOut, rows: data.items.map(row => projectLangsmithRow(row, plan.scope, traceId))};
    page.hash = hash(page);
    const candidate = {...state, pages: [...state.pages, page], complete: cursorOut === null && totals.traceIndex + 1 === plan.scope.traceIds.length};
    totals = validateState(candidate, plan);
    if (signal?.aborted) fail('langsmith_cancelled');
    await transport.checkpoint(JSON.parse(JSON.stringify(candidate)), saveCheckpoint, signal);
    state = candidate;
  }
  return {plan, checkpoint: state, converted: convertLangsmithCapture(state, plan.scope), coverage: 'returned-completed-runs-in-selected-traces-and-window', traceMembershipVerified: false};
}
