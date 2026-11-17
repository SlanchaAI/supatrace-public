import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runPrivateLangfuseWorkflow} from '../src/importers/private-langfuse-runtime.mjs';

const spec = {origin:'https://cloud.langfuse.com',sourceProject:'synthetic-source',
  destinationProject:'synthetic-destination',namespace:'synthetic-private-runtime',
  from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z',
  maxRows:2,maxPages:2,pageSize:1,maxBytes:100000,maxRetries:0};
const bounds = {requestTimeoutMs:1000,totalTimeoutMs:10000,maxRequests:10,
  maxResponseBytes:100000,maxTotalBytes:200000};
const row = {id:'synthetic-one',traceId:'synthetic-trace',projectId:spec.sourceProject,
  startTime:'2026-10-01T12:00:00Z',input:{message:'synthetic payload'}};
const json = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

async function isolated(fn) {
  const root = mkdtempSync(join(tmpdir(),'supatrace-runtime-test-'));
  try { await fn(join(root,'workspace'),root); }
  finally { rmSync(root,{recursive:true,force:true}); }
}
function options(directory,extra={}) {
  return {directory,bounds,
    fetchImpl:async url => json(url.endsWith('/projects') ?
      {data:[{id:spec.sourceProject}]} : {data:[row],meta:{cursor:null}}),
    credentialProvider:async () => ({origin:spec.origin,projectId:spec.sourceProject,
      publicKey:'synthetic-public-key',secretKey:'synthetic-secret-key',expiresAt:Date.now()+60000}),
    authorize:async () => true, // Test double only, never a production authorization example.
    ...extra};
}

test('missing hooks and forbidden credential options fail before filesystem or credential access',async()=>{
  await isolated(async directory=>{
    let keys=0;
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory,{fetchImpl:undefined,
      credentialProvider:async()=>{keys++;}})),/explicit_dependencies/);
    await assert.rejects(runPrivateLangfuseWorkflow(spec,{...options(directory),secretKey:'not-accepted'}),/explicit_dependencies/);
    assert.equal(keys,0);assert.equal(existsSync(directory),false);
  });
});
test('invalid explicit fields are validated before JSON snapshotting can drop undefined',async()=>{
  await isolated(async directory=>{
    let calls=0;
    const hooks=options(directory,{fetchImpl:async()=>{calls++;},authorize:async()=>{calls++;return true;},credentialProvider:async()=>{calls++;}});
    for(const edit of [{environment:undefined},{unknown:undefined}]) {
      await assert.rejects(runPrivateLangfuseWorkflow({...spec,...edit},hooks),/invalid_spec|explicit_environment/);
    }
    assert.equal(calls,0);assert.equal(existsSync(directory),false);
  });
});

test('existing transport preflight rejects invalid bounds or origin before workspace creation',async()=>{
  await isolated(async directory=>{
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory,{bounds:{...bounds,maxRequests:0}})),/bounds/);
    await assert.rejects(runPrivateLangfuseWorkflow({...spec,origin:'https://foreign.invalid'},options(directory)),/allowlisted/);
    assert.equal(existsSync(directory),false);
  });
});

test('real private checkpoint and Python stager compose; verified local files are never hosted success',async()=>{
  await isolated(async directory=>{
    const actions=[];
    const result=await runPrivateLangfuseWorkflow(spec,options(directory,{authorize:async d=>{actions.push(d.action);return true;}}));
    assert.equal(result.outcome,'locally-staged');assert.equal(result.localFilesVerified,true);
    assert.equal(result.staged,true);assert.equal(result.uploaded,false);
    assert.equal(result.hostedReadbackVerified,false);assert.equal(result.crashDurabilityVerified,false);
    assert.equal(result.workspaceExclusion,'exclusive-lock-for-cooperating-runtimes');
    assert.equal(result.transportRequestsAttempted,2);
    assert.deepEqual(actions,['read-source','verify-source-project','read-observations','stage-destination']);
    const checkpoint=JSON.parse(readFileSync(join(directory,'checkpoint.json'),'utf8'));
    assert.equal(checkpoint.complete,true);assert.deepEqual(checkpoint.pages[0].data[0],row);
    const disk=JSON.parse(readFileSync(join(directory,'stage-receipt.json'),'utf8'));
    assert.deepEqual(result.stageReceipt,disk);assert.equal(disk.batches,1);
    assert.equal(JSON.stringify(result).includes('synthetic-secret-key'),false);
    const manifest=JSON.parse(readFileSync(join(directory,'pending/import-manifest.json'),'utf8'));
    assert.equal(manifest.count,1);assert.equal(manifest.batches.length,1);
  });
});

test('completed checkpoint resumes without transport or credential calls but reauthorizes',async()=>{
  await isolated(async directory=>{
    const first=await runPrivateLangfuseWorkflow(spec,options(directory));const actions=[];
    const second=await runPrivateLangfuseWorkflow(spec,options(directory,{
      fetchImpl:async()=>{throw Error('must not fetch');},
      credentialProvider:async()=>{throw Error('must not retrieve');},
      authorize:async d=>{actions.push(d.action);return true;}}));
    assert.equal(second.transportRequestsAttempted,0);assert.equal(second.localFilesVerified,true);
    assert.deepEqual(second.stageReceipt,first.stageReceipt);
    assert.deepEqual(actions,['read-source','stage-destination']);
  });
});

test('source or destination drift is rejected before every runtime hook',async()=>{
  await isolated(async directory=>{
    await runPrivateLangfuseWorkflow(spec,options(directory));
    let hooks=0;const never=async()=>{hooks++;throw Error('must not invoke');};
    for(const changed of [{...spec,destinationProject:'foreign'},{...spec,namespace:'foreign'}]) {
      await assert.rejects(runPrivateLangfuseWorkflow(changed,options(directory,{
        fetchImpl:never,credentialProvider:never,authorize:never})),/workspace_scope_mismatch/);
    }
    assert.equal(hooks,0);
  });
});

test('binding without checkpoint still rejects wrong destination before network',async()=>{
  await isolated(async(directory,root)=>{
    // A failed/offline stage may have written a binding before any stage receipt exists.
    const {mkdirSync}=await import('node:fs');mkdirSync(directory,{mode:0o700});
    writeFileSync(join(directory,'binding.json'),JSON.stringify({destinationProject:'foreign',fingerprint:'foreign'}),{mode:0o600});
    let calls=0;
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory,{
      fetchImpl:async()=>{calls++;}})),/workspace_scope_mismatch/);
    assert.equal(calls,0);assert.equal(existsSync(join(directory,'checkpoint.json')),false);
  });
});

test('unsafe binding cannot cause an external file read or a provider call',async()=>{
  await isolated(async(directory,root)=>{
    const {mkdirSync}=await import('node:fs');mkdirSync(directory,{mode:0o700});
    const foreign=join(root,'foreign.json');writeFileSync(foreign,'private',{mode:0o600});
    symlinkSync(foreign,join(directory,'binding.json'));
    let calls=0;
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory,{
      fetchImpl:async()=>{calls++;}})),/binding_unsafe/);
    assert.equal(calls,0);assert.equal(readFileSync(foreign,'utf8'),'private');
  });
});

test('denied staging keeps checkpoint and resume uses no wire requests',async()=>{
  await isolated(async directory=>{
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory,{
      authorize:async d=>d.action!=='stage-destination'})),/destination_approval/);
    assert.equal(existsSync(join(directory,'checkpoint.json')),true);
    assert.equal(existsSync(join(directory,'stage-receipt.json')),false);
    const result=await runPrivateLangfuseWorkflow(spec,options(directory,{
      fetchImpl:async()=>{throw Error('must not fetch');}}));
    assert.equal(result.transportRequestsAttempted,0);assert.equal(result.localFilesVerified,true);
  });
});

test('bounded-incomplete capture retains checkpoint and never stages',async()=>{
  await isolated(async directory=>{
    const result=await runPrivateLangfuseWorkflow({...spec,maxPages:1},options(directory,{
      fetchImpl:async url=>json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:
        {data:[row],meta:{cursor:'more'}})}));
    assert.equal(result.outcome,'bounded-incomplete');assert.equal(result.staged,false);
    assert.equal(result.uploaded,false);assert.equal(result.localFilesVerified,false);
    assert.equal(existsSync(join(directory,'checkpoint.json')),true);
    assert.equal(existsSync(join(directory,'pending')),false);
  });
});

test('empty capture is explicit and never labeled locally staged or live validated',async()=>{
  await isolated(async directory=>{
    const result=await runPrivateLangfuseWorkflow(spec,options(directory,{
      fetchImpl:async url=>json(url.endsWith('/projects')?{data:[{id:spec.sourceProject}]}:
        {data:[],meta:{cursor:null}})}));
    assert.equal(result.outcome,'captured-empty');assert.equal(result.staged,false);
    assert.equal(result.uploaded,false);assert.equal(result.localFilesVerified,false);
    assert.equal(existsSync(join(directory,'stage-receipt.json')),false);
  });
});

test('overlapping calls for the same workspace are denied; completed work releases the guard',async()=>{
  await isolated(async directory=>{
    let release,ready;const paused=new Promise(r=>{release=r;}),started=new Promise(r=>{ready=r;});
    const first=runPrivateLangfuseWorkflow(spec,options(directory,{
      authorize:async d=>{if(d.action==='read-source'){ready();await paused;}return true;}}));
    await started;
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory)),/already_active/);
    release();await first;
    const replay=await runPrivateLangfuseWorkflow(spec,options(directory));
    assert.equal(replay.transportRequestsAttempted,0);
  });
});

test('aliases through a symlinked parent share the same workspace exclusion',async()=>{
  await isolated(async(_directory,root)=>{
    const real=join(root,'real'),alias=join(root,'alias');mkdirSync(real,{mode:0o700});
    symlinkSync(real,alias,'dir');
    let release,ready;const paused=new Promise(r=>{release=r;}),started=new Promise(r=>{ready=r;});
    const first=runPrivateLangfuseWorkflow(spec,options(join(real,'workspace'),{
      authorize:async d=>{if(d.action==='read-source'){ready();await paused;}return true;}}));
    await started;
    try { await assert.rejects(runPrivateLangfuseWorkflow(spec,options(join(alias,'workspace'))),/already_active/); }
    finally { release();await first; }
  });
});

test('FIFO binding is rejected without blocking the runtime',async t=>{
  await isolated(async directory=>{
    const {spawnSync}=await import('node:child_process');mkdirSync(directory,{mode:0o700});
    const fifo=spawnSync('mkfifo',[join(directory,'binding.json')]);
    if(fifo.error?.code==='ENOENT'){t.skip('mkfifo not available');return;}
    assert.equal(fifo.status,0);
    const url=new URL('../src/importers/private-langfuse-runtime.mjs',import.meta.url).href;
    const code=`import {runPrivateLangfuseWorkflow} from ${JSON.stringify(url)};
      const never=async()=>{throw Error('hook must not run')};
      try {await runPrivateLangfuseWorkflow(${JSON.stringify(spec)},
        {directory:${JSON.stringify(directory)},bounds:${JSON.stringify(bounds)},
         authorize:never,credentialProvider:never,fetchImpl:never});process.exitCode=2;}
      catch(e){if(e.message!=='private_runtime_binding_unsafe')process.exitCode=3;}`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:2000,encoding:'utf8'});
    assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
  });
});

test('staging timeout retains workspace exclusion until the child really closes',async()=>{
  await isolated(async directory=>{
    const childProcess=(await import('node:child_process')).default;
    const {syncBuiltinESMExports}=await import('node:module');
    const {EventEmitter}=await import('node:events');
    const original=childProcess.spawn;let ready,closed=false;
    const started=new Promise(r=>{ready=r;});
    childProcess.spawn=()=>{
      const child=new EventEmitter();
      child.kill=()=>{setTimeout(()=>{closed=true;child.emit('close',null);},80);return true;};
      ready();return child;
    };
    syncBuiltinESMExports();
    let first;
    try {
      first=runPrivateLangfuseWorkflow(spec,options(directory,{
        bounds:{...bounds,requestTimeoutMs:20,totalTimeoutMs:1000}}));
      const observed=first.then(()=>({ok:true}),error=>({error}));
      await started;
      await new Promise(r=>setTimeout(r,40));
      assert.equal(closed,false);
      await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory)),/already_active/);
      const result=await observed;
      assert.match(result.error?.message??'',/local_stage_outcome_unverified/);
      assert.equal(closed,true);
    } finally {
      if(first)await first.catch(()=>{});
      childProcess.spawn=original;syncBuiltinESMExports();
    }
  });
});

test('stale cross-process lock blocks before runtime hooks and is never taken over',async()=>{
  await isolated(async directory=>{
    mkdirSync(directory,{mode:0o700});
    const path=join(directory,'.live-import.lock');writeFileSync(path,'stale',{mode:0o600});
    let calls=0;const never=async()=>{calls++;throw Error('must not invoke');};
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory,{
      authorize:never,credentialProvider:never,fetchImpl:never})),/workspace_locked_reconciliation/);
    assert.equal(calls,0);assert.equal(readFileSync(path,'utf8'),'stale');
  });
});

test('second process cannot acquire a workspace held by this runtime',async()=>{
  await isolated(async directory=>{
    let release,ready;const paused=new Promise(r=>{release=r;}),started=new Promise(r=>{ready=r;});
    const first=runPrivateLangfuseWorkflow(spec,options(directory,{
      authorize:async d=>{if(d.action==='read-source'){ready();await paused;}return true;}}));
    await started;
    try {
      const {spawnSync}=await import('node:child_process');
      const url=new URL('../src/importers/private-langfuse-runtime.mjs',import.meta.url).href;
      const code=`import {runPrivateLangfuseWorkflow} from ${JSON.stringify(url)};
        const never=async()=>{throw Error('hook must not run')};
        try{await runPrivateLangfuseWorkflow(${JSON.stringify(spec)},
          {directory:${JSON.stringify(directory)},bounds:${JSON.stringify(bounds)},
          authorize:never,credentialProvider:never,fetchImpl:never});process.exitCode=2;}
        catch(e){if(e.message!=='private_runtime_workspace_locked_reconciliation_required')process.exitCode=3;}`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',code],{timeout:2000,encoding:'utf8'});
      assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);
    } finally {release();await first;}
    assert.equal(existsSync(join(directory,'.live-import.lock')),false);
  });
});

test('release errors preserve a replaced lock but do not leak the in-process guard',async()=>{
  await isolated(async directory=>{
    const lock=join(directory,'.live-import.lock');
    await assert.rejects(runPrivateLangfuseWorkflow(spec,options(directory,{
      authorize:async descriptor=>{
        if(descriptor.action==='read-source'){
          rmSync(lock);writeFileSync(lock,'replacement-test-lock',{mode:0o600});
        }
        return true;
      }})),/lock_reconciliation_required/);
    assert.equal(readFileSync(lock,'utf8'),'replacement-test-lock');
    // Explicit test-owner reconciliation, never automatic runtime takeover.
    rmSync(lock);
    const replay=await runPrivateLangfuseWorkflow(spec,options(directory));
    assert.equal(replay.outcome,'locally-staged');assert.equal(replay.transportRequestsAttempted,0);
  });
});
