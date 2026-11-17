// Trace drains in Settings: HTTPS webhooks that receive every accepted batch of the active workspace.
// The signing secret is shown once, when the drain is created.
const messages = {
  invalid_drain_url: 'Use a public https:// address with a host name and the default port. Internal names and IP addresses are not allowed.',
  plan_upgrade_required: 'Trace drains need the Pro plan. Billing shows what each plan includes.',
  drain_limit: 'This workspace already has 3 drains. Delete one before adding another.',
  drain_not_found: 'That drain is no longer on this workspace.',
  workspace_admin_required: 'Only workspace owners and admins can manage drains.',
  rate_limit: 'The request limit was reached. Wait before trying again.',
  sign_in_required: 'Please sign in to continue.'
};
const failure = {timeout: 'timed out', connect_failed: 'connection failed', dns_failed: 'host name did not resolve', blocked_address: 'host resolves to a private or reserved address', blocked_url: 'address not allowed', expired: 'gave up after 3 days', batch_unavailable: 'stored batch could not be read', failed: 'failed'};
// The panel builds its own markup and talks to the API itself, so adding it needs one import in
// app.js and no change to the shared page markup.
const PANEL = '<div><h2>Trace drains</h2><p class="muted">Send every accepted batch of this workspace to your own HTTPS endpoint, signed. Owners and admins manage drains. Each request carries <code>X-Supatrace-Signature: t=…,v1=…</code>, an HMAC-SHA256 of <code>t.body</code> with the signing secret. Deliveries are attempted after uploads and on request, and retried with growing pauses for up to 3 days.</p></div><div><p id="drains-status" role="status" aria-live="polite"></p><p id="drains-empty" class="hint">No drains yet.</p><ul id="drains-list" class="token-list" aria-label="Trace drains"></ul><button id="drains-flush" type="button" class="quiet" hidden>Deliver queued now</button><form id="drain-form"><label for="drain-url">Endpoint address</label><input id="drain-url" type="url" maxlength="2048" placeholder="https://example.com/supatrace-hook" required autocomplete="off"><button type="submit">Add drain</button></form><div id="drain-created" hidden><p>Copy this signing secret now. It is not shown again.</p><p><code id="drain-secret"></code></p><button id="drain-copy" type="button" class="quiet">Copy secret</button><button id="drain-dismiss" type="button" class="quiet">Done</button></div></div>';
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
// Drains belong to the workspace the page is showing: the one named in the address, or the signed-in account's own.
async function request(path, body) {
  const workspace = new URLSearchParams(location.search || '').get('workspace');
  const raw = body === undefined ? undefined : JSON.stringify(body), headers = {};
  if (raw !== undefined) { headers['Content-Type'] = 'application/json'; headers['x-amz-content-sha256'] = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))); }
  const response = await fetch('/api/' + path + (workspace ? '?workspace=' + encodeURIComponent(workspace) : ''), {method: raw === undefined ? 'GET' : 'POST', headers, body: raw, credentials: 'same-origin', cache: 'no-store'});
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(response.status === 429 ? 'rate_limit' : value?.error || 'request_failed'); error.status = response.status; throw error; }
  return value;
}
/** Adds the panel above the Session block in Settings, hidden until the workspace allows it, and keeps it in step with sign-in state. */
export function installDrains(document) {
  const settings = document.querySelector('#view-settings .settings');
  if (!settings || document.getElementById('drains-section')) return null;
  const section = document.createElement('div'); section.className = 'setting'; section.id = 'drains-section'; section.hidden = true; section.innerHTML = PANEL;
  settings.insertBefore(section, document.getElementById('logout-settings')?.closest('.setting') ?? null);
  const panel = mountDrains({document, api: request});
  let signedIn = false;
  const sync = () => { const now = document.body.classList.contains('signed-in'); if (now === signedIn) return; signedIn = now; if (now) void panel.refresh(); else panel.reset(); };
  new MutationObserver(sync).observe(document.body, {attributes: true, attributeFilter: ['class']}); sync();
  return panel;
}
export function mountDrains({document, api}) {
  const $ = id => document.getElementById(id);
  const section = $('drains-section'), status = $('drains-status'), list = $('drains-list'), form = $('drain-form'), created = $('drain-created');
  let version = 0;
  const fail = error => { status.textContent = messages[error?.message] || 'Drains could not be loaded. Try again.'; };
  const hide = () => { $('drain-secret').textContent = ''; created.hidden = true; };
  const button = (label, action, id) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = label; b.dataset.action = action; b.dataset.drain = id; return b; };
  function render(drains) {
    list.replaceChildren(...drains.map(drain => {
      const item = document.createElement('li'), url = document.createElement('code'), facts = document.createElement('span');
      url.textContent = drain.url;
      const last = drain.last_status === null ? 'no delivery yet' : drain.last_error ? 'last attempt: ' + (failure[drain.last_error] || drain.last_error.replace('http_', 'HTTP ')) : 'last attempt: HTTP ' + drain.last_status;
      facts.textContent = ' · delivered ' + drain.delivered + ' · queued ' + drain.queued + ' · failed ' + drain.failed + (drain.dropped ? ' · dropped ' + drain.dropped : '') + ' · ' + last + (drain.paused_until ? ' · paused until ' + new Date(drain.paused_until).toLocaleTimeString() : '');
      const remove = button('Delete', 'delete', drain.id); remove.setAttribute('aria-label', 'Delete drain ' + drain.url);
      item.append(url, facts, ' ', button('Send test', 'test', drain.id), ' ', remove); return item;
    }));
    $('drains-empty').hidden = drains.length > 0; $('drains-flush').hidden = !drains.some(drain => drain.queued > 0);
  }
  async function refresh() {
    const mine = ++version;
    try { const data = await api('drains'); if (mine !== version) return; section.hidden = false; render(data.drains); }
    catch (error) { if (mine !== version) return; if (error?.message === 'workspace_admin_required') { section.hidden = true; return; } fail(error); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); hide();
    const submit = form.querySelector('button'); submit.disabled = true; status.textContent = 'Adding drain…';
    try {
      const drain = await api('drains', {url: $('drain-url').value.trim()});
      $('drain-secret').textContent = drain.secret; created.hidden = false; form.reset(); status.textContent = 'Drain added. Copy the signing secret now; it is not shown again.';
      await refresh();
    } catch (error) { fail(error); }
    finally { submit.disabled = false; }
  });
  list.addEventListener('click', async event => {
    const target = event.target.closest('button[data-drain]'); if (!target) return;
    const id = target.dataset.drain;
    if (target.dataset.action === 'delete' && target.dataset.armed !== 'true') { target.dataset.armed = 'true'; target.textContent = 'Confirm delete'; return; }
    target.disabled = true;
    try {
      if (target.dataset.action === 'delete') { await api('drains/delete', {id}); status.textContent = 'Drain deleted. Queued deliveries were discarded; stored traces are unchanged.'; }
      else { const result = await api('drains/test', {id}); status.textContent = result.delivered ? 'Test delivered: HTTP ' + result.status + '.' : 'Test failed: ' + (failure[result.error] || String(result.error).replace('http_', 'HTTP ')) + '.'; }
      await refresh();
    } catch (error) { fail(error); target.disabled = false; }
  });
  $('drains-flush').addEventListener('click', async () => {
    $('drains-flush').disabled = true;
    try { const result = await api('drains/flush', {}); status.textContent = 'Attempted ' + result.attempted + ', delivered ' + result.delivered + ', failed ' + result.failed + '.'; await refresh(); }
    catch (error) { fail(error); }
    finally { $('drains-flush').disabled = false; }
  });
  $('drain-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('drain-secret').textContent); status.textContent = 'Signing secret copied.'; }
    catch { status.textContent = 'Copy failed. Select the secret and copy it manually.'; }
  });
  $('drain-dismiss').addEventListener('click', hide);
  return {refresh, reset() { version++; hide(); list.replaceChildren(); status.textContent = ''; }};
}

if (typeof document !== 'undefined') installDrains(document);
