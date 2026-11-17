import {ImportJobLedger} from '../src/import-job-ledger.mjs';
import {runHostedLangfuseStage} from '../src/hosted-langfuse-stage.mjs';
import {planCustomerImport} from '../src/import-planning.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {start} from './harness.mjs';
import {stageConnectorFile} from '../agent/import_traces.mjs';
import {convertConnectorFile} from '../src/importers/connector-files.mjs';
import {prepareAccountArchive, saveAccountArchive} from '../public/app/account-export.js';
import {fixtures, marker} from './connector-fixtures.mjs';
import {createPrivateBraintrustJobs} from '../src/importers/private-braintrust-jobs.mjs';
import {runPrivateBraintrustImport} from '../src/importers/private-braintrust-runtime.mjs';
import {spec as braintrustSpec, row as braintrustRow, fakeOptions as braintrustTransport} from './braintrust-fixtures.mjs';
import {runPrivateLangsmithImport} from '../src/importers/private-langsmith-runtime.mjs';
import {spec as langsmithSpec, row as langsmithRow, root as langsmithRoot, child as langsmithChild, fakeOptions as langsmithTransport} from './langsmith-fixtures.mjs';

function upload(config) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [new URL('connector_upload_driver.py', import.meta.url).pathname], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', errors = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => errors += x);
    child.on('error', reject); child.on('close', code => code ? reject(Error(errors)) : resolve(JSON.parse(output))); child.stdin.end(JSON.stringify(config));
  });
}
async function setup({importJobs=false}={}) {
  const live = await start({importJobControl:importJobs}), dir = mkdtempSync(join(tmpdir(), 'connector-roundtrip-'));
  let cookies; const tenant = await live.signIn({addCookies: async value => cookies = value});
  const key = await live.writeKey(tenant), headers = {cookie: cookies.map(c => c.name + '=' + c.value).join('; ')};
  const me = await (await fetch(live.origin + '/api/me', {headers})).json();
  const project = me.project_id;
  assert.match(project, /^proj_/);
  async function stage(format, input, suffix = format, content = 'include') {
    const path = join(dir, suffix + '.json'), directory = join(dir, suffix);
    writeFileSync(path, typeof input === 'string' ? input : JSON.stringify(input));
    const {receipt} = await stageConnectorFile(path, {format, namespace: 'local-e2e-' + suffix, directory, destinationProject: project, content});
    const scope = {origin: 'https://supatrace.dev', project_id: project, fingerprint: receipt.fingerprint, conversion_hash: receipt.conversionHash, manifest_hash: receipt.manifestHash, max_batches: 1000, max_requests: 1000, max_total_bytes: 20 * 1024 * 1024, total_timeout_ms: 30000};
    return {directory, local_origin: live.origin, scope, key};
  }
  async function get(path) { return fetch(live.origin + path, {headers}); }
  const loadCatalog = async () => (await (await get('/api/runs')).json()).runs;
  async function writeRun(id, signal, sink) {
    let cursor, events = 0, batches = 0;
    do {
      let response = await get('/api/events?run=' + id + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
      if (response.status === 429) response = await get('/api/events?run=' + id + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
      assert.equal(response.status, 200); const page = await response.json();
      events += page.events.length; batches += page.events.length ? 1 : 0; await sink(page.events); cursor = page.next;
    } while (cursor);
    return {events, batches};
  }
  return {live, dir, key, stage, get, headers, project, tenant, loadCatalog, writeRun, close: async () => {await live.close(); rmSync(dir, {recursive: true, force: true});}};
}

for (const content of ['metadata', 'include']) test('Braintrust paginated API -> private stage -> retained upload -> storage -> exact export (' + content + ')', async () => {
  const env = await setup();
  try {
    const rows = [braintrustRow(), braintrustRow('child')], spec = {...braintrustSpec, content, destinationProject: env.project};
    const directory = join(env.dir, 'api'), fake = braintrustTransport([{data: {data: [rows[0]]}, headers: {'x-bt-cursor': 'next'}}, {data: {data: [rows[1]]}}]);
    const {stageReceipt} = await runPrivateBraintrustImport(spec, {...fake.options, directory});
    const scope = {origin: 'https://supatrace.dev', project_id: env.project, fingerprint: stageReceipt.fingerprint, conversion_hash: stageReceipt.conversionHash, manifest_hash: stageReceipt.manifestHash, max_batches: 1000, max_requests: 1000, max_total_bytes: 20 * 1024 * 1024, total_timeout_ms: 30000};
    const config = {directory, scope, local_origin: env.live.origin, key: env.key};
    assert.equal((await upload(config)).all_batches_acknowledged, true);
    assert.equal((await upload(config)).transport_requests_attempted, 0);
    const archive = await prepareAccountArchive({projectId: env.project, loadCatalog: env.loadCatalog, writeRun: env.writeRun});
    const saved = JSON.parse(await archive.blob.text()), events = saved.runs.flatMap(r => r.events);
    assert.equal(saved.run_count, 1); assert.equal(saved.event_count, 2);
    const staged = readdirSync(join(directory, 'converted')).filter(n => n.startsWith('imp.')).flatMap(n => JSON.parse(readFileSync(join(directory, 'converted', n))).events);
    assert.deepEqual(events.map(e => e.data).sort((a, b) => a.span.spanId.localeCompare(b.span.spanId)), staged.map(e => e.data).sort((a, b) => a.span.spanId.localeCompare(b.span.spanId)));
    assert.equal(events.filter(e => e.data.span.parentSpanId === 'root').length, 1);
    if (content === 'include') assert.deepEqual(events.map(e => e.data.original).sort((a, b) => a.id.localeCompare(b.id)), rows.sort((a, b) => a.id.localeCompare(b.id)));
    else assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROMPT_MUST_NOT_PERSIST/);
  } finally {await env.close();}
});

for (const content of ['metadata', 'include']) test('Langsmith paginated API -> private stage -> retained upload -> storage -> exact export (' + content + ')', async () => {
  const env = await setup();
  try {
    const rows = [langsmithRow(), langsmithRow(langsmithChild)], spec = {...langsmithSpec, content, destinationProject: env.project};
    const directory = join(env.dir, 'api'), fake = langsmithTransport([{items: [rows[1]], next_cursor: 'next'}, {items: [rows[0]], next_cursor: ''}]);
    const {stageReceipt} = await runPrivateLangsmithImport(spec, {...fake.options, directory});
    const scope = {origin: 'https://supatrace.dev', project_id: env.project, fingerprint: stageReceipt.fingerprint, conversion_hash: stageReceipt.conversionHash, manifest_hash: stageReceipt.manifestHash, max_batches: 1000, max_requests: 1000, max_total_bytes: 20 * 1024 * 1024, total_timeout_ms: 30000};
    const config = {directory, scope, local_origin: env.live.origin, key: env.key};
    assert.equal((await upload(config)).all_batches_acknowledged, true);
    assert.equal((await upload(config)).transport_requests_attempted, 0);
    const archive = await prepareAccountArchive({projectId: env.project, loadCatalog: env.loadCatalog, writeRun: env.writeRun});
    const saved = JSON.parse(await archive.blob.text()), events = saved.runs.flatMap(r => r.events);
    assert.equal(saved.run_count, 1); assert.equal(saved.event_count, 2);
    assert.deepEqual(events.find(e => e.data.span.spanId === langsmithChild).data.span.usage, {input: 2, output: 3, cacheRead: 1});
    const staged = readdirSync(join(directory, 'converted')).filter(n => n.startsWith('imp.')).flatMap(n => JSON.parse(readFileSync(join(directory, 'converted', n))).events);
    assert.deepEqual(events.map(e => e.data).sort((a, b) => a.span.spanId.localeCompare(b.span.spanId)), staged.map(e => e.data).sort((a, b) => a.span.spanId.localeCompare(b.span.spanId)));
    assert.equal(events.filter(e => e.data.span.parentSpanId === langsmithRoot).length, 1);
    if (content === 'include') assert.deepEqual(events.map(e => e.data.original).sort((a, b) => a.id.localeCompare(b.id)), rows.sort((a, b) => a.id.localeCompare(b.id)));
    else assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROMPT_MUST_NOT_PERSIST/);
  } finally {await env.close();}
});

test('all provider files -> private spool -> retained uploader -> actual API storage -> exact account archive', async () => {
  const env = await setup();
  try {
    const expected = [];
    for (const [format, make] of Object.entries(fixtures)) {
      const input = make(), config = await env.stage(format, input);
      const result = await upload(config); assert.equal(result.all_batches_acknowledged, true); assert.equal(result.accepted_batches, 2);
      const replay = await upload(config); assert.equal(replay.transport_requests_attempted, 0);
      assert.deepEqual(readdirSync(join(config.directory, 'pending')), ['import-manifest.json']);
      expected.push(...convertConnectorFile(JSON.stringify(input), {format, namespace: 'local-e2e-' + format, content: 'include'}).batches.flatMap(b => b.events));
    }
    env.live.rateLimitEvents(1);
    const result = await prepareAccountArchive({projectId: env.project, loadCatalog: env.loadCatalog, writeRun: env.writeRun});
    const saved = JSON.parse(await result.blob.text()), events = saved.runs.flatMap(r => r.events);
    assert.equal(saved.complete, true); assert.equal(saved.event_count, 16); assert.equal(saved.run_count, 8);
    assert.deepEqual(events.map(e => ({id: e.id, time: e.time, kind: e.kind, name: e.name, data: e.data})).sort((a, b) => a.id.localeCompare(b.id)), expected.sort((a, b) => a.id.localeCompare(b.id)));
    let foreignCookies; await env.live.signIn({addCookies: async value => foreignCookies = value}, 4243);
    const foreign = await (await fetch(env.live.origin + '/api/runs', {headers: {cookie: foreignCookies.map(c => c.name + '=' + c.value).join('; ')}})).json(); assert.equal(foreign.total, 0);
    let aborted = false, committed = false;
    await assert.rejects(saveAccountArchive({projectId: env.project, loadCatalog: env.loadCatalog, writeRun: env.writeRun, pick: async () => ({createWritable: async () => ({write: async () => {throw Error('disk full');}, close: async () => {committed = true;}, abort: async () => {aborted = true;}})})}));
    assert.equal(aborted, true); assert.equal(committed, false);
  } finally {await env.close();}
});
for (const failure of ['lost_ack', 'rate_limit']) test(failure + ' remains pending and restart never replays an ambiguous attempt', async () => {
  const env = await setup();
  try {
    const config = await env.stage('langsmith', fixtures.langsmith());
    const result = await upload({...config, failure}); assert.equal(result.outcome, 'reconciliation-required');
    const restart = await upload(config); assert.equal(restart.outcome, 'reconciliation-required'); assert.equal(restart.transport_requests_attempted, 0);
    assert.equal(readdirSync(join(config.directory, 'pending')).filter(n => n !== 'import-manifest.json').length, 2);
    const runs = await env.loadCatalog(); assert.equal(runs.length, failure === 'lost_ack' ? 1 : 0);
    if (failure === 'lost_ack') assert.equal(runs[0].event_count, 1);
  } finally {await env.close();}
});
test('fresh pinned real OpenInference capture imports and exports exact original span envelopes', {skip: !process.env.SUPATRACE_REAL_OTLP_FILE}, async () => {
  const raw = readFileSync(process.env.SUPATRACE_REAL_OTLP_FILE, 'utf8'), env = await setup();
  try {
    const converted = convertConnectorFile(raw, {format: 'otlp', namespace: 'local-e2e-real', content: 'include'});
    assert.equal(converted.batches.length, 4); assert.deepEqual(converted.report.rejected, []);
    const config = await env.stage('otlp', raw, 'real'); assert.equal((await upload(config)).all_batches_acknowledged, true);
    const archive = await prepareAccountArchive({projectId: env.project, loadCatalog: env.loadCatalog, writeRun: env.writeRun});
    const exported = JSON.parse(await archive.blob.text()).runs.flatMap(r => r.events);
    assert.deepEqual(exported.map(e => e.data).sort((a, b) => a.span.spanId.localeCompare(b.span.spanId)), converted.batches.map(b => b.events[0].data).sort((a, b) => a.span.spanId.localeCompare(b.span.spanId)));
    assert.equal(exported.filter(e => e.data.span.parentSpanId).length, 3);
  } finally {await env.close();}
});

test('bounded private job -> retained uploader -> actual tenant storage -> exact metadata export', async () => {
  const env = await setup();
  try {
    const fake = braintrustTransport([{data: {data: [braintrustRow('child')], cursor: 'next'}}, {data: {data: [braintrustRow()]}}]);
    const owner = {tenantId: env.tenant, projectId: env.project};
    const jobs = createPrivateBraintrustJobs({...fake.options, directory: join(env.dir, 'jobs')});
    const {jobId} = await jobs.create(owner, {...braintrustSpec, destinationProject: env.project}, 'synthetic_e2e_request_1234');
    const result = await jobs.execute(owner, jobId);assert.equal(result.status, 'staged');assert.equal(result.progress.pages, 2);
    const {directory, receipt} = await jobs.stagedArtifact(owner, jobId);
    const scope = {origin: 'https://supatrace.dev', project_id: env.project, fingerprint: receipt.fingerprint, conversion_hash: receipt.conversionHash, manifest_hash: receipt.manifestHash, max_batches: 1000, max_requests: 1000, max_total_bytes: 20 * 1024 * 1024, total_timeout_ms: 30000};
    const config = {directory, scope, local_origin: env.live.origin, key: env.key};
    const uploaded = await upload(config);assert.equal(uploaded.all_batches_acknowledged, true);assert.equal(uploaded.accepted_batches, 2);
    assert.equal((await upload(config)).transport_requests_attempted, 0);
    const archive = await prepareAccountArchive({projectId: env.project, loadCatalog: env.loadCatalog, writeRun: env.writeRun});
    const saved = JSON.parse(await archive.blob.text()), events = saved.runs.flatMap(r => r.events);
    const staged = readdirSync(join(directory, 'converted')).filter(n => n.startsWith('imp.')).flatMap(n => JSON.parse(readFileSync(join(directory, 'converted', n))).events);
    assert.equal(saved.run_count, 1);assert.equal(saved.event_count, 2);
    assert.deepEqual(events.map(e => e.data).sort((a,b) => a.span.spanId.localeCompare(b.span.spanId)), staged.map(e => e.data).sort((a,b) => a.span.spanId.localeCompare(b.span.spanId)));
    assert.equal(events.filter(e => e.data.span.parentSpanId === 'root').length, 1);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROMPT_MUST_NOT_PERSIST/);
    assert.equal((await jobs.execute(owner, jobId)).status, 'staged');assert.equal(fake.requests.length, 4);
    // The capture job deliberately does not claim the separately authorized upload/readback.
    assert.equal((await jobs.status(owner, jobId)).uploaded, false);
  } finally {await env.close();}
});

test('hosted Langfuse job API -> actual stage/uploader -> authoritative reconcile -> exact export (synthetic)', async () => {
  const env = await setup({importJobs:true});
  try {
    const input={provider:'langfuse',origin:'https://cloud.langfuse.com',sourceProject:'synthetic-source',environment:'synthetic-environment',namespace:'synthetic-hosted-roundtrip',from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',maxRows:10,maxPages:2,pageSize:5,maxBytes:100000,maxRetries:0};
    const fingerprint=planCustomerImport(input,env.project).plan.fingerprint;
    const post=async(path,data)=>fetch(env.live.origin+'/api/imports/'+path+'?project='+env.project,{method:'POST',headers:{...env.headers,origin:env.live.origin,'content-type':'application/json'},body:JSON.stringify(data)});
    let response=await post('jobs',{plan:input,fingerprint});assert.equal(response.status,202);const job=await response.json();
    const ledger=new ImportJobLedger(env.live.store),authority={worker_id:'1'.repeat(64),revision:'a'.repeat(40),source_binding:'2'.repeat(64),destination_binding:'3'.repeat(64),approval_hash:'4'.repeat(64),expires_at:Math.floor(Date.now()/1000)+120};
    const rows=[{id:'child',traceId:'live-fixture',parentObservationId:'root',projectId:input.sourceProject,environment:input.environment,startTime:'2026-10-01T12:00:00Z',input:{text:'SYNTHETIC_EXPLICIT_CONTENT'}},{id:'root',traceId:'live-fixture',parentObservationId:null,projectId:input.sourceProject,environment:input.environment,startTime:'2026-10-01T12:00:00Z'}];
    const directory=join(env.dir,'job-workspace'),hooks={authorize:async()=>true,checkExistingOperation:async()=>true}; // Synthetic controller only.
    const staged=await runHostedLangfuseStage({ledger,tenant:env.tenant,job:job.job_id,authority,directory,bounds:{requestTimeoutMs:1000,totalTimeoutMs:30000,maxRequests:10,maxResponseBytes:100000,maxTotalBytes:200000},...hooks,
      credentialProvider:async()=>({origin:input.origin,projectId:input.sourceProject,publicKey:'synthetic-public',secretKey:'synthetic-source-secret',expiresAt:Date.now()+60000}),
      fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/projects')?{data:[{id:input.sourceProject}]}:{data:rows,meta:{cursor:null}}),{headers:{'content-type':'application/json'}})});
    assert.equal(staged.job.status,'staged');assert.equal((await env.loadCatalog()).length,0);
    const permit=await ledger.consumeUpload(env.tenant,staged.claim,hooks);assert.equal(await ledger.verifyUpload(env.tenant,staged.claim,permit.receipt),true);
    const receipt=JSON.parse(readFileSync(join(directory,'stage-receipt.json'),'utf8'));
    const scope={origin:'https://supatrace.dev',project_id:env.project,fingerprint,conversion_hash:receipt.conversionHash,manifest_hash:receipt.manifestHash,max_batches:100,max_requests:100,max_total_bytes:2097152,total_timeout_ms:30000};
    // Existing test-only Python sender; an installed real per-batch controller bridge remains a gate.
    const config={directory,scope,local_origin:env.live.origin,key:env.key};assert.equal((await upload(config)).all_batches_acknowledged,true);assert.equal((await upload(config)).transport_requests_attempted,0);
    response=await post('jobs/'+job.job_id+'/reconcile',{});assert.equal(response.status,200);assert.equal((await response.json()).progress.readback_batches,1);
    response=await post('jobs/'+job.job_id+'/reconcile',{});const verified=await response.json();assert.equal(verified.status,'readback_verified');assert.equal(verified.export_verified,false);
    const archive=await prepareAccountArchive({projectId:env.project,loadCatalog:env.loadCatalog,writeRun:env.writeRun});
    const saved=JSON.parse(await archive.blob.text()),events=saved.runs.flatMap(r=>r.events);
    assert.equal(saved.event_count,2);assert.equal(saved.run_count,1);
    assert.deepEqual(events.map(e=>e.data.observation).sort((a,b)=>a.id.localeCompare(b.id)),rows.sort((a,b)=>a.id.localeCompare(b.id)));
    assert.equal(events.find(e=>e.data.observation.id==='child').data.observation.parentObservationId,'root');
    assert.doesNotMatch(JSON.stringify(saved),/synthetic-source-secret/);
  } finally {await env.close();}
});
