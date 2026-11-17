// Copyright (c) ZenML GmbH 2026. All Rights Reserved.
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Modified for SupaTrace: pure bounded query builder; no environment credentials,
// polling, concurrency, session merging or SDK. Source and changes: provenance.json.
export const METADATA_FIELDS = 'id, project_id, root_span_id, span_id, span_parents, created, metrics, span_attributes, _xact_id';
const literal = value => "'" + value.replaceAll("'", "''") + "'";

// Derived from Kitaru _query_spans_batch / _query_rows. The caller validates scope.
// Stable _pagination_key sorting preserves Braintrust pagination support.
export function braintrustQuery(scope, cursor = null) {
  const roots = scope.rootSpanIds.map(id => `(root_span_id = ${literal(id)})`).join(' OR ');
  let query = `select: ${scope.content === 'include' ? '*' : METADATA_FIELDS} | from: project_logs(${literal(scope.sourceProject)}) spans | filter: ${roots} | sort: _pagination_key asc | limit: ${scope.pageSize}`;
  if (cursor !== null) query += ` | cursor: ${literal(cursor)}`;
  return {query, fmt: 'json'};
}
