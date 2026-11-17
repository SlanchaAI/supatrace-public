import {clearSetupCode} from './setup-code.js';
import {clearFirstTraceStorage} from './first-trace.js';
// Sign-in methods in Settings: which GitHub and Google sign-ins open this account, the explicit choice to link or keep
// apart another account with the same verified email, and unlinking. Everything shown comes from GET /api/auth/identities.
// The panel builds its own markup and talks to the API itself, so adding it needs one import in app.js.
const messages = {
  no_account_to_link: 'There is no longer another account to link. Nothing was changed.',
  identity_changed: 'Sign-in methods changed in another tab. Nothing was changed here; the list has been reloaded.',
  rate_limit: 'The request limit was reached. Wait before trying again.',
  sign_in_required: 'Please sign in to continue.'
};
const NAMES = {github: 'GitHub', google: 'Google'};
const PANEL = '<div><h2>Sign-in methods</h2><p class="muted">The first time you sign in with GitHub or Google, it opens your existing account if both providers verify the same email address. Accounts that already exist are linked only by your choice here, and a method you unlinked or kept separate stays separate. An account takes one linked method. A provider that has not verified the address is never linked. Trace data is never merged between accounts. The Sign-in provider shown under Account is the method this account was created with, also when you came in through a linked one.</p></div><div><p id="identities-status" role="status" aria-live="polite"></p><ul id="identities-list" class="token-list" aria-label="Sign-in methods for this account"></ul><div id="identities-choice" hidden><p id="identities-choice-text"></p><p id="identities-choice-effect" class="hint"></p><button id="identities-link" type="button" class="quiet"></button> <button id="identities-separate" type="button" class="quiet">Keep the accounts separate</button></div></div>';
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
async function request(path, body) {
  const raw = body === undefined ? undefined : JSON.stringify(body), headers = {};
  if (raw !== undefined) { headers['Content-Type'] = 'application/json'; headers['x-amz-content-sha256'] = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))); }
  const response = await fetch('/api/' + path, {method: raw === undefined ? 'GET' : 'POST', headers, body: raw, credentials: 'same-origin', cache: 'no-store'});
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(response.status === 429 ? 'rate_limit' : value?.error || 'request_failed'); error.status = response.status; throw error; }
  return value;
}
/** Checks the response shape, so the panel never renders a guess. */
export function validateIdentities(data) {
  const provider = value => value === 'github' || value === 'google', email = value => typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+$/.test(value);
  if (!data?.account || !(data.account.provider === null || provider(data.account.provider)) || !(data.account.verified_email === null || email(data.account.verified_email)) || typeof data.account.linkable !== 'boolean' || !Array.isArray(data.linked) || data.linked.length > 20 || !(data.same_email_account === null || provider(data.same_email_account?.provider))) throw new Error('invalid_response');
  for (const item of data.linked) if (typeof item?.id !== 'string' || !/^(github-\d{1,16}|google-[a-f0-9]{64})$/.test(item.id) || !provider(item.provider) || !email(item.verified_email) || !Number.isFinite(Date.parse(item.linked_at)) || !['sign_in', 'settings'].includes(item.linked_by)) throw new Error('invalid_response');
  return data;
}

export function mountSignInMethods({document, api = request, signedOut = () => {clearSetupCode();clearFirstTraceStorage();location.replace('/app/');}}) {
  const $ = id => document.getElementById(id), section = $('identities-section'), status = $('identities-status'), list = $('identities-list'), choice = $('identities-choice');
  let version = 0;
  const fail = error => { status.textContent = messages[error?.message] || 'Sign-in methods could not be loaded. Nothing below is current; try again.'; };
  function render(data) {
    const own = NAMES[data.account.provider], items = [];
    const first = document.createElement('li');
    first.textContent = own ? `${own} · this account's own sign-in${data.account.verified_email ? ' · verified email ' + data.account.verified_email : ' · no verified email reported yet; sign in again to check'}` : 'This account signs in with email, SSO or another method. Linking is available for GitHub and Google accounts.';
    items.push(first);
    for (const item of data.linked) {
      const row = document.createElement('li'), text = document.createElement('span'), remove = document.createElement('button');
      text.textContent = `${NAMES[item.provider]} · verified email ${item.verified_email} · linked ${new Date(item.linked_at).toLocaleDateString()} ${item.linked_by === 'sign_in' ? 'at sign-in' : 'in Settings'} `;
      remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Unlink'; remove.dataset.identity = item.id; remove.setAttribute('aria-label', 'Unlink ' + NAMES[item.provider] + ' sign-in');
      row.append(text, remove); items.push(row);
    }
    list.replaceChildren(...items);
    const other = NAMES[data.same_email_account?.provider];
    choice.hidden = !other;
    if (other) {
      $('identities-choice-text').textContent = `Another SupaTrace account signs in with ${other} and has the same verified email. The two accounts are separate.`;
      $('identities-choice-effect').textContent = `If you link them, signing in with ${own} will open the ${other} account instead of this one. This account's traces, keys and billing stay here and are not copied; agents that upload with this account's keys keep uploading here. You will be signed out now. The link can be removed later from the ${other} account's Settings.`;
      $('identities-link').textContent = `Open the ${other} account when I sign in with ${own}`; delete $('identities-link').dataset.armed;
    }
  }
  async function refresh() {
    const mine = ++version;
    try { const data = validateIdentities(await api('auth/identities')); if (mine !== version) return; section.hidden = false; render(data); }
    catch (error) { if (mine !== version) return; if (error?.status === 404) { section.hidden = true; return; } section.hidden = false; fail(error); }
  }
  async function act(button, path, body, done) {
    button.disabled = true; status.textContent = 'Saving…';
    try { await api(path, body); await done(); }
    catch (error) { fail(error); if (error?.message === 'identity_changed' || error?.message === 'no_account_to_link') { const text = status.textContent; await refresh(); status.textContent = text; } }
    finally { button.disabled = false; }
  }
  // Each change that moves a sign-in method or ends sessions takes a second, confirming click.
  const armed = (button, label) => { if (button.dataset.armed === 'true') return true; button.dataset.armed = 'true'; button.textContent = label; return false; };
  $('identities-link').addEventListener('click', event => { const button = event.currentTarget; if (!armed(button, 'Confirm: link and sign out')) return; void act(button, 'auth/identities/link', {}, async () => { status.textContent = 'Linked. Signing out…'; await api('auth/logout', {}).catch(() => {}); signedOut(); }); });
  $('identities-separate').addEventListener('click', event => { void act(event.currentTarget, 'auth/identities/separate', {}, async () => { await refresh(); status.textContent = 'The accounts stay separate. This choice is remembered.'; }); });
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-identity]'); if (!button) return;
    if (!armed(button, 'Confirm: unlink and sign out everywhere')) { status.textContent = 'Unlinking signs out every session of this account. That sign-in method will then open its own separate account, and it cannot be linked to this account again here. Personal access tokens and write keys of this account are not revoked; revoke them separately if needed.'; return; }
    void act(button, 'auth/identities/unlink', {id: button.dataset.identity}, async () => { status.textContent = 'Unlinked. Signing out…'; signedOut(); });
  });
  return {refresh, reset() { version++; status.textContent = ''; list.replaceChildren(); choice.hidden = true; }};
}
/** Adds the panel above the Session block in Settings and keeps it in step with sign-in state. */
export function installSignInMethods(document) {
  const settings = document.querySelector('#view-settings .settings');
  if (!settings || document.getElementById('identities-section')) return null;
  const section = document.createElement('div'); section.className = 'setting'; section.id = 'identities-section'; section.hidden = true; section.innerHTML = PANEL;
  settings.insertBefore(section, document.getElementById('logout-settings')?.closest('.setting') ?? null);
  const panel = mountSignInMethods({document});
  let signedIn = false;
  const sync = () => { const now = document.body.classList.contains('signed-in'); if (now === signedIn) return; signedIn = now; if (now) void panel.refresh(); else panel.reset(); };
  new MutationObserver(sync).observe(document.body, {attributes: true, attributeFilter: ['class']}); sync();
  return panel;
}
if (typeof document !== 'undefined') installSignInMethods(document);
