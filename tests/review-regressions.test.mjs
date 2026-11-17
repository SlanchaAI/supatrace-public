import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {parseBatch,LIMITS} from '../src/trace.mjs';

const token = 'd'.repeat(43);
const raw = JSON.stringify({version: 1, batch_id: 'batch1', run_id: 'run1', events: [{id: 'event1', time: '2026-10-21T00:00:00Z', kind: 'note', name: 'synthetic', data: {safe: true}}]});

function store(extra = {}) {
  return {
    consumeRate: async () => ({allowed: true, ...extra.rate}),
    lookupWriteKey: async hash => hash === digest(token) ? {tenant_id: 'github-1'} : null,
    getSession: async hash => hash === digest(token) ? {tenant_id: 'github-1'} : null,
    getTenant: async () => ({project_id: alphaProject('github-1').id, used_bytes: 0, byte_limit: 10485760}),
    reserveBatch: async () => ({status: 'accepted'}),
    listRuns: async () => ({items: [], next: null}),
    ...extra.store
  };
}
const env = extra => ({ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', store: store(extra), objects: {}});

test('accepted uploads name the account project the live agents check', async () => {
  const response = await handle(new Request('https://supatrace.dev/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': token, 'x-amz-content-sha256': digest(raw)}, body: raw}), env());
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.project_id, alphaProject('github-1').id);
  assert.equal(body.accepted, true);
});

test('a full request window tells the caller when to retry', async () => {
  const response = await handle(new Request('https://supatrace.dev/api/me'), env({rate: {allowed: false, retry_after: 12}}));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '12');
});

test('session responses keep the project id the workspace stores', async () => {
  const response = await handle(new Request('https://supatrace.dev/api/me', {headers: {cookie: '__Host-supatrace=' + token}}), env());
  assert.deepEqual(await response.json(), {tenant_id: 'github-1', project_id: alphaProject('github-1').id, auth_provider: null, mfa: false, mfa_enabled: false});
});

test('revoke refreshes the key list instead of calling the row array', () => {
  const source = readFileSync(new URL('../public/app/app.js', import.meta.url), 'utf8');
  assert.match(source, /const keyRows=await loadAccountKeys/);
  assert.match(source, /await keys\(\)/);
  assert.equal(source.includes('const keys=[]'), false);
});

test('the first-trace example is bounded synthetic intake, not automatic customer capture',()=>{
 const raw=readFileSync(new URL('../public/examples/first-trace.json',import.meta.url),'utf8');const {batch}=parseBatch(raw);assert.equal(batch.run_id,'first-trace-example');assert.equal(batch.events.length,3);assert.ok(batch.events.every(event=>event.data.synthetic===true));assert.ok(Buffer.byteLength(raw)<LIMITS.bytes);
 const guide=readFileSync(new URL('../public/agent-setup.html',import.meta.url),'utf8');for(const path of ['/agent/connect.py','/agent/upload.py','/agent/claude_snapshot.py','/examples/first-trace.json','/app/#agents','/app/#traces'])assert.ok(guide.includes('href="'+path+'"'),path);for(const fact of ['50,000 spans','1 GB','512 KiB','32 KiB','30 days','Shared service caps can stop an upload','does not reset monthly','not automatically redacted','server acceptance order','/privacy.html'])assert.ok(guide.includes(fact),fact);
});

test('public entry points explain supported capture and link the published policies',()=>{
 const landing=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');for(const fact of ['Explicit JSON batches and reviewed Claude Code snapshots','50k spans a month','/privacy.html','/docs/quickstart/','/app/'])assert.ok(landing.includes(fact),fact);assert.doesNotMatch(landing,/<script(?![^>]*src=)(?!\s+type="application\/ld\+json">)|\son\w+=/i);
 assert.doesNotMatch(landing,/provider-note|use the sign-in method you previously used|stay separate unless you link/);
 const settings=readFileSync(new URL('../public/app/sign-in-methods.js',import.meta.url),'utf8');assert.ok(settings.includes('GitHub and Google can open the same account when both verify the same email.'));
 for(const path of ['terms.html','privacy.html'])assert.match(readFileSync(new URL('../public/'+path,import.meta.url),'utf8'),/Slancha, Inc\./);
});


test('setup and export copy state complete-catalog and aggregate download bounds honestly',()=>{
 const guide=readFileSync(new URL('../public/agent-setup.html',import.meta.url),'utf8'),html=readFileSync(new URL('../public/app/index.html',import.meta.url),'utf8'),docs=readFileSync(new URL('../docs/streaming-export.md',import.meta.url),'utf8'),readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
 for(const text of [guide,html])for(const fact of ['100,000','20 MiB','five minutes'])assert.ok(text.includes(fact),fact);assert.ok(html.includes('not a snapshot'));
 for(const fact of ['including metadata','across all traces','Download account archive','before final saving or download begins','no partial total'])assert.ok(guide.includes(fact),fact);
 assert.doesNotMatch(guide,/subset of up to 800|filters and totals do not cover omitted|Cancel stops its download/);assert.doesNotMatch(readme,/This unpublished candidate|deployed ancestor’s run list/);assert.doesNotMatch(docs,/Unsupported browsers cannot start account export/);
});

test('account archive documentation warns about unredacted captured secrets and raw-batch limits',()=>{
 const docs=readFileSync(new URL('../docs/streaming-export.md',import.meta.url),'utf8');
 for(const warning of ['Account archives are not redacted','may contain captured secrets','There is no automatic secret removal','Review the complete archive before sharing','does not redact account archives','both streaming saves and standard account downloads','does not preserve original raw batch envelopes or the exact bytes of uploaded batches','does not mean captured credentials are removed'])assert.ok(docs.includes(warning),warning);
 assert.doesNotMatch(docs,/upload byte identity or secrets|(?:does not|never) export secrets|secret-free archive/i);
});


test('original export controls disclose unredacted content beside the action',()=>{
 const html=readFileSync(new URL('../public/app/index.html',import.meta.url),'utf8'),guide=readFileSync(new URL('../public/agent-setup.html',import.meta.url),'utf8');
 for(const [control,notice] of [['export','export-hint'],['export-account','account-export-note'],['download-account','account-export-note']])assert.match(html,new RegExp('id="'+control+'"[^>]*aria-describedby="'+notice+'"'));
 for(const id of ['export-hint','account-export-note']){const text=html.match(new RegExp('<p id="'+id+'"[^>]*>([^<]*)</p>'))?.[1];assert.ok(text,id);for(const fact of ['not redacted','secrets','Review'])assert.ok(text.includes(fact),id+': '+fact);}
 assert.match(guide,/Account archives are not redacted.*per-trace redacted-copy tool does not redact it/);
});

test('evergreen capability docs state the runtime boundaries',()=>{
 const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
 const architecture=read('docs/architecture.md'),signin=read('docs/sign-in.md'),commercial=read('docs/commercial-controls.md');
 for(const fact of ['No automatic redaction','not a point-in-time snapshot','does not guarantee anonymity','Stripe live mode','in-memory'])assert.ok(architecture.includes(fact),fact);
 assert.match(signin,/Supplying the client ID, secret and all three URLs would expose the scaffold mechanically/);
 assert.match(signin,/Keep these parameters empty until an approved official integration/);
 assert.doesNotMatch(signin,/When the real ones are known, set/);
 assert.match(read('aws/handler.mjs'),/stripeBilling/);
 assert.match(read('src/commercial-policy.mjs'),/enableFulfillment:false/);
 assert.doesNotMatch(commercial,/larger-account export remains unresolved|Browser export still has a 20 MiB limit/);
});


test('Claude hook beta documents explicit scope, metadata default and unverified native acceptance',()=>{
 const settings=JSON.parse(readFileSync(new URL('../public/examples/claude-hooks.settings.json',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(settings.hooks),['UserPromptSubmit','PostToolUse','Stop']);
 for(const groups of Object.values(settings.hooks))for(const group of groups)for(const hook of group.hooks){assert.equal(hook.type,'command');assert.equal(hook.timeout,12);assert.equal(hook.async,undefined);assert.match(hook.command,/claude_hook\.py.*capture --spool/);assert.doesNotMatch(hook.command,/--content|--upload-on-stop/);}
 const guide=readFileSync(new URL('../public/agent-setup.html',import.meta.url),'utf8');
 for(const phrase of ['id="claude-hooks"','metadata only','--content --allow-content','--upload-on-stop','not yet verified','not redacted','Uncertain uploads block further sends','remove only the project hook entries'])assert.ok(guide.includes(phrase),phrase);
 const doc=readFileSync(new URL('../docs/claude-hooks.md',import.meta.url),'utf8');
 for(const phrase of ['never reads `transcript_path`','not necessarily a human message','Duplicate source Stop delivery','There is deliberately no blind retry','actual installed Claude version','not standing permission','24 MiB'])assert.ok(doc.includes(phrase),phrase);
});
