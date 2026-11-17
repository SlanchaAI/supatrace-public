// Personal access tokens in Settings. The token is made here and shown once; the server
// receives only its SHA-256, so it cannot be shown again or recovered.
const messages = {
  access_token_limit: 'This account already has 20 tokens. Revoke one before creating another.',
  invalid_token_name: 'Give the token a name of 1 to 80 characters.',
  invalid_token_expiry: 'Choose an expiry between 1 and 365 days.',
  access_token_not_found: 'That token is no longer on this account.',
  rate_limit: 'The request limit was reached. Wait before trying again.',
  sign_in_required: 'Please sign in to continue.'
};
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
export function newAccessToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'stpat_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// The panel builds its own markup and talks to the API itself, so adding it needs one import in
// app.js and no change to the shared page markup.
const PANEL = '<div><h2>Personal access tokens</h2><p class="muted">Read-only tokens for scripts that call the management API at <code>/api/v1</code> (<a href="/api/v1/openapi.json">OpenAPI</a>, <a href="/docs/management-api/">guide</a>). Send the token as <code>X-Supatrace-Key</code>. A token can list the workspaces, keys, usage, and traces this account can open. It cannot upload or change anything. Each token is shown once.</p></div><div><p id="tokens-status" role="status" aria-live="polite"></p><p id="tokens-empty" class="hint">No tokens yet.</p><ul id="tokens-list" class="token-list" aria-label="Personal access tokens"></ul><form id="token-form"><label for="token-name">Token name</label><input id="token-name" maxlength="80" required autocomplete="off"><label for="token-days">Expires after (days)</label><input id="token-days" type="number" min="1" max="365" value="30" required><button type="submit">Create token</button></form><div id="token-created" hidden><p>Copy this token now. It is not shown again.</p><p><code id="token-value"></code></p><button id="token-copy" type="button" class="quiet">Copy token</button><button id="token-dismiss" type="button" class="quiet">Done</button></div></div>';
async function request(path, body) {
  const raw = body === undefined ? undefined : JSON.stringify(body), headers = {};
  // POST bodies carry their SHA-256, as every dashboard request does.
  if (raw !== undefined) { headers['Content-Type'] = 'application/json'; headers['x-amz-content-sha256'] = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))); }
  const response = await fetch('/api/' + path, {method: raw === undefined ? 'GET' : 'POST', headers, body: raw, credentials: 'same-origin', cache: 'no-store'});
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(response.status === 429 ? 'rate_limit' : value?.error || 'request_failed'); error.status = response.status; throw error; }
  return value;
}
/** Adds the panel above the Session block in Settings and keeps it in step with sign-in state. */
export function installAccessTokens(document) {
  const settings = document.querySelector('#view-settings .settings');
  if (!settings || document.getElementById('tokens-section')) return null;
  const section = document.createElement('div'); section.className = 'setting'; section.id = 'tokens-section'; section.innerHTML = PANEL;
  settings.insertBefore(section, document.getElementById('logout-settings')?.closest('.setting') ?? null);
  const panel = mountAccessTokens({document, api: request});
  let signedIn = false;
  const sync = () => { const now = document.body.classList.contains('signed-in'); if (now === signedIn) return; signedIn = now; if (now) void panel.refresh(); else panel.reset(); };
  new MutationObserver(sync).observe(document.body, {attributes: true, attributeFilter: ['class']}); sync();
  return panel;
}
export function mountAccessTokens({document, api}) {
  const $ = id => document.getElementById(id);
  const status = $('tokens-status'), list = $('tokens-list'), form = $('token-form'), created = $('token-created');
  let version = 0;
  const fail = error => { status.textContent = messages[error?.message] || 'Tokens could not be loaded. Try again.'; };
  const hide = () => { $('token-value').textContent = ''; created.hidden = true; };
  function render(tokens) {
    list.replaceChildren(...tokens.map(token => {
      const item = document.createElement('li'), label = document.createElement('span'), revoke = document.createElement('button');
      label.textContent = token.name + ' · read-only · ' + (token.expired ? 'expired ' : 'expires ') + new Date(token.expires_at).toLocaleDateString();
      revoke.type = 'button'; revoke.className = 'quiet'; revoke.textContent = 'Revoke'; revoke.dataset.token = token.id;
      revoke.setAttribute('aria-label', 'Revoke token ' + token.name);
      item.append(label, ' ', revoke); return item;
    }));
    $('tokens-empty').hidden = tokens.length > 0;
  }
  async function refresh() {
    const mine = ++version;
    try { const data = await api('tokens'); if (mine !== version) return; render(data.tokens); status.textContent = ''; }
    catch (error) { if (mine === version) fail(error); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); hide();
    const button = form.querySelector('button'), token = newAccessToken();
    button.disabled = true; status.textContent = 'Creating token…';
    try {
      const token_hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
      await api('tokens', {name: $('token-name').value.trim(), expires_in_days: Number($('token-days').value), token_hash});
      $('token-value').textContent = token; created.hidden = false; form.reset(); status.textContent = 'Token created. Copy it now; it is not shown again.';
      await refresh();
    } catch (error) { fail(error); }
    finally { button.disabled = false; }
  });
  list.addEventListener('click', async event => {
    const button = event.target.closest('button[data-token]'); if (!button) return;
    // Two clicks: the first arms the button, the second revokes.
    if (button.dataset.armed !== 'true') { button.dataset.armed = 'true'; button.textContent = 'Confirm revoke'; return; }
    button.disabled = true;
    try { await api('tokens/revoke', {id: button.dataset.token}); status.textContent = 'Token revoked.'; await refresh(); }
    catch (error) { fail(error); button.disabled = false; }
  });
  $('token-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('token-value').textContent); status.textContent = 'Token copied.'; }
    catch { status.textContent = 'Copy failed. Select the token and copy it manually.'; }
  });
  $('token-dismiss').addEventListener('click', hide);
  return {refresh, reset() { version++; hide(); list.replaceChildren(); status.textContent = ''; }};
}

if (typeof document !== 'undefined') installAccessTokens(document);
