# Server configuration

Copy [`.env.example`](../.env.example) to `.env` and run `node --env-file=.env scripts/dev.mjs` for local development. No variable is required. The local server uses in-memory storage and synthetic accounts. It ignores AWS service settings. Data resets on exit. `--port` changes the loopback port; the default is 3000.

`SUPATRACE_DEV_STRIPE_TEST_KEY` is the only optional local environment setting. Leave it unset for synthetic billing. A TEST key opts into external Stripe test requests; no key is needed for the README quickstart. Never use a live key.

## Durable AWS service

The AWS entrypoints read the following settings. They are not a portable `.env` deployment: the CloudFormation template wires resource references, IAM, schedules, and edge routing. See [AWS deployment](../aws/DEPLOYMENT.md) before changing them. Do not put secret contents in `.env.example` or source control. Settings ending in `_SECRET_ARN` refer to AWS Secrets Manager entries.

| Settings | Requirement and purpose |
| --- | --- |
| `SUPATRACE_ENABLED` | Must be `true` to enable the AWS API. The example disables it. |
| `TABLE_NAME`, `PAYLOAD_BUCKET`, `GITHUB_CLIENT_ID`, `GITHUB_SECRET_ARN` | Required by the enabled AWS API. Missing configuration leaves it unavailable. |
| `AWS_REGION` | AWS SDK and ingress region; supplied by Lambda in deployment. |
| `APP_HOSTS` | Allowed application hosts; parsed by `src/origins.mjs`. The current defaults target the hosted service. Changing this alone does not make a new deployment portable. |
| `GITHUB_TECH_CLIENT_ID`, `GITHUB_TECH_SECRET_ARN` | Optional separate GitHub OAuth application for the alternate hosted domain. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_SECRET_ARN` | Optional Google sign-in; both are required to enable it. |
| `CHATGPT_CLIENT_ID`, `CHATGPT_SECRET_ARN`, `CHATGPT_AUTHORIZE_URL`, `CHATGPT_TOKEN_URL`, `CHATGPT_USERINFO_URL` | Optional identity-provider integration; all are required to enable it. |
| `EMAIL_FROM` | Optional SES sender for email flows. |
| `SSO_EMAIL_DOMAINS`, `SSO_IDP_SSO_URL`, `SSO_IDP_ISSUER`, `SSO_IDP_CERT_SECRET_ARN` | Optional SAML identity-provider settings. See [organization SSO](organization-sso.md). |
| `MFA_ENABLED`, `MCP_BRIDGE_ENABLED` | Optional authentication and bridge gates. Disabled in the example. See [sign-in](sign-in.md) and [bridge guide](../mcp/README.md). |
| `RETENTION_ERASURE_MODE` | Erasure mode passed to the retention worker. See [retention](retention.md). |
| `IMPORT_POLICY_CONFIG`, `SERVER_PULL_CONFIG` | Optional bounded import-controller configuration. See [server pull imports](server-pull-import.md). |
| `INGEST_API_ID`, `INGEST_EDGE_TOKEN` | Ingest edge identity supplied by the deployment. Keep the edge token private. |
| `PLAN_OVERAGE_RULE_ARN`, `ACCOUNT_ERASURE_RULE_ARN` | Expected schedule identities; only matching scheduled events run these jobs. |
| `PLAN_BILLING_SECRET_ARN`, `PLAN_BILLING_WEBHOOK_SECRET_ARN` | Optional Stripe TEST-mode billing and webhook references. Missing or rejected billing credentials leave sign-in and trace access available. |
| `BILLING_SANDBOX_CONFIG`, `BILLING_COMMERCIAL_POLICY_CONFIG` | Optional JSON configuration for authorized sandbox actions. See [commercial controls](commercial-controls.md). |
| `BILLING_INGRESS_ACCOUNT_ID`, `BILLING_INGRESS_API_ID` | Authenticated account and webhook ingress binding; supplied by deployment. |
| `BILLING_INBOX_TABLE_NAME`, `BILLING_STATE_TABLE_NAME` | Isolated billing capture/state tables, used only by configured billing paths. |
| `BILLING_WORKER_CONFIG`, `BILLING_WORKER_SANDBOX_CONFIG` | Billing worker JSON configuration. See [billing](plan-billing.md) and worker source. |
| `BILLING_ENTITLEMENT_WORKER_CONFIG`, `BILLING_ENTITLEMENT_PROTECTED_TABLES` | Entitlement-worker policy and protected-table list. |
| `BILLING_METER_WORKER_CONFIG` | Usage-meter worker JSON configuration. See [usage metering](usage-metering.md). |

Deployment tools also use `AWS_ACCOUNT_ID` to bind change-set checks to the authenticated account. The workflow derives it at runtime. Do not set a fixed account identifier in source. SDK/client variables belong in the SDK guides, not in the server environment.

`NODE_TLS_REJECT_UNAUTHORIZED` is a Node transport safety setting, not a feature flag. Keep TLS verification enabled. Import transports reject attempts to disable it. Browser checks can use `PLAYWRIGHT_CHROMIUM_PATH` as described in [UI tests](ui-tests.md); it is not a server setting.
