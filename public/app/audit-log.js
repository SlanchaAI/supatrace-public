import {entitlements} from './entitlements.js';
// Audit log view. Owner only: the server refuses everyone else, and the rail entry is hidden for them.
// Every value is written with textContent. Export downloads come from the API, which records the export itself.
const CATEGORIES = [['', 'All actions'], ['auth', 'Sign-in'], ['key', 'Keys'], ['token', 'Access tokens'], ['member', 'Members'], ['org', 'Organizations'], ['sso', 'Single sign-on'], ['scim', 'SCIM provisioning'], ['workspace', 'Workspace'], ['environment', 'Environments'], ['settings', 'Security settings'], ['billing', 'Billing'], ['export', 'Exports'], ['audit', 'Audit log']];
const LABELS = {
  'auth.sign_in': 'Signed in', 'key.create': 'Key created', 'key.rotate': 'Key rotated', 'key.revoke': 'Key revoked', 'token.create': 'Access token created', 'token.revoke': 'Access token revoked',
  'member.invite': 'Member invited', 'member.accept': 'Invitation accepted', 'member.role_change': 'Member role changed', 'member.remove': 'Member removed',
  'sso.config_changed': 'SSO settings changed', 'sso.domain_verified': 'SSO domain verified', 'sso.enforcement_changed': 'SSO enforcement changed', 'sso.member_joined': 'Member joined through SSO', 'scim.token_created': 'SCIM token created', 'scim.user_provisioned': 'SCIM user provisioned', 'scim.user_deactivated': 'SCIM user deactivated', 'member.leave': 'Member left', 'member.scope_change': 'Member environments changed', 'settings.require_mfa_changed': 'Require two-factor authentication changed', 'org.create': 'Organization created', 'org.rename': 'Organization renamed', 'org.transfer_ownership': 'Ownership transferred', 'workspace.sharing_enabled': 'Team sharing enabled', 'environment.create': 'Environment created', 'settings.mfa_enabled': 'Two-factor authentication turned on', 'settings.mfa_disabled': 'Two-factor authentication turned off',
  'billing.checkout_started': 'Checkout started', 'billing.portal_opened': 'Billing portal opened', 'billing.controls_enrolled': 'Billing controls enrolled', 'billing.reconciled': 'Billing reconciled', 'billing.spend_cap_changed': 'Spend cap changed',
  'export.started': 'Export started', 'audit.export': 'Audit log exported'
};
const messages = {plan_upgrade_required: 'The audit log needs a higher plan. Events are still recorded, and Billing shows what each plan includes.', workspace_owner_required: 'Only the workspace owner can read the audit log.', rate_limit: 'The request limit was reached. Wait before trying again.', invalid_query: 'Those filters are not valid. Check the dates and the account ID.', sign_in_required: 'Please sign in to continue.'};
export const auditDetailText = detail => Object.entries(detail || {}).map(([name, value]) => `${name}: ${value}`).join(', ');
/** Query string for the list and export endpoints from the filter form values. Dates are whole local days. */
export function auditQuery({action = '', actor = '', from = '', to = ''} = {}) {
  const query = new URLSearchParams();
  if (action) query.set('action', action);
  if (actor.trim()) query.set('actor', actor.trim());
  if (from) query.set('from', new Date(from + 'T00:00:00').toISOString());
  if (to) query.set('to', new Date(to + 'T23:59:59').toISOString());
  return query;
}
// The Audit log rail entry and view are added when this module loads, before the app first routes, so the page
// markup itself stays untouched. The entry starts hidden and is shown to the owner only.
export function installAuditView(document) {
  const settings = document.querySelector('#rail a[data-nav="settings"]'), view = document.getElementById('view-settings');
  if (!settings || !view || document.getElementById('view-audit')) return;
  settings.insertAdjacentHTML('beforebegin', '<a href="#audit" data-nav="audit" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h7l3 3v10H3zm6.5 1V5H12zM5 7.5h6v1.2H5zm0 2.4h6v1.2H5zm0 2.4h4v1.2H5z"/></svg><span>Audit log</span></a>');
  view.insertAdjacentHTML('beforebegin', '<section id="view-audit" data-view="audit" hidden><h1>Audit log</h1><p class="muted">Who did what in this workspace. Only the owner can read it.</p></section>');
}
if (typeof document !== 'undefined') installAuditView(document);
export function mountAuditLog({document, request, workspace, ownWorkspace, role, fetcher = (...args) => fetch(...args)}) {
  const link = document.querySelector('#rail [data-nav="audit"]'), view = document.getElementById('view-audit');
  if (!link || !view) return null;
  const isAuditRoute = () => location.hash.replace('#', '').split(/[\/?]/)[0] === 'audit';
  if (role !== 'owner') { document.documentElement.dataset.auditAvailable = 'false'; link.hidden = true; if (isAuditRoute()) location.hash = '#home'; return null; }
  let allowed = false;
  const card = document.createElement('article'); card.className = 'card'; card.id = 'audit-controls';
  card.innerHTML = '<form id="audit-filters"><label>Action<select name="action"></select></label><label>Account ID<input name="actor" maxlength="128" autocomplete="off" placeholder="Any account"></label><label>From<input name="from" type="date"></label><label>To<input name="to" type="date"></label><button type="submit">Apply filters</button></form><p id="audit-status" role="status" aria-live="polite"></p><div class="grid-wrap"><table id="audit-table" class="grid"><thead><tr><th scope="col">Time</th><th scope="col">Account</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th><th scope="col">Network address</th></tr></thead><tbody id="audit-rows"></tbody></table></div><div class="bar"><button id="audit-more" type="button" class="quiet" hidden>Load older events</button><button id="audit-export-json" type="button" class="quiet">Export JSON</button><button id="audit-export-csv" type="button" class="quiet">Export CSV</button><button id="audit-export-next" type="button" class="quiet" hidden>Export next part</button></div><p class="hint" id="audit-note"></p>';
  card.hidden = true; view.append(card);
  const planStatus = document.createElement('p'); planStatus.id = 'audit-plan-status'; planStatus.setAttribute('role', 'status');
  const retryPlan = document.createElement('button'); retryPlan.id = 'audit-plan-retry'; retryPlan.type = 'button'; retryPlan.textContent = 'Retry'; retryPlan.hidden = true;
  view.append(planStatus, retryPlan);
  async function checkPlan() {
    retryPlan.disabled = true; planStatus.textContent = 'Checking audit access…';
    const value = await entitlements?.load();
    retryPlan.disabled = false;
    if (value) sync(value);
    else { planStatus.textContent = 'Audit access could not be checked. Try again.'; retryPlan.hidden = false; }
  }
  retryPlan.onclick = () => void checkPlan();
  const $ = id => card.querySelector('#' + id), form = $('audit-filters'), status = $('audit-status'), rows = $('audit-rows');
  for (const [value, text] of CATEGORIES) { const option = document.createElement('option'); option.value = value; option.textContent = text; form.elements.action.append(option); }
  const scope = () => workspace !== ownWorkspace ? '&workspace=' + encodeURIComponent(workspace) : '';
  const current = () => auditQuery(Object.fromEntries(new FormData(form)));
  let next = null, version = 0, loaded = false;
  const fail = error => { status.textContent = messages[error?.message] || 'The audit log could not be loaded. Try again.'; };
  function append(events) {
    for (const event of events) {
      const row = document.createElement('tr');
      for (const text of [new Date(event.time).toLocaleString(), event.actor, (LABELS[event.action] || event.action) + (event.source === 'client_reported' ? ' (reported by the browser)' : ''), event.target ?? '', auditDetailText(event.detail), event.ip]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
      row.dataset.action = event.action; rows.append(row);
    }
  }
  async function load(more = false) {
    if (!allowed) return;
    const mine = ++version, query = current(); if (more && next) query.set('after', next);
    status.textContent = 'Loading…';
    try {
      const result = await request('audit' + (query.size ? '?' + query : ''));
      if (mine !== version) return;
      if (!Array.isArray(result?.events)) throw Error('invalid_audit_log');
      if (!more) rows.replaceChildren();
      append(result.events); next = typeof result.next === 'string' ? result.next : null; loaded = true;
      $('audit-more').hidden = !next;
      status.textContent = rows.children.length ? `${rows.children.length} event${rows.children.length === 1 ? '' : 's'} shown, newest first.` + (next ? ' Older events are available.' : '') : 'No events match these filters.';
      $('audit-note').textContent = `Events are kept for ${result.retention_days} days and cannot be edited or turned off. Keys and tokens appear as the first 12 characters of their ID.`;
    } catch (error) { if (mine === version) fail(error); }
  }
  // One export file holds 5,000 scanned events. When more remain the server returns a cursor, and the next part continues from it.
  let pending = null, exportVersion = 0;
  const offerNext = (part, retry = false) => { pending = part; $('audit-export-next').hidden = !part; if (part) $('audit-export-next').textContent = `${retry ? 'Retry' : 'Export'} part ${part.number} (${part.format.toUpperCase()})`; };
  async function download(format, part = null) {
    const query = part ? new URLSearchParams(part.query) : current(); query.set('format', format); if (part) query.set('after', part.after); else query.delete('after');
    const mine = ++exportVersion, number = part ? part.number : 1; offerNext(null); status.textContent = 'Preparing export…';
    try {
      const response = await fetcher('/api/audit/export?' + query + scope(), {credentials: 'same-origin', cache: 'no-store'});
      if (mine !== exportVersion) return;
      if (!response.ok) { const value = await response.json().catch(() => ({})); throw Error(response.status === 429 ? 'rate_limit' : value?.error || 'request_failed'); }
      const blob = await response.blob(); if (mine !== exportVersion) return;
      const href = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = href; a.download = number === 1 ? `supatrace-audit-log.${format}` : `supatrace-audit-log-part-${number}.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
      const after = response.headers.get('x-audit-export-next');
      if (after) { query.delete('after'); query.delete('format'); offerNext({format, after, number: number + 1, query: query.toString()}); status.textContent = `Part ${number} download started. Older events remain: choose Export part ${number + 1} to continue from where this file ends.`; }
      else status.textContent = number === 1 ? 'Export download started. The export is recorded in this log.' : `Part ${number} download started. That is the last part.`;
    } catch (error) {
      if (mine !== exportVersion) return;
      if (part) { offerNext(part, true); status.textContent = `Part ${number} could not be downloaded. Retry this part to continue.`; }
      else fail(error);
    }
  }
  form.onsubmit = event => { event.preventDefault(); ++exportVersion; offerNext(null); void load(); };
  $('audit-more').onclick = () => void load(true);
  $('audit-export-json').onclick = () => void download('json');
  $('audit-export-csv').onclick = () => void download('csv');
  $('audit-export-next').onclick = () => { if (pending) void download(pending.format, pending); };
  const visible = () => { if (allowed && isAuditRoute()) void load(); };
  const sync = value => {
    if (!value?.features) return;
    planStatus.textContent = ''; retryPlan.hidden = true;
    const wasAllowed = allowed; allowed = value.features.audit_log?.enabled === true;
    document.documentElement.dataset.auditAvailable = String(allowed);
    link.hidden = !allowed; card.hidden = !allowed;
    const exports = value.features.audit_log_export?.enabled === true;
    for (const id of ['audit-export-json', 'audit-export-csv']) $(id).hidden = !exports;
    let note = document.getElementById('audit-export-plan');
    if (allowed && !exports && !note) { note = document.createElement('p'); note.id = 'audit-export-plan'; note.textContent = 'Export is on the Enterprise plan.'; $('audit-export-json').before(note); }
    if (exports || !allowed) note?.remove();
    if (!allowed) { ++version; status.textContent = ''; if (isAuditRoute()) location.hash = '#home'; }
    else if (!wasAllowed) visible();
  };
  document.addEventListener('supatrace:entitlements', event => sync(event.detail));
  addEventListener('hashchange', visible);
  if (entitlements?.current()) sync(entitlements.current()); else void checkPlan();
  return {load, loaded: () => loaded};
}
