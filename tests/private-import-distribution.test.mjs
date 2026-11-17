import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,rmSync,readFileSync,appendFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
// The distribution check refuses extracted files that group or others can write, so the package is not extracted under
// the machine's umask (0002 would fail it) (#155). The child processes inherit this.
process.umask(0o022);
import {planCustomerImport} from '../src/import-planning.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {privateHostFixture} from './private-host-fixture.mjs';
import {privateLauncherFixture} from './private-launcher-fixture.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
test('full pinned private package runs actual Node/Python job after extraction and refuses tampering',async()=>{
 const temp=mkdtempSync(join(realpathSync(tmpdir()),'private-dist-')),archive=join(temp,'private-host.zip'),directory=join(temp,'extracted');mkdirSync(directory,{mode:0o700});
 const f=await privateHostFixture();
 f.plan.traceId='synthetic-trace';f.submit.fingerprint=planCustomerImport(f.plan,alphaProject(f.submit.tenant).id).plan.fingerprint;const broker=f.options.sourceBroker;f.options.sourceBroker=async request=>{assert.equal(request.request.traceId,f.plan.traceId);return{...await broker(request),traceId:f.plan.traceId};};
 try{
  const receipt=JSON.parse(execFileSync('python3',['scripts/package-private-import.py','--output',archive],{cwd:root,encoding:'utf8',timeout:60000}));
  execFileSync('python3',['-c','import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',archive,directory],{timeout:30000});
  const manifest=JSON.parse(readFileSync(join(directory,'private-host-manifest.json')));for(const path of ['scripts/hosted_upload_worker.py','agent/private_upload_runtime.py','agent/upload.py','agent/stage_import.py','src/private-import-host.mjs','src/private-import-launcher.mjs','src/hosted-import-export.mjs'])assert.ok(manifest.files.some(f=>f.path===path),path);assert.ok(manifest.dependency_inventory.every(p=>!p.path.includes('playwright')));assert.equal(manifest.source_fields,'core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context');
  const entry=await import(pathToFileURL(join(directory,'src/private-import-distribution.mjs'))),distribution={directory,manifestHash:receipt.manifest_sha256,archivePath:archive,archiveHash:receipt.archive_sha256,revision:receipt.source_revision};
  assert.equal(entry.verifyPrivateImportDistribution(distribution).revision,receipt.source_revision);
  f.runtime.artifact_hash=f.descriptor.artifact_hash=receipt.archive_sha256;f.runtime.revision=f.descriptor.revision=receipt.source_revision;
  const host=entry.loadPrivateImportHost({distribution,hostOptions:f.options}),original={...distribution};Object.assign(distribution,{directory:join(temp,'wrong-distribution'),archiveHash:'0'.repeat(64),manifestHash:'0'.repeat(64)});const job=await host.submit(f.submit),result=await host.runOne('github-4242',job.job_id);Object.assign(distribution,original);assert.equal(result.receipt.export_verified,true);assert.equal(JSON.parse(readFileSync(result.exportPath)).runs[0].events[0].data.observation.traceId,f.plan.traceId);assert.deepEqual(f.counts(),{sourceRequests:2,destinationRequests:1,leases:1});
  const g=await privateLauncherFixture();try{
   g.runtime.artifact_hash=g.descriptor.artifact_hash=receipt.archive_sha256;g.runtime.revision=g.descriptor.revision=receipt.source_revision;
   const auth=await import(pathToFileURL(join(directory,'src/private-import-auth.mjs')));g.options.authenticate=auth.createPrivateImportAuthenticator({store:g.store,origin:g.descriptor.destination_origin});
   const request=new Request(g.descriptor.destination_origin+'/private-import-control',{method:'POST',headers:{origin:g.descriptor.destination_origin,cookie:'__Host-supatrace='+g.token}});
   const input=g.bind(),launcher=entry.loadPrivateImportLauncher({distribution,launcherOptions:g.options}),queued=await launcher.queue(request,input),target={approval_id:input.approval_id,job_id:queued.job_id};
   assert.equal((await launcher.runOne(request,target)).receipt.export_verified,true);
   const archive=JSON.parse(await launcher.download(request,target));assert.equal(archive.event_count,2);assert.ok(archive.runs[0].events.every(e=>e.data.observation.traceId==='synthetic-trace'));
   assert.deepEqual(g.counts(),{sourceRequests:2,destinationRequests:2,leases:2});
  }finally{g.close();}
  const w=await privateLauncherFixture();try{
   w.runtime.artifact_hash=w.descriptor.artifact_hash=receipt.archive_sha256;w.runtime.revision=w.descriptor.revision=receipt.source_revision;
   const imported=path=>import(pathToFileURL(join(directory,path)));
   const [{createPrivateImportConsentStore},{createImportStartController},{handle}]=await Promise.all([imported('src/private-import-consent.mjs'),imported('src/import-start.mjs'),imported('src/aws-api.mjs')]);
   const input=w.bind(),record=w.approvals.get(input.approval_id),origin=w.descriptor.destination_origin;
   const request=()=>new Request(origin+'/api/imports/start',{method:'POST',headers:{origin,cookie:'__Host-supatrace='+w.token,'content-type':'application/json'},body:JSON.stringify({fingerprint:input.fingerprint})});
   const consents=createPrivateImportConsentStore({store:w.store,objects:w.objects,origin,runtime:w.runtime,authorize:async d=>d.action==='record-reviewed-private-import-consent'&&d.approval_id===input.approval_id});
   const {authenticate,...options}=w.options,assignmentActions=new Set(['consume-private-import-assignment','complete-private-import-assignment','release-private-import-assignment']);
   const workerOptions={...options,approvalProvider:consents.provide,authorize:async d=>assignmentActions.has(d.descriptor.action)?d.approval_id===input.approval_id:options.authorize(d)};
   const worker=entry.loadPrivateImportWorker({distribution,workerOptions});
   const controller=createImportStartController({store:w.store,objects:w.objects,origin,runtime:w.runtime,consents,authorize:workerOptions.authorize,readiness:async()=>true});
   await consents.registerReviewedApproval(request(),record);
   const response=await handle(request(),{ENABLED:true,APP_ORIGIN:origin,GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store:w.store,objects:w.objects,importStartController:controller});
   assert.equal(response.status,202);const job=await response.json();assert.equal(job.execution_started,false);assert.equal(job.assignment_state,'pending');
   const slot=()=>[...w.client.items.values()].find(r=>r.sk==='SLOT'),helper=join(directory,'scripts/hosted_upload_worker.py'),bytes=readFileSync(helper);
   appendFileSync(helper,'\n# synthetic tamper before consume\n');await assert.rejects(worker.runNext());assert.equal(slot().state,'pending');assert.deepEqual(w.counts(),{sourceRequests:0,destinationRequests:0,leases:0});writeFileSync(helper,bytes);
   assert.equal((await worker.runNext()).receipt.matched_events,2);assert.equal(slot().state,'complete');const counts=w.counts();
   appendFileSync(helper,'\n# synthetic tamper before release\n');await assert.rejects(worker.releaseCompleted());assert.equal(slot().state,'complete');assert.deepEqual(w.counts(),counts);writeFileSync(helper,bytes);
   assert.equal((await worker.releaseCompleted()).assignment_state,'released');assert.equal((await worker.runNext()).outcome,'idle');assert.deepEqual(w.counts(),counts);
  }finally{w.close();}
  assert.throws(()=>entry.verifyPrivateImportDistribution({...distribution,archiveHash:'0'.repeat(64)}),/unverified/);assert.throws(()=>entry.verifyPrivateImportDistribution({...distribution,manifestHash:'0'.repeat(64)}),/unverified/);assert.throws(()=>entry.verifyPrivateImportDistribution({...distribution,revision:'0'.repeat(40)}),/unverified/);
  const extra=join(directory,'unexpected.env');writeFileSync(extra,'synthetic only');assert.throws(()=>entry.verifyPrivateImportDistribution(distribution),/unverified/);rmSync(extra);
  symlinkSync(join(directory,'package.json'),extra);assert.throws(()=>entry.verifyPrivateImportDistribution(distribution),/unverified/);rmSync(extra);
  appendFileSync(join(directory,'scripts/hosted_upload_worker.py'),'\n# changed\n');assert.throws(()=>entry.verifyPrivateImportDistribution(distribution),/unverified/);
 }finally{f.close();rmSync(temp,{recursive:true,force:true});}
});
