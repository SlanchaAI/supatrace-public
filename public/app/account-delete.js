// Account closure is personal, even while viewing an organization. Credentials stay in the browser.
const messages = {
 recent_sign_in_required: 'Sign out and sign in again, then delete within ten minutes.',
 owned_organizations_require_transfer_or_deletion: 'Transfer or delete organizations you own before deleting your account.',
 live_billing_requires_operator_closure: 'Contact support@supatrace.dev to close live billing before deleting this account.',
 legacy_billing_requires_operator_closure: 'Contact support@supatrace.dev to close the legacy billing agreement first.',
 workspace_changed: 'Account state changed. Reload and try again.',
 sign_in_required: 'Sign in again before deleting your account.'
};
export function installAccountDelete(document, {request, signedOut = () => location.replace('/app/?account_deleted=1')} = {}) {
 const settings = document.querySelector('#view-settings .settings');
 if (!settings || document.getElementById('account-delete-section')) return null;
 const section = document.createElement('div'); section.className = 'setting'; section.id = 'account-delete-section';
 section.innerHTML = '<div><h2>Delete account</h2><p>This closes your personal account, ends every session, and revokes its keys and traces at once. Transfer or delete organizations you own first. Subscriptions are cancelled during erasure. Stored account data is erased in the background. Recovery backups expire within 35 days. This cannot be undone.</p></div><div><form id="account-delete-form"><label for="account-delete-confirm">Type DELETE to confirm</label><input id="account-delete-confirm" required pattern="DELETE" autocomplete="off"><button type="submit">Delete my account</button></form><p id="account-delete-status" role="status" aria-live="polite"></p></div>';
 settings.insertBefore(section, document.getElementById('logout-settings')?.closest('.setting') ?? null);
 const form = document.getElementById('account-delete-form'), status = document.getElementById('account-delete-status'), button = form.querySelector('button');
 const send = request ?? (async body => {
  const raw = JSON.stringify(body), hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), n => n.toString(16).padStart(2, '0')).join('');
  const r = await fetch('/api/account/delete', {method:'POST', headers:{'Content-Type':'application/json','x-amz-content-sha256':hash}, body:raw, credentials:'same-origin', cache:'no-store'});
  const value = await r.json(); if (!r.ok) throw Error(value.error); return value;
 });
 form.addEventListener('submit', async event => {
  event.preventDefault(); if (button.disabled) return;
  button.disabled = true; status.textContent = 'Closing your personal account…';
  try { const result = await send({confirm:document.getElementById('account-delete-confirm').value}); if (result.deleted !== true) throw Error('unconfirmed'); status.textContent = 'Account closed. Stored data erasure is queued.'; signedOut(); }
  catch (error) { status.textContent = messages[error.message] || 'Account closure could not be confirmed. Reload and check your session before trying again.'; button.disabled = false; }
 });
 return section;
}
if (typeof document !== 'undefined') installAccountDelete(document);
