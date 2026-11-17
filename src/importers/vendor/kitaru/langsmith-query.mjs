// Copyright (c) ZenML GmbH 2026. All Rights Reserved.
// Licensed under Apache-2.0; see LICENSE and langsmith-provenance.json.
// Modified for SupaTrace: completed, explicitly selected traces only. The query
// builder is SupaTrace code for the current v2 API, not Kitaru's legacy SDK call.
export const METADATA_SELECTS = Object.freeze(['ID', 'PROJECT_ID', 'TRACE_ID', 'PARENT_RUN_IDS', 'IS_ROOT', 'RUN_TYPE', 'STATUS', 'START_TIME', 'END_TIME', 'PROMPT_TOKENS', 'COMPLETION_TOKENS', 'PROMPT_TOKEN_DETAILS', 'COMPLETION_TOKEN_DETAILS']);
export const CONTENT_SELECTS = Object.freeze([...METADATA_SELECTS, 'NAME', 'ERROR', 'INPUTS', 'OUTPUTS', 'EXTRA', 'METADATA', 'EVENTS', 'TAGS', 'DOTTED_ORDER', 'THREAD_ID', 'REFERENCE_EXAMPLE_ID', 'MANIFEST']);

export function langsmithQuery(scope, traceId, cursor = null) {
  return {project_ids: [scope.sourceProject], trace_id: traceId,
    min_start_time: scope.minStartTime, max_start_time: scope.maxStartTime,
    page_size: scope.pageSize, include_subtree_usage: false,
    selects: [...(scope.content === 'include' ? CONTENT_SELECTS : METADATA_SELECTS)],
    ...(cursor === null ? {} : {cursor})};
}

// Port of Kitaru _trace_has_ended. SupaTrace additionally validates status,
// explicit bounds, ancestry and duplicates before conversion or staging.
export function traceHasEnded(runs, traceId) {
  return runs.some(run => run.id === traceId) && runs.every(run => run.end_time != null);
}
