// OpenAPI 3.1 description of the management API, served at /api/v1/openapi.json.
// tests/management-api.test.mjs calls every operation listed here against the handler and
// checks each response against its schema, so this file cannot drift from the code silently.
const error = description => ({description, content: {'application/json': {schema: {$ref: '#/components/schemas/Error'}}}});
const ok = schema => ({description: 'OK', content: {'application/json': {schema: {$ref: '#/components/schemas/' + schema}}}});
const workspace = {name: 'workspace', in: 'query', schema: {type: 'string'}, description: 'Workspace id. Defaults to the token owner\'s own workspace.'};
const project = {name: 'project', in: 'query', schema: {type: 'string'}, description: 'Project id. Defaults to the workspace default project; a secret key defaults to its bound project.'};
const environment = {name: 'environment', in: 'query', schema: {type: 'string'}, description: 'Environment id. Defaults to `default`.'};
const after = {name: 'after', in: 'query', schema: {type: 'string'}, description: 'Cursor from the previous page\'s `next`.'};
const common = {401: error('Missing, unknown, expired or revoked token'), 429: error('Rate limited; see Retry-After')};
const iso = {type: 'string', format: 'date-time'}, nullableIso = {type: ['string', 'null'], format: 'date-time'}, nullableInt = {type: ['integer', 'null']};
export const MANAGEMENT_OPENAPI = Object.freeze({
  openapi: '3.1.0',
  info: {title: 'SupaTrace Management API', version: '1.0.0-alpha', description: 'Read-only alpha. Authenticate with a personal access token created in the dashboard (Settings). Send it as `Authorization: Bearer <token>`; on https://supatrace.dev send it as `X-Supatrace-Key: <token>`, because the hosted edge replaces the Authorization header. Errors are `{"error": "<code>"}`.'},
  servers: [{url: '/'}],
  security: [{bearerToken: []}, {keyHeader: []}],
  paths: {
    '/api/v1/me': {get: {operationId: 'getMe', summary: 'The account and token making the request', responses: {200: ok('Me'), ...common}}},
    '/api/v1/workspaces': {get: {operationId: 'listWorkspaces', summary: 'Workspaces the account can open', responses: {200: ok('WorkspaceList'), ...common}}},
    '/api/v1/projects': {get: {operationId: 'listProjects', summary: 'Projects the account can open', responses: {200: ok('ProjectList'), ...common}}},
    '/api/v1/keys': {get: {operationId: 'listKeys', summary: 'Write keys of a workspace environment (owner or admin)', parameters: [workspace, project, environment, after], responses: {200: ok('KeyList'), ...common, 403: error('Viewer role, or workspace not available')}}},
    '/api/v1/usage': {get: {operationId: 'getUsage', summary: 'Storage use and plan of a workspace', parameters: [workspace], responses: {200: ok('Usage'), ...common, 403: error('Workspace not available')}}},
    '/api/v1/logs': {get: {operationId: 'listIngestLog', summary: 'Recorded upload attempts of a workspace environment, newest first', parameters: [workspace, project, environment,
      {name: 'stream', in: 'query', schema: {type: 'string', enum: ['issues', 'accepted'], default: 'issues'}, description: '`issues`: refused and partly stored requests. `accepted`: fully stored requests.'},
      {name: 'route', in: 'query', schema: {type: 'string', enum: ['batches', 'otlp', 'langfuse']}}, {name: 'reason', in: 'query', schema: {type: 'string'}, description: 'Exact reason code.'},
      {name: 'from', in: 'query', schema: iso}, {name: 'to', in: 'query', schema: iso}, {name: 'limit', in: 'query', schema: {type: 'integer', minimum: 1, maximum: 200, default: 50}}, after],
      responses: {200: ok('IngestLog'), ...common, 400: error('Invalid query'), 403: error('Workspace not available')}}},
    '/api/v1/traces': {get: {operationId: 'listTraces', summary: 'Traces (runs) of a workspace environment', parameters: [workspace, project, environment,
      {name: 'limit', in: 'query', schema: {type: 'integer', minimum: 1, maximum: 100, default: 25}}, {name: 'offset', in: 'query', schema: {type: 'integer', minimum: 0, maximum: 100000, default: 0}},
      {name: 'sort', in: 'query', schema: {type: 'string', enum: ['started', 'agent', 'duration', 'events', 'status'], default: 'started'}}, {name: 'dir', in: 'query', schema: {type: 'string', enum: ['asc', 'desc'], default: 'desc'}},
      {name: 'q', in: 'query', schema: {type: 'string'}, description: 'Substring of the trace id.'}, {name: 'from', in: 'query', schema: iso}, {name: 'to', in: 'query', schema: iso}],
      responses: {200: ok('TraceList'), ...common, 400: error('Invalid query'), 403: error('Workspace not available')}}},
    '/api/v1/traces/{trace_id}/events': {get: {operationId: 'listTraceEvents', summary: 'Events (spans) of one trace, one stored batch per page', parameters: [{name: 'trace_id', in: 'path', required: true, schema: {type: 'string'}}, workspace, project, environment, after],
      responses: {200: ok('EventPage'), ...common, 403: error('Workspace not available')}}},
  },
  components: {
    securitySchemes: {bearerToken: {type: 'http', scheme: 'bearer', description: 'Personal access token (`stpat_…`). A secret key (`st_sec_…`) is accepted on the traces and events routes for its own workspace and environment only.'}, keyHeader: {type: 'apiKey', in: 'header', name: 'X-Supatrace-Key', description: 'The same token, for the hosted edge.'}},
    schemas: {
      Error: {type: 'object', required: ['error'], properties: {error: {type: 'string'}}},
      Me: {type: 'object', required: ['account_id', 'token'], properties: {account_id: {type: 'string'}, token: {type: 'object', required: ['id', 'name', 'scope', 'expires_at'], properties: {id: {type: 'string'}, name: {type: 'string'}, scope: {type: 'string', enum: ['read']}, expires_at: iso}}}},
      WorkspaceList: {type: 'object', required: ['workspaces'], properties: {workspaces: {type: 'array', items: {type: 'object', required: ['id', 'name', 'role', 'shared'], properties: {id: {type: 'string'}, name: {type: 'string'}, role: {type: 'string', enum: ['owner', 'admin', 'viewer']}, shared: {type: 'boolean'}}}}}},
      ProjectList: {type: 'object', required: ['projects'], properties: {projects: {type: 'array', items: {type: 'object', required: ['id', 'name', 'workspace_id', 'role'], properties: {id: {type: 'string'}, name: {type: 'string'}, workspace_id: {type: 'string'}, role: {type: 'string'}}}}}},
      KeyList: {type: 'object', required: ['keys', 'next'], properties: {next: {type: ['string', 'null']}, environment_id: {type: 'string'}, keys: {type: 'array', items: {type: 'object', required: ['id', 'project_id', 'scope', 'environment_id', 'revoked'], properties: {id: {type: 'string', description: 'SHA-256 of the key; the key itself is never returned.'}, project_id: {type: 'string'}, scope: {type: 'string'}, environment_id: {type: 'string'}, authorization_active: {type: 'boolean'}, expires_at: {type: 'integer'}, revoked: {type: 'boolean'}, created_at: {type: 'integer'}}}}}},
      Usage: {type: 'object', required: ['quota_scope', 'storage'], properties: {quota_scope: {type: 'object', required: ['workspace_id', 'project_id'], properties: {workspace_id: {type: 'string'}, project_id: {type: 'string'}, environment_id: {type: 'string'}}}, storage: {type: 'object', required: ['used_bytes', 'limit_bytes', 'remaining_bytes'], properties: {used_bytes: {type: 'integer'}, limit_bytes: {type: 'integer'}, remaining_bytes: {type: 'integer'}}}, billing: {type: 'object'}, commercial: {type: 'object'}, account_plan: {type: 'object'}, plan_configuration: {type: 'object'}}},
      TraceList: {type: 'object', required: ['runs', 'total', 'offset', 'limit', 'next'], properties: {total: {type: 'integer'}, offset: {type: 'integer'}, limit: {type: 'integer'}, truncated: {type: 'boolean'}, next: {type: ['string', 'null']}, environment_id: {type: 'string'},
        runs: {type: 'array', items: {type: 'object', required: ['id', 'created_at', 'status'], properties: {id: {type: 'string'}, created_at: iso, started_at: nullableIso, ended_at: nullableIso, duration_ms: nullableInt, event_count: nullableInt, batch_count: nullableInt, byte_count: nullableInt, agents: {type: 'array', items: {type: 'string'}}, status: {type: ['string', 'null'], enum: ['ok', 'error', null]}}}}}},
      IngestLog: {type: 'object', required: ['workspace_id', 'environment_id', 'stream', 'retention_days', 'attempts', 'next', 'truncated'], properties: {workspace_id: {type: 'string'}, environment_id: {type: 'string'}, stream: {type: 'string', enum: ['issues', 'accepted']}, retention_days: {type: 'integer'}, routes: {type: 'array', items: {type: 'string'}},
        recorded: {type: 'object', description: 'What the log does and does not hold: refusals are recorded up to a per-minute rate, requests without a valid key are not recorded, and a row can be missing.', properties: {issues_per_minute: {type: 'integer'}, unauthenticated_requests: {type: 'boolean'}, best_effort: {type: 'boolean'}}},
        next: {type: ['string', 'null']}, truncated: {type: 'boolean', description: 'The read stopped at its row limit with rows left; continue with `next`.'},
        attempts: {type: 'array', items: {type: 'object', required: ['id', 'time', 'route', 'outcome', 'http_status', 'reason'], properties: {id: {type: 'string'}, time: iso, route: {type: 'string', enum: ['batches', 'otlp', 'langfuse']}, outcome: {type: 'string', enum: ['accepted', 'partial', 'rejected']}, http_status: {type: 'integer'},
          reason: {type: ['string', 'null'], description: 'Reason code; null for an accepted request.'}, message: {type: ['string', 'null']}, detail: {type: ['string', 'null']}, key_prefix: {type: ['string', 'null'], description: 'First 12 characters of the key id.'},
          batches: nullableInt, repeated_batches: nullableInt, stored_events: nullableInt, rejected_events: nullableInt, stored_bytes: nullableInt, stored_trace_id: {type: ['string', 'null'], description: 'The trace the request stored events for, when that was exactly one trace. A trace whose events were all refused is not named.'}, stored_trace_count: {type: ['integer', 'null'], description: 'Traces the request stored events for.'}}}}}},
      EventPage: {type: 'object', required: ['events', 'next'], properties: {next: {type: ['string', 'null']}, environment_id: {type: 'string'}, events: {type: 'array', items: {type: 'object', required: ['id', 'time', 'kind', 'name', 'data'], properties: {id: {type: 'string'}, time: iso, kind: {type: 'string', enum: ['request', 'tool_call', 'tool_result', 'response', 'error', 'note']}, name: {type: 'string'}, data: {}}}}}},
    },
  },
});
