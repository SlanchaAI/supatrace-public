import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {profileWorkload,validateWorkload} from '../scripts/profile-workload.mjs';
import {estimateWorkloadCost,contributionScenario,rates} from '../scripts/workload-cost.mjs';
const batch=(n=1)=>({version:1,batch_id:'batch'+n,run_id:'run'+Math.floor(n/2),events:[{id:'event'+n,time:'2026-10-21T00:00:00Z',kind:'note',name:'Synthetic economics test',data:{safe:true,text:'PRIVATE_PAYLOAD_SENTINEL'}}]});
const assumptions={billedMs:100,ingestedLogBytesPerRequest:1024,storedLogBytesPerRequest:512,storageMonths:1,secretReads:1};
let shared;const profile=()=>shared??=profileWorkload([batch()]);

test('actual handler reserve/accept/export/recovery counts retain safe offline boundaries',async()=>{
 const input=[batch()],copy=structuredClone(input),p=await profileWorkload(input);
 assert.deepEqual(input,copy);assert.equal(p.network_calls,0);assert.equal(p.measured_aws_billed_duration,false);
 assert.equal(p.representative_customer_day,false);assert.equal(p.scenario.accepted_batches,1);
 assert.equal(p.measured.objects,2);assert.equal(p.measured.archive_events,2);assert.equal(p.measured.archive_runs,2);
 assert.equal(p.measured.reserved_bytes,p.measured.payload_bytes);assert.ok(p.measured.archive_bytes>0);
 assert.equal(p.phases.ingest.dynamo_commands.TransactWriteCommand,2);
 // 20 for reserve and accept; +2 because the monthly counter row joins the reservation transaction; +2 for the accepted
 // counters in the accept transaction; +2 for the hourly
 // last-use stamp on the key's lookup and list rows (#105), written at most once per key per hour, so it does not
 // grow with batches. +1 RRU per new batch: the plan is read from the account row.
 // +1 RRU per ingest request: verify the key owner is not closed.
 // +1 WRU per ingest request: the ingest-log row (#88), a plain Put outside any transaction.
 assert.equal(p.phases.ingest.dynamo_commands.UpdateCommand,2);assert.equal(p.phases.ingest.estimated_wrus,27);assert.equal(p.phases.ingest.estimated_rrus,9); // Per new batch: +2 WRU for the monthly counter row in the reservation transaction, +2 WRU for the accepted counters in the accept transaction, +1 RRU for the plan on the account row, +1 RRU for the month's usage row (alert level and an exact allowance check). +1 RRU per ingest request: one query for the workspace's trace drains.
 assert.equal(p.phases.duplicate.http_statuses['201'],1);assert.deepEqual(p.phases.duplicate.s3_commands,{});
 assert.equal(p.phases.conflict.http_statuses['409'],1);assert.deepEqual(p.phases.conflict.s3_commands,{});
 assert.equal(p.phases.hash_rejection.http_statuses['400'],1);assert.deepEqual(p.phases.hash_rejection.s3_commands,{});
 assert.equal(p.phases.failed_upload.http_statuses['503'],1);assert.equal(p.phases.failed_upload.s3_write_bytes,0);
 assert.equal(p.phases.recovery_retry.http_statuses['201'],1);assert.equal(p.phases.export.s3_commands.GetObjectCommand,2);
 assert.equal(p.phases.setup.dynamo_item_actions.transaction_conditioncheck,2);
 assert.equal(p.phases.setup.estimated_wrus,22); // Includes transaction ConditionChecks, not RRUs.
 assert.equal(JSON.stringify(p).includes('PRIVATE_PAYLOAD_SENTINEL'),false);
 assert.equal(JSON.stringify(p).includes('event1'),false);
});
test('copies preserve distinct traces and repeated event content; recovery can be excluded',async()=>{
 const p=await profileWorkload([batch(1),batch(2)],{copies:3,exerciseRecovery:false});
 assert.equal(p.scenario.accepted_batches,6);assert.equal(p.measured.objects,6);assert.equal(p.measured.archive_events,6);
 assert.equal(p.measured.archive_runs,6);assert.equal(p.phases.duplicate,undefined);
});
test('unpaced burst records real rate rejection and failed-write charges, not fabricated acceptance',async()=>{
 const p=await profileWorkload(Array.from({length:80},(_,i)=>batch(i)),{spacingSeconds:0,exerciseRecovery:false});
 assert.equal(p.scenario.accepted_batches,30);assert.equal(p.scenario.rejected_batches,50);
 assert.equal(p.phases.ingest.http_statuses['429'],50);assert.equal(p.measured.objects,30);assert.equal(p.measured.archive_events,30);
 assert.ok(p.phases.ingest.dynamo_failures.PutCommand>0);assert.ok(p.phases.ingest.dynamo_failures.UpdateCommand>0);
 assert.ok(p.phases.ingest.estimated_wrus>30*16); // Rejections and failed conditions are not free.
});
test('input and scenario bounds fail before a success report',async()=>{
 for(const v of [[],null,[batch(),batch()],Array(1001).fill(batch())])assert.throws(()=>validateWorkload(v));
 assert.throws(()=>validateWorkload([{...batch(),events:[{...batch().events[0],data:'x'.repeat(32769)}]}]));
 for(const options of [{copies:0},{copies:11},{copies:1.5},{spacingSeconds:-1},{spacingSeconds:61}])await assert.rejects(profileWorkload([batch()],options));
});
test('provider fetch is never needed or attempted',async()=>{
 const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('unexpected_network');};
 try{assert.equal((await profileWorkload([batch()],{exerciseRecovery:false})).network_calls,0);}finally{globalThis.fetch=old;}
});
test('CLI creates a private aggregate only and never overwrites existing output',()=>{
 const dir=mkdtempSync(join(tmpdir(),'supatrace-economics-'));try{
  const input=join(dir,'input.json'),output=join(dir,'result.json');writeFileSync(input,JSON.stringify([batch()]));
  const args=['scripts/profile-workload.mjs',input,output],r=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(statSync(output).mode&0o777,0o600);
  const bytes=readFileSync(output,'utf8');assert.equal((bytes+r.stdout+r.stderr).includes('PRIVATE_PAYLOAD_SENTINEL'),false);
  assert.equal(spawnSync(process.execPath,args,{encoding:'utf8'}).status,1);assert.equal(readFileSync(output,'utf8'),bytes);
  writeFileSync(input,'PRIVATE_PAYLOAD_SENTINEL');const bad=spawnSync(process.execPath,['scripts/profile-workload.mjs',input,join(dir,'bad.json')],{encoding:'utf8'});
  assert.equal(bad.status,1);assert.equal((bad.stdout+bad.stderr).includes('PRIVATE_PAYLOAD_SENTINEL'),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('cost model uses transaction item units and includes ingress/functions separately',async()=>{
 const p=await profile(),c=estimateWorkloadCost(p,assumptions);
 assert.equal(c.components.dynamodb_writes,c.units.wrus*0.625/1e6);
 assert.equal(c.components.cloudfront_functions,c.units.requests*0.1/1e6);
 assert.equal(c.components.cloudfront_origin_upload,c.units.upload_bytes/(2**30)*0.02);
 assert.equal(c.components.lambda_compute_assumed,c.units.requests*0.1*0.25*0.0000166667);
 assert.equal(c.components.s3_puts,3*0.005/1000); // The failed PUT attempt remains counted.
 assert.equal(c.components.s3_gets,2*0.0004/1000);
 assert.equal(c.total_usd,Object.values(c.components).reduce((a,b)=>a+b,0));
 assert.equal(c.includes_full_login_or_support,false);
});
test('unknown billed duration is required and local elapsed time cannot silently set it',async()=>{
 const p=await profile();assert.throws(()=>estimateWorkloadCost(p,{}));
 assert.throws(()=>estimateWorkloadCost(p,{...assumptions,billedMs:NaN}));
 const a=estimateWorkloadCost(p,assumptions);p.measured.ingest_local_elapsed_ms=1e9;
 const b=estimateWorkloadCost(p,assumptions);assert.equal(a.total_usd,b.total_usd);
 assert.ok(estimateWorkloadCost(p,{...assumptions,billedMs:1000}).total_usd>a.total_usd);
 assert.ok(estimateWorkloadCost(p,{...assumptions,storageMonths:12}).total_usd>a.total_usd);
});
test('margin sensitivity accounts for support and fees without activating or promising a tier',()=>{
 const input={workloadCostUsd:0.01,workloadsPerMonth:30,revenueUsd:9,supportMinutes:10,supportHourlyUsd:60,sharedInfraUsd:0.01,authUsd:0.01,paymentCount:1,billingVolumeUsd:9};
 const c=contributionScenario(input);assert.equal(c.costs.support,10);assert.equal(c.costs.payments,9*0.029+0.3);assert.equal(c.costs.billing,9*0.007);
 assert.ok(c.contribution_usd<0);assert.equal(c.not_net_profit,true);assert.equal(c.hypothetical_price_not_approved,true);
 assert.equal(contributionScenario({...input,revenueUsd:0,billingVolumeUsd:0}).contribution_percent,null);
 assert.throws(()=>contributionScenario({...input,supportMinutes:undefined}));assert.throws(()=>contributionScenario({...input,authUsd:-1}));
 assert.equal(rates.dynamodb_wru_per_million,0.625);
});

test('conflict probe stays distinct when source already uses its sentinel name',async()=>{
 const b=batch();b.events[0].name='Synthetic conflicting event';const p=await profileWorkload([b]);
 assert.equal(p.phases.conflict.http_statuses['409'],1);
});

test('near-quota recovery is classified and never bypasses alpha storage limits',async()=>{
 const input=Array.from({length:21},(_,i)=>({...batch(i),events:Array.from({length:16},(_,j)=>({...batch(i).events[0],id:'event'+j,data:'x'.repeat(32000)}))}));
 const p=await profileWorkload(input);assert.equal(p.scenario.accepted_batches,20);assert.equal(p.scenario.rejected_batches,1);
 assert.equal(p.scenario.ingest_rejections.storage_capacity,1);assert.equal(p.scenario.recovery_upload,'not_exercised_storage_capacity');
 assert.equal(p.phases.failed_upload.http_statuses['429'],1);assert.deepEqual(p.phases.failed_upload.s3_commands,{});assert.equal(p.phases.recovery_retry,undefined);
 assert.equal(p.measured.archive_events,320);assert.equal(p.measured.objects,20);assert.ok(p.measured.reserved_bytes<=10*1024*1024);
});
test('committed baseline cost and contribution cases recompute from their explicit inputs',()=>{
 const baseline=JSON.parse(readFileSync(new URL('../tests/fixtures/economics/workloads.json',import.meta.url),'utf8'));
 assert.equal(baseline.scenario_names_are_hypothetical,true);
 for(const [name,cases]of Object.entries(baseline.costs))for(const expected of Object.values(cases))assert.deepEqual(estimateWorkloadCost(baseline.reports[name],expected.assumptions),expected);
 for(const {inputs,result}of baseline.margins)assert.deepEqual(contributionScenario(inputs),result);
 for(const report of Object.values(baseline.reports)){
  assert.equal(report.representative_customer_day,false);assert.equal(report.network_calls,0);assert.equal(report.measured_aws_billed_duration,false);
  assert.equal(report.scenario.recovery_upload,'failed_then_accepted_without_double_reservation');
 }
});
