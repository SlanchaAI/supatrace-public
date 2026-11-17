import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';

function world(extra = {}) {
  const dynamo = new MemoryDynamo();
  const store = new DynamoMetadataStore({client: dynamo, commands: commandClasses(), tableName: 'metadata'});
  const saved = new Map(); let puts = 0;
  const objects = {saved, puts: () => puts, async putImmutable(key, raw, hash) {
    if (digest(raw) !== hash) throw Object.assign(new Error('invalid_payload'), {status: 400, code: 'invalid_payload'});
    const old = saved.get(key);
    if (old !== undefined && old !== raw) throw Object.assign(new Error('object_conflict'), {status: 409, code: 'object_conflict'});
    puts++; saved.set(key, raw);
  }, async get(key) {
    if (!saved.has(key)) throw Object.assign(new Error('object_read_unavailable'), {status: 503, code: 'object_read_unavailable'});
    return saved.get(key);
  }};
  const env = {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic-client', GITHUB_CLIENT_SECRET: 'synthetic-secret', store, objects, sourceIp: '203.0.113.10', ...extra};
  return {env, dynamo, objects};
}
function cookie(response, name) {
  const hit = response.headers.getSetCookie().find(value => value.startsWith(name + '='));
  assert.ok(hit, name);
  return hit.split(';')[0];
}
function assertSafe(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
}
function call(env, path, {method = 'GET', body, session, key, origin, hash} = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    if (hash !== false) headers['x-amz-content-sha256'] = hash || digest(body);
  }
  if (session) headers.cookie = session;
  if (key) headers['x-supatrace-key'] = key;
  if (origin) headers.origin = origin;
  return handle(new Request('https://supatrace.dev' + path, {method, headers, body}), env);
}
async function signIn(env, githubId) {
  const start = await handle(new Request('https://supatrace.dev/api/auth/login'), env);
  assert.equal(start.status, 302); assertSafe(start);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  let step = 0;
  env.fetcher = async () => ++step === 1 ? Response.json({access_token: 'synthetic-token'}) : Response.json({id: githubId, login: 'synthetic'});
  const back = await handle(new Request(`https://supatrace.dev/api/auth/callback?code=code-${githubId}&state=${state}`, {headers: {cookie: cookie(start, '__Host-supatrace-oauth')}}), env);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/app/');
  assert.equal(JSON.stringify(back.headers.getSetCookie()).includes('synthetic-token'), false);
  return cookie(back, '__Host-supatrace');
}
const note = (id, name) => ({id, time: '2026-10-24T18:00:00Z', kind: 'note', name, data: {safe: true}});
const rawBatch = (batchId, events) => JSON.stringify({version: 1, batch_id: batchId, run_id: 'run-order', events});

test('github sign-up and a later sign-in resolve the same tenant', async () => {
  const {env} = world();
  const first = await signIn(env, 42);
  const me = await call(env, '/api/me', {session: first});
  assert.equal(me.status, 200); assert.equal((await me.json()).tenant_id, 'github-42');
  const second = await signIn(env, 42);
  assert.equal((await (await call(env, '/api/me', {session: second})).json()).tenant_id, 'github-42');
});

test('google sign-in is one redirect and a github state cannot finish it', async () => {
  const {env} = world({GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret'});
  const start = await handle(new Request('https://supatrace.dev/api/auth/google'), env);
  const location = new URL(start.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('scope'), 'openid email');
  assert.equal(location.searchParams.has('prompt'), false);
  const state = location.searchParams.get('state');
  const oauth = cookie(start, '__Host-supatrace-oauth');
  env.fetcher = async () => { throw new Error('wrong provider exchanged the code'); };
  const crossed = await handle(new Request(`https://supatrace.dev/api/auth/callback?code=google-code&state=${state}`, {headers: {cookie: oauth}}), env);
  assert.equal(crossed.status, 400);
  env.fetcher = async url => String(url).includes('token') ? Response.json({access_token: 'synthetic-google-token'}) : Response.json({sub: 'acct-1'});
  const back = await handle(new Request(`https://supatrace.dev/api/auth/google/callback?code=google-code&state=${state}`, {headers: {cookie: oauth}}), env);
  assert.equal(back.status, 302);
  assert.equal(JSON.stringify(back.headers.getSetCookie()).includes('synthetic-google-token'), false);
  const me = await (await call(env, '/api/me', {session: cookie(back, '__Host-supatrace')})).json();
  assert.match(me.tenant_id, /^google-[a-f0-9]{64}$/);
  assert.match(me.project_id, /^proj_[a-f0-9]{32}$/);
  assert.notEqual(me.tenant_id, 'github-1');
});

test('a github state saved before provider tagging can still finish', async () => {
  const {env, dynamo} = world();
  const start = await handle(new Request('https://supatrace.dev/api/auth/login'), env);
  for (const item of dynamo.items.values()) if (item.verifier) delete item.provider;
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  env.fetcher = async () => Response.json({access_token: 'synthetic-token', id: 7});
  let step = 0;
  env.fetcher = async () => ++step === 1 ? Response.json({access_token: 'synthetic-token'}) : Response.json({id: 7, login: 'synthetic'});
  const back = await handle(new Request(`https://supatrace.dev/api/auth/callback?code=legacy&state=${state}`, {headers: {cookie: cookie(start, '__Host-supatrace-oauth')}}), env);
  assert.equal(back.status, 302);
  assert.equal((await (await call(env, '/api/me', {session: cookie(back, '__Host-supatrace')})).json()).tenant_id, 'github-7');
});

test('appending to a legacy run retains unknown summaries while exporting every old and new event',async()=>{
 const {env,objects}=world(),owner=await signIn(env,4242),tenant='github-4242',key=randomBytes(32).toString('base64url');
 const setup=await env.store.createSetup(digest(key));await env.store.approveSetup(tenant,setup.user_code);
 const oldEvents=Array.from({length:100},(_,i)=>({...note('legacy-'+i,'legacy '+i),kind:i===0?'error':'note'}));
 const raw=rawBatch('legacy-batch',oldEvents),hash=digest(raw);
 const reserved=await env.store.reserveBatch(tenant,{batch_id:'legacy-batch',run_id:'run-order',request_hash:hash,byte_count:Buffer.byteLength(raw),event_count:oldEvents.length});
 await objects.putImmutable(reserved.object_key,raw,hash);
 // The production baseline accepted batches without the newer trace-summary argument.
 await env.store.acceptReservedBatch(tenant,'legacy-batch',hash);
 const fresh=rawBatch('fresh-batch',[note('fresh-event','fresh event')]);
 for(let retry=0;retry<2;retry++)assert.equal((await call(env,'/api/batches',{method:'POST',body:fresh,key})).status,201);
 const runs=await (await call(env,'/api/runs',{session:owner})).json();assert.equal(runs.total,1);const summary=runs.runs[0];
 for(const field of ['started_at','ended_at','duration_ms','event_count','byte_count','status'])assert.equal(summary[field],null,field+' must not describe only the latest batch');
 assert.deepEqual(summary.agents,[]);assert.equal(summary.batch_count,2,'retry does not add another batch');
 const row=await env.store._get({pk:'TENANT#'+tenant,sk:'RUN#run-order'});for(const field of ['started_at','ended_at','event_count','byte_count','has_error','writers'])assert.equal(row[field],undefined,'no historical backfill or partial summary');
 let after='',events=[];do{const page=await (await call(env,'/api/events?run=run-order'+(after?'&after='+encodeURIComponent(after):''),{session:owner})).json();events.push(...page.events);after=page.next;}while(after);
 assert.equal(events.length,101);assert.equal(events[0].kind,'error');assert.equal(events.at(-1).id,'fresh-event');
});

test('paired key, hashes, retries, order, revocation, sign-out, and tenant isolation', async () => {
  const {env, objects} = world();
  const owner = await signIn(env, 41);
  const other = await signIn(env, 99);
  const key = randomBytes(32).toString('base64url');
  const started = await call(env, '/api/setup/start', {method: 'POST', body: JSON.stringify({key_hash: digest(key)})});
  assert.equal(started.status, 201);
  const setup = await started.json();
  assert.equal(setup.user_code.length, 12);
  assert.equal(JSON.stringify(setup).includes(key), false);
  const blocked = await call(env, '/api/setup/approve', {method: 'POST', body: JSON.stringify({user_code: setup.user_code}), session: owner});
  assert.equal(blocked.status, 403); assert.equal((await blocked.json()).error, 'origin_required');
  const approved = await call(env, '/api/setup/approve', {method: 'POST', body: JSON.stringify({user_code: setup.user_code}), session: owner, origin: env.APP_ORIGIN});
  assert.equal(approved.status, 200);
  const polled = await call(env, '/api/setup/poll', {method: 'POST', body: JSON.stringify({device_secret: setup.device_secret})});
  const approval = await polled.json();
  assert.equal(approval.approved, true); assert.equal(approval.scope, 'write'); assert.equal(JSON.stringify(approval).includes(key), false);
  const stolen = await call(env, '/api/setup/approve', {method: 'POST', body: JSON.stringify({user_code: setup.user_code}), session: other, origin: env.APP_ORIGIN});
  assert.equal(stolen.status, 409);

  const first = rawBatch('z-batch', [note('e1', 'first-a'), note('e2', 'first-b')]);
  const missing = await call(env, '/api/batches', {method: 'POST', body: first, key, hash: false});
  assert.equal(missing.status, 400); assert.equal((await missing.json()).error, 'payload_hash_required'); assert.equal(objects.puts(), 0);
  const wrong = await call(env, '/api/batches', {method: 'POST', body: first, key, hash: 'ab'.repeat(32)});
  assert.equal(wrong.status, 400); assert.equal(objects.puts(), 0);
  const accepted = await call(env, '/api/batches', {method: 'POST', body: first, key});
  assert.equal(accepted.status, 201); assertSafe(accepted);
  const receipt = await accepted.json();
  assert.equal(receipt.request_hash, digest(first));
  assert.match(receipt.project_id, /^proj_[a-f0-9]{32}$/);
  assert.equal(receipt.accepted, true);
  const retry = await call(env, '/api/batches', {method: 'POST', body: first, key});
  assert.equal(retry.status, 201); assert.equal(objects.puts(), 1);
  const conflictBody = rawBatch('z-batch', [note('e1', 'changed')]);
  const conflict = await call(env, '/api/batches', {method: 'POST', body: conflictBody, key});
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, 'idempotency_conflict'); assert.equal(objects.puts(), 1);
  const second = rawBatch('a-batch', [note('e3', 'second')]);
  assert.equal((await call(env, '/api/batches', {method: 'POST', body: second, key})).status, 201);

  for (const path of ['/api/runs', '/api/events?run=run-order', '/api/keys', '/api/me']) {
    const denied = await call(env, path, {key});
    assert.equal(denied.status, 401);
    assert.equal(JSON.stringify(await denied.json()).includes('first-a'), false);
  }
  let after = '', names = [];
  do {
    const page = await call(env, '/api/events?run=run-order' + (after ? '&after=' + encodeURIComponent(after) : ''), {session: owner});
    assert.equal(page.status, 200);
    const body = await page.json();
    names.push(...body.events.map(event => event.name));
    after = body.next || '';
  } while (after);
  assert.deepEqual(names, ['first-a', 'first-b', 'second']);
  const listed = await (await call(env, '/api/runs?sort=events&dir=asc', {session: owner})).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.runs[0].id, 'run-order');
  assert.equal(listed.runs[0].event_count, 3);
  assert.equal(listed.runs[0].duration_ms, 0);
  assert.equal(listed.runs[0].status, 'ok');
  assert.deepEqual(listed.runs[0].agents, [digest(key)]);
  assert.equal((await call(env, '/api/runs?agent=' + digest(key), {session: owner})).status, 200);
  assert.deepEqual((await (await call(env, '/api/runs?agent=' + 'ab'.repeat(32), {session: owner})).json()).runs, []);
  assert.equal((await call(env, '/api/runs?sort=nope', {session: owner})).status, 400);
  const failedRun = JSON.stringify({version: 1, batch_id: 'err-batch', run_id: 'run-failed', events: [{id: 'e9', time: '2026-10-24T18:00:00Z', kind: 'error', name: 'failed', data: {safe: true}}, {id: 'e10', time: '2026-10-24T18:00:02Z', kind: 'note', name: 'after', data: {safe: true}}]});
  assert.equal((await call(env, '/api/batches', {method: 'POST', body: failedRun, key})).status, 201);
  const failed = (await (await call(env, '/api/runs?q=run-failed', {session: owner})).json()).runs[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.duration_ms, 2000);
  assert.equal(failed.event_count, 2);
  assert.deepEqual((await (await call(env, '/api/runs?from=2026-10-24T19:00:00Z', {session: owner})).json()).runs, []);
  const otherEvents = await call(env, '/api/events?run=run-order', {session: other});
  assert.deepEqual((await otherEvents.json()).events, []);
  assert.deepEqual((await (await call(env, '/api/runs', {session: other})).json()).runs, []);
  const keys = await (await call(env, '/api/keys', {session: other})).json();
  assert.deepEqual(keys.keys, []);
  const ownerKeys = await (await call(env, '/api/keys', {session: owner})).json();
  assert.equal(ownerKeys.keys.length, 1);
  assert.equal(ownerKeys.keys[0].id, digest(key));

  const foreign = await call(env, '/api/keys/revoke', {method: 'POST', body: JSON.stringify({id: digest(key)}), session: other, origin: env.APP_ORIGIN});
  assert.equal(foreign.status, 404);
  const revoke = await call(env, '/api/keys/revoke', {method: 'POST', body: JSON.stringify({id: digest(key)}), session: owner, origin: env.APP_ORIGIN});
  assert.equal(revoke.status, 200);
  const rejected = await call(env, '/api/batches', {method: 'POST', body: rawBatch('fresh', [note('e4', 'after-revoke')]), key});
  assert.equal(rejected.status, 401); assert.equal(objects.saved.size, 3);

  const csrf = await call(env, '/api/auth/logout', {method: 'POST', body: '{}', session: other});
  assert.equal(csrf.status, 403);
  assert.equal((await call(env, '/api/me', {session: other})).status, 200);
  const bye = await call(env, '/api/auth/logout', {method: 'POST', body: '{}', session: other, origin: env.APP_ORIGIN});
  assert.equal(bye.status, 204); assertSafe(bye);
  assert.match(bye.headers.getSetCookie().find(value => value.startsWith('__Host-supatrace=')), /^__Host-supatrace=;.*Max-Age=0/);
  assert.equal((await call(env, '/api/me', {session: other})).status, 401);
  assert.equal((await call(env, '/api/me', {session: owner})).status, 200);
});
// Sign-in linking is part of the same journey; loaded here so the root `npm test` list does not change.
import './identity-links.test.mjs';
