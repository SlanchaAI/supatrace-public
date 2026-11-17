import {validateUsage} from '../public/app/usage-data.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {accountPlanConfiguration, PLAN_CATALOG} from '../src/plans.mjs';
import {readFileSync} from 'node:fs';
// Runs the plan-allowance suite inside `npm test` through this registered file. The one-line test list in
// package.json conflicts with every concurrent PR that adds a test, so new suites here are imported instead.
import './plan-allowance.test.mjs';
import './retention.test.mjs';
import './usage-metering.test.mjs';
import './spend-cap.test.mjs';
import './test-mode-upgrade.test.mjs';
import './project-pause.test.mjs';

const token = 'c'.repeat(43);
function env(row, tenantId = 'github-9') {
  return {
    ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic',
    store: {
      consumeRate: async () => ({allowed: true}),
      getSession: async hash => hash === digest(token) ? {tenant_id: tenantId} : null,
      getTenant: async () => row
    },
    objects: {}
  };
}
const me = () => new Request('https://supatrace.dev/api/usage', {headers: {cookie: '__Host-supatrace=' + token}});

test('inherited setup guide agrees on team scope, cumulative quota and safe pending-config recovery',()=>{
 const guide=readFileSync(new URL('../public/agent-setup.html',import.meta.url),'utf8');
 assert.match(guide,/Organizations support multiple isolated projects within plan limits/);assert.match(guide,/Owners invite existing accounts and assign plan-enabled roles and environment scopes/);
 assert.match(guide,/shared across its environments and including accepted and pending uploads/);
 assert.match(guide,/Keep the selected pending config private and unchanged; use a different config path for a new setup/);
 assert.match(guide,/Approved configs are not silently replaced/);
 assert.match(guide,/scheduled retention worker removes their payload versions/);
 assert.doesNotMatch(guide,/One project per account\. No teams|Delete.*pending config/i);
});

test('usage reports this account ceiling and does not offer a paid plan', async () => {
  const response = await handle(me(), env({used_bytes: 100, byte_limit: 10485760, project_id: undefined}));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(validateUsage(body).storage.used_bytes, 100);
  assert.equal(body.storage.used_bytes, 100);
  assert.equal(body.storage.limit_bytes, 10485760);
  assert.equal(body.storage.remaining_bytes, 10485760 - 100);
  assert.equal(body.account_plan.paid_activation_enabled, false);
  assert.equal(body.plan_configuration.target_allowances_active, false);
});

test('usage stays unavailable when the account counters are missing', async () => {
  assert.equal((await handle(me(), env(null))).status, 503);
  assert.equal((await handle(me(), env({used_bytes: -1, byte_limit: 10}))).status, 503);
});

test('alpha plan scope follows the authenticated provider, never row or query hints', async () => {
  for (const provider of ['github', 'google', 'email', 'sso', 'chatgpt']) {
    const tenantId = provider === 'github' ? 'github-9' : provider + '-' + 'ab'.repeat(32);
    const project = alphaProject(tenantId);
    const configuration = env({used_bytes: 37, byte_limit: 100, provider: 'untrusted', account_plan: {scope: 'github_account'}}, tenantId);
    const request = new Request('https://supatrace.dev/api/usage?project=' + project.id + '&provider=github&scope=github_account', {headers: me().headers});
    const response = await handle(request, configuration);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.account_plan.scope, project.accounting_scope);
    assert.equal(body.account_plan.scope, provider + '_account');
    assert.equal(body.storage.used_bytes, 37);
    assert.equal(body.storage.remaining_bytes, 63);
    assert.equal(body.storage.accounting, 'cumulative_reserved_bytes');
    assert.equal(body.account_plan.paid_active, false);
    assert.equal(body.account_plan.paid_activation_enabled, false);
    assert.equal(body.plan_configuration.target_allowances_active, false);
    const other = new Request('https://supatrace.dev/api/usage?project=' + alphaProject('github-10').id, {headers: me().headers});
    assert.equal((await handle(other, configuration)).status, 403);
  }
});

test('alpha plan projection fails closed without a valid authenticated tenant or reviewed catalog', () => {
  for (const tenant of [undefined, null, '', 'google-fake', 'github-0', 'unknown-' + 'ab'.repeat(32)]) {
    assert.throws(() => accountPlanConfiguration(undefined, tenant), error => error.code === 'invalid_tenant');
  }
  assert.throws(() => accountPlanConfiguration({...PLAN_CATALOG, paid_activation_enabled: true}, 'github-9'), error => error.code === 'plan_not_configured');
});

test('manual uploader classifies actual API rejections without claiming reservations were freed',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{execFileSync}=await import('node:child_process'),{alphaProject}=await import('../src/alpha-projects.mjs');
 const dir=mkdtempSync(join(tmpdir(),'supatrace-upload-recovery-')),project=alphaProject('github-1').id,key='a'.repeat(43);
 const raw=JSON.stringify({version:1,batch_id:'recovery1',run_id:'run1',events:[{id:'event1',time:'2026-10-21T00:00:00Z',kind:'note',name:'Synthetic recovery',data:{safe:true}}]});
 const cases=[['rate','rate_limit'],['storage_before','capacity_or_account_state'],['storage_after','capacity_or_account_state'],['key','write_key'],['project','project'],['conflict','identity_conflict'],['commercial','account_access']];
 const receipts=[];
 try{
  for(const [scenario,reason]of cases){
   let reserved=0,objects=0;
   const store={getTenant:async tenant_id=>({tenant_id}),consumeRate:async()=>({allowed:scenario!=='rate',retry_after:60}),lookupWriteKey:async()=>scenario==='key'?null:{tenant_id:'github-1',project_id:project},
    reserveBatch:async(t,b)=>{if(scenario==='storage_before')throw{status:429,code:'storage_capacity_or_unknown_tenant'};if(scenario==='conflict')throw{status:409,code:'idempotency_conflict'};if(scenario==='commercial')throw{status:403,code:'commercial_upload_blocked'};reserved=b.byte_count;return{...b,status:'pending',object_key:'synthetic'};},
    acceptReservedBatch:async()=>{if(scenario==='storage_after')throw{status:429,code:'storage_capacity_or_unknown_tenant'};}};
   const configuration={ENABLED:true,APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects:{putImmutable:async()=>{objects++;}}};
   const response=await handle(new Request('https://supatrace.dev/api/batches?project='+(scenario==='project'?'proj_'+'f'.repeat(32):project),{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':digest(raw)},body:raw}),configuration);
   receipts.push({status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers),reason});
   if(scenario==='storage_after'){assert.equal(objects,1);assert.equal(reserved,Buffer.byteLength(raw));}else{assert.equal(objects,0);assert.equal(reserved,0);}
  }
  writeFileSync(join(dir,'cases.json'),JSON.stringify(receipts));writeFileSync(join(dir,'batch.json'),raw);
  const script=String.raw`import sys,pathlib,json
sys.path.insert(0,'agent');import upload
root=pathlib.Path(sys.argv[1]);results=[]
for case in json.loads((root/'cases.json').read_text()):
 path=upload.stage(root/'batch.json',root/'spool');before=path.read_bytes();calls=[]
 class Reply:
  status=case['status'];headers=case['headers']
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def read(self,n):return case['body'].encode()[:n]
 def transport(*args,**kwargs):calls.append(1);return Reply()
 result=upload.upload_pending_result(path,'https://supatrace.dev/api/batches','synthetic',transport=transport)
 results.append({'reason':result['reason'],'accepted':result['accepted'],'calls':len(calls),'retained':path.read_bytes()==before,'message':upload.upload_result_message(result)})
print(json.dumps(results))`;
  const results=JSON.parse(execFileSync('python3',['-c',script,dir],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
  assert.deepEqual(results.map(r=>r.reason),cases.map(c=>c[1]));
  for(const r of results){assert.equal(r.accepted,false);assert.equal(r.calls,1);assert.equal(r.retained,true);assert.match(r.message,/reservations may still consume quota/);assert.doesNotMatch(r.message,/nothing stored|quota freed|capacity restored/);}
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('setup guide aligns first-upload recovery with cumulative usage limits',async()=>{
 const {readFileSync}=await import('node:fs');const guide=readFileSync(new URL('../public/agent-setup.html',import.meta.url),'utf8');
 assert.match(guide,/capacity or key failures require review/);assert.match(guide,/batch\/hash\/project reconciliation/);
 assert.match(guide,/Server reservations may remain/);assert.match(guide,/does not reset monthly/);
 assert.doesNotMatch(guide,/A failed or ambiguous response leaves it pending; rerun with the same unchanged file to retry/);
});
