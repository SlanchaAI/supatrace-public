// Account security summary at the top of Settings. It makes two-factor authentication findable when the deployment has
// it switched on, and says plainly when it does not. It reads the state app.js already rendered from /api/me (the
// two-factor section is shown only when the server reports the switch on; its "Turn on" button is hidden once the account
// is enrolled), so it makes no request of its own. One import in app.js; no change to the shared page markup.
const SUMMARY = '<div><h2>Account security</h2><p class="muted">Two-factor authentication asks for a code from an authenticator app after you sign in.</p></div><div><p id="security-mfa" role="status"></p><button id="security-mfa-go" type="button" class="quiet" hidden></button></div>';
const HELP = 'You need an authenticator app (TOTP). Turning it on shows a secret to add to the app, then eight one-time recovery codes. Keep the recovery codes: they are the only way back in without the app, and there is no email reset.';
export const MFA_STATES = Object.freeze({
  unavailable: {text: 'Two-factor authentication is not available on this deployment.', action: null},
  off: {text: 'Two-factor authentication is off for this account.', action: 'Set up two-factor authentication'},
  on: {text: 'Two-factor authentication is on for this account.', action: 'Manage two-factor authentication'}
});
/** unavailable: the server reports the switch off. off / on: the switch is on and the account is not / is enrolled. */
export const mfaState = ({sectionHidden, enrollHidden}) => sectionHidden ? 'unavailable' : enrollHidden ? 'on' : 'off';

export function installMfaStatus(document) {
  const settings = document.querySelector('#view-settings .settings'), section = document.getElementById('mfa-section'), enroll = document.getElementById('mfa-enroll');
  if (!settings || !section || !enroll || document.getElementById('security-summary')) return null;
  const summary = document.createElement('div'); summary.className = 'setting'; summary.id = 'security-summary'; summary.hidden = true; summary.innerHTML = SUMMARY;
  settings.insertBefore(summary, settings.firstElementChild?.nextElementSibling ?? null); // right after Account
  const help = document.createElement('p'); help.className = 'hint'; help.id = 'mfa-help'; help.textContent = HELP;
  document.getElementById('mfa-note')?.after(help);
  const text = document.getElementById('security-mfa'), go = document.getElementById('security-mfa-go');
  const sync = () => {
    if (!document.body.classList.contains('signed-in')) { summary.hidden = true; return; }
    const name = mfaState({sectionHidden: section.hidden, enrollHidden: enroll.hidden}), state = MFA_STATES[name];
    summary.hidden = false; summary.dataset.mfa = name; text.textContent = state.text; go.hidden = state.action === null; go.textContent = state.action ?? '';
  };
  go.addEventListener('click', () => { section.scrollIntoView({block: 'center'}); const target = [enroll, document.getElementById('mfa-reenroll')].find(button => button && !button.hidden); target?.focus(); });
  const observer = new MutationObserver(sync);
  observer.observe(document.body, {attributes: true, attributeFilter: ['class']});
  for (const node of [section, enroll]) observer.observe(node, {attributes: true, attributeFilter: ['hidden']});
  sync();
  return {sync};
}
if (typeof document !== 'undefined') installMfaStatus(document);
