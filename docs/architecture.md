# Architecture and current boundaries

The hosted service uses a static dashboard, a Node API on AWS Lambda, DynamoDB metadata and private S3 trace objects. `aws/template.yaml` defines the deployment. `src/aws-api.mjs` composes the API; `src/trace.mjs` implements trace storage; `public/app/` contains the dashboard.

Local development runs the same handlers with in-memory storage and synthetic identity and billing adapters. State resets when the process stops. This path is for evaluation and development. A durable deployment requires your own AWS resources and identity-provider configuration. See [local development](local-development.md) and [deployment](../aws/DEPLOYMENT.md).

No automatic redaction applies to uploaded trace data or account archives. Review data before upload or sharing. Redaction of selected fields does not guarantee anonymity. Account export reads bounded pages and is not a point-in-time snapshot.

Hosted billing uses Stripe TEST mode. Checkout return alone does not establish fulfillment. The billing adapter requires a verified event and explicit configuration. Live billing is outside the local quickstart.

Sign-in providers are disabled when required configuration is absent. See [sign-in configuration](sign-in.md). Trace ingest uses scoped keys; local developer identity routes are available only in the loopback composition.
