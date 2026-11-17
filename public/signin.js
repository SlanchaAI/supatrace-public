import {rememberSetupCode,setupReturnUrl} from './app/setup-code.js';
// API requests from this page are retried when the service is momentarily busy (see app/request-queue.js).
import './app/request-queue.js';
const messages = {
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
  if (!response.ok) throw Object.assign(new Error(value.error || 'request_failed'), {status: response.status});
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
function choice(id, href, text) { return el('a', {class: 'button choice', id, href}, text); }

export async function loadProviders() {
  const response = await fetch('/api/auth/providers', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) return {github: true};
  return response.json();
}

function openApp(){
  const target=new URL(setupReturnUrl(),location.origin);
  if(target.pathname===location.pathname&&target.search===location.search){history.replaceState(null,'',target.pathname+target.search+target.hash);location.reload();}
  else location.replace(target.href);
}
export function mountSignIn(root, providers) {
  rememberSetupCode();
  root.classList.add('auth');
  const status = el('p', {id: 'auth-status', role: 'status'});
  const views = {};
  function show(name) { for (const [key, node] of Object.entries(views)) node.hidden = key !== name; status.textContent = ''; }
  function fail(error) { status.textContent = explain(error); }
  async function finish(result) {
    if (result?.mfa_required) { show('mfa'); return; }
    openApp();
  }

  const main = el('div', {'data-view': 'main'});
  if (providers.github !== false) main.append(choice('github', '/api/auth/login', 'Continue with GitHub'));
  if (providers.google) main.append(choice('google', '/api/auth/google', 'Continue with Google'));
  if (providers.chatgpt) main.append(choice('chatgpt', '/api/auth/chatgpt', 'Continue with ChatGPT'));
  if (providers.sso) main.append(button('button choice', 'Continue with SSO', () => show('sso')));
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
    if (main.childNodes.length) main.append(el('div', {class: 'or'}, 'or'));
    main.append(form, el('p', {class: 'switch'}, 'Don’t have an account? ', button('quiet', 'Sign up', () => show('signup'))));
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
    el('h2', {}, 'Get started'), el('p', {class: 'sub'}, 'Create a new account'));
  if (providers.github !== false) signup.append(choice('signup-github', '/api/auth/login', 'Continue with GitHub'));
  if (providers.google) signup.append(choice('signup-google', '/api/auth/google', 'Continue with Google'));
  if (providers.chatgpt) signup.append(choice('signup-chatgpt', '/api/auth/chatgpt', 'Continue with ChatGPT'));
  if (providers.sso) signup.append(button('button choice', 'Continue with SSO', () => show('sso')));
  if (providers.email) {
    if (signup.childNodes.length > 2) signup.append(el('div', {class: 'or'}, 'or'));
    signup.append(signUpForm);
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

  for (const [name, node] of Object.entries({main, sso, signup, forgot, code: codeView, reset, check, confirm, mfa, recovery})) {
    views[name] = node;
  }
  root.replaceChildren(status, main, sso, signup, forgot, codeView, reset, check, confirm, mfa, recovery);
  const confirming = !!providers.email && /^[A-Za-z0-9_-]{43}$/.test(pendingToken) && pendingEmail.length > 0 && pendingEmail !== 'confirmed';
  show(providers.mfa ? 'mfa' : confirming ? 'confirm' : 'main');
  if (confirming) { root.scrollIntoView({block: 'start'}); confirmPassword.input.focus({preventScroll: true}); }
  if (!confirming && pendingEmail === 'confirmed') status.textContent = 'Email confirmed. Sign in with your password.';
  const authError=pending.get('auth_error');
  if (['provider_unavailable','restart_required','not_verified','unavailable'].includes(authError)) {
    const provider=pending.get('provider')==='google'?'Google':'GitHub';
    status.textContent=authError==='restart_required'
      ? 'That sign-in attempt expired or was already used. Start a fresh sign-in with '+provider+'.'
      : provider+' sign-in could not finish. Start a fresh sign-in with '+provider+'. If this continues, use the sign-in method you previously used for this account.';
    const clean=new URL(location.href);clean.searchParams.delete('auth_error');clean.searchParams.delete('provider');
    history.replaceState(null,'',clean.pathname+clean.search+clean.hash);
  }
}

if (document.body?.dataset?.page === 'landing') {
  const root = document.getElementById('signin');
  loadProviders().then(providers => mountSignIn(root, providers)).catch(() => mountSignIn(root, {github: true}));
}
