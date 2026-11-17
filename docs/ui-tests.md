# UI tests

`npm test` runs the Node and Python suites. It does not launch a browser.
It does not depend on the machine's umask or on running inside an agent session. Two packaging tests
(`tests/private-host-synthetic.test.mjs`, `tests/private-import-distribution.test.mjs`) build the private import
package from the current commit, and the packager refuses source files that differ from that commit
(`runtime_source_must_match_exact_commit`). Commit or set aside work in progress on packaged files before running them.

`npm run test:ui` runs the browser suites, including the Playwright walks of
`public/`, against the live API handler (`src/aws-api.mjs`) backed by an in-memory DynamoDB and object store
(`tests/harness.mjs`, `tests/memory-dynamo.mjs`). Nothing in `tests/` ships.
`playwright-core` is a devDependency, so `npm ci` installs it. CI then installs Chromium
unless `PLAYWRIGHT_CHROMIUM_PATH` is already set.

Harness notes:

- The live handler accepts only the production origins `https://supatrace.dev` and `https://supatrace.tech` (the first is the harness's `APP_ORIGIN`). The harness rewrites a
  same-origin `Origin` header to that value; any other origin reaches the real check unchanged.
- Tests seed a session row and set the `__Host-supatrace` cookie directly. All non-loopback
  browser requests are aborted.
- `start({enabled: false})` gives the 503 `service_not_configured` state.
- `start({google: true})` turns Continue with Google on. The button is hidden unless both the client id and the secret are set.
- `start({dashboard: true})` also turns on the local stand-ins for ChatGPT, SSO, and email. ChatGPT's URLs point at the harness itself. SSO uses a generated certificate and exposes its private key on `idp` so a test can sign an assertion. Email records messages in memory instead of sending them. Production leaves those parameters empty.
- `start({mfa: true})` sets `MFA_ENABLED`. Settings shows two-factor controls only when that switch is on. Production leaves `MfaEnabled` at `false`.
- Agent scripts live in `agent/` and are served at `/agent/*.py`, the same paths production publishes.

`npm run screenshots` writes `test-artifacts/screenshots/after/`.

The public homepage may scroll; tests assert no horizontal overflow, an above-fold first action, bounded sign-in panels and reachable setup content. The signed-out workspace and optional sign-in panels still have their viewport checks. Mobile tests open the drawer based on its explicit expanded state, never a forced offscreen click, and cover focus/close/repeated/hash navigation.

CI also captures synthetic desktop/mobile views and uploads a seven-day screenshot artifact. These are in-memory fixture screenshots, not production account evidence. Local browser launch can be unavailable in a sandbox; CI's browser result is reported separately, never as a local rendered pass.
