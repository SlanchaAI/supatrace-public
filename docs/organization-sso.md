# Organization single sign-on and SCIM

An organization's owner can connect a SAML 2.0 identity provider (IdP), require members to sign in through it, and let the IdP add and remove members with SCIM 2.0. Settings are on the Members page under **Single sign-on**.

This sits on the SAML code described in [sign-in](sign-in.md): the same `/api/auth/sso` start, the same `/api/auth/sso/callback`, the same `@node-saml/node-saml` checks (assertion signature, audience, NotBefore, NotOnOrAfter, InResponseTo, issuer) and the same relay cookie.

## Two ways an IdP is configured

| | Deployment IdP | Organization IdP |
| --- | --- | --- |
| Who sets it | Operator, with stack parameters | The organization's owner, in the dashboard |
| Where it lives | `SsoEmailDomains`, `SsoIdpSsoUrl`, `SsoIdpIssuer`, `SsoIdpCertSecretArn` (and `SsoCertSecretArn` on the OIDC stack so the function may read the secret) | Items in the metadata table |
| Domains | The `SsoEmailDomains` list | Domains the organization verified by DNS |
| Membership | None; the person gets their own account | The person joins the organization with its default role |

The deployment IdP is unchanged and wins for its own domains: an organization cannot verify a domain listed in `SsoEmailDomains`. If the operator later lists a domain an organization already verified, the domain stops counting for that organization: sign-in for it goes to the deployment IdP, the organization's IdP can no longer sign in anyone with an email in it (even in a request started for another of its domains), SCIM cannot provision it, and sessions for it no longer satisfy that organization's **Require SSO**. **Organization SSO needs no stack parameter.** The stack-level IdP parameters above remain an operator action, and only for a deployment-wide IdP.

## Setting it up

1. In the IdP, create a SAML application with Audience (SP entity ID) `https://<host>/api/auth/sso`, ACS URL `https://<host>/api/auth/sso/callback`, Name ID format email address, assertion signed.
2. On the Members page paste the IdP sign-on URL, issuer and signing certificate (PEM), list up to five email domains and choose the role people get when they join.
3. For each domain, add the TXT record shown (`_supatrace.<domain>` with value `supatrace-verification=<token>`) and choose Verify. A domain can be verified by one organization only. Sign-in works for a domain only after it is verified.

The certificate is a public signing certificate, not a secret. It is stored with the organization, shown afterwards only as its SHA-256 fingerprint, and never written to the audit log.

## Signing in

On the sign-in page, **Continue with SSO** appears once the deployment IdP is configured or any organization has a verified domain. The person enters their work email; the domain picks the IdP. The request remembers which organization it was for, so the response is checked against that organization's certificate, issuer and domains and nothing else.

After a valid response the person is signed in as their SSO account (`sso-<hash of the email>`) and, if the organization has never seen them, becomes a member with the default role (just-in-time provisioning). The join only ever creates a membership that does not exist, and only while the organization's SSO settings are the ones the response was checked against. Signing in never undoes a removal: a member the owner removed, a SCIM user who is deactivated or deleted, and a SCIM user created inactive stay out until the owner (a new invitation) or SCIM (`active: true`) brings them back. An unused invitation for the person is spent when they join by SSO or SCIM and when SCIM deactivates them, so an older invitation cannot bring them back later. SSO accounts are separate from GitHub, Google and email accounts, as before.

The session records which organization's IdP vouched for it and the version of that organization's IdP settings (sign-on URL, issuer, certificate). The record survives the two-factor step.

## Require SSO

With **Require SSO** on, every member except the owner must be signed in through the organization's IdP. The check is on the session, on every request: the session must have been created by a SAML response from this organization's IdP, under the IdP settings the organization has now, for an SSO account whose email is in a domain the organization still has verified. Anyone else gets `403 sso_required` on every route that reads or changes the organization's data or settings, and a prompt in the dashboard. Listing one's organizations, accepting an invitation and leaving the organization stay available. That includes:

- a session from GitHub, Google, email, the deployment IdP or another organization's IdP, even for the same SSO account;
- a session the organization's previous IdP vouched for, once the owner replaces the sign-on URL, issuer or certificate (members sign in again; changing the default role or the domain list does not end sessions);
- personal access tokens and secret keys of members other than the owner on the Management API. They carry no SSO sign-in. This is a limit of this change: under Require SSO, use an owner's token or key for the Management API.

The owner keeps access so a broken IdP cannot lock the organization. Removing the last verified domain turns the requirement off. Removing a domain does not remove the members who joined through it. Upload (ingestion) keys are not affected.

## SCIM 2.0

- Base URL `https://<host>/api/scim/v2`, bearer token. Create the token on the Members page; the browser makes it and the server stores only its SHA-256. A new token replaces the old one.
- `GET /ServiceProviderConfig`
- `GET /Users` (`startIndex`, `count`, and the filter `userName eq "<email>"`), `GET /Users/{id}`
- `POST /Users` with `userName` (an email in a verified domain), optional `externalId` and `active`. The person becomes a member with the default role before they first sign in.
- `PATCH /Users/{id}` replacing `active`, `PUT /Users/{id}` with `active`, `DELETE /Users/{id}`. Deactivating ends the membership at once; reactivating restores it. Setting `active: true` is refused (`400`) for a user whose domain the organization no longer has verified or the deployment IdP now owns; deactivating and deleting such a user still work.
- With SCIM on, the IdP is the authority for the people it manages: `active: true` restores a membership even if the owner removed it in the dashboard, so remove such a person in the IdP. To stop the IdP from provisioning, replace the token.
- A request is refused (`401` or `409`) if the token is replaced, the SSO settings change, or the person's membership or invitation changes (for example an invitation is issued or accepted) while it runs. Retry `409`.

Not supported: Groups, bulk, sort, other filters, changing a role or name through SCIM. SCIM never changes the owner. An organization can provision at most 20 different addresses through SCIM, deleted ones included, matching today's 20-member limit. Each address is an account, so the cap stops a token from using up the service's account capacity by creating and deleting. Recreating a deleted address reuses its account.

## Audit events

`sso.config_changed`, `sso.domain_verified`, `sso.enforcement_changed`, `sso.member_joined`, `scim.token_created`, `scim.user_provisioned`, `scim.user_deactivated`. SCIM events name the actor as `scim:` and the first 12 characters of the token's ID.

## Not in this change

- OIDC as an organization IdP, IdP-initiated sign-in, encrypted assertions, IdP metadata upload (the three values are pasted).
- Plan gating. The proposal in #98 puts SSO on Team and SCIM on Enterprise; the plan table has no feature flags yet, so neither is gated.
- Tested against a SAML test IdP that signs Okta-shaped assertions (assertion signed, response not). Not yet run against a live Okta, Entra ID or Google Workspace tenant.

## Operator notes

- Domain verification makes a DNS TXT lookup from the API function. It works with the function's default network settings; a function moved into a VPC needs DNS resolution and outbound access.
- `/api/scim/v2/*` is under `/api/`, which the edge already routes to the function. SCIM clients must be able to send `Authorization`; where the edge does not forward it, `X-Supatrace-Key` carries the same token.
