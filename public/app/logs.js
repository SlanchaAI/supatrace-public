// Logs view: upload attempts recorded for the selected workspace and environment, read from GET /api/logs.
// The server writes one row per ingest request that reached this workspace (batch upload, OTLP, Langfuse) with its
// outcome and reason code. Nothing here is inferred: an unknown value is shown as unknown and a failed read says so.
// The view builds its own markup and rail link when this module is imported, so the shared page markup is untouched.
// Log filters and refresh controls.
const messages = {
  rate_limit: 'The request limit was reached. Wait before trying again.',
  sign_in_required: 'Please sign in to continue.',
  workspace_access_denied: 'This account cannot open that workspace.',
  invalid_query: 'Those filters are not valid. Check the dates and the reason code.',
  invalid_cursor: 'That page is no longer available. Refresh the log.'
};
const ROUTES = {batches: 'Batch upload', otlp: 'OpenTelemetry (OTLP)', langfuse: 'Langfuse SDK'};
const OUTCOMES = {accepted: 'Accepted', partial: 'Partly stored', rejected: 'Rejected'};
const VIEW = '<div class="view-head"><div><h1 id="logs-title">Logs</h1><p class="muted">Upload attempts recorded for this workspace and environment, with the reason when one was refused.</p></div><div class="bar"><button id="logs-refresh" type="button" class="quiet">Refresh logs</button></div></div>'
  + '<article class="card"><form id="logs-filters"><label>Show<select name="stream"><option value="issues">Rejected and partly stored</option><option value="accepted">Accepted</option></select></label><label>Route<select name="route"><option value="">All routes</option><option value="batches">Batch upload</option><option value="otlp">OpenTelemetry (OTLP)</option><option value="langfuse">Langfuse SDK</option></select></label><label>Reason code<input name="reason" maxlength="64" autocomplete="off" placeholder="Any reason" pattern="[a-z][a-z0-9_]*"></label><label>From<input name="from" type="date"></label><label>To<input name="to" type="date"></label><button type="submit">Apply filters</button></form>'
  + '<p id="logs-status" role="status" aria-live="polite"></p><div class="grid-wrap"><table id="logs-table" class="grid"><thead><tr><th scope="col">Time</th><th scope="col">Route</th><th scope="col">Result</th><th scope="col">Reason</th><th scope="col">Stored</th><th scope="col">Stored trace</th><th scope="col">Key</th></tr></thead><tbody id="logs-rows"></tbody></table></div><div class="bar"><button id="logs-more" type="button" class="quiet" hidden>Load older attempts</button></div><p id="logs-note" class="hint"></p></article>';
const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2.5h12v2H2zm0 3.5h8v2H2zm0 3.5h12v2H2zm0 3.5h6v1.5H2z"/></svg><span>Logs</span>';

async function request(path) {
  const page = new URLSearchParams(location.search || ''), query = new URLSearchParams(path.split('?')[1] || '');
  for (const name of ['workspace', 'environment']) if (page.get(name)) query.set(name, page.get(name));
  const response = await fetch('/api/' + path.split('?')[0] + (query.size ? '?' + query : ''), {credentials: 'same-origin', cache: 'no-store'});
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(response.status === 429 ? 'rate_limit' : value?.error || 'request_failed'); error.status = response.status; throw error; }
  return value;
}
/** Query string for GET /api/logs from the filter form values. Dates are whole local days. */
export function logsQuery({stream = 'issues', route = '', reason = '', from = '', to = ''} = {}) {
  const query = new URLSearchParams();
  if (stream && stream !== 'issues') query.set('stream', stream);
  if (route) query.set('route', route);
  if (reason.trim()) query.set('reason', reason.trim());
  if (from) query.set('from', new Date(from + 'T00:00:00').toISOString());
  if (to) query.set('to', new Date(to + 'T23:59:59').toISOString());
  return query;
}
/** Checks the response shape. A malformed body is an error, so the view never renders a guess. */
export function validateLogs(data) {
  const count = value => value === null || value === undefined || Number.isSafeInteger(value) && value >= 0, text = value => value === null || value === undefined || typeof value === 'string' && value.length <= 400;
  if (!data || !Array.isArray(data.attempts) || data.attempts.length > 200 || !['issues', 'accepted'].includes(data.stream) || !Number.isSafeInteger(data.retention_days) || typeof data.truncated !== 'boolean' || !(data.next === null || typeof data.next === 'string')) throw new Error('invalid_response');
  for (const a of data.attempts) if (!a || typeof a.id !== 'string' || !Number.isFinite(Date.parse(a.time ?? '')) || !Object.hasOwn(ROUTES, a.route) || !Object.hasOwn(OUTCOMES, a.outcome) || !Number.isInteger(a.http_status) || !text(a.reason) || !text(a.message) || !text(a.detail) || !text(a.key_prefix) || !text(a.stored_trace_id) || ![a.batches, a.repeated_batches, a.stored_events, a.rejected_events, a.stored_bytes, a.stored_trace_count].every(count)) throw new Error('invalid_response');
  return data;
}
const plural = (n, word, many = word + 's') => n.toLocaleString() + ' ' + (n === 1 ? word : many);
/** What one attempt stored, in words. A count the server did not record is left out, never shown as zero. */
export function storedText(a) {
  const parts = [];
  if (Number.isSafeInteger(a.stored_events)) parts.push(plural(a.stored_events, 'event') + (Number.isSafeInteger(a.batches) ? ' in ' + plural(a.batches, 'batch', 'batches') : ''));
  if (a.repeated_batches) parts.push(plural(a.repeated_batches, 'batch', 'batches') + ' already stored by an earlier request');
  if (a.rejected_events) parts.push(plural(a.rejected_events, 'event') + ' refused');
  return parts.join(' · ') || 'Not recorded';
}

export function mountLogs(document, {api = request} = {}) {
  const rail = document.getElementById('rail'), settings = rail?.querySelector('[data-nav="settings"]'), anchor = document.getElementById('view-settings');
  if (!rail || !settings || !anchor || document.getElementById('view-logs')) return null;
  settings.insertAdjacentHTML('beforebegin', '<a href="#logs" data-nav="logs">' + ICON + '</a>');
  anchor.insertAdjacentHTML('beforebegin', '<section id="view-logs" data-view="logs" hidden aria-labelledby="logs-title">' + VIEW + '</section>');
  const section = document.getElementById('view-logs'), $ = id => document.getElementById(id), form = $('logs-filters'), status = $('logs-status'), rows = $('logs-rows'), more = $('logs-more');
  // `applied` is the filter set of the rows on screen; Load older continues that read, whatever the form now holds.
  let version = 0, loaded = false, next = null, applied = '';
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  function append(attempts) {
    for (const a of attempts) {
      const row = el('tr'); row.dataset.outcome = a.outcome; row.dataset.reason = a.reason ?? '';
      const reason = el('td');
      if (a.reason) { reason.append(el('code', a.reason)); if (a.message) reason.append(el('span', ' ' + a.message)); }
      if (a.detail) reason.append(el('p', a.detail, 'hint'));
      // Only traces the request stored events for are known; a refused trace is not named.
      const trace = a.stored_trace_id ? el('code', a.stored_trace_id) : el('span', a.stored_trace_count ? plural(a.stored_trace_count, 'trace') : '');
      row.append(el('td', new Date(a.time).toLocaleString()), el('td', ROUTES[a.route]), el('td', `${OUTCOMES[a.outcome]} · HTTP ${a.http_status}`), reason, el('td', storedText(a)), el('td'), el('td'));
      row.children[5].append(trace); if (a.key_prefix) row.children[6].append(el('code', a.key_prefix + '…'));
      rows.append(row);
    }
  }
  async function load(older = false) {
    if (older && !next) return;
    const mine = ++version, filters = older ? applied : logsQuery(Object.fromEntries(new FormData(form))).toString(), query = new URLSearchParams(filters);
    if (older) query.set('after', next);
    status.textContent = 'Loading logs…'; section.setAttribute('aria-busy', 'true');
    try {
      const data = validateLogs(await api('logs' + (query.size ? '?' + query : '')));
      if (mine !== version) return;
      if (!older) rows.replaceChildren();
      append(data.attempts); applied = filters; next = data.next; loaded = true; more.hidden = !next;
      const shown = rows.children.length, kind = data.stream === 'accepted' ? 'accepted attempt' : 'rejected or partly stored attempt';
      status.textContent = (shown ? `${plural(shown, kind)} shown, newest first.` : `No recorded ${kind} matches these filters among the rows read.`)
        + (data.truncated ? ' The read stopped at its row limit before reaching the end: Load older attempts continues it.' : next ? ' Older rows remain.' : '');
      $('logs-note').textContent = `Attempts are kept for ${data.retention_days} days. A request sent without a key, or with a key that is unknown, expired or revoked, cannot be tied to a workspace and is not recorded here; the sender gets HTTP 401.`
        + (Number.isSafeInteger(data.recorded?.issues_per_minute) ? ` Refusals are recorded up to ${data.recorded.issues_per_minute} a minute for a workspace.` : '') + ' Recording never fails an upload and holds its answer for less than half a second at most, so a row can be missing. Keys appear as the first 12 characters of their ID.';
    } catch (error) { if (mine !== version) return; status.textContent = messages[error?.message] || 'The log could not be loaded. Rows below, if any, are from an earlier read; try again.'; }
    finally { if (mine === version) section.removeAttribute('aria-busy'); }
  }
  function reset() { version++; loaded = false; next = null; applied = ''; status.textContent = ''; rows.replaceChildren(); more.hidden = true; $('logs-note').textContent = ''; }
  // Loads when the view is opened by a signed-in account, and again on request. Signing out clears it.
  const signedIn = () => document.body.classList.contains('signed-in'), open = () => (location.hash || '').replace('#', '').split(/[/?]/)[0] === 'logs';
  const sync = () => { if (!signedIn()) { if (loaded || status.textContent) reset(); return; } if (open() && !loaded) void load(); };
  form.addEventListener('submit', event => { event.preventDefault(); if (signedIn()) void load(); });
  $('logs-refresh').addEventListener('click', () => { if (signedIn()) void load(); });
  more.addEventListener('click', () => { if (signedIn()) void load(true); });
  addEventListener('hashchange', () => { if (signedIn() && open()) void load(); });
  new MutationObserver(sync).observe(document.body, {attributes: true, attributeFilter: ['class']}); sync();
  return {load, reset};
}
if (typeof document !== 'undefined') mountLogs(document);
