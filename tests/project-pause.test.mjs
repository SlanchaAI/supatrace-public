// Idle pause of Free projects (#113): no accepted upload for 30 days pauses the project, one click resumes it,
// paid plans are exempt, and nothing stored is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {IDLE_PAUSE, RESUME_PATH, projectLifecycle} from '../src/plan-limits.mjs';
import {pauseMessage} from '../src/project-pause.mjs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {validateUsage} from '../public/app/usage-data.js';
import {start} from './harness.mjs';
import {Workspaces, workspaceSession, environmentStore} from '../src/workspaces.mjs';

const tenant = 'github-7', DAY = 86400, T0 = Date.UTC(2026, 10, 20, 12) / 1000, token = 'c'.repeat(43), key = 'a'.repeat(43), ORIGIN = 'https://supatrace.dev';
const sha = value => createHash('sha256').update(value).digest('hex'), iso = seconds => new Date(seconds * 1000).toISOString();
const paused = error => error.status === 403 && error.code === 'project_paused';
async function fixture({plan, identity} = {}) {
  let now = T0; const client = new MemoryDynamo(), mail = [];
  const store = new DynamoMetadataStore({client, commands: commandClasses(), tableName: 'synthetic', now: () => now});
  await store.getOrCreateTenant(7);
  const root = () => client.items.get('TENANT#' + tenant + '\0META'); if (plan) root().plan_id = plan; if (identity) Object.assign(root(), identity);
  const reserve = id => store.reserveBatch(tenant, {batch_id: id, run_id: 'run1', request_hash: sha(id), byte_count: 100, event_count: 1});
  const accept = id => store.acceptReservedBatch(tenant, id, sha(id), {writer: digest(key), started_at: now * 1000, ended_at: now * 1000, has_error: false});
  const notices = () => [...client.items.values()].filter(row => row.sk.startsWith('NOTICE#PAUSE#'));
  client.items.set('WRITE#' + digest(key) + '\0KEY', {pk: 'WRITE#' + digest(key), sk: 'KEY', token_hash: digest(key), tenant_id: tenant, scope: 'write', revoked: false, expires_at: T0 + DAY * 3650});
  const api = Object.create(store); api.consumeRate = async () => ({allowed: true}); api.lookupWriteKey = async () => ({tenant_id: tenant, project_id: alphaProject(tenant).id, token_hash: digest(key)});
  const env = {ENABLED: true, APP_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', store: api, objects: {putImmutable: async () => {}}};
  const signIn = () => store.createSession(digest(token), tenant);
  const post = (path, body) => handle(new Request(ORIGIN + '/api/' + path, {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN, cookie: '__Host-supatrace=' + token}, body: JSON.stringify(body)}), env);
  const usage = async () => (await handle(new Request(ORIGIN + '/api/usage', {headers: {cookie: '__Host-supatrace=' + token}}), env)).json();
  let batches = 0;
  const upload = () => { const raw = JSON.stringify({version: 1, batch_id: 'up' + ++batches, run_id: 'run1', events: [{id: 'e' + batches, time: iso(now), kind: 'note', name: 'Synthetic', data: {safe: true}}]});
    return handle(new Request(ORIGIN + '/api/batches?project=' + alphaProject(tenant).id, {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw}), env); };
  const email = () => { env.EMAIL_FROM = 'member@example.com'; env.sendEmail = async message => { mail.push(message); }; };
  return {store, client, root, reserve, accept, notices, env, signIn, post, usage, upload, email, mail, at: value => now = value};
}

test('the rule: 30 idle days pause a Free project, the last 3 warn, paid and managed accounts never pause', () => {
  assert.deepEqual({...IDLE_PAUSE}, {days: 30, warn_days: 3, introduced_at: Date.UTC(2026, 10, 14) / 1000});
  const row = {created_at: T0}, at = days => projectLifecycle(row, T0 + days * DAY).state;
  assert.deepEqual([at(0), at(26.99), at(27), at(29.99), at(30), at(400)], ['active', 'active', 'pausing_soon', 'pausing_soon', 'paused', 'paused']);
  assert.deepEqual(projectLifecycle(row, T0 + 30 * DAY), {state: 'paused', exempt: false, last_activity_at: T0, last_accepted_at: null, pauses_at: T0 + 30 * DAY});
  // Activity is the latest of accepted upload, resume and plan change.
  for (const field of ['last_accepted_at', 'resumed_at', 'plan_changed_at']) assert.equal(projectLifecycle({created_at: T0, [field]: T0 + 20 * DAY}, T0 + 45 * DAY).state, 'active', field);
  // Accounts older than the rule count from its introduction, not from their creation: nobody is paused retroactively.
  const old = {created_at: IDLE_PAUSE.introduced_at - 400 * DAY};
  assert.equal(projectLifecycle(old, IDLE_PAUSE.introduced_at + 29 * DAY).state, 'pausing_soon'); assert.equal(projectLifecycle(old, IDLE_PAUSE.introduced_at + 30 * DAY).state, 'paused');
  // Exempt: paid plans, commercially managed rows. Unknown plan ids resolve to Free and are not exempt.
  for (const exempt of [{created_at: T0, plan_id: 'base'}, {created_at: T0, plan_id: 'pro'}, {created_at: T0, plan_id: 'enterprise'}, {created_at: T0, commercial_managed: true}]) assert.deepEqual(projectLifecycle(exempt, T0 + 400 * DAY), {state: 'active', exempt: true});
  for (const unknown of ['platinum', 'team']) assert.equal(projectLifecycle({created_at: T0, plan_id: unknown}, T0 + 30 * DAY).state, 'paused');
  // Malformed stamps never extend the window.
  assert.equal(projectLifecycle({created_at: T0, last_accepted_at: 'tomorrow', resumed_at: -5}, T0 + 30 * DAY).state, 'paused');
});

test('a paused project refuses new uploads, keeps every stored trace, and resumes in one call', async () => {
  const f = await fixture(); await f.reserve('first'); await f.accept('first');
  assert.equal(f.root().last_accepted_at, T0);
  f.at(T0 + 30 * DAY - 1); await f.reserve('last-second');   // still inside the window; reserved but never accepted
  f.at(T0 + 30 * DAY); const before = structuredClone([...f.client.items.entries()]);
  await assert.rejects(f.reserve('idle'), error => paused(error) && error.details.resume_url === RESUME_PATH && error.details.paused_at === iso(T0 + 30 * DAY) && error.details.plan === 'free' && /Stored traces are kept/.test(error.details.message));
  // Refusing changed nothing: no marker, no counters, no deletion.
  assert.deepEqual([...f.client.items.entries()], before);
  assert.ok(before.some(([, row]) => row.sk.startsWith('BATCH#') && row.status === 'accepted')); assert.equal(f.root().used_bytes, 200);
  // A reservation alone is not activity; only an accepted upload is.
  assert.equal(projectLifecycle(f.root(), T0 + 30 * DAY).state, 'paused');
  // Resume: idempotent, stamps resumed_at, and the window starts again.
  const resumed = await f.store.resumeProject(tenant); assert.equal(resumed.resumed, true); assert.equal(resumed.lifecycle.state, 'active'); assert.equal(f.root().resumed_at, T0 + 30 * DAY);
  assert.deepEqual(await f.store.resumeProject(tenant), {resumed: false, lifecycle: projectLifecycle(f.root(), T0 + 30 * DAY)});
  await f.reserve('after-resume'); await f.accept('after-resume'); assert.equal(f.root().last_accepted_at, T0 + 30 * DAY);
  f.at(T0 + 59 * DAY); await f.reserve('day-59'); f.at(T0 + 60 * DAY); await assert.rejects(f.reserve('day-60'), paused);
  await assert.rejects(f.store.resumeProject('github-999'), error => error.status === 404);
});

test('an identical retry of an upload reserved before the pause still gets its reservation', async () => {
  const f = await fixture(); const first = await f.reserve('same'); f.at(T0 + 31 * DAY);
  assert.equal((await f.reserve('same')).object_key, first.object_key); await f.accept('same');
  assert.equal(projectLifecycle(f.root(), T0 + 31 * DAY).state, 'active');   // accepting it is activity
});

test('paid plans are exempt: a Pro project idle for a year still accepts uploads', async () => {
  for (const plan of ['base', 'pro', 'enterprise']) { const f = await fixture({plan}); f.at(T0 + 365 * DAY); await f.reserve('paid'); assert.deepEqual(await f.store.resumeProject(tenant), {resumed: false, lifecycle: {state: 'active', exempt: true}}); }
});

test('the upload API explains the pause, /api/usage reports it, and the owner resumes with one POST', async () => {
  const f = await fixture(); f.at(T0 + 27 * DAY); await f.signIn();
  let body = await f.usage();
  assert.deepEqual(body.lifecycle, {state: 'pausing_soon', pauses_when_idle: true, idle_days: 30, warn_days: 3, last_upload_at: null, pauses_at: iso(T0 + 30 * DAY), resume_url: '/app/#usage'});
  assert.deepEqual(validateUsage(body).lifecycle, body.lifecycle);
  f.at(T0 + 30 * DAY); await f.signIn(); const refused = await f.upload(); assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {error: 'project_paused', message: 'This project is paused: no trace was accepted for 30 days, and Free projects pause when idle. Stored traces are kept. The workspace owner can resume it in one click under Usage; uploads work again at once.', plan: 'free', paused_at: iso(T0 + 30 * DAY), resume_url: '/app/#usage'});
  assert.equal((await f.usage()).lifecycle.state, 'paused');
  // Exact empty body, owner only.
  for (const bad of [{force: true}, [], null]) { const r = await f.post('billing/resume', bad); assert.equal(r.status, 400); assert.deepEqual(await r.json(), {error: 'invalid_resume_request'}); }
  assert.equal((await f.post('billing/resume?workspace=github-8', {})).status, 403);
  assert.equal((await handle(new Request(ORIGIN + '/api/billing/resume', {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN}, body: '{}'}), f.env)).status, 401);
  assert.equal(f.root().resumed_at, undefined);
  const response = await f.post('billing/resume', {}); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {resumed: true, lifecycle: {state: 'active', pauses_when_idle: true, idle_days: 30, warn_days: 3, last_upload_at: null, pauses_at: iso(T0 + 60 * DAY), resume_url: '/app/#usage'}});
  const accepted = await f.upload(); assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal((await f.usage()).lifecycle.last_upload_at, iso(T0 + 30 * DAY));
  // Paid: no pause state to show, and the dashboard validator accepts both shapes and refuses broken ones.
  f.root().plan_id = 'pro'; body = await f.usage(); assert.deepEqual(body.lifecycle, {state: 'active', pauses_when_idle: false}); assert.deepEqual(validateUsage(body).lifecycle, body.lifecycle);
  const {lifecycle, ...legacy} = body; assert.equal(validateUsage(legacy).lifecycle, undefined);
  for (const bad of [{state: 'paused', pauses_when_idle: false}, {state: 'gone', pauses_when_idle: true}, {state: 'paused', pauses_when_idle: true, idle_days: 30, warn_days: 3, last_upload_at: null, pauses_at: 'soon', resume_url: '/app/#usage'}, {state: 'paused', pauses_when_idle: true, idle_days: 30, warn_days: 3, last_upload_at: null, pauses_at: iso(T0), resume_url: 'https://evil.example/'}])
    assert.throws(() => validateUsage({...body, lifecycle: bad}), /invalid_usage/);
});

test('one notification row per pause; email only when the SES path is configured and the account has an address', async () => {
  // Not configured: a row, no email.
  const plain = await fixture(); plain.at(T0 + 31 * DAY); await plain.upload(); await plain.upload();
  assert.deepEqual(plain.notices().map(n => [n.kind, n.paused_at, n.idle_days, n.email_status]), [['project_paused', T0 + 30 * DAY, 30, 'not_configured']]);
  // Configured, GitHub account (no address on file): no email.
  const github = await fixture(); github.email(); github.at(T0 + 31 * DAY); await github.upload();
  assert.deepEqual([github.notices()[0].email_status, github.mail.length], ['no_address', 0]);
  // Configured, email account: exactly one email for the pause, however many uploads are refused.
  const mailed = await fixture({identity: {provider: 'email', email: 'owner@example.com'}}); mailed.email(); mailed.at(T0 + 31 * DAY);
  assert.equal((await mailed.upload()).status, 403); assert.equal((await mailed.upload()).status, 403);
  assert.equal(mailed.mail.length, 1); assert.deepEqual(mailed.mail[0], {to: 'owner@example.com', ...pauseMessage(ORIGIN)});
  assert.match(mailed.mail[0].text, /Nothing was deleted\./); assert.match(mailed.mail[0].text, /https:\/\/supatrace\.dev\/app\/#usage/); assert.equal(mailed.notices()[0].email_status, 'sent');
  // A second pause after a resume is a new notice.
  await mailed.store.resumeProject(tenant); mailed.at(T0 + 62 * DAY); await mailed.upload(); assert.equal(mailed.mail.length, 2); assert.equal(mailed.notices().length, 2);
  // An SES failure or stall never turns the 403 into a 5xx.
  const down = await fixture({identity: {provider: 'email', email: 'owner@example.com'}}); down.env.EMAIL_FROM = 'member@example.com'; down.env.sendEmail = async () => { throw new Error('SES down'); }; down.at(T0 + 31 * DAY);
  assert.equal((await down.upload()).status, 403); assert.equal(down.notices()[0].email_status, 'failed');
  const stalled = await fixture({identity: {provider: 'email', email: 'owner@example.com'}}); stalled.env.EMAIL_FROM = 'member@example.com'; stalled.env.alertEmailTimeoutMs = 20; stalled.env.sendEmail = () => new Promise(() => {}); stalled.at(T0 + 31 * DAY);
  assert.equal((await stalled.upload()).status, 403); assert.equal(stalled.notices()[0].email_status, 'failed');
});

test('the dashboard has the pause banner with a Resume button, and the agent uploader explains the refusal', () => {
  const html = readFileSync(new URL('../public/app/index.html', import.meta.url), 'utf8'), app = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8'), agent = readFileSync(new URL('../agent/upload.py', import.meta.url), 'utf8');
  assert.match(html, /<div id="pause-banner" class="usage-banner pause-banner" role="status" aria-live="polite" hidden><span id="pause-text"><\/span> <button id="project-resume" type="button" hidden>Resume project<\/button><\/div>/);
  assert.match(html, /<p id="usage-lifecycle" class="hint"><\/p>/); assert.match(app, /api\('billing\/resume',\{\}\)/); assert.match(app, /project_paused:/);
  assert.match(agent, /\(403, 'project_paused'\): 'project_paused'/); assert.match(agent, /'project_paused': 'The project is paused/);
});

test('an organization owner resumes its project; a decision made before an ownership transfer cannot', {timeout: 30000}, async () => {
  const live = await start(); try {
    const account = async id => { let cookie = ''; const tenantId = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant: tenantId, cookie}; };
    const post = (who, path, data) => fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie: who.cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)});
    const json = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
    let owner = await account(4242), admin = await account(5252);
    const org = (await json(await post(owner, 'orgs', {name: 'Acme'}), 201)).id, invite = await json(await post(owner, 'workspaces/invite?workspace=' + org, {recipient_id: admin.tenant, role: 'admin'}), 201);
    await json(await post(admin, 'workspaces/accept', {workspace_id: org, token: invite.token}));
    // 31 idle days later (the organization's project never received a trace), with fresh sessions.
    const real = live.store.now(); live.store.now = () => real + 31 * DAY + Math.floor(Date.now() / 1000) - real; owner = await account(4242); admin = await account(5252);
    const usage = async who => json(await fetch(live.origin + '/api/usage?workspace=' + org, {headers: {cookie: who.cookie}}));
    assert.equal((await usage(owner)).lifecycle.state, 'paused');
    // Only the owner resumes: an admin is refused by the billing gate.
    assert.equal((await post(admin, 'billing/resume?workspace=' + org, {})).status, 403);
    // The owner's request passed its ownership check; then ownership moves. The stale request's write must fail.
    const request = new Request(live.origin + '/api/billing/resume?workspace=' + org, {headers: {cookie: owner.cookie}}), stamp = await workspaceSession(request, live.store, owner.tenant), access = await new Workspaces(live.store).access(owner.tenant, org);
    assert.equal(access.role, 'owner'); const stale = environmentStore(live.store, {owner: org, environment: 'default', stamp, access, issuer: owner.tenant});
    const members = (await json(await fetch(live.origin + '/api/workspaces/members?workspace=' + org, {headers: {cookie: owner.cookie}}))).members;
    await json(await post(owner, 'orgs/transfer', {organization_id: org, user_id: admin.tenant, version: members.find(m => m.user_id === admin.tenant).version}));
    await assert.rejects(stale.resumeProject(org), error => error.status === 409 && error.code === 'workspace_changed');
    assert.equal((await live.store._get({pk: 'TENANT#' + org, sk: 'META'})).resumed_at, undefined); assert.equal((await usage(admin)).lifecycle.state, 'paused');
    assert.equal((await post(owner, 'billing/resume?workspace=' + org, {})).status, 403);   // no longer the owner
    const resumed = await json(await post(admin, 'billing/resume?workspace=' + org, {})); assert.equal(resumed.resumed, true); assert.equal(resumed.lifecycle.state, 'active');
  } finally { await live.close(); }
});
