# SupaTrace

SupaTrace is a trace service for applications that use large language models. Send OpenTelemetry traces, inspect runs in a web dashboard, and export the stored JSON. This repository contains the service, site, SDKs, command line tools, and AWS deployment configuration. The local server runs with synthetic accounts and in-memory storage. The hosted service runs at [supatrace.dev](https://supatrace.dev).

## Try the hosted service

1. [Sign up or sign in](https://supatrace.dev/app/).
2. Create an ingest key on Home or API keys.
3. Follow the [OpenTelemetry quickstart](docs/otlp-ingest.md). It works with stock exporters and needs no SupaTrace package.
4. Open Traces in the same workspace to find your run and export its JSON.

Provider file import tools are a preview. Preparing a file does not upload it; the secure upload runner requires deployment-specific hooks. Start with hosted OpenTelemetry or the local synthetic recipe.

The SupaTrace packages are coming soon. Until then send traces with the stock OpenTelemetry exporter (see the [OTLP quickstart](docs/otlp-ingest.md)) or the Python/Node snippets on Home. The public repository includes checkout-only SDKs. See the [JavaScript](packages/supatrace-js/README.md) and [Python](packages/supatrace/README.md) guides for exporter setup and configuration.

The Free plan permits model training and product improvement on submitted traces. Paid-plan protections apply prospectively; review the [Terms](https://supatrace.dev/terms.html) before uploading real data.

Hosted plans are billed by Stripe. The local server uses synthetic billing and charges no cards. Review [data handling](docs/roles-and-security.md) before sending traces. Trace attributes and imported content can contain secrets. Redacted-copy previews require review and do not guarantee anonymity.

## Run locally

Requires Git, Node.js 22+, and OpenSSL. Python is needed for the Python tests and tools, not for server startup. No cloud account, payment key, OAuth application, or model provider is required.

```sh
git clone https://github.com/SlanchaAI/supatrace-public.git supatrace
cd supatrace
cp .env.example .env
npm ci --ignore-scripts
node --env-file=.env scripts/dev.mjs
```


Open `http://127.0.0.1:3000/__local__/` and choose **Team admin account**. This starts a local session for a synthetic account. Keep its personal workspace selected. Create an ingest key on Home, then follow the [OpenTelemetry quickstart](docs/otlp-ingest.md) with the endpoint set to `http://127.0.0.1:3000`. Find the resulting `otlp.<traceid>` run in Traces. To inspect seeded team runs, choose **Owner account** instead. Seed upload keys are revoked after seeding, so the Owner can create an ingest key within the Free allowance.

For a command-only first trace, follow the [synthetic self-host check](docs/self-hosting.md#send-and-read-one-trace). It keeps its local key and session in memory and prints status counts.

The server binds to loopback. Data resets when the process stops. Local sign-in bypasses external identity providers, and local billing uses synthetic transactions. This is a development and evaluation setup. Do not expose it to a network or use it for durable data. See [local development](docs/local-development.md) for roles, imports, and test billing.

Use `node --env-file=.env scripts/dev.mjs --port 3001` to select another port. The health endpoint is `GET /api/public/health`. Durable hosting needs AWS storage, configured identity providers, and deployment work; [architecture](docs/architecture.md) and the [AWS deployment guide](aws/DEPLOYMENT.md) describe those boundaries. The deployment workflow maintains the hosted service; it is not a one-command installer for a new AWS account.

## Configuration

[`.env.example`](.env.example) lists server and worker settings. Values are empty or safe defaults. No environment variables are required for the local server. Keep `.env` private and leave optional Stripe credentials unset for a synthetic run.

The [configuration reference](docs/configuration.md) separates local options from AWS service settings. SDK settings are documented with each SDK. The [plan catalog](docs/plan-catalog.md) describes limits; `src/plans.mjs` is their source of truth.

## Repository map

| Directory | Contents |
| --- | --- |
| `src/` | API handlers, authentication, storage, billing, imports |
| `public/` | Static site and web dashboard |
| `scripts/` | Local server, page generators, test runners |
| `aws/` | Lambda adapters, templates, deployment guards |
| `packages/` | JavaScript and Python SDKs and command line tools |
| `agent/` | Connection, file conversion, upload tools |
| `mcp/` | Model Context Protocol bridge |
| `examples/` | SDK integration examples |
| `docs/` | API and operational documentation |
| `tests/` | Synthetic Node, Python, and browser checks |

## Tests and contributions

```sh
npm ci --ignore-scripts
npm test
```

`npm test` runs the root Node and Python suites. Browser, SDK, and bridge suites have separate commands in [CONTRIBUTING.md](CONTRIBUTING.md). See [UI tests](docs/ui-tests.md) for Chromium setup. Tests use synthetic data; passing tests do not establish provider compatibility or hosted durability.

Bug reports and pull requests are welcome. No contributor license agreement is required; commit sign-off is optional. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities to **security@supatrace.dev**, as described in [SECURITY.md](SECURITY.md). General open source questions can go to **oss@supatrace.dev**.

## Documentation and license

Start with [architecture](docs/architecture.md), [OTLP ingest](docs/otlp-ingest.md), [management API](docs/management-api.md), [sign-in](docs/sign-in.md), or [connector imports](docs/connector-file-imports.md). Hosted documentation is at <https://supatrace.dev/docs/>.

Apache-2.0. Copyright 2026 Slancha, Inc. See [LICENSE](LICENSE). Third-party code and fonts retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
