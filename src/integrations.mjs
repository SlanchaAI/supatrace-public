// In-app Integrations: what has actually arrived in this workspace, grouped by the path that wrote it, and the state of
// import jobs. Read-only and derived from rows that already exist (the run catalog, the import job ledger, server-pull
// rows); nothing is written and no new counter is kept.
//
// A trace is attributed to a source by the id prefix that path gives its traces. Uploads through POST /api/batches choose
// their own trace ids, so a client that names a trace with one of these prefixes is counted under that source.
import {json} from './http.mjs';

export const INTEGRATION_SOURCES = Object.freeze([
  {id: 'otlp', prefix: 'otlp.', kind: 'ingest', name: 'OpenTelemetry (OTLP)', note: 'Spans sent to the OTLP receiver. Langfuse SDK traces that carry an OpenTelemetry trace id are stored under the same traces and counted here.', guide: '/docs/frameworks/opentelemetry/#otlp'},
  {id: 'langfuse', prefix: 'lf.', kind: 'ingest and import', name: 'Langfuse', note: 'Traces sent by a Langfuse SDK and traces imported from Langfuse.', guide: '/docs/importers/#langfuse'},
  {id: 'import-files', prefix: 'imp.', kind: 'import', name: 'Imported files and API pulls', note: 'LangSmith, Braintrust, Weave, Opik, Datadog LLM Observability, MLflow, Helicone and OTLP JSON exports converted by the local importers.', guide: '/docs/importers/#files'},
  {id: 'claude-hooks', prefix: 'claude-', kind: 'ingest', name: 'Claude Code hooks', note: 'Events recorded by the opt-in Claude Code command hook.', guide: '/docs/importers/#claude'},
  {id: 'uploads', prefix: null, kind: 'ingest', name: 'SDK and direct uploads', note: 'Batches uploaded with a write key: the SDKs, the agent uploader and anything else that does not use one of the paths above.', guide: '/docs/quickstart/'}
]);
// Job states that need a person to look, as opposed to finished or in progress.
const ATTENTION = new Set(['reconciliation_required', 'cancellation_requested', 'bounded_incomplete', 'conversion_rejected']);
const DONE = new Set(['readback_verified', 'complete', 'empty', 'cancelled', 'revoked']);
const SCAN_PAGES = 8, JOB_ROWS = 32;
const iso = seconds => Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export const integrationSource = runId => INTEGRATION_SOURCES.find(source => source.prefix !== null && typeof runId === 'string' && runId.startsWith(source.prefix)) ?? INTEGRATION_SOURCES[INTEGRATION_SOURCES.length - 1];

function jobView(row) {
  if (typeof row?.sk !== 'string') return null;
  if (row.sk.startsWith('IMPORTJOB#') && /^ij_[a-f0-9]{64}$/.test(row.job_id ?? '') && typeof row.state === 'string')
    return {id: row.job_id, kind: 'import_job', provider: 'langfuse', status: row.state, created_at: iso(row.created_at), progress: {pages: count(row.pages), rows: count(row.rows), staged_batches: Array.isArray(row.stage?.batches) ? row.stage.batches.length : 0, verified_batches: count(row.verified_batches)}};
  // A server-pull row is created with a one-hour consent window; that start is the only time it records.
  if (row.sk.startsWith('SERVERPULL#') && /^[a-f0-9]{64}$/.test(row.fingerprint ?? '') && typeof row.phase === 'string')
    return {id: 'sp_' + row.fingerprint, kind: 'server_pull', provider: 'langfuse', status: row.phase, created_at: iso(Number.isSafeInteger(row.expires_at) ? row.expires_at - 3600 : null), progress: {pages: Array.isArray(row.checkpoint?.pages) ? row.checkpoint.pages.length : 0, rows: Array.isArray(row.checkpoint?.pages) ? row.checkpoint.pages.reduce((n, page) => n + (Array.isArray(page?.data) ? page.data.length : 0), 0) : 0, staged_batches: 0, verified_batches: count(row.index)}};
  return null;
}
async function importJobs(base, tenant) {
  const jobs = []; let truncated = false;
  for (const [prefix, limit] of [['IMPORTJOB#', JOB_ROWS], ['SERVERPULL#', 8]]) { // server-pull rows carry their checkpoint, so they are read a few at a time
    let cursor = null, rows = 0;
    for (let page = 0; page < 4; page++) {
      const result = await base._page('TENANT#' + tenant, prefix, {cursor, limit});
      for (const row of result.items) { rows++; const view = jobView(row); if (view) jobs.push(view); }
      cursor = result.next; if (!cursor || rows >= JOB_ROWS) break;
    }
    if (cursor) truncated = true;
  }
  jobs.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.id.localeCompare(b.id));
  return {jobs: jobs.map(job => ({...job, state: ATTENTION.has(job.status) ? 'attention' : DONE.has(job.status) ? 'finished' : 'in_progress'})), truncated};
}

/** GET /api/integrations. `store` is the environment-scoped store; `base` the unscoped one (import jobs live in the Default environment only). */
export async function integrationsApi({store, base, tenant, actor, environment, capabilities}) {
  const totals = new Map(INTEGRATION_SOURCES.map(source => [source.id, {traces: 0, error_traces: 0, unknown_error_traces: 0, first: null, last: null, last_error: null}]));
  let cursor, scanned = 0, truncated = false;
  for (let page = 0; page < SCAN_PAGES; page++) {
    const result = await store.listRuns(tenant, {cursor, limit: 100});
    for (const row of result.items) {
      const total = totals.get(integrationSource(row.run_id).id), at = Number.isFinite(row.created_at) ? row.created_at : null;
      scanned++; total.traces++;
      if (at !== null) { total.first = total.first === null ? at : Math.min(total.first, at); total.last = total.last === null ? at : Math.max(total.last, at); }
      // A run stored before error summaries were kept has no has_error. That is unknown, not error-free.
      if (typeof row.has_error !== 'boolean') total.unknown_error_traces++;
      if (row.has_error === true) { total.error_traces++; if (at !== null) total.last_error = total.last_error === null ? at : Math.max(total.last_error, at); }
    }
    if (!result.next) { truncated = false; break; }
    cursor = result.next; truncated = page === SCAN_PAGES - 1;
  }
  // Import jobs belong to the signed-in account's own workspace and its Default environment, as /api/imports does.
  const ownDefault = tenant === actor && environment === 'default';
  const listed = ownDefault ? await importJobs(base, tenant) : {jobs: [], truncated: false};
  return json({
    workspace_id: tenant, environment_id: environment, directory: '/integrations/',
    sources: INTEGRATION_SOURCES.map(({id, kind, name, note, guide}) => { const total = totals.get(id); return {id, kind, name, note, guide, traces: total.traces, error_traces: total.error_traces, unknown_error_traces: total.unknown_error_traces, first_received_at: iso(total.first), last_received_at: iso(total.last), last_error_trace_at: iso(total.last_error)}; }),
    scanned: {traces: scanned, truncated},
    import_jobs: {scope: ownDefault ? 'listed' : 'own_default_environment_only', job_control_available: capabilities.job_control_available === true, server_pull_available: capabilities.server_pull_available === true, ...listed}
  });
}
