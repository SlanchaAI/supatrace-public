// Plans in Billing: the four plans with their prices, an upgrade button that opens Stripe Checkout (test mode), and a
// button that opens the Stripe customer portal to change or cancel. The server decides everything shown here
// (GET /api/billing/catalog); after a return from Stripe this asks the server to read the subscription back
// (POST /api/billing/sync) before showing the plan. Only the organization's owner, on Default, gets the catalog.
// Like drains.js, the module builds its own markup and talks to the API itself: one import in app.js.
import {entitlements} from './entitlements.js';

const messages = {
  plan_billing_unavailable: 'Checkout is not switched on for this deployment yet. Your plan and limits are unchanged.',
  subscription_exists: 'This organization already has a subscription. Use "Manage subscription" to change or cancel it.',
  plan_managed_by_operator: 'This organization\'s plan is set by SupaTrace. Contact sales to change it.',
  no_subscription: 'This organization has no subscription to manage.',
  subscription_not_changeable: 'Resolve any outstanding invoice or scheduled cancellation in Manage subscription before changing plans.',
  plan_payment_pending: 'A plan-change payment is pending. Open Manage subscription to complete or resolve the invoice; your current plan stays in force.',
  billing_portal_unavailable: 'The billing portal is not set up yet. Your plan is unchanged.',
  plan_billing_provider_error: 'Stripe could not confirm the request. Refresh Billing before retrying; the plan shown is the last verified subscription.',
  billing_changed: 'Billing changed while saving. Refresh and try again.',
  workspace_owner_required: 'Only the organization owner can manage billing.',
  rate_limit: 'The request limit was reached. Wait a minute, then try again.',
  sign_in_required: 'Please sign in to continue.'
};
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
const money = cents => '$' + (cents / 100).toFixed(2).replace(/\.00$/, '');
const count = value => value === null ? 'Unlimited' : Number(value).toLocaleString('en-US');
/** What a plan card's button does, from the server's `action`. */
export function planAction(plan) {
  return ({checkout: {label: 'Upgrade to ' + plan.name, kind: 'checkout'}, change: {label: 'Change to ' + plan.name, kind: 'change'}, portal: {label: 'Manage subscription', kind: 'portal'}, contact_sales: {label: 'Contact sales', kind: 'link', href: '/enterprise/#contact'},
    unavailable: {label: 'Checkout not available yet', kind: 'disabled'}})[plan.action] ?? null;
}
export const priceText = plan => plan.price_kind === 'custom' ? 'Custom' : money(plan.monthly_usd_cents) + ' / month';

export function installPlanBilling(document, {fetcher = (...args) => fetch(...args), location = globalThis.location, history = globalThis.history, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), assign = url => location.assign(url), confirm = message => globalThis.confirm(message)} = {}) {
  const view = document.getElementById('view-billing');
  if (!view || document.getElementById('plan-billing')) return null;
  const section = document.createElement('section'); section.id = 'plan-billing'; section.className = 'card plan-billing'; section.hidden = true; section.setAttribute('aria-labelledby', 'plan-billing-title');
  const title = document.createElement('h2'); title.id = 'plan-billing-title'; title.textContent = 'Plans';
  const mode = document.createElement('p'); mode.id = 'plan-billing-mode'; mode.className = 'hint';
  const status = document.createElement('p'); status.id = 'plan-billing-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const grid = document.createElement('ul'); grid.id = 'plan-billing-plans'; grid.className = 'plan-grid';
  const manage = document.createElement('button'); manage.id = 'plan-billing-manage'; manage.type = 'button'; manage.className = 'quiet'; manage.textContent = 'Manage subscription'; manage.hidden = true;
  section.append(title, mode, status, grid, manage);
  (document.getElementById('billing-summary') ?? view.lastElementChild).before(section);

  // The organization on screen: named in the address, or resolved by the app (it also opens one from ?project=).
  const workspace = () => new URLSearchParams(location?.search || '').get('workspace') ?? document.documentElement?.dataset?.workspace ?? null;
  async function request(path, body) {
    const id = workspace(), raw = body === undefined ? undefined : JSON.stringify(body), headers = {};
    if (raw !== undefined) { headers['Content-Type'] = 'application/json'; headers['x-amz-content-sha256'] = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))); }
    const response = await fetcher('/api/' + path + (id ? '?workspace=' + encodeURIComponent(id) : ''), {method: raw === undefined ? 'GET' : 'POST', headers, body: raw, credentials: 'same-origin', cache: 'no-store'});
    const value = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(response.status === 429 ? 'rate_limit' : value?.error || 'request_failed'); error.status = response.status; throw error; }
    return value;
  }
  const say = error => { status.textContent = messages[error?.message] || 'Stripe could not confirm the request. The billing outcome is unknown. Refresh Billing before retrying; the plan shown is the last verified subscription.'; };
  let busy = false;
  const act = async (button, path, body) => {
    if (busy) return; const owner = workspace(); busy = true; button.disabled = true; status.textContent = 'Contacting Stripe…';
    try {
      const result = await request(path, body); if (workspace() !== owner) return;
      if (path === 'billing/change' && !result.url) { await entitlements?.refresh(); await refresh(); status.textContent = 'Plan confirmed with Stripe. Limits and features follow the paid plan now.'; button.disabled = false; return; }
      if (typeof result.url !== 'string' || !/^https:\/\/(checkout|billing|invoice)\.stripe\.com\//.test(result.url)) throw new Error('request_failed'); assign(result.url);
    }
    catch (error) {
      if (workspace() !== owner) return;
      // A timeout may follow a completed Stripe mutation. Re-read the server before offering another change.
      if (path === 'billing/change' && (!error.status || error.status >= 500)) {
        await refresh();
        if (workspace() !== owner) return;
      }
      say(error); button.disabled = false;
    }
    finally { busy = false; }
  };
  manage.addEventListener('click', () => act(manage, 'billing/manage', {}));

  function render(catalog) {
    section.hidden = false;
    mode.textContent = catalog.checkout_available
      ? 'Payments are in Stripe test mode. No real card is charged: at Checkout use the test card 4242 4242 4242 4242, any future date and any CVC.'
      : 'Checkout is not switched on for this deployment yet. The plans and limits below are what the service enforces.';
    const sub = catalog.subscription;
    section.dataset.plan = catalog.current_plan;
    title.textContent = 'Plans · this organization is on ' + catalog.current_plan_name;
    manage.hidden = !catalog.portal_available;
    grid.replaceChildren(...catalog.plans.map(plan => {
      const item = document.createElement('li'); item.className = 'plan-card'; item.dataset.plan = plan.id; item.dataset.current = String(plan.current);
      const name = document.createElement('h3'); name.textContent = plan.name + (plan.current ? ' (current)' : '');
      const price = document.createElement('p'); price.className = 'plan-price'; price.textContent = priceText(plan);
      const facts = document.createElement('ul');
      const fact = text => { const li = document.createElement('li'); li.textContent = text; facts.append(li); };
      if (plan.price_kind === 'custom') fact('Volume and retention by contract');
      else { fact(count(plan.limits.spans_per_month) + ' spans per month'); fact(plan.limits.retention_days + ' days retention'); }
      fact(count(plan.limits.seats) + ' members · ' + count(plan.limits.environments) + ' environments · ' + count(plan.limits.api_keys) + ' API keys');
      for (const feature of plan.features) fact(feature.label);
      item.append(name, price, facts);
      const action = planAction(plan);
      if (action?.kind === 'link') { const link = document.createElement('a'); link.className = 'button'; link.href = action.href; link.textContent = action.label; item.append(link); }
      else if (action) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label; button.dataset.action = action.kind; button.disabled = action.kind === 'disabled';
        if (action.kind === 'checkout') button.addEventListener('click', () => act(button, 'billing/subscribe', {plan: plan.id}));
        if (action.kind === 'portal') button.addEventListener('click', () => act(button, 'billing/manage', {}));
        if (action.kind === 'change') button.addEventListener('click', () => {
          if (confirm('Change to ' + plan.name + ' at ' + priceText(plan) + '? Stripe invoices the prorated difference now. Features change after payment succeeds. Test mode: no real charge.')) void act(button, 'billing/change', {plan: plan.id});
        });
        item.append(button);
      }
      return item;
    }));
    if (sub) status.textContent = 'Subscription ' + (sub.status ?? 'unknown') + (sub.cancel_at_period_end ? ', cancels' : ', renews') + (sub.current_period_end ? ' on ' + sub.current_period_end.slice(0, 10) : '') + '. Test mode: no real payment.';
    else if (catalog.plan_source === 'operator') status.textContent = 'This plan is set by SupaTrace for your organization.';
  }
  let version = 0;
  async function refresh() {
    const mine = ++version;
    try {
      const catalog = await request('billing/catalog'); if (mine !== version) return catalog; render(catalog);
      // Opening Billing re-reads the subscription on the server; if that moved the plan, everything that shows a plan follows.
      if (entitlements?.current() && entitlements.current().plan_id !== catalog.current_plan) void entitlements.refresh();
      return catalog;
    }
    // Members and non-Default environments have no billing: the plan card from entitlements.js still shows their plan.
    catch (error) { if (mine === version) { section.hidden = true; if (error.status !== 403 && error.status !== 401) say(error); } return null; }
  }
  /** After Stripe sends the owner back: read the subscription until the plan reflects it, then repaint everything that shows a plan. */
  let settling = false;
  async function settle(state) {
    settling = true; try { return await settleNow(state); } finally { settling = false; }
  }
  async function settleNow(state) {
    section.hidden = false;
    if (state === 'cancelled') { status.textContent = 'Checkout was cancelled. Nothing was charged and the plan is unchanged.'; return refresh(); }
    status.textContent = 'Confirming the subscription with Stripe…';
    let result = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { result = await request('billing/sync', {}); } catch (error) { if (attempt === 5) { say(error); break; } }
      // Checkout success means a new subscription is expected; the portal may have changed nothing.
      if (result && (state !== 'success' || result.changed || result.plan !== 'free')) break;
      await wait(2000);
    }
    await entitlements?.refresh(); const catalog = await refresh();
    if (result && catalog) status.textContent = (result.changed ? 'Plan changed to ' + catalog.current_plan_name + '. ' : 'Plan is ' + catalog.current_plan_name + '. ') + 'Limits and features follow it now. Test mode: no real payment.';
    document.dispatchEvent(new CustomEvent('supatrace:plan-changed', {detail: result}));
    return catalog;
  }
  // The catalog is the owner's, on Default. The entitlements answer says who that is, so nothing is asked of billing
  // for a member, and nothing at all before the session is known.
  let returned = new URLSearchParams(location?.search || '').get('checkout');
  if (!['success', 'cancelled', 'portal'].includes(returned)) returned = null;
  document.addEventListener('supatrace:entitlements', event => {
    if (event.detail?.billing_owner !== true) { section.hidden = true; return; }
    if (returned) { const state = returned; returned = null; const url = new URL(location.href); url.searchParams.delete('checkout'); history?.replaceState?.(null, '', url.pathname + url.search + url.hash); void settle(state); }
    else if (!busy && !settling) void refresh();
  });
  if (entitlements?.current()?.billing_owner === true) void refresh();
  return {refresh, settle};
}

export const planBilling = typeof document !== 'undefined' && typeof window !== 'undefined' ? installPlanBilling(document) : null;
