// Public changelog entries, newest first, curated from merged pull requests.
//   date    UTC date the pull request was merged (GitHub mergedAt)
//   pr      pull request number in SlanchaAI/supatrace
//   commit  merge commit, so tests/changelog.test.mjs can check it against git history
//   state   'deployed'  the merge commit is on main, the branch production deploys from
//           'merged'    merged to the integration branch; not on main, so not deployed
// Add an entry when a user-visible pull request merges. Move it to 'deployed' only after
// its commit is on main and a Deploy run for that commit or a later one succeeded.
export const LAST_DEPLOY = {date: '2026-11-13', commit: '0a800c0'};
export const CHANGELOG = [
  {date: '2026-11-14', pr: 157, commit: 'b19cace518', state: 'merged', title: 'Per-plan retention',
    body: 'Each batch is stamped with its plan retention when accepted (30 days on Free) and stops being listed, opened and exported after that. Expired data is hidden, not deleted.'},
  {date: '2026-11-14', pr: 150, commit: '5b3028af73', state: 'merged', title: 'Security and Enterprise pages',
    body: 'A /security page states storage, encryption and access facts and what is not in place (no SOC 2, DPA or HIPAA). An /enterprise page shows the proposal and marks SLA terms as pending.'},
  {date: '2026-11-14', pr: 147, commit: 'c475f6cb12', state: 'merged', title: 'Build marker',
    body: 'A release writes the served commit to /build.json and the footer shows it, so anyone can tell which build a site serves.'},
  {date: '2026-11-14', pr: 142, commit: '1f780f7f09', state: 'merged', title: 'Monthly Free allowance',
    body: 'The lifetime 10 MiB cap is replaced by a Free allowance of 50,000 spans per UTC calendar month and 1 GB stored. The span count resets monthly; stored bytes do not.'},
  {date: '2026-11-14', pr: 152, commit: 'b62f5feec1', state: 'merged', title: 'Ingest from Langfuse SDKs',
    body: 'An app on a Langfuse SDK can send traces by changing the host and keys. Ingest only. Hosted routes answer; SDK compatibility remains beta with local acceptance only.'},
  {date: '2026-11-14', pr: 141, commit: '17d53b602e', state: 'merged', title: 'OTLP/HTTP trace ingest',
    body: 'A receiver at POST /v1/traces accepts OpenTelemetry traces as protobuf or JSON. Available on supatrace.dev for traces only; no gRPC, metrics or logs.'},
  {date: '2026-11-14', pr: 145, commit: '5490406f82', state: 'merged', title: 'Integrations directory',
    body: 'An /integrations page lists frameworks, providers, importers and agent tools, each marked Live, Beta or Coming soon.'},
  {date: '2026-11-14', pr: 144, commit: '392d17f741', state: 'merged', title: 'Docs site',
    body: 'A /docs site with a quickstart, framework guides and reference pages for keys, limits, export and importers. It records SDK availability; Python is now on PyPI and JavaScript is Coming soon on npm.'},
  {date: '2026-11-14', pr: 138, commit: 'd11be454de', state: 'merged', title: 'Proposed pricing page',
    body: 'A /pricing page shows proposed Free, Pro, Team and Enterprise plans. It is labelled a proposal; no plan can be bought.'},
  {date: '2026-11-14', pr: 132, commit: '4b19252625', state: 'merged', title: 'Python and JavaScript SDK prototypes',
    body: 'Source for a supatrace Python package and an @supatrace/client JavaScript package that validate and spool batches locally. Python is now on PyPI as supatrace 0.1.0; the JavaScript supatrace package is Coming soon on npm.'},
  {date: '2026-11-12', pr: 79, commit: '8553ccc2dd', state: 'deployed', title: 'Setup links and clearer key list',
    body: 'A setup link opens Agents with the setup code filled in. The key list shows when each key was created and marks the newest one.'},
  {date: '2026-11-11', pr: 63, commit: '45e1473636', state: 'deployed', title: 'Langfuse import from the workspace (beta)',
    body: 'Import one exact Langfuse trace scope from Agents in bounded, resumable steps. It runs only where the server has it enabled; a verified import from a real account on the hosted site is still open.'},
  {date: '2026-11-09', pr: 60, commit: 'd97337472e', state: 'deployed', title: 'Crawl files, share tags and a 404 page',
    body: 'robots.txt, sitemap.xml, llms.txt, canonical and social tags, and a real not-found page.'},
  {date: '2026-11-09', pr: 57, commit: '48513bad03', state: 'deployed', title: 'Create a write key from the dashboard',
    body: 'A signed-in owner can create a write key from the dashboard.'},
  {date: '2026-11-06', pr: 43, commit: 'b5889a019a', state: 'deployed', title: 'Workspace and environment switching',
    body: 'The workspace and environment switcher stays available across the dashboard.'},
  {date: '2026-11-06', pr: 39, commit: '3a2effc8b3', state: 'deployed', title: 'Workspace roles and environments',
    body: 'Owners can invite existing accounts as Admin or Viewer and create environments that share the workspace quota.'},
  {date: '2026-11-05', pr: 30, commit: '2ef96db56e', state: 'deployed', title: 'Braintrust and LangSmith import handoff',
    body: 'Agents can prepare a reviewed import spec for the local Braintrust and LangSmith importers. Nothing is fetched or uploaded from the browser.'},
  {date: '2026-11-05', pr: 23, commit: '9c608530f5', state: 'deployed', title: 'Read-only MCP trace server',
    body: 'A local stdio MCP server that lists, searches, inspects and exports traces within a reviewed scope. Source is public at https://github.com/SlanchaAI/supatrace-public. Not available in the hosted service yet; browser read consent is disabled by default.'},
  {date: '2026-11-05', pr: 21, commit: '91d43ca6b0', state: 'deployed', title: 'Braintrust API import',
    body: 'A local importer that reads 1 to 25 completed Braintrust traces you name and stages them for review.'},
  {date: '2026-11-05', pr: 20, commit: 'd9c6bb0148', state: 'deployed', title: 'Provider file imports',
    body: 'Convert export files from LangSmith, Braintrust, Weave, Opik, Datadog LLM Observability, MLflow, Helicone and OTLP JSON into reviewed batches on your machine.'},
  {date: '2026-11-05', pr: 15, commit: '60c434f3d2', state: 'deployed', title: 'Clearer outcomes for interrupted archive exports',
    body: 'Stalled account archive file operations now time out and can be retried. A save that could not be confirmed is reported as unconfirmed, not as success; an interrupted export is not resumed.'},
  {date: '2026-10-27', pr: 9, commit: '85077a15aa', state: 'deployed', title: 'supatrace.dev and supatrace.tech',
    body: 'Both hostnames are served from one deployment.'},
  {date: '2026-10-25', pr: 6, commit: '15ba89806c', state: 'deployed', title: 'Signed-in dashboard',
    body: 'The signed-in workspace is restored, and its address without the trailing slash redirects to it.'},
  {date: '2026-10-24', pr: 3, commit: '2c72f5bd3b', state: 'deployed', title: 'Traces on one screen',
    body: 'The trace view is one screen with no page scroll.'}
];
