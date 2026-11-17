# Sign-in

The hosted service supports GitHub, Google, SSO, and email + password, as verified on November 16, 2026. The homepage and signed-out app use the same sign-in component. Provider availability comes from `/api/auth/providers`; optional providers stay hidden on hosts where they are not configured.

For email + password, choose Sign up, enter your email and a password, then open the confirmation link from the support email. Enter the chosen password to confirm the account and sign in. Confirmation opens the app; later visits can use email and password. Forgot password sends a reset code; enter that code and a new password to reset access. Email confirmation links are account verification, not passwordless sign-in.

The legal line is the two links `/terms.html` and `/privacy.html`. It does not ask anyone to agree to email updates. Supatrace collects no email addresses on that line. The sign-in and sign-up line says "By continuing you agree to the Terms of Service and Privacy Policy" with links to the published documents, effective November 16, 2026. The footer also links Acceptable Use and Subprocessors.

Requesting a link twice within a minute sends one email. Resend keeps **Check your email** and the same address visible. Success shows **Sent again** and restarts the 60-second cooldown; rate limits show the existing message and honor Retry-After, while other failures allow retry without claiming another delivery. Focus moves to the status message. Successful-send metadata (address, cooldown deadline, and expiry) stays in this tab’s session storage so reloads and remounts restore the card until the 15-minute expiry. No token is stored. **Use a different email** clears that state and ignores any pending resend result, so a new address can be submitted immediately; explicit link confirmation and sign-in errors take precedence over restoration.

## Workspace startup recovery

The session and project GET sequence has a shared 15-second deadline, including response-body parsing. A stalled read, unavailable service or unverified project leaves a visible Retry sign-in check control. Cancel and page interruption cancel the pending check; late responses cannot reveal the workspace or replace a newer attempt. Retry is deliberate and only repeats the identity reads. A 429 response keeps Retry disabled for the server's numeric Retry-After interval (60 seconds when absent); the end of that interval does not send a request.

Signed-out provider discovery has its own 15-second deadline and retains the existing GitHub fallback if discovery fails. Successful startup still validates the single project against `/api/me`, establishes billing's account/project recovery scope and handles Checkout return hints before loading usage, traces and keys. Startup retries never create keys, upload data, initiate Checkout or replay a mutation. Tests use synthetic loopback responses and dispatched page-lifecycle events; they do not establish hosted sign-in or native browser back/forward-cache acceptance.

| Option | Supabase dashboard | Supatrace |
| --- | --- | --- |
| Continue with GitHub | First button | Supported when configured for the current host. `/api/auth/login`. A host without its own configured GitHub app does not offer it. |
| Continue with Google | Not on the dashboard | Built. Shown only when `GoogleClientId` and `GoogleSecretArn` are both set. `/api/auth/google`. |
| Continue with ChatGPT | Second button | Experimental disabled scaffold, not an accepted ChatGPT integration. Official identity-token verification and approved client registration must be completed before enabling it. |
| Continue with SSO | Third button | Built. Off until the email domains, SSO URL, issuer, and IdP certificate secret are all set. |
| Email link sign-in | Not on the dashboard | Built. One email address creates an account or signs in. Links expire in 15 minutes and work once. Requires `EmailFrom` and mail delivery. |
| Email and password | After "or" | Supported on the hosted service. Sign up, then confirm using the emailed link and chosen password to sign in and open the app. Self-hosted deployments require `EmailFrom` and mail delivery. |
| Forgot password | Under the password field | Built with the email sign-in. One live code per address. Changing the password ends every existing session. |
| Sign up | "Don't have an account? Sign up" | Built with the email sign-in. The account is created only after the confirmation page password matches the newest sign-up. |
| Two-factor authentication | Asked when the account has it | Built, and off unless `MfaEnabled` is `true`. Settings buttons turn it on, set it up again, or turn it off. |
| Terms of Service and Privacy Policy | Footer links | `/terms.html` and `/privacy.html`. Published documents effective November 16, 2026. |

Passkeys and phone sign-in are not built here.

## Defaults and optional providers

Leave these parameters empty. The deploy passes an empty value for each one the live stack does not already have. `MfaEnabled` is separate: it defaults to `false`, and the deploy passes `false` when the live stack does not already have it. Set it to `true` only when two-factor authentication should be available.

- `GoogleClientId`, `GoogleSecretArn`
- `ChatGptClientId`, `ChatGptSecretArn`, `ChatGptAuthorizeUrl`, `ChatGptTokenUrl`, `ChatGptUserinfoUrl`
- `SsoEmailDomains`, `SsoIdpSsoUrl`, `SsoIdpIssuer`, `SsoIdpCertSecretArn`
- `EmailFrom`

`SsoIdpCertSecretArn` is a Secrets Manager ARN. The certificate PEM is the secret value. It is not a Lambda environment variable.

The function role's permissions boundary is `supatrace-alpha-api-boundary`, in the hand-deployed OIDC stack. The deploy role cannot change that policy. Before Google, ChatGPT, or SSO can read a secret, pass that secret's ARN to the OIDC stack (`GoogleSecretArn`, `ChatGptSecretArn`, or `SsoCertSecretArn`) in the same hand deploy. The boundary already allows `ses:SendEmail` on `identity/*`, so turning mail on later does not require a boundary change. The function role itself only receives that permission when `EmailFrom` is set.

## Email link sign-in

Choose **Email me a sign-in link** on Sign in or Create a free account. Enter one email address for a new or existing account. Open the email, then press **Continue to SupaTrace**. This creates an email account when needed and signs in. An existing email and password account opens the same tenant. The app opens on Home for a new account. **Use a password instead** opens the password form.

The link expires in 15 minutes and works once. The store keeps the SHA-256 hash of the token and the normalized email address. It never keeps the raw token. Opening the link does not read, consume or create a challenge, account or session. The page removes the token from the address bar. Only the confirmation POST consumes the challenge and can create an account or session. Multi-factor authentication (MFA) still applies to enrolled accounts.

`POST /api/auth/email/link` accepts `{email}` and sends the link. New and existing addresses receive the same response, status and mail text, with the same store and mail work. `GET /api/auth/email/link?token=…` checks token shape and redirects to the confirmation page with no-store and no-referrer headers. `POST /api/auth/email/link/confirm` accepts `{token}` and returns `{ok:true,new_account:true|false}` or `{mfa_required:true}`. Invalid, expired and used tokens return `invalid_code`. POSTs require same-origin JSON. Routes and controls stay unavailable when email is not configured.

Limits are 5 requests per 5 minutes for each email and each IP network, 20 per hour per network, 30 per hour per email domain and 200 per hour for the service. IPv6 uses its /64 prefix. Confirmation allows 10 attempts per 5 minutes per network. A limit returns 429 with Retry-After. Resend waits for that interval. Mail failure returns 503 email_unavailable and removes the challenge. Account creation uses the alpha account cap; capacity failure returns 429 account_capacity.

Passwordless accounts have no password hash. Password sign-in fails until the owner uses Forgot password to set a password. Password sign-up, sign-in, confirmation and reset keep their existing paths.

Signing in by email creates a separate account from GitHub or Google sign-in. Account merging is not available.

## Email and password

The confirmation email asks you to open the link and enter the password you chose to sign in. The link expires in 10 minutes.

An unconfirmed sign-up is a short-lived challenge, not an account. It does not take a row in the 100-account alpha cap, and it does not reserve the address. Signing up again replaces that challenge and sends a new link. The previous link stops working. Opening the link, or requesting `GET /api/auth/email/verify`, does not create the account. The page asks for the password. The account is created only when that password matches the newest challenge, so the person who registered last cannot own a confirmed account by sending the last email. A different password leaves the account uncreated, and the challenge stays so the matching password can still be tried. A successful confirmation sets a session through the same helper as password sign-in and opens `/app/`. Two-factor authentication, when required, still runs before a session is issued. Opening the link alone never sets a session. A later sign-up for an address that already has an account returns `email_already_registered`. Signing in before the account is created returns the same `invalid_credentials` as an unknown address.

A password is rejected before any sign-up counter moves. The 5-per-5-minutes check for that email address and for that network runs next, and an address that already has an account is rejected after that. Only a request that passes those checks is counted, and the count happens immediately before the confirmation email is sent. The caps are 3 confirmation emails per hour for each network, 8 per hour for each email domain, and 20 per hour for the whole service. A request that fails an earlier check does not use the hourly caps. An IPv4 address is its own identity. An IPv6 address is the /64 prefix (the first four groups).

Password rules match the dashboard checklist: 8 to 72 characters, with an uppercase letter, a lowercase letter, a number, and a special character.

Mail uses Amazon SES from `EmailFrom`. Create and verify that identity before setting the parameter. Move SES out of the sandbox before setting `EmailFrom`, or mail only reaches verified recipient addresses. No SES identity is created by this repository.

## Password reset

One code is live per address. Asking again replaces it, and the previous code dies. Five wrong codes burn the live code. Reset requests are limited to 5 per 5 minutes per address and per network. The reply is the same whether or not an account exists, and a code is sent only for a confirmed account. When the password is reset, every existing session for that account stops working. A new sign-in with the new password is required.

## Two-factor authentication

`MfaEnabled` defaults to `false`, so two-factor authentication is not on for every account when this merges. Set the parameter to `true` to show the Settings controls and to ask for a code at sign-in (the operator action is under [Turning it on](#turning-two-factor-authentication-on-operator)). Setting `MfaEnabled` back to `false` quietly drops the second factor for enrolled accounts: sign-in asks for the password alone, and the stored secret is left in place. While it is false, enroll, confirm, disable, and code checks return `mfa_unavailable`.

The secret is base32, the form authenticator apps accept (`otpauth` SHA1, 30 seconds, 6 digits). Settings has "Turn on two-factor authentication", "Set up two-factor authentication again", and "Turn off two-factor authentication". Enrollment shows eight one-time recovery codes. Those codes are the recovery path. There is no email reset of two-factor authentication.

Five wrong codes, whether authenticator codes or recovery codes, lock the account. The lock starts at 5 minutes and doubles after each further set of five failures, up to 1 hour. During the lock, neither the authenticator nor a recovery code is accepted, and a new sign-in is refused with `mfa_locked`. After the lock ends, a recovery code signs the person in and is single-use. A session created in the last 10 minutes, or the current authenticator code, can turn two-factor authentication off from Settings. A successful code resets the failure count. Setting it up again or turning it off requires the current code, or a session that was created in the last 10 minutes. The first time it is turned on, no current code exists yet, so the signed-in session is enough.

### Where a customer finds it

When the switch is on, **Settings** opens with an **Account security** block right under Account. It says whether two-factor authentication is off or on for the signed-in account and has a button that jumps to the two-factor controls further down ("Set up two-factor authentication" when it is off, "Manage two-factor authentication" when it is on). The controls explain what is needed: an authenticator app, and that the eight recovery codes are the only way back in without it.

When the switch is off, the same block says "Two-factor authentication is not available on this deployment." and offers no button, and the controls stay hidden.

### Turning two-factor authentication on (operator)

This is a stack parameter change. Nothing in this repository makes it: the template default stays `false`, and the Deploy workflow cannot do it. That workflow passes `UsePreviousValue` for `MfaEnabled` once the stack has the parameter (the values it sets itself are `ArtifactKey`, `McpBridgeEnabled` when explicitly asked, and the template default for a parameter the stack does not have yet), and it executes a change set only when its review finds an artifact-only change. The commands below have not been run by this change.

Before: the live stack must already be on a template that has the `MfaEnabled` parameter (true once a release from this trunk has been deployed), and the operator must authorize enabling it. On November 15 the live stack was enabled and synthetic enrollment, challenge, recovery and disabling passed.

With credentials that may update the stack, in `us-east-1`:

```sh
STACK="${STACK_NAME:?set your deployment stack name}"

# 1. The parameter exists and is false.
aws cloudformation describe-stacks --region us-east-1 --stack-name "$STACK" \
  --query "Stacks[0].Parameters[?ParameterKey=='MfaEnabled'].ParameterValue" --output text

# 2. MfaEnabled=true, every other parameter unchanged.
aws cloudformation describe-stacks --region us-east-1 --stack-name "$STACK" \
  --query 'Stacks[0].Parameters[].ParameterKey' --output json \
  | node -e 'const keys=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!keys.includes("MfaEnabled"))throw new Error("MfaEnabled is not a parameter of the live stack");console.log(JSON.stringify(keys.map(k=>k==="MfaEnabled"?{ParameterKey:k,ParameterValue:"true"}:{ParameterKey:k,UsePreviousValue:true})))' \
  > mfa-parameters.json

# 3. A change set on the template that is already deployed.
aws cloudformation create-change-set --region us-east-1 --stack-name "$STACK" \
  --change-set-name mfa-enabled-true --change-set-type UPDATE --use-previous-template \
  --capabilities CAPABILITY_NAMED_IAM --parameters file://mfa-parameters.json
aws cloudformation wait change-set-create-complete --region us-east-1 --stack-name "$STACK" --change-set-name mfa-enabled-true

# 4. Read it before executing. Expect one row: Modify, Api, False (the function's environment; no replacement).
#    That expectation comes from the template (only the function references MfaEnabled); it was not checked against the live stack.
aws cloudformation describe-change-set --region us-east-1 --stack-name "$STACK" --change-set-name mfa-enabled-true \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]' --output text

# 5. Execute and wait.
aws cloudformation execute-change-set --region us-east-1 --stack-name "$STACK" --change-set-name mfa-enabled-true
aws cloudformation wait stack-update-complete --region us-east-1 --stack-name "$STACK"

# 6. The API now reports the switch on.
curl -s https://supatrace.dev/api/auth/providers    # contains "mfa_enabled":true
```

If step 4 shows anything other than that one row, delete the change set (`aws cloudformation delete-change-set ...`) and do not execute it.

After this, later runs of the Deploy workflow keep `MfaEnabled` as set, since they pass `UsePreviousValue` for it. To turn it off again, repeat with `ParameterValue:"false"`; as said above, that drops the second factor for accounts that enrolled.

**The switch takes effect at once.** As soon as step 5 completes the server accepts enrollment for every account; no further gate exists, and recording an acceptance does not add one. The dashboard reads the switch when it loads, so a customer sees the controls on the next page load. A tab that was already open keeps saying "not available" until it is reloaded. So do the live check immediately after: enroll a real account on https://supatrace.dev, sign in with a code and with a recovery code, and record the result. Until that is recorded, two-factor authentication is on in production but unverified there.

The README records the enabled production state separately from the template-off default. Recheck `/api/auth/providers` and customer Settings after any operator switch change.

## SSO

SSO uses `@node-saml/node-saml` 5.1.0. That library checks the XML signature, the audience, NotBefore, NotOnOrAfter, and InResponseTo. The assertion issuer must match `SsoIdpIssuer`. `wantAssertionsSigned` is on and `wantAuthnResponseSigned` is off, which is how Okta signs: the signature is inside the assertion. A fixture signed that way is in `tests/saml-fixture.mjs`.

The IdP posts the response from its own site, so the browser binding is its own cookie, `supatrace-sso`. It is `Secure`, `HttpOnly`, `SameSite=None`, lasts 10 minutes, and its path is only `/api/auth/sso/callback`. It is not an `__Host-` cookie, because that prefix requires `Path=/`. The cookie value is the RelayState. The SAML request id is a different value, stored for the InResponseTo check, so the two are not confused. A RelayState that does not match the cookie is rejected before the assertion is validated, and the request id stays valid for the real response. GitHub, Google, and ChatGPT still use `__Host-supatrace-oauth`, which is a same-site redirect and stays `SameSite=Lax`.

An organization's owner can also connect their own IdP, without stack parameters: see [organization SSO and SCIM](organization-sso.md). The parameters above then apply only to a deployment-wide IdP.

## ChatGPT

This is a generic experimental OAuth scaffold, not a supported official ChatGPT sign-in. A configured userinfo subject may contain `|`; spaces and control characters are rejected. Supplying the client ID, secret and all three URLs would expose the scaffold mechanically. Configuration is not provider approval or identity-verification acceptance, and no separate acceptance flag protects it. Keep these parameters empty until an approved official integration, client registration, required identity-token verification and acceptance are complete. Do not guess endpoints or reuse another application's client identity. Any credential installation or access change requires its own approval.

## Failed OAuth attempts

Google and GitHub token exchange failures emit only a fixed event, provider, HTTP status and allowlisted error category. Codes, tokens, secrets, callback URLs, provider descriptions and full responses must never be logged. Unknown or oversized error responses get a generic category. Network failures have status zero. These diagnostics identify the failed stage; they do not prove which credential or account setting is wrong.

A browser callback failure redirects to a clean workspace sign-in with an allowlisted error marker. The UI removes that marker from history and offers a fresh sign-in with the same provider. JSON/API callers retain a bounded error response. OAuth state stays single-use: do not refresh or replay an old callback to troubleshoot it. No provider scopes, persistent grants or credentials are added by this recovery path.

## Identify the current workspace

Settings names the account's original sign-in provider, account and workspace.
The **Account recovery** block explains how to get back in:

- **Email (link or password account):** request a new sign-in link from the sign-in
  page. It works once and expires in 15 minutes.
- **GitHub or Google:** choose the same provider and use the same provider account.
  Recover a lost provider account through GitHub or Google.
- **SSO:** choose SSO and enter your work email. Ask your organization to restore
  access if needed.

To return to another account, sign out and use its original email and sign-in
method, or a method already linked to it. A different email or an unlinked provider
opens a different account. GitHub and Google can also link at first sign-in under
the verified-email rules below. Data is never merged. An empty workspace does not
mean traces were deleted; check the account and workspace before uploading again.

If you lose your authenticator, two-factor recovery codes are the only way back
in. Two-factor authentication cannot be reset by email.

**Sign-in methods** shows linking controls and guidance only for GitHub and Google
accounts. Email, SSO and other accounts do not show GitHub/Google linking copy.
Members lists a personal organization by account email or readable name when
available, with a readable workspace label as fallback. Organization labels do
not display raw tenant IDs.

## Linked sign-in methods

A GitHub sign-in and a Google sign-in can open the same account.

**What is read from the provider.** Sign-in asks GitHub for the `user:email` scope and Google for `openid email`. On each sign-in the handler reads the address once to decide linking: GitHub's primary address from `/user/emails`, Google's `email` from userinfo. It is kept on the account row as `verified_email`. The provider token is still used only inside the callback request and is never stored.

**An email counts only when the provider says it is verified.** Google must return `email_verified: true`. GitHub must mark the primary address `verified: true`; a verified secondary address or the public profile email is not used. A missing, malformed or unverified address links nothing, and sign-in continues as before.

**Linking at sign-in.** When a provider identity that has no account yet signs in with a verified address, and exactly one existing account of the other provider holds the same verified address and has no linked method yet, the sign-in opens that account. No second account is created and no data moves. The link is listed in **Settings**, **Sign-in methods**. If the account has two-factor authentication, the second factor is still required.

**Existing separate accounts are not linked at sign-in.** When two accounts with the same verified address already exist, each keeps opening its own account. Settings in each shows that another account exists (by provider only) and offers a choice:

- *Link*: this account's own sign-in method will open the other account from now on. This account's traces, keys and billing stay where they are and are not copied. Write keys of this account keep uploading here. The dashboard then signs this browser out. From then on this account is reached again only if the link is removed in the other account's Settings.
- *Keep separate*: remembered for both accounts; the offer is not shown again and nothing links them later.

**Unlinking.** The account that holds a linked method can unlink it in Settings. Every session of that account ends, because a session does not record which method opened it. The unlinked method then opens its own account and is not linked by email again. An account's own sign-in method cannot be unlinked; only a method linked to the account can.

**The Account block names the account's own provider.** "Sign-in provider" under Account in Settings is the provider the account was created with. It stays the same when the session was opened through a linked method, because a session does not record which method opened it.

**What unlinking does not do.** Personal access tokens and write keys belong to the account, not to a sign-in method, and are not revoked by unlinking. Revoke them under Settings and API keys if the person who used the unlinked method should lose access.

**A link is durable.** Once made it does not depend on later email changes at either provider; it ends only by unlinking.

**A lost verification withdraws the basis for new links.** When an account's own provider signs in without a verified address (unverified, missing, or the email list could not be read), the stored address is cleared. No new link can then be made to or from that account until its provider verifies an address again.

**Concurrent sign-ins of one identity.** Making a link at sign-in requires, in the same transaction, that the identity has no account of its own; creating that account requires that the identity is not linked. Whichever commits first decides, and the other sign-in follows it, so an identity never ends up with both a link and a stranded account.

**Unlink and a sign-in in flight.** A linked sign-in is issued against the account's session epoch read when the link was confirmed. Unlinking raises that epoch in the same transaction that removes the link, so a callback that was already running is refused instead of opening a session after the unlink.

**Stored.** The verified address on the account row, a lookup row keyed by the SHA-256 of the address, and one row per linked method (provider, verified address, time, how it was linked). No provider token.

**One linked method per account.** An account has its own sign-in method and at most one linked method, of the other provider. A second identity of that provider that later verifies the same address (a reassigned mailbox, for example) gets its own account and is not offered the link. After an unlink the place is free again.

**Not linked:** email, SSO and ChatGPT accounts; two identities of the same provider; an address held by more than one eligible account; an account that already has a linked method; an account whose own sign-in method was linked elsewhere, kept separate or unlinked before.

**What this relies on.** Linking trusts each provider's statement that the address was verified for that provider account. A person who can make GitHub or Google assert a verified address they no longer control (a reassigned mailbox, a recycled domain) can reach an account that holds the same address and has no linked method yet. This is the same trust the usual "link by verified email" sign-in makes; unlinking and two-factor authentication are the controls.

**Not built:** connecting a second provider that has a different email address from Settings, re-linking a method that was unlinked or kept separate, and merging the data of two accounts.

**Operator notes.** No stack parameter is needed. Sign-in requests one more scope per provider, so expect each provider to show its consent screen again at a person's next sign-in. The Google OAuth consent screen should list the `email` scope (`.../auth/userinfo.email`, non-sensitive). None of this was tried against the live GitHub and Google OAuth clients: check one sign-in with each provider right after deployment. When a provider's response carries no verified email, sign-in still works and nothing is linked.

MFA is enabled on supatrace.dev. Self-hosted deployments default to disabled; configure and test it before use.
