// Integrations view: what has arrived in the selected workspace and environment, by source, and the state of import jobs.
// Read-only. Everything shown comes from GET /api/integrations; an unknown or failed read is shown as such, never as zero.
// The view builds its own markup and nav link when this module is imported. app.js routes to any section it finds in
// #workspace, so adding the view needs one import there and no change to the shared page markup.
const messages = {
  rate_limit: 'The request limit was reached. Wait before trying again.',
  sign_in_required: 'Please sign in to continue.',
  workspace_access_denied: 'This account cannot open that workspace.'
};
const STATUS = {
  awaiting_bindings: 'waiting for source and upload approval', claimed: 'claimed by a worker', staged: 'staged, not uploaded', upload_consumed: 'uploading', cancellation_requested: 'cancel requested',
  cancelled: 'cancelled', reconciliation_required: 'needs reconciliation', readback_verified: 'stored and read back',
  reviewed: 'scope reviewed, not approved', consented: 'approved, not started', capturing: 'reading the source', ready: 'ready to store', reserve_consumed: 'storing', object_ready: 'storing', object_consumed: 'storing',
  ack_ready: 'storing', ack_consumed: 'storing', verifying: 'verifying', complete: 'complete', empty: 'complete, source had no rows', bounded_incomplete: 'stopped at a limit before the end', conversion_rejected: 'source data was rejected', revoked: 'approval revoked'
};
const VIEW = '<div class="view-head"><div><h2>Integrations</h2><p class="muted">Traces in this environment, grouped by source. See the <a href="/integrations/">integrations directory</a> for setup guides.</p></div><div class="bar"><button id="integrations-refresh" type="button" class="quiet">Refresh</button></div></div><p id="integrations-status" role="status" aria-live="polite"></p><p id="integrations-scan" class="hint"></p><div id="integrations-sources" class="cards" aria-label="Sources"></div><article class="card" id="integrations-jobs-card"><h2>Import jobs</h2><p id="integrations-jobs-note" class="hint"></p><ul id="integrations-jobs" class="token-list" aria-label="Import jobs"></ul></article>';

async function request(path) {
  const page = new URLSearchParams(location.search || ''), query = new URLSearchParams();
  for (const name of ['workspace', 'environment']) if (page.get(name)) query.set(name, page.get(name));
  const response = await fetch('/api/' + path + (query.size ? '?' + query : ''), {credentials: 'same-origin', cache: 'no-store'});
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(response.status === 429 ? 'rate_limit' : value?.error || 'request_failed'); error.status = response.status; throw error; }
  return value;
}
const when = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? new Date(time).toLocaleString() : null; };
const plural = (n, word) => n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's');
/** Checks the response shape. A malformed body is an error, so the view never renders a guess. */
export function validateIntegrations(data) {
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 400, number = value => Number.isSafeInteger(value) && value >= 0, time = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!data || !Array.isArray(data.sources) || !data.sources.length || data.sources.length > 20 || !data.scanned || !number(data.scanned.traces) || typeof data.scanned.truncated !== 'boolean' || !data.import_jobs || !Array.isArray(data.import_jobs.jobs) || data.import_jobs.jobs.length > 80) throw new Error('invalid_response');
  for (const source of data.sources) if (!text(source.id) || !text(source.name) || !text(source.note) || !text(source.kind) || typeof source.guide !== 'string' || !/^\/docs\/[a-z0-9/#-]*$/.test(source.guide) || !number(source.traces) || !number(source.error_traces) || !number(source.unknown_error_traces) || source.error_traces + source.unknown_error_traces > source.traces || !time(source.first_received_at) || !time(source.last_received_at) || !time(source.last_error_trace_at)) throw new Error('invalid_response');
  for (const job of data.import_jobs.jobs) if (!/^(ij|sp)_[a-f0-9]{64}$/.test(job.id ?? '') || !text(job.status) || !['attention', 'finished', 'in_progress'].includes(job.state) || !time(job.created_at) || !job.progress || !['pages', 'rows', 'staged_batches', 'verified_batches'].every(name => number(job.progress[name]))) throw new Error('invalid_response');
  return data;
}

export function mountIntegrations(document, {api = request} = {}) {
  const agents = document.getElementById('view-agents');
  if (!agents || document.getElementById('view-integrations')) return null;
  agents.insertAdjacentHTML('beforeend', '<section id="view-integrations">' + VIEW + '</section>');
  const section = document.getElementById('view-integrations');
  const $ = id => document.getElementById(id), status = $('integrations-status'), sources = $('integrations-sources'), jobs = $('integrations-jobs');
  let version = 0, loaded = false;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  function render(data) {
    $('integrations-scan').textContent = data.scanned.truncated ? `Counts and times cover the ${data.scanned.traces.toLocaleString()} retained traces read in one pass, which are not the newest ones in particular. This environment holds more, so totals are a lower bound and newer traces may exist.` : `${plural(data.scanned.traces, 'trace')} in this environment. Expired traces are not counted.`;
    sources.replaceChildren(...data.sources.map(source => {
      const card = el('article', undefined, 'card'); card.dataset.source = source.id; card.dataset.state = source.traces ? 'receiving' : 'none';
      const guide = el('a', 'Setup guide'); guide.href = source.guide; guide.setAttribute('aria-label', 'Setup guide: ' + source.name);
      const last = when(source.last_received_at), lastError = when(source.last_error_trace_at);
      // Only retained traces are read, and a partial read sees some of them. The wording claims no more than that: times are
      // "among the traces read" when the read was partial, and an empty source has no retained trace rather than "never".
      const among = data.scanned.truncated ? ' among the traces read' : '';
      card.append(el('h2', source.name), el('p', source.traces ? plural(source.traces, 'trace') + (last ? ` · newest${among} received ${last}` : '') : data.scanned.truncated ? `No trace from this source among the ${data.scanned.traces.toLocaleString()} traces read.` : 'None yet.'));
      if (source.traces) {
        const unknown = source.unknown_error_traces ? `Error state was not recorded for ${plural(source.unknown_error_traces, 'older trace')}.` : '';
        card.append(el('p', source.error_traces ? plural(source.error_traces, 'trace') + ' with an error event' + (lastError ? ` · latest${among} received ${lastError}` : '') + (unknown ? '. ' + unknown : '') : unknown ? `No error event recorded${among}. ` + unknown : `No trace with an error event${among}.`, 'hint'));
      }
      card.append(el('p', source.note, 'hint'), el('p'));
      card.lastChild.append(guide); return card;
    }));
    const scope = data.import_jobs, note = $('integrations-jobs-note');
    const available = scope.scope === 'listed' && scope.server_pull_available === true;
    if ($('langfuse-import-card')) $('langfuse-import-card').hidden = !available;
    if ($('importers-unavailable')) $('importers-unavailable').hidden = available;
    jobs.replaceChildren(...scope.jobs.map(job => {
      const item = el('li'); item.dataset.job = job.id; item.dataset.state = job.state;
      const started = when(job.created_at);
      item.append(el('code', job.id.slice(0, 15) + '…'), el('span', ` · ${job.kind === 'server_pull' ? 'Langfuse in-app import' : 'Langfuse import job'} · ${job.state === 'attention' ? 'Needs attention: ' : ''}${STATUS[job.status] ?? job.status}${started ? ' · created ' + started : ''} · ${plural(job.progress.rows, 'row')} read, ${job.progress.verified_batches.toLocaleString()} ${job.progress.verified_batches === 1 ? 'batch' : 'batches'} verified`));
      return item;
    }));
    note.textContent = scope.scope !== 'listed' ? 'Import jobs are kept for the workspace owner in the Default environment. Switch to your own workspace and Default to see them.'
      : scope.jobs.length ? (scope.truncated ? 'Showing the first jobs read; more exist. ' : '') + 'Newest first. Imports run from the Agents view or the local importers.'
      : 'None yet.';
  }
  async function refresh() {
    const mine = ++version; status.textContent = 'Loading integrations…'; section.setAttribute('aria-busy', 'true');
    try { const data = validateIntegrations(await api('integrations')); if (mine !== version) return; render(data); loaded = true; status.textContent = ''; }
    catch (error) { if (mine !== version) return; status.textContent = messages[error?.message] || 'Integrations could not be loaded. Nothing below is current; try again.'; }
    finally { if (mine === version) section.removeAttribute('aria-busy'); }
  }
  function reset() { version++; loaded = false; status.textContent = ''; $('integrations-scan').textContent = ''; sources.replaceChildren(); jobs.replaceChildren(); $('integrations-jobs-note').textContent = ''; }
  // Loads when the view is opened by a signed-in account, and again on request. Signing out clears it.
  const signedIn = () => document.body.classList.contains('signed-in'), open = () => (location.hash || '').replace('#', '').split(/[/?]/)[0] === 'agents';
  const sync = () => { if (!signedIn()) { if (loaded || status.textContent) reset(); return; } if (open() && !loaded) void refresh(); };
  $('integrations-refresh').addEventListener('click', () => { if (signedIn()) void refresh(); });
  addEventListener('hashchange', () => { if (signedIn() && open()) void refresh(); });
  new MutationObserver(sync).observe(document.body, {attributes: true, attributeFilter: ['class']}); sync();
  return {refresh, reset};
}
if (typeof document !== 'undefined') mountIntegrations(document);
