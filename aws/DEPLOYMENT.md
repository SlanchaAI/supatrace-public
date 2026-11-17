# AWS deployment

The templates describe the hosted service on AWS. They are not a portable,
one-command installer. Fixed resource names and the release guard protect the
existing deployment. A new installation needs its own infrastructure review.
For a credential-free local server, use the root README.

## Existing deployment updates

The Deploy workflow releases `main`. Its production environment and
`AWS_DEPLOY_ROLE_ARN` repository variable must already be configured. It runs the
complete CI workflow at the same commit before requesting AWS credentials.
Failed, skipped, or cancelled verification cannot deploy.

After assuming the role, the workflow discovers its account with STS and derives
bucket names. It masks the account identifier before writing workflow state.
No account identifier belongs in a checked-in command or template.

Normal releases preserve existing CloudFormation parameter values. They upload a
content-addressed Lambda artifact, then publish static files after the stack
update succeeds. The artifact-only guard rejects resource additions, replacements,
removals, and changes outside the reviewed artifact fields. The general
`aws/change-set-guard.mjs` check also refuses replacement or removal. Neither check
is permission to make infrastructure changes.

The function role must already have its permissions boundary, both in IAM and in
the deployed template. The release role cannot remove or rewrite that boundary.
A missing boundary or changed parameter set requires a separate infrastructure
review. Do not bootstrap credentials or create another stack to bypass a failed
release.

## Manual inspection prerequisites

Use credentials for the intended account. Select the existing stack by name before
running inspection or recovery commands. Do not enable shell tracing or print
account identifiers, secret parameters, or full AWS responses into shared logs.

```sh
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_ACCOUNT_ID
: "${AWS_ACCOUNT_ID:?STS account discovery failed}"
: "${STACK_NAME:?Set the existing deployment stack name before continuing}"
export STACK_NAME
```

The templates use the `AWS::AccountId`, `AWS::Region`, and `AWS::Partition`
pseudo-parameters. `ArtifactBucket` is required. For an existing stack, retain its
previous value. Do not infer an installation's resources from the hosted service's
fixed names.

## Build identity and smoke checks

The repository's `public/build.json` is unstamped. The workflow runs
`node scripts/build-marker.mjs` before publishing `public/`. The served
`https://supatrace.dev/build.json` must identify the release commit. This marker
identifies static files; Lambda packages are identified by their content hash.
Preview hosting must run the same marker script in its build command.

Smoke checks cover the homepage, sign-in redirect, static assets, provider
availability, signed-out API responses, and security headers. A failed check
restores the static snapshot and removes objects introduced by that release.
Authenticated sign-in, trace upload, tenant isolation, and export need separate
checks with synthetic data. A successful smoke check does not prove those paths.

## Infrastructure and recovery boundaries

Changes to resources, permissions, secrets, capacity, identity providers, or
CloudFormation parameters need a separate reviewed change set. Preserve current
parameters with `aws/deploy-parameters.mjs`. Inspect every page of the change-set
response before applying `aws/change-set-guard.mjs`; a partial response is not a
complete review. Never execute a change set that the guard rejects.

The API uses DynamoDB metadata, S3 payload storage, Lambda, and CloudFront.
`IngestEdgeToken` gates the public ingest adapter; an empty value disables it.
`ApiConcurrency` sets reserved function concurrency. Raising concurrency also
requires checking database capacity and cost. Deployment does not change DNS.

OAuth, SSO, MFA, and email configuration are optional. Secrets Manager references
must be allowed by the function role's boundary before the function can read them.
SES must permit delivery to the intended recipients. Public contact addresses do
not establish mailbox routing. The application retains its existing backend
support route. `aws/production-ops.yaml` is separate from app Deploy: preserve the
confirmed alert recipient through `AlertEmailAddress`, verify new mailbox routing,
and confirm subscriptions before applying any mail configuration update.

Billing mode follows the secret key prefix. Test keys keep test behavior; live keys enable live payments. See [plan billing](../docs/plan-billing.md). Enabling billing needs reviewed resources, permissions, a matching webhook signing secret and synthetic checkout verification.

On rollback, reconcile in-flight writes and quota reservations; rolling back code
does not undo data. Do not fall back to an artifact that ignores current tenant,
workspace, environment, or key scopes. Diagnose the failed resource before
requesting recovery privileges. Resource skipping can leave the stack inconsistent
and needs a separate recovery plan.

## Going live and rolling back

The lead stages Stripe objects and secrets, then controls the flip. Merging this code changes nothing in production while the secret holds a test key. Legal and marketing wording is proposed in [live-billing-copy-changes.md](../docs/live-billing-copy-changes.md) for a separate approved flip-time change.

Required objects in **live mode**:

- Base and Pro products and active USD monthly licensed prices with lookup keys `supatrace_base_monthly` (999 cents) and `supatrace_pro_monthly` (2599 cents).
- An active monthly metered price with lookup key `supatrace_pro_overage_monthly`, at USD 0.0005 cents per span, attached to the active meter whose event name is `supatrace_pro_overage`. The meter sums `value` and maps customers by `stripe_customer_id`.
- An active customer portal configuration with `livemode: true` and `metadata.app=supatrace`, allowing cancellation, payment details and invoice access. The app changes plan prices in place and preserves metered items.
- A webhook endpoint for `POST /api/billing/webhook` subscribing to all six events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.

Put the live secret or restricted key in `supatrace-plan-billing-test-key` and the matching live endpoint signing secret in `supatrace-plan-billing-test-webhook`. These names are historical. Their ARNs are the existing stack parameters that supply `PLAN_BILLING_SECRET_ARN` and `PLAN_BILLING_WEBHOOK_SECRET_ARN`; no new secret name, parameter or mode flag is needed. The app picks up a new secret version within five minutes through its secret cache. Stage both matching secrets before directing live traffic. During a mismatch, webhook verification fails closed.

A restricted key needs these permissions: customers **write**, Checkout Sessions **write**, billing portal **write**, subscriptions **write**, prices **read**, products **read**, invoices **read**, billing meters **read**, meter events **write**, billing meter event summaries **read**. Keep unrelated permissions disabled.

**One-step rollback:** restore the prior secret versions, moving `AWSPREVIOUS` back to `AWSCURRENT` with `aws secretsmanager update-secret-version-stage`, for the key and webhook secrets as one rollback operation. For each secret, use its previous and current version IDs:

```sh
aws secretsmanager update-secret-version-stage --secret-id SECRET_NAME --version-stage AWSCURRENT --move-to-version-id PREVIOUS_VERSION_ID --remove-from-version-id CURRENT_VERSION_ID
```

Alternatively, put the test key and test webhook signing secret back in those same secrets. No deploy or mode parameter change is needed. Allow the five-minute cache window. Other-mode billing state remains stored and is ignored; operator plans are unchanged. Existing live subscriptions remain in Stripe and require lead reconciliation if live traffic is rolled back.

## References

- [CloudFront access to Lambda function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
- [Lambda function URL authentication](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html)
- [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
