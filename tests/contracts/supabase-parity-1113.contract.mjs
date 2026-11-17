// Contract for issue #85 (Supabase-parity comparison of dashboard source).
// Run: node --test tests/contracts/supabase-parity-1113.contract.mjs
// No server, browser, Docker or network: the comparison runs in-process against the shipped
// dashboard source, with reads served by an in-memory stand-in.
//
// Source-only inventory: no deployed-state assertions or live browser verification.
// Named checks cover seven of 21 surfaces (members, MFA, logs, integrations, realtime,
// billing, first load). Absence checks fail when a named pattern appears; presence checks
// fail when named wiring disappears. These narrow detectors do not cover all 21 rows.
//
// Interface (tests/contracts/README.md).
//  - An absence "gap" probe is falsifiable: it asserts the ABSENCE of the capability, with a message
//    telling the reader to re-score the surface when the capability appears. Fix a gap and this
//    check goes red. Unprobed rows still require manual review.
//  - The parity table is machine-checked against the scores: one table row per non-present
//    surface, and every score carries evidence.
//  - No probe may pass vacuously: helpers that a probe extracts from source are asserted to be
//    non-empty, and the executed probes assert measured behaviour, not a regex.
//
// Startup probes execute concurrent reads, a bounded deadline and a reachability check.
// The remaining inventory is synthetic source coverage, not a deployed-state assessment.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {loadStartupIdentity, probeReachable, STARTUP_TIMEOUT_MS} from '../../public/app/startup-data.js';

// Repo-root relative, resolved away from this file's own directory.
const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const readParity = name => readFileSync(new URL(`../fixtures/contracts/${name === 'receipt.json' ? 'surfaces.json' : 'surfaces.md'}`, import.meta.url), 'utf8');

const appSource = read('public/app/app.js');
const indexSource = read('public/app/index.html');
const workspacesSource = read('public/app/workspaces.js');
const authSource = read('src/dashboard-auth.mjs');
const startupUiSource = read('public/app/startup-ui.js');
const startupDataSource = read('public/app/startup-data.js');
const usageDataSource = read('public/app/usage-data.js');
const apiHelper = appSource.match(/async function api\([\s\S]*?fetch\('\/api\/'\+path/)?.[0] ?? '';

const tick = () => new Promise(resolve => setImmediate(resolve));
const twoStartupReads = async () => {
  // Both reads start before either finishes. Their shared deadline expires before
  // the synthetic responses, so the caller must receive a bounded timeout.
  let firstDone = false, secondStartedBeforeFirst = false;
  const seen = [];
  const result = await loadStartupIdentity(async (path, signal) => {
    seen.push(path);
    if (path === 'projects' && firstDone === false) secondStartedBeforeFirst = true;
    await new Promise(resolve => setTimeout(resolve, 120));
    if (path === 'me') firstDone = true;
    if (signal?.aborted) throw new Error('startup_cancelled');
    return path === 'me' ? {tenant_id: 'github-1', project_id: 'proj_' + '1'.repeat(32)} : {projects: []};
  }, {timeoutMs: 25}).catch(error => error);
  return {seen, result, secondStartedBeforeFirst};
};

// ---------------------------------------------------------------------------
// 0. Reject empty source extraction so wiring checks cannot pass vacuously.
// ---------------------------------------------------------------------------

test('the source extraction used by the source probes is real, not a vacuous match', () => {
  assert.ok(apiHelper.includes('async function api('), 'no api helper extracted');
  assert.ok(apiHelper.includes("fetch('/api/'+path"), 'extracted helper is not the request helper');
  assert.ok(apiHelper.length > 400 && apiHelper.length < 4000, `helper looks mis-sliced: ${apiHelper.length} chars`);
});

// ---------------------------------------------------------------------------
// 1. Executed probes: real behaviour, run here, in this sandbox.
// ---------------------------------------------------------------------------

test('startup overlaps account reads under a bounded deadline', async () => {
  assert.equal(STARTUP_TIMEOUT_MS,15000);
  const {seen,result,secondStartedBeforeFirst}=await twoStartupReads();
  assert.ok(result instanceof Error);
  assert.equal(result.message,'startup_timeout');
  assert.deepEqual(seen,['me','projects']);
  assert.equal(secondStartedBeforeFirst,true);
});

test('reachability distinguishes an unavailable transport and parses providers', async () => {
  await assert.rejects(probeReachable({fetcher:async()=>{throw Error('offline');},timeoutMs:25}),/startup_unreachable/);
  const reachable=await probeReachable({fetcher:async()=>new Response(JSON.stringify({github:true})),timeoutMs:25});
  assert.deepEqual(await reachable.providers,{github:true});
});

// ---------------------------------------------------------------------------
// 2. Narrow source change detectors: absence checks for remaining gaps,
//    presence checks for invitation discovery and polling already implemented.
// ---------------------------------------------------------------------------

const findings = [
  {
    id: 'F-NO-MEMBER-VIEW',
    surface: 'Members, roles and invitations',
    probe: 'team management is reachable as its own surface',
    check: () => assert.doesNotMatch(indexSource, /data-nav="members"|data-nav="team"/,
      'a Members/Team navigation item now ships: re-score and close the gap issue'),
  },
  {
    id: 'F-TEAM-BEHIND-SETTINGS',
    surface: 'Members, roles and invitations',
    probe: 'team management is reachable without first opening Settings',
    check: () => assert.match(workspacesSource, /document\.getElementById\('view-settings'\)\.append\(node\)/,
      'team controls moved out of Settings: re-score this surface'),
  },
  {
    id: 'F-MFA-GATED-OFF',
    surface: 'Two-factor authentication',
    probe: 'MFA source-template default is explicitly assessed',
    check: () => {
      // The source template defaults off. The providers projection starts with mfa:false
      // and may set it true for an enabled pending challenge; this is not a live-state check.
      assert.match(authSource, /mfa:false/, 'the providers projection initial value changed: re-score source evidence');
      assert.match(read('aws/template.yaml'), /MfaEnabled:[\s\S]*?Default: 'false'/,
        'MFA default is no longer false: re-check whether MFA is live before you file this');
    },
  },
  {
    id: 'F-NO-LOG-VIEW',
    surface: 'Logs and observability',
    probe: 'a customer-facing place to read system or audit logs exists',
    check: () => assert.doesNotMatch(indexSource, /id="view-logs"|data-nav="logs"|data-nav="observability"/,
      'a logs view exists now: re-score this surface'),
  },
  {
    id: 'F-NO-INTEGRATION-HUB',
    surface: 'Integrations',
    probe: 'one Integrations surface lists connected sources and their state',
    check: () => assert.doesNotMatch(indexSource, /id="view-integrations"|data-nav="integrations"/,
      'an integrations hub exists now: re-score this surface'),
  },
  {
    id: 'F-NO-REALTIME',
    surface: 'Realtime updates',
    probe: 'the live trace list is wired through the polling watcher',
    check: () => {
      assert.ok(appSource.includes('createLiveWatch({'), 'live watcher must stay wired');
      assert.ok(appSource.includes("$('live-toggle').onchange"), 'live toggle must stay wired');
      assert.ok(read('public/app/live-data.js').includes('createLiveWatch'), 'live watcher implementation must exist');
    },
  },
  {
    id: 'F-NO-PENDING-INVITE-DISCOVERY',
    surface: 'Members, roles and invitations',
    probe: 'addressed pending invitations can be discovered without a URL',
    check: () => {
      assert.ok(workspacesSource.includes("request('workspaces/invitations')"), 'pending invitation list must stay wired');
      assert.ok(workspacesSource.includes("$('pending-invite-list')"), 'pending invitation UI must stay wired');
    },
  },
  {
    id: 'F-BILLING-NO-PURCHASE',
    surface: 'Billing',
    probe: 'a customer can actually buy a plan',
    check: () => {
      // Sandbox preview only: purchases are hard-off in the policy projection, so the surface
      // exists but cannot complete a purchase. That is a parity gap against Supabase's billing,
      // and it is a launch decision, not a defect covered by this contract.
      assert.match(read('src/commercial-policy.mjs'), /purchases_enabled:false/,
        'purchases are no longer hard-disabled: re-score billing');
    },
  },
];

for (const finding of findings) {
  test(`FALSIFIABLE ${finding.id} (${finding.surface}): ${finding.probe}`, () => finding.check());
}

// ---------------------------------------------------------------------------
// 3. Parity that must not be lost while anyone works this area. These are
// PRESENCE probes: they go red if a working surface is taken away. Kept apart
// from the ABSENCE probes above on purpose - a passing absence probe is a
// finding, a failing presence probe is a defect.

test('PARITY-PATHS: the shipped app really calls the Supabase-shaped surfaces, so "missing" means missing rather than renamed', () => {
  // Paths reach the request helper WITHOUT the /api/ prefix, so probe the bare form.
  // Startup paths live in startup-ui.js / startup-data.js, data reads in the data modules:
  // a parity table that only looked at app.js would have invented these call sites.
  const callSites = [appSource, startupUiSource, startupDataSource, usageDataSource];
  for (const [path, where] of [['me', startupDataSource], ['projects', startupDataSource], ['usage', appSource], ['keys', appSource], ['billing/status', appSource]]) {
    assert.ok(new RegExp(`['"\`]${path}['"\`?&]`).test(where), `${path} has no caller where the parity table says it does`);
    assert.ok(!callSites.some(src => src.includes('/api/' + path)), `${path} must not be spelled with its /api/ prefix`);
  }
  for (const path of ['workspaces/members', 'workspaces/invite', 'workspaces/accept']) {
    assert.ok(workspacesSource.includes(path), `${path} has no caller in the shipped workspace UI`);
  }
});

test('PARITY-SCOPE: workspace/environment switching and role-fenced navigation stay wired', () => {
  assert.match(appSource, /activeWorkspace\s*=\s*chosen\.workspace_id/, 'workspace selection must stay resolved before render');
  assert.match(appSource, /activeRole\s*===\s*'viewer'/, 'viewer-role nav fencing must stay in place');
  assert.match(workspacesSource, /workspace-select/, 'the workspace selector must stay rendered');
});

// ---------------------------------------------------------------------------
// 4. The parity table itself: machine-checked, one row per gap, evidence per
//    score, with historical issue tracking distinguished from current gaps.
// ---------------------------------------------------------------------------

test('the synthetic inventory scores at least ten surfaces, each with evidence', () => {
  const receipt = JSON.parse(readParity('receipt.json'));
  // Source-only: #85's live criterion is not met, so the receipt must not claim completion.
  assert.equal(receipt.complete, false);
  assert.equal(receipt.evidence_kind, 'source-only');
  assert.equal(receipt.base_branch, 'main');
  assert.equal(receipt.base_commit.length, 40);
  assert.equal(receipt.summary.total_surfaces, receipt.surfaces.length);
  for (const score of ['present', 'partial', 'missing']) {
    assert.equal(receipt.summary[score], receipt.surfaces.filter(s => s.score === score).length);
  }
  assert.ok(!receipt.surfaces.some(s => s.score === 'present'), 'a source-only pass cannot score a surface present');
  assert.ok(Array.isArray(receipt.surfaces) && receipt.surfaces.length >= 10, 'need >= 10 surfaces');
  for (const surface of receipt.surfaces) {
    assert.ok(['present', 'partial', 'missing'].includes(surface.score), `${surface.name}: bad score ${surface.score}`);
    assert.ok(surface.source_paths.length > 0, `${surface.name}: source paths missing`);
    for (const path of surface.source_paths) assert.ok(read(path).length > 0, `${path}: empty source`);
    assert.ok(typeof surface.evidence === 'string' && surface.evidence.length > 8, `${surface.name}: scored without evidence`);
  }
  assert.ok(receipt.gap_table_path.endsWith('gap-table.md'));
  assert.ok(Array.isArray(receipt.issues));
});

test('every non-present surface has a gap-table row naming what to do about it', () => {
  const receipt = JSON.parse(readParity('receipt.json'));
  const table = readParity('gap-table.md');
  for (const surface of receipt.surfaces.filter(s => s.score !== 'present')) {
    const cells = table.split('\n').filter(line => line.includes(`\`${surface.score}\``));
    assert.ok(cells.length >= 1, `${surface.name} is scored ${surface.score} with no table row`);
    assert.ok(cells.some(cell => cell.includes(surface.name)), `${surface.name} scored ${surface.score} but absent from the table`);
  }
});

test('synthetic tracking schema: every in-scope gap row links a filed issue or says why it is unfiled', () => {
  const receipt = JSON.parse(readParity('receipt.json'));
  assert.equal(receipt.github_issues_filed, true);
  for (const surface of receipt.surfaces) {
    assert.ok(Array.isArray(surface.issues), `${surface.name}: issues[] missing`);
    for (const url of surface.issues) assert.match(url, /^https:\/\/github\.com\/SlanchaAI\/supatrace\/issues\/\d+$/);
    assert.ok(surface.issues.length > 0 || (surface.unfiled_reason ?? '').length > 5, `${surface.name}: no issue and no unfiled reason`);
  }
  assert.ok(receipt.issue_filing_note, 'explain what the issues list is for');
  const filed = receipt.issues.filter(i => !i.id.startsWith('F-'));
  assert.ok(filed.length >= 8, 'the handoff shrank');
  for (const issue of receipt.issues) {
    assert.ok(['bug', 'task'].includes(issue.kind), `${issue.title}: kind must be bug or task`);
    assert.ok(['human-facing', 'bot-facing'].includes(issue.audience), `${issue.title}: audience must be human-facing or bot-facing`);
    assert.ok(issue.title.length > 8 && issue.body.length > 40, `${issue.title}: thin issue`);
    // A probe stub that shares a parent issue must say so, or it gets filed as a duplicate.
    if (issue.id.startsWith('F-')) assert.match(issue.body, /GAP-/, `${issue.id}: probe stub with no owning issue`);
    assert.ok(Array.isArray(issue.searched), `${issue.title}: record what you searched before filing`);
  }
});

test('synthetic tracking covers every gap the contract probes, one issue each', () => {
  const receipt = JSON.parse(readParity('receipt.json'));
  const filed = receipt.issues.map(i => i.id);
  for (const finding of findings) {
    assert.ok(filed.includes(finding.id), `${finding.id} is a probed gap with no issue handoff`);
  }
  for (const probe of ['PROBE-STARTUP-SERIAL', 'PROBE-STARTUP-NO-PROBE']) {
    assert.ok(!filed.includes(probe), `${probe} is a probe, not an issue`);
  }
});
