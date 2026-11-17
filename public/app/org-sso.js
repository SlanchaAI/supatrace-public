// Single sign-on and SCIM settings for the selected organization, on the Members page. Owner only.
// Every value is written with textContent. The SCIM token is made here and shown once; the server gets only its SHA-256.
const messages = {
  plan_upgrade_required: 'Single sign-on and SCIM need the Enterprise plan. Billing shows what each plan includes.',
  invalid_sso_certificate: 'That is not an X.509 certificate in PEM form.', invalid_sso_configuration: 'Check the sign-on URL (https), the issuer and the default role.', invalid_sso_domain: 'Enter up to five lower-case domains, such as example.com.',
  sso_domain_not_verified: 'The TXT record was not found yet. DNS changes can take a while; try again later.', sso_domain_claimed: 'Another organization has already verified this domain.', sso_not_ready: 'Save the IdP settings and verify a domain first.',
  sso_not_configured: 'Save the IdP settings first.', workspace_changed: 'Something changed in the meantime. Reload and try again.', workspace_not_shared: 'Enable team sharing first.', rate_limit: 'The request limit was reached. Wait before trying again.'
};
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
export function newScimToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return 'stscim_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export const parseDomains = text => String(text ?? '').split(/[\s,]+/).map(value => value.trim().toLowerCase()).filter(Boolean);
export async function mountOrgSso({document, request, organization, parent}) {
  const card = document.createElement('article'); card.className = 'card'; card.id = 'sso-controls';
  card.innerHTML = '<h2>Single sign-on</h2><p>Let people sign in to this organization with your identity provider (SAML 2.0: Okta, Microsoft Entra ID, Google Workspace and others). Give the provider the two values below, then paste its settings here.</p><dl id="sso-sp"><dt>Audience (SP entity ID)</dt><dd id="sso-entity"></dd><dt>ACS URL</dt><dd id="sso-acs"></dd><dt>Name ID</dt><dd>Email address</dd></dl><p id="sso-status" role="status" aria-live="polite"></p><form id="sso-form"><label>IdP sign-on URL<input name="idp_sso_url" type="url" required maxlength="2048" placeholder="https://idp.example.com/sso/saml"></label><label>IdP issuer<input name="idp_issuer" required maxlength="1024"></label><label>IdP signing certificate (PEM)<textarea name="idp_cert" rows="5" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label><p id="sso-cert" class="hint"></p><label>Email domains<input name="domains" maxlength="400" placeholder="example.com"></label><label>Role for people who join through SSO<select name="default_role"><option value="viewer">Read-only</option><option value="developer">Developer</option><option value="admin">Admin</option></select></label><button type="submit">Save SSO settings</button></form><section id="sso-domains"><h3>Domain verification</h3><p>Add each TXT record at your DNS provider, then choose Verify. Sign-in with SSO works for a domain only after it is verified.</p><div id="sso-domain-list"></div></section><form id="sso-enforce"><h3>Require SSO</h3><label><input type="checkbox" name="enforce"> Members must sign in through this identity provider</label><p class="hint">Members signed in another way are refused until they use SSO. The owner keeps access, so a broken identity provider cannot lock the organization.</p><button type="submit">Save requirement</button></form><section id="sso-scim"><h3>SCIM provisioning</h3><p>Your identity provider can add and remove members with SCIM 2.0 (Users). Base URL: <code id="scim-base"></code>. Authentication: bearer token.</p><p id="scim-state" class="hint"></p><button id="scim-new" type="button" class="quiet">Create SCIM token</button><div id="scim-created" hidden><p>Copy this token now. It is not shown again. Creating another replaces it.</p><p><code id="scim-token"></code></p></div></section>';
  parent.append(card);
  const $ = id => card.querySelector('#' + id), form = $('sso-form'), status = $('sso-status');
  const fail = error => { status.textContent = 'Could not save: ' + (messages[error?.message] || String(error?.message || 'request failed')) + ' No automatic retry was made.'; };
  let current = null;
  function show(config) {
    current = config;
    $('sso-entity').textContent = config.service_provider.entity_id; $('sso-acs').textContent = config.service_provider.acs_url; $('scim-base').textContent = config.scim.base_url;
    form.elements.idp_sso_url.value = config.idp_sso_url ?? ''; form.elements.idp_issuer.value = config.idp_issuer ?? ''; form.elements.default_role.value = config.default_role; form.elements.domains.value = config.domains.map(d => d.domain).join(', ');
    form.elements.idp_cert.required = !config.configured; $('sso-cert').textContent = config.idp_cert_sha256 ? 'Saved certificate SHA-256 fingerprint: ' + config.idp_cert_sha256 + '. Paste a certificate only to replace it.' : 'No certificate saved yet.';
    const list = $('sso-domain-list'); list.replaceChildren();
    for (const entry of config.domains) {
      const row = document.createElement('p'), text = document.createElement('span'); row.className = 'sso-domain'; row.dataset.domain = entry.domain;
      text.textContent = entry.verified ? `${entry.domain}: verified. ` : `${entry.domain}: not verified. TXT record ${entry.record.name} with value ${entry.record.value} `; row.append(text);
      if (!entry.verified) { const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet'; button.textContent = 'Verify ' + entry.domain; button.onclick = async () => { button.disabled = true; status.textContent = 'Checking DNS…'; try { show(await request('orgs/sso/verify', {organization_id: organization, domain: entry.domain})); status.textContent = entry.domain + ' is verified.'; } catch (error) { fail(error); button.disabled = false; } }; row.append(button); }
      list.append(row);
    }
    $('sso-domains').hidden = !config.domains.length;
    const enforce = $('sso-enforce'); enforce.elements.enforce.checked = config.enforce; enforce.hidden = !config.configured || !config.domains.some(d => d.verified);
    $('sso-scim').hidden = !config.configured; $('scim-state').textContent = config.scim.token_set ? 'A SCIM token is set.' : 'No SCIM token yet.';
  }
  let certificate = null;
  form.onsubmit = async event => {
    event.preventDefault(); const data = new FormData(form), pasted = String(data.get('idp_cert') ?? '').trim(); if (pasted) certificate = pasted;
    if (!certificate) { status.textContent = 'Paste the certificate again to change these settings. Only its fingerprint is kept for display.'; return; }
    status.textContent = 'Saving…';
    try { show(await request('orgs/sso', {organization_id: organization, idp_sso_url: data.get('idp_sso_url'), idp_issuer: data.get('idp_issuer'), idp_cert: certificate, default_role: data.get('default_role'), domains: parseDomains(data.get('domains'))})); form.elements.idp_cert.value = ''; status.textContent = 'SSO settings saved.'; }
    catch (error) { fail(error); }
  };
  $('sso-enforce').onsubmit = async event => { event.preventDefault(); status.textContent = 'Saving…'; try { show(await request('orgs/sso/enforce', {organization_id: organization, enforce: $('sso-enforce').elements.enforce.checked})); status.textContent = current.enforce ? 'SSO is now required for members.' : 'SSO is no longer required.'; } catch (error) { fail(error); } };
  $('scim-new').onclick = async () => {
    const token = newScimToken(), hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    try { show(await request('orgs/sso/scim-token', {organization_id: organization, token_hash: hash})); $('scim-token').textContent = token; $('scim-created').hidden = false; status.textContent = 'SCIM token created.'; } catch (error) { fail(error); }
  };
  try { show(await request('orgs/sso?workspace=' + encodeURIComponent(organization))); } catch (error) { status.textContent = 'SSO settings could not be loaded. Reload to try again.'; }
  return card;
}
