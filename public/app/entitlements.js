// Plan entitlements in the dashboard. GET /api/entitlements is the server's answer for the organization on screen:
// its plan, the count limits with what is used, and every feature flag. This module does two things with it:
//   1. locks each panel of a feature the plan lacks and puts an upgrade note in front of it;
//   2. shows the plan, its limits and its features as a card in Billing.
// The server enforces every gate on its own; this only tells the person why a control is unavailable.
// The module builds its own markup and talks to the API itself, like drains.js: adding it is one import in app.js.

/** Element id -> feature flag. A locked element is made inert and gets a note before it. */
export const GATES = Object.freeze({
  'drain-form': 'trace_drains',
  'audit-table': 'audit_log', 'audit-filters': 'audit_log',
  'audit-export-json': 'audit_log_export', 'audit-export-csv': 'audit_log_export',
  'sso-form': 'sso_saml', 'sso-enforce': 'sso_saml',
  'sso-scim': 'scim',
  'org-security': 'enforce_mfa',
  'invite-scope': 'rbac_roles',
  'spend-cap-toggle': 'spend_cap',
  'retention-form': 'custom_retention',
  'role-form': 'custom_roles'
});
/** Role options that need the rbac_roles feature; Admin is on every plan. */
export const GATED_ROLES = Object.freeze(['developer', 'viewer']);
const LIMIT_LABELS = Object.freeze({seats: 'Members', environments: 'Environments', api_keys: 'Active API keys', projects: 'Projects'});
const number = value => value === null ? 'Unlimited' : Number(value).toLocaleString('en-US');

/** The sentence shown where a feature is locked. */
export function upgradeText(entitlements, feature) {
  const flag = entitlements?.features?.[feature];
  if (!flag) return '';
  return `${flag.label} needs the ${flag.required_plan_name ?? 'Enterprise'} plan. This organization is on ${entitlements.plan_name}.`;
}
/** Text for a 402 from the API: the server's own sentence when it sent one. */
export function entitlementMessage(body) {
  if (body?.error !== 'plan_upgrade_required' && body?.error !== 'plan_limit_reached') return null;
  const recovery = body.limit_name === 'api_keys' && !body.message?.startsWith('Revoke an unused key') ? 'Revoke an unused key in API keys (/app/#keys) before creating another. ' : '';
  return recovery + (typeof body.message === 'string' && body.message ? body.message : 'This needs a higher plan.') + ' Upgrade in Billing.';
}

function note(document, id, text) {
  const item = document.createElement('p'); item.className = 'upgrade-note'; item.dataset.upgradeFor = id; item.setAttribute('role', 'note');
  const link = document.createElement('a'); link.href = '#billing'; link.textContent = 'Upgrade in Billing';
  item.append(text + ' ', link); return item;
}
/** Applies the gates to whatever panels exist now. Safe to call again and again: it changes nothing that is already right. */
export function applyGates(document, entitlements) {
  if (!entitlements?.features) return;
  for (const [id, feature] of Object.entries(GATES)) {
    const element = document.getElementById(id); if (!element) continue;
    const locked = entitlements.features[feature]?.enabled !== true, existing = document.querySelector(`[data-upgrade-for="${id}"]`);
    if (locked) {
      if (!element.inert) element.inert = true;
      if (!element.classList.contains('locked')) element.classList.add('locked');
      const text = upgradeText(entitlements, feature);
      if (!existing) element.before(note(document, id, text)); else if (!existing.textContent.startsWith(text)) existing.replaceWith(note(document, id, text));
    } else {
      if (element.inert) element.inert = false;
      if (element.classList.contains('locked')) element.classList.remove('locked');
      existing?.remove();
    }
  }
  // Role choices: Developer and Read-only need rbac_roles. The option stays visible so the plan that unlocks it is clear.
  const roles = entitlements.features.rbac_roles?.enabled === true;
  for (const select of document.querySelectorAll('select[name="role"]')) for (const option of select.options) {
    if (!GATED_ROLES.includes(option.value)) continue;
    if (option.disabled === roles) option.disabled = !roles;
    const label = option.dataset.label ?? (option.dataset.label = option.textContent), wanted = roles ? label : label + ' (Pro plan)';
    if (option.textContent !== wanted) option.textContent = wanted;
    if (!roles && select.value === option.value) select.value = 'admin';
  }
}

/** The plan card for Billing: plan name, limits with usage, and each feature with the plan that unlocks it. */
export function planCard(document, entitlements) {
  const card = document.createElement('section'); card.id = 'plan-entitlements'; card.className = 'card plan-entitlements'; card.setAttribute('aria-labelledby', 'plan-entitlements-title');
  const title = document.createElement('h2'); title.id = 'plan-entitlements-title'; title.textContent = entitlements.plan_name + ' plan';
  const limits = document.createElement('dl'); limits.id = 'plan-limits'; limits.className = 'plan-limits';
  const row = (name, value) => { const term = document.createElement('dt'); term.textContent = name; const detail = document.createElement('dd'); detail.textContent = value; limits.append(term, detail); };
  row('Spans per month', number(entitlements.limits.spans_per_month));
  row('Stored data', (entitlements.limits.stored_bytes / 1e9) + ' GB');
  row('Retention', entitlements.limits.retention_days + ' days');
  for (const [key, label] of Object.entries(LIMIT_LABELS)) {
    const used = entitlements.usage?.[key], limit = entitlements.limits[key];
    row(label, (Number.isSafeInteger(used) ? used + ' of ' : '') + number(limit));
  }
  const heading = document.createElement('h3'); heading.textContent = 'Features';
  const list = document.createElement('ul'); list.id = 'plan-features'; list.className = 'plan-features';
  for (const [id, flag] of Object.entries(entitlements.features)) {
    const item = document.createElement('li'); item.dataset.feature = id; item.dataset.enabled = String(flag.enabled === true);
    item.textContent = flag.label + (flag.enabled ? ': included' : ': needs ' + (flag.required_plan_name ?? 'Enterprise'));
    list.append(item);
  }
  // Custom retention (Enterprise): the owner chooses how long traces accepted from now on are kept.
  const form = document.createElement('form'); form.id = 'retention-form'; form.className = 'retention-form';
  const label = document.createElement('label'); label.textContent = 'Retention for new traces (days) ';
  const input = document.createElement('input'); input.type = 'number'; input.name = 'days'; input.min = '1'; input.max = '3650'; input.required = true; input.value = String(entitlements.limits.retention_days);
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'quiet'; save.textContent = 'Save retention';
  const result = document.createElement('p'); result.id = 'retention-status'; result.className = 'hint'; result.setAttribute('role', 'status');
  label.append(input); form.append(label, save, result);
  card.append(title, limits, form, heading, list); return card;
}

/** Loads the entitlements of the organization on screen and keeps the gates applied as panels appear. */
export function installEntitlements(document, {fetcher = (...args) => fetch(...args), location = globalThis.location} = {}) {
  let entitlements = null, loading = null, attempts = 0, last = 0;
  // The organization on screen: named in the address, or resolved by the app (it also opens one from ?project=).
  const workspace = () => new URLSearchParams(location?.search || '').get('workspace') ?? document.documentElement?.dataset?.workspace ?? null;
  const paint = () => {
    if (!entitlements) return;
    applyGates(document, entitlements);
    const billing = document.getElementById('view-billing'), old = document.getElementById('plan-entitlements');
    // The card is rebuilt only when what it shows changed, so an open form is not wiped by unrelated page updates.
    const shown = entitlements.plan_id + ':' + JSON.stringify([entitlements.usage ?? {}, entitlements.limits]);
    if (billing && old?.dataset.plan !== shown) {
      const card = planCard(document, entitlements); card.dataset.plan = shown;
      if (old) old.replaceWith(card); else (document.getElementById('billing-summary') ?? billing.lastElementChild)?.before(card);
      card.querySelector('#retention-form').addEventListener('submit', event => { event.preventDefault(); void saveRetention(card); });
    }
  };
  // Saving goes to the owner-only billing route; the server checks the plan again.
  async function saveRetention(card) {
    const status = card.querySelector('#retention-status'), days = Number(card.querySelector('#retention-form input').value), raw = JSON.stringify({days}), id = workspace();
    status.textContent = 'Saving…';
    try {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), value => value.toString(16).padStart(2, '0')).join('');
      const response = await fetcher('/api/billing/retention' + (id ? '?workspace=' + encodeURIComponent(id) : ''), {method: 'POST', headers: {'Content-Type': 'application/json', 'x-amz-content-sha256': hash}, body: raw, credentials: 'same-origin', cache: 'no-store'}), body = await response.json().catch(() => ({}));
      if (!response.ok) { status.textContent = entitlementMessage(body) ?? ({workspace_owner_required: 'Only the organization owner can change retention.', invalid_retention: 'Enter a whole number of days from 1 to 3650.'}[body.error] ?? 'Retention was not changed. Try again.'); return; }
      entitlements = null; await load();
      const fresh = document.getElementById('retention-status'); if (fresh) fresh.textContent = 'Saved. Traces accepted from now on are kept ' + body.retention_days + ' days; stored traces keep the retention they had.';
    } catch { status.textContent = 'Retention was not changed. Try again.'; }
  }
  async function load() {
    if (loading) return loading;
    attempts++; last = Date.now();
    loading = (async () => {
      try {
        const id = workspace(), response = await fetcher('/api/entitlements' + (id ? '?workspace=' + encodeURIComponent(id) : ''), {credentials: 'same-origin', cache: 'no-store'});
        // The body is always read: an unread response keeps its connection open, and the page never goes idle.
        const value = await response.json().catch(() => null);
        if (!response.ok) return null;
        if (!value || typeof value.plan_id !== 'string' || !value.features || !value.limits) return null;
        entitlements = value; paint();
        document.dispatchEvent(new CustomEvent('supatrace:entitlements', {detail: value}));
        return value;
      } catch { return null; } finally { loading = null; }
    })();
    return loading;
  }
  // Panels are built after their own data loads, so the gates are re-applied whenever the page changes. A read that
  // fails is retried, at most every five seconds and twenty times, as the page changes.
  // Nothing is asked before the dashboard has a signed-in session on screen: the sign-in check owns the first requests.
  const signedIn = () => { const shell = document.getElementById('shell'); return !!shell && !shell.hidden; };
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (entitlements) paint(); else if (signedIn() && !loading && attempts < 20 && (attempts === 0 || Date.now() - last > 5000)) void load();
  }) : null;
  observer?.observe(document.body ?? document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden']});
  // The page's own Refresh buttons re-read the plan too, so a plan changed elsewhere shows without a reload.
  document.addEventListener('click', event => { if (event.target?.closest?.('#billing-refresh, #usage-refresh, #usage-refresh-home')) { entitlements = null; void load(); } });
  if (signedIn()) void load();
  return {load, refresh: () => { entitlements = null; return load(); }, current: () => entitlements, stop: () => observer?.disconnect()};
}

export const entitlements = typeof document !== 'undefined' && typeof window !== 'undefined' ? installEntitlements(document) : null;
