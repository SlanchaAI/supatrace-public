import test from 'node:test';
import assert from 'node:assert/strict';
import {start} from './harness.mjs';
import {configureLocalBilling} from '../scripts/local-billing.mjs';
import {seedLocalWorkspace} from '../scripts/dev.mjs';
test('local SDK composition completes signed captured events and isolated worker reconciliation',async()=>{
 let billing;const live=await start({localDev:true,configureEnvironment:async env=>{billing=env.localBilling=await configureLocalBilling(env);}});
 try{
  await seedLocalWorkspace(live);let cookies;await live.signIn({addCookies:async v=>{cookies=v.map(c=>c.name+'='+c.value).join('; ');}},4242);
  const before=await live.store.getTenant('github-4242'),response=await fetch(live.origin+'/api/billing/checkout',{method:'POST',headers:{cookie:cookies,origin:live.origin,'content-type':'application/json'},body:JSON.stringify({plan_id:'synthetic-paid',policy_version:'synthetic-v1',request_id:'checkout_test_1234567890abcdef'})});assert.equal(response.status,201,await response.clone().text());const session=await response.json();
  assert.equal(session.local_simulation,true);await billing.complete(session.session_id,'github-4242');
  const read=await fetch(live.origin+'/api/billing/sandbox-entitlement',{headers:{cookie:cookies}});assert.equal(read.status,200,await read.clone().text());const data=await read.json();assert.equal(data.status,'active');assert.equal(data.paid_access,false);assert.equal(data.quota_enforced,false);const ledgerBefore=await billing.workerEnvironment.store.getStripeSandboxEntitlement('github-4242'),callsBefore=billing.calls.length;assert.deepEqual(await billing.replayCaptured('evt_checkout'+session.session_id.slice(8)),{batchItemFailures:[]});assert.equal(billing.calls.length,callsBefore);assert.deepEqual(await billing.workerEnvironment.store.getStripeSandboxEntitlement('github-4242'),ledgerBefore);const calls=billing.calls.length;assert.equal((await billing.complete(session.session_id,'github-4242')).replayed,true);assert.equal(billing.calls.length,calls);assert.deepEqual(await live.store.getTenant('github-4242'),before);
  await assert.rejects(billing.emit('evt_risksynthetic','charge.refunded',{object:'charge',id:'ch_missing',customer:'cus_localowner',livemode:false,refunded:true}),/Synthetic stream reconciliation failed/);
  const risk=await(await fetch(live.origin+'/api/billing/sandbox-entitlement',{headers:{cookie:cookies}})).json();assert.equal(risk.status,'blocked');assert.equal(risk.reason,'sandbox_risk_review_required');
  assert.deepEqual(await billing.replayCaptured('evt_checkout'+session.session_id.slice(8)),{batchItemFailures:[]});assert.equal((await billing.workerEnvironment.store.getStripeSandboxEntitlement('github-4242')).reason,'sandbox_risk_review_required');assert.deepEqual(await live.store.getTenant('github-4242'),before);
 }finally{await live.close();}
});
