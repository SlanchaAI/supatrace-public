import {rememberSetupCode,setupReturnUrl} from './app/setup-code.js';
import {startupRead} from './app/startup-data.js';
// API requests from this page are retried when the service is momentarily busy (see app/request-queue.js).
import './app/request-queue.js';
// Remove the bearer link before provider discovery or any user interaction.
const linkLocation = globalThis.location ? new URL(location.href) : null;
let incomingLink = linkLocation?.searchParams.get('link') ?? null;
if (linkLocation?.searchParams.has('link')) {
  linkLocation.searchParams.delete('link');
  history.replaceState(history.state, '', linkLocation.pathname + linkLocation.search + linkLocation.hash);
}
const linkInvalidMessage = 'This sign-in link was already used or has expired. Request a new one below.';
const messages = {
  link_invalid: linkInvalidMessage,
  invalid_credentials: 'Invalid email or password.',
  session_unavailable: 'Sign-in is busy. Please try again shortly.',
  session_changed: 'Your account changed during sign-in. Please sign in again.',
  email_not_confirmed: 'Your account has not been verified. Check the link sent to your email. It expires in 10 minutes.',
  password_rejected: 'Password must be 8 to 72 characters and include an uppercase letter, a lowercase letter, a number, and a special character.',
  email_already_registered: 'An account with this email already exists.',
  invalid_email: 'Must be a valid email.',
  invalid_code: 'That code is not valid.',
  sso_domain_unknown: 'No SSO provider assigned for this domain.',
  sso_request_busy: 'Single sign-on is busy. Please try again.',
  email_sign_in_unavailable: 'Email sign-in is not available right now.',
  email_unavailable: 'Email could not be sent. Try again later.',
  rate_limit: 'Too many attempts. Wait and try again.',
  mfa_locked: 'Two-factor authentication is locked. Wait for the lock to end, then try the current code or a recovery code.',
  sign_in_required: 'Please sign in to continue.'
};
function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const kid of kids) node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}
function button(className, text, onClick) {
  const node = el('button', {type: 'button', class: className}, text);
  node.addEventListener('click', onClick);
  return node;
}
export async function post(path, body) {
  const raw = JSON.stringify(body);
  // CloudFront signs the Lambda URL request; POST bodies need their exact UTF-8 payload hash.
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))), value => value.toString(16).padStart(2, '0')).join('');
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json', 'x-amz-content-sha256': hash}, credentials: 'same-origin', body: raw});
  if (response.status === 204) return {};
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || 'request_failed'), {status: response.status, retryAfter: response.headers.get('Retry-After')});
  return value;
}
function explain(error) { return messages[error.message] || 'Sign-in could not be completed.'; }
function passwordField(id, autocomplete) {
  const input = el('input', {id, type: 'password', autocomplete, required: true, maxlength: '72'});
  const reveal = button('quiet reveal', 'Show', () => {
    const hidden = input.getAttribute('type') === 'password';
    input.setAttribute('type', hidden ? 'text' : 'password');
    reveal.textContent = hidden ? 'Hide' : 'Show';
    reveal.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
  });
  reveal.setAttribute('aria-label', 'Show password');
  return {input, wrap: el('div', {class: 'field'}, input, reveal)};
}
function rules(input) {
  const list = el('ul', {class: 'rules'});
  const checks = [
    ['Uppercase letter', value => /[A-Z]/.test(value)],
    ['Lowercase letter', value => /[a-z]/.test(value)],
    ['Number', value => /[0-9]/.test(value)],
    ['Special character (e.g. !?<>@#$%)', value => /[^A-Za-z0-9]/.test(value)],
    ['8 characters or more', value => value.length >= 8]
  ];
  function paint() {
    list.replaceChildren();
    const value = input.value;
    for (const [title, met] of checks) {
      const item = el('li', {class: met(value) ? 'met' : ''}, title);
      list.append(item);
    }
    if (value.length > 72) list.append(el('li', {}, '72 characters or less'));
  }
  input.addEventListener('input', paint);
  paint();
  return list;
}
function legal() {
  return el('p', {class: 'legal'}, 'By continuing you agree to the ',
    el('a', {href: '/terms.html'}, 'Terms of Service'), ' and ',
    el('a', {href: '/privacy.html'}, 'Privacy Policy'));
}
function choice(id, href, text) { return el('a', {class: 'button choice' + (id.endsWith('github') ? ' provider-primary' : ' secondary'), id, href}, text); }

export function hasPendingLink() { return incomingLink !== null; }
export async function loadProviders({attempts = 2} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt || attempts === 1) await new Promise(resolve => setTimeout(resolve, 200));
    try {
      const providers = await startupRead(async signal => {
        const response = await fetch('/api/auth/providers', {credentials: 'same-origin', cache: 'no-store', signal});
        if (!response.ok) throw Error('providers_unavailable');
        const value = await response.json();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('providers_unavailable');
        return value;
      }, {timeoutMs: 6000});
      return providers;
    } catch { /* Retry discovery once; all sign-in endpoints enforce configuration themselves. */ }
  }
  return {github: true};
}

function openApp(){
  const target=new URL(setupReturnUrl(),location.origin);
  if(target.pathname===location.pathname&&target.search===location.search){history.replaceState(null,'',target.pathname+target.search+target.hash);location.reload();}
  else location.replace(target.href);
}
export function mountSignIn(root, providers) {
  rememberSetupCode();
  // A link proves email sign-in intent even when provider discovery is unavailable.
  if (hasPendingLink() || new URLSearchParams(location.search).get('auth_error') === 'link_invalid') providers = {...providers, email: true};
  root.classList.add('auth');
  const status = el('p', {id: 'auth-status', role: 'status', tabindex: '-1'});
  const views = {};
  function show(name) { for (const [key, node] of Object.entries(views)) node.hidden = key !== name; status.textContent = ''; }
  function fail(error) { status.textContent = explain(error); }
  async function finish(result) {
    clearSentLink();
    if (result?.mfa_required) { show('mfa'); return; }
    openApp();
  }

  const sentLinkSlot = 'supatrace-sent-link';
  let sentEmail = '', resendAt = 0, expiresAt = 0, sendingLink = false, linkRequest = 0;
  function clearSentLink() {
    // Recovery invalidates pending sends, including their error and cleanup paths.
    linkRequest++;
    sendingLink = false;
    sentEmail = ''; resendAt = 0; expiresAt = 0;
    try { sessionStorage.removeItem(sentLinkSlot); } catch { /* Storage may be unavailable. */ }
  }
  function saveSentLink() {
    if (!expiresAt) return;
    // Only successful-send metadata, never a bearer token.
    try { sessionStorage.setItem(sentLinkSlot, JSON.stringify({sentEmail, resendAt, expiresAt})); } catch { /* Keep the current view usable. */ }
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(sentLinkSlot));
    if (typeof saved?.sentEmail === 'string' && saved.sentEmail && Number.isFinite(saved.resendAt) && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()) {
      ({sentEmail, resendAt, expiresAt} = saved);
    } else clearSentLink();
  } catch { clearSentLink(); }
  function retryDeadline(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.parse(value) || Date.now() + 60000;
  }
  function paintResend() {
    const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    resend.disabled = sendingLink || seconds > 0;
    resend.textContent = seconds ? `Resend in ${seconds}s` : 'Resend sign-in link';
    if (seconds) setTimeout(paintResend, Math.min(1000, resendAt - Date.now()));
  }
  async function sendLink(email, submit) {
    if (sendingLink) return;
    if (email.trim().toLowerCase() === sentEmail.trim().toLowerCase() && Date.now() < resendAt) { showLinkResult(!!expiresAt); paintResend(); focusSignIn(linkSentHeading); return; }
    const resending = submit === resend;
    if (!resending) clearSentLink();
    const request = ++linkRequest;
    sendingLink = true;
    submit.disabled = true;
    resendAt = 0;
    sentEmail = email;
    try {
      await post('/api/auth/email/link', {email});
      if (request !== linkRequest) return;
      resendAt = Date.now() + 60000;
      expiresAt = Date.now() + 900000;
      saveSentLink();
      showLinkResult(true);
      if (resending) status.textContent = 'Sent again';
      focusSignIn(resending ? status : linkSentHeading);
    } catch (error) {
      if (request !== linkRequest) return;
      if (error.status === 429) resendAt = retryDeadline(error.retryAfter);
      if (resending || error.status === 429) showLinkResult(!!expiresAt);
      saveSentLink();
      fail(error);
      if (resending || error.status === 429) focusSignIn(status);
    } finally {
      if (request === linkRequest) { sendingLink = false; submit.disabled = false; paintResend(); }
    }
  }
  function linkForm(id) {
    const email = el('input', {id, type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com'});
    const submit = el('button', {type: 'submit', class: 'button choice secondary'}, 'Email me a sign-in link');
    const form = el('form', {}, el('label', {for: id}, 'Email'), email, submit);
    form.addEventListener('submit', event => { event.preventDefault(); sendLink(email.value, submit); });
    return form;
  }
  const resend = button('button choice secondary', 'Resend sign-in link', () => sendLink(sentEmail, resend));
  const linkSentHeading = el('h2', {tabindex: '-1'});
  const linkSentMessage = el('p', {class: 'sub'});
  function showLinkResult(delivered) {
    linkSentHeading.textContent = delivered ? 'Check your email' : 'Try again later';
    linkSentMessage.textContent = delivered ? `We sent a sign-in link to ${sentEmail}.` : messages.rate_limit;
    show('linkSent');
  }
  const linkSent = el('div', {'data-view': 'linkSent', hidden: true},
    linkSentHeading, linkSentMessage, el('p', {class: 'sub'}, 'It expires in 15 minutes and works once.'),
    button('quiet', 'Use a different email', () => { clearSentLink(); show('main'); focusSignIn(root.querySelector('#link-email')); }), resend);
  function focusSignIn(target) {
    requestAnimationFrame(() => { root.scrollIntoView({block: 'nearest'}); target?.focus({preventScroll: true}); });
  }
  function invalidLink() {
    incomingLink = null;
    clearSentLink();
    show('main');
    status.textContent = linkInvalidMessage;
    focusSignIn(root.querySelector('#link-email'));
  }
  const linkContinue = button('primary', 'Continue to SupaTrace', async () => {
    if (linkContinue.disabled) return;
    linkContinue.disabled = true;
    try {
      const result = await post('/api/auth/email/link/confirm', {token: incomingLink});
      incomingLink = null;
      await finish(result);
    }
    catch (error) {
      if (['invalid_code', 'expired', 'used'].includes(error.message)) invalidLink();
      else status.textContent = error.status ? explain(error) : 'Could not reach SupaTrace. Try again.';
    }
    finally { linkContinue.disabled = false; }
  });
  const linkConfirm = el('div', {'data-view': 'linkConfirm', hidden: true},
    el('h2', {}, 'Continue to SupaTrace'), linkContinue, legal());

  const main = el('div', {'data-view': 'main'}, el('h2', {}, 'Sign in'));
  if (providers.github !== false) main.append(choice('github', '/api/auth/login', 'Continue with GitHub'));
  if (providers.google) main.append(choice('google', '/api/auth/google', 'Continue with Google'));
  if (providers.chatgpt) main.append(choice('chatgpt', '/api/auth/chatgpt', 'Continue with ChatGPT'));
  if (providers.sso) main.append(button('button choice secondary', 'Continue with SSO', () => show('sso')));
  const emailInput = el('input', {id: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com'});
  const password = passwordField('password', 'current-password');
  const signIn = el('button', {class: 'primary', type: 'submit'}, 'Sign in');
  const form = el('form', {id: 'sign-in-form'},
    el('label', {for: 'email'}, 'Email'), emailInput,
    el('div', {class: 'row'}, el('label', {for: 'password'}, 'Password'), button('quiet', 'Forgot password?', () => show('forgot'))),
    password.wrap, signIn);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    signIn.disabled = true;
    try { await finish(await post('/api/auth/email/sign-in', {email: emailInput.value, password: password.input.value})); }
    catch (error) { fail(error); }
    finally { signIn.disabled = false; }
  });
  if (providers.email) {
    if (main.querySelector('.choice')) main.append(el('div', {class: 'or'}, 'or'));
    form.hidden = true;
    main.append(linkForm('link-email'), button('quiet', 'Use a password instead', () => { form.hidden = false; emailInput.focus(); }), form, el('p', {class: 'switch'}, 'New here? ', button('quiet', 'Create a free account', () => show('signup'))));
  }
  main.append(legal());

  const ssoEmail = el('input', {id: 'sso-email', type: 'email', autocomplete: 'email', required: true, placeholder: 'gavin@hooli.com'});
  const ssoButton = el('button', {class: 'primary', type: 'submit'}, 'Sign in');
  const ssoForm = el('form', {}, el('label', {for: 'sso-email'}, 'Email'), ssoEmail, ssoButton);
  ssoForm.addEventListener('submit', async event => {
    event.preventDefault();
    ssoButton.disabled = true;
    try {
      const response = await fetch('/api/auth/sso?email=' + encodeURIComponent(ssoEmail.value), {credentials: 'same-origin'});
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(value.error || 'request_failed'), {status: response.status});
      location.assign(value.url);
    } catch (error) { fail(error); ssoButton.disabled = false; }
  });
  const sso = el('div', {'data-view': 'sso', hidden: true},
    el('h2', {}, 'Welcome back'), el('p', {class: 'sub'}, 'Sign in to your enterprise account'),
    ssoForm, el('p', {class: 'switch'}, 'Interested in SSO? ', button('quiet', 'Let us know', () => { status.textContent = 'SSO is available after an identity provider is configured for your email domain.'; })),
    button('quiet', 'Back to sign in', () => show('main')), legal());

  const signUpEmail = el('input', {id: 'signup-email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com'});
  const signUpPassword = passwordField('signup-password', 'new-password');
  const signUpButton = el('button', {class: 'primary', type: 'submit'}, 'Sign up');
  const signUpForm = el('form', {}, el('label', {for: 'signup-email'}, 'Email'), signUpEmail,
    el('label', {for: 'signup-password'}, 'Password'), signUpPassword.wrap, rules(signUpPassword.input), signUpButton);
  signUpForm.addEventListener('submit', async event => {
    event.preventDefault();
    signUpButton.disabled = true;
    try { await post('/api/auth/email/sign-up', {email: signUpEmail.value, password: signUpPassword.input.value}); show('check'); }
    catch (error) { fail(error); }
    finally { signUpButton.disabled = false; }
  });
  const signup = el('div', {'data-view': 'signup', hidden: true},
    el('h2', {}, 'Create a free account'), el('p', {class: 'sub'}, 'Free plan. No card.'));
  if (providers.github !== false) signup.append(choice('signup-github', '/api/auth/login', 'Continue with GitHub'));
  if (providers.google) signup.append(choice('signup-google', '/api/auth/google', 'Continue with Google'));
  if (providers.chatgpt) signup.append(choice('signup-chatgpt', '/api/auth/chatgpt', 'Continue with ChatGPT'));
  if (providers.sso) signup.append(button('button choice secondary', 'Continue with SSO', () => show('sso')));
  if (providers.email) {
    if (signup.childNodes.length > 2) signup.append(el('div', {class: 'or'}, 'or'));
    signUpForm.hidden = true;
    signup.append(linkForm('signup-link-email'), button('quiet', 'Use a password instead', () => { signUpForm.hidden = false; signUpEmail.focus(); }), signUpForm);
  }
  signup.append(el('p', {class: 'switch'}, 'Have an account? ', button('quiet', 'Sign in', () => show('main'))), legal());

  const forgotEmail = el('input', {id: 'forgot-email', type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com'});
  const forgotButton = el('button', {class: 'primary', type: 'submit'}, 'Send reset code');
  const forgotForm = el('form', {}, el('label', {for: 'forgot-email'}, 'Email'), forgotEmail, forgotButton);
  forgotForm.addEventListener('submit', async event => {
    event.preventDefault();
    forgotButton.disabled = true;
    try { await post('/api/auth/email/reset', {email: forgotEmail.value}); show('code'); }
    catch (error) { fail(error); }
    finally { forgotButton.disabled = false; }
  });
  const forgot = el('div', {'data-view': 'forgot', hidden: true},
    el('h2', {}, 'Forgot your password?'), el('p', {class: 'sub'}, 'Enter your email and we\'ll send you a code to reset the password'),
    forgotForm, el('p', {class: 'switch'}, 'Already have an account? ', button('quiet', 'Sign in', () => show('main'))));

  const resetCode = el('input', {id: 'reset-code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, minlength: '6', maxlength: '6', placeholder: 'XXXXXX'});
  const codeButton = el('button', {class: 'primary', type: 'submit'}, 'Confirm reset code');
  const codeForm = el('form', {}, el('label', {for: 'reset-code'}, 'Code'), resetCode, codeButton);
  codeForm.addEventListener('submit', async event => {
    event.preventDefault();
    codeButton.disabled = true;
    try { await post('/api/auth/email/reset/confirm', {email: forgotEmail.value, code: resetCode.value}); show('reset'); }
    catch (error) { fail(error); }
    finally { codeButton.disabled = false; }
  });
  const codeView = el('div', {'data-view': 'code', hidden: true},
    el('h2', {}, 'Check your email for a reset code'),
    el('p', {class: 'sub'}, 'You\'ll receive an email if an account associated with the email address exists'),
    codeForm);

  const newPassword = passwordField('new-password', 'new-password');
  const resetButton = el('button', {class: 'primary', type: 'submit'}, 'Reset password');
  const resetForm = el('form', {}, el('label', {for: 'new-password'}, 'Password'), newPassword.wrap, rules(newPassword.input), resetButton);
  resetForm.addEventListener('submit', async event => {
    event.preventDefault();
    resetButton.disabled = true;
    try { await post('/api/auth/email/reset/password', {password: newPassword.input.value}); status.textContent = 'Password updated. Sign in with the new password.'; show('main'); }
    catch (error) { fail(error); }
    finally { resetButton.disabled = false; }
  });
  const reset = el('div', {'data-view': 'reset', hidden: true}, el('h2', {}, 'Choose a new password'), resetForm);

  const check = el('div', {'data-view': 'check', hidden: true},
    el('h2', {}, 'Check your email'), el('p', {class: 'sub'}, 'We sent you a link. Open it and enter the password you chose. The link expires in 10 minutes.'),
    button('quiet', 'Back to sign in', () => show('main')));

  const pending = new URLSearchParams(location.search);
  const requestedView = pending.get('view');
  if (pending.has('view')) {
    const clean = new URL(location.href);
    clean.searchParams.delete('view');
    history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
  }
  const pendingEmail = pending.get('email') || '';
  const pendingToken = pending.get('token') || '';
  const confirmEmail = el('input', {id: 'confirm-email', type: 'email', value: pendingEmail, readonly: true, autocomplete: 'username'});
  const confirmPassword = passwordField('confirm-password', 'current-password');
  const confirmButton = el('button', {class: 'primary', type: 'submit'}, 'Confirm email');
  const confirmForm = el('form', {}, el('label', {for: 'confirm-email'}, 'Email'), confirmEmail,
    el('label', {for: 'confirm-password'}, 'Password'), confirmPassword.wrap, confirmButton);
  confirmForm.addEventListener('submit', async event => {
    event.preventDefault();
    confirmButton.disabled = true;
    try {
      const result = await post('/api/auth/email/verify', {email: pendingEmail, token: pendingToken, password: confirmPassword.input.value});
      history.replaceState(null, '', location.pathname);
      await finish(result);
    } catch (error) { fail(error); }
    finally { confirmButton.disabled = false; }
  });
  const confirm = el('div', {'data-view': 'confirm', hidden: true},
    el('h2', {}, 'Confirm your email'), el('p', {class: 'sub'}, 'Enter the password you chose to confirm your email and sign in.'),
    confirmForm, legal());

  const mfaCode = el('input', {id: 'mfa-code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, minlength: '6', maxlength: '6', placeholder: 'XXXXXX'});
  const mfaButton = el('button', {class: 'primary', type: 'submit'}, 'Verify');
  const mfaForm = el('form', {}, el('label', {for: 'mfa-code'}, 'Authentication code'), mfaCode, mfaButton);
  mfaForm.addEventListener('submit', async event => {
    event.preventDefault();
    mfaButton.disabled = true;
    try { await post('/api/auth/mfa', {code: mfaCode.value}); openApp(); }
    catch (error) { fail(error); }
    finally { mfaButton.disabled = false; }
  });
  const mfa = el('div', {'data-view': 'mfa', hidden: true},
    el('h2', {}, 'Two-factor authentication'),
    el('p', {class: 'sub'}, 'Enter the authentication code from your two-factor authentication app'),
    mfaForm, button('quiet', 'Authenticate using a recovery code', () => show('recovery')),
    button('quiet', 'Back to sign in', () => show('main')));

  const recoveryCode = el('input', {id: 'recovery-code', autocomplete: 'one-time-code', required: true});
  const recoveryButton = el('button', {class: 'primary', type: 'submit'}, 'Verify');
  const recoveryForm = el('form', {}, el('label', {for: 'recovery-code'}, 'Recovery code'), recoveryCode, recoveryButton);
  recoveryForm.addEventListener('submit', async event => {
    event.preventDefault();
    recoveryButton.disabled = true;
    try { await post('/api/auth/mfa/recovery', {code: recoveryCode.value}); openApp(); }
    catch (error) { fail(error); }
    finally { recoveryButton.disabled = false; }
  });
  const recovery = el('div', {'data-view': 'recovery', hidden: true},
    el('h2', {}, 'Recovery code'), recoveryForm, button('quiet', 'Back to sign in', () => show('mfa')));

  for (const [name, node] of Object.entries({main, sso, signup, forgot, code: codeView, reset, check, confirm, linkSent, linkConfirm, mfa, recovery})) {
    views[name] = node;
  }
  root.replaceChildren(status, main, sso, signup, forgot, codeView, reset, check, confirm, linkSent, linkConfirm, mfa, recovery);
  const confirming = !!providers.email && /^[A-Za-z0-9_-]{43}$/.test(pendingToken) && pendingEmail.length > 0 && pendingEmail !== 'confirmed';
  const linking = hasPendingLink();
  show(linking ? 'linkConfirm' : providers.mfa ? 'mfa' : confirming ? 'confirm' : requestedView === 'signup' ? 'signup' : 'main');
  if (linking || providers.mfa || confirming || pending.has('auth_error') || pendingEmail === 'confirmed') clearSentLink();
  else if (expiresAt) { showLinkResult(true); paintResend(); focusSignIn(linkSentHeading); }
  if (linking) focusSignIn(linkContinue);
  if (confirming) { root.scrollIntoView({block: 'start'}); confirmPassword.input.focus({preventScroll: true}); }
  if (!confirming && pendingEmail === 'confirmed') status.textContent = 'Email confirmed. Sign in with your password.';
  const authError=pending.get('auth_error');
  if (authError === 'link_invalid') {
    invalidLink();
    const clean = new URL(location.href); clean.searchParams.delete('auth_error');
    history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
  }
  if (['provider_unavailable','restart_required','not_verified','unavailable'].includes(authError)) {
    const provider=pending.get('provider')==='google'?'Google':'GitHub';
    status.textContent=authError==='restart_required'
      ? 'Start a fresh sign-in with '+provider+' because this attempt expired or was already used.'
      : provider+' sign-in could not finish; start a fresh sign-in with '+provider+'.';
    const clean=new URL(location.href);clean.searchParams.delete('auth_error');clean.searchParams.delete('provider');
    history.replaceState(null,'',clean.pathname+clean.search+clean.hash);
  }
}

if (document.body?.dataset?.page === 'landing') {
  const root = document.getElementById('signin');
  if (hasPendingLink() || new URLSearchParams(location.search).get('auth_error') === 'link_invalid') mountSignIn(root, {github: true});
  else loadProviders().then(providers => mountSignIn(root, providers));
}
