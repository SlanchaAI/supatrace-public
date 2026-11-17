import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,lstatSync,statfsSync,copyFileSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
// The distribution check refuses extracted files that group or others can write, so the package is not extracted under
// the machine's umask (0002 would fail it) (#155). The child processes inherit this.
process.umask(0o022);
import {createHash} from 'node:crypto';
import {selectLinuxMount} from '../src/private-host-readiness.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
test('private ZIP owns a network-disabled synthetic lifecycle command with exact pins and no workspace replay',{timeout:60000},async t=>{
 const temporary=mkdtempSync(join(realpathSync(tmpdir()),'private-synthetic-')),archive=join(temporary,'host.zip'),directory=join(temporary,'code');mkdirSync(directory,{mode:0o700});
 try{
  const pins=JSON.parse(execFileSync('python3',['scripts/package-private-import.py','--output',archive],{cwd:root,encoding:'utf8',timeout:30000}));
  execFileSync('python3',['-c','import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',archive,directory],{timeout:30000});
  const manifest=JSON.parse(readFileSync(join(directory,'private-host-manifest.json')));assert.equal(manifest.synthetic_entrypoint,'scripts/private-host-synthetic.mjs');assert.ok(manifest.files.some(f=>f.path==='tests/memory-dynamo.mjs'));assert.ok(!manifest.files.some(f=>f.path==='tests/harness.mjs'||f.path==='scripts/dev.mjs'));
  let python=realpathSync(execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim());
  if(process.platform==='linux'){const prefix=execFileSync(python,['-I','-B','-c','import sys;print(sys.base_prefix)'],{encoding:'utf8'}).trim(),runtime=join(temporary,'python-runtime');mkdirSync(runtime,{mode:0o700});mkdirSync(join(runtime,'bin'),{mode:0o700});const original=python;python=join(runtime,'bin','python3.12');copyFileSync(original,python);chmodSync(python,0o500);symlinkSync(join(prefix,'lib'),join(runtime,'lib'),'dir');t.diagnostic('Linux uses a private interpreter fixture; original group/world writable: '+Boolean(lstatSync(original).mode&0o022));}
  const workspace=join(temporary,'work');
  // The test process and every Node child are denied socket connections, not merely mocked URLs.
  const blocker=join(temporary,'no-network.cjs');writeFileSync(blocker,"require('node:net').Socket.prototype.connect=function(){throw Error('NETWORK_DISABLED')};globalThis.fetch=()=>{throw Error('NETWORK_DISABLED')};\n");
  const args=['--archive',archive,'--archive-sha256',pins.archive_sha256,'--manifest-sha256',pins.manifest_sha256,'--revision',pins.source_revision,'--workspace',workspace,'--python',python,'--uid',String(process.getuid()),'--device',String(lstatSync(temporary).dev),'--filesystem-type',String(statfsSync(temporary).type),'--arch',process.arch,'--python-sha256',createHash('sha256').update(readFileSync(python)).digest('hex')];
  if(process.platform==='linux'){const m=selectLinuxMount(readFileSync('/proc/self/mountinfo','utf8'),temporary);args.push('--mount-point',m.point,'--mount-source',m.source,'--mount-filesystem',m.filesystem);}else args.push('--local-filesystem-only');
  // The Stripe SDK writes a hint line to stderr when these two variables are set, which they are inside an agent
  // session. The command's own stderr is what is asserted empty, so the children start without them (#155).
  const {CLAUDECODE:_agent,CLAUDE_CODE_CHILD_SESSION:_child,...inherited}=process.env;
  const run=(options=args)=>spawnSync(process.execPath,[join(directory,'scripts/private-host-synthetic.mjs'),...options],{cwd:temporary,encoding:'utf8',timeout:20000,env:{...inherited,NODE_OPTIONS:'--require='+blocker,AWS_ACCESS_KEY_ID:'SYNTHETIC_MUST_NOT_BE_USED',LANGFUSE_SECRET_KEY:'SYNTHETIC_MUST_NOT_BE_USED'}});
  const wrong=[...args];wrong[3]='0'.repeat(64);const invalid=run(wrong);assert.equal(invalid.status,1);assert.equal(existsSync(workspace),false);assert.equal(invalid.stdout,'');
  const wrongDevice=[...args];wrongDevice[wrongDevice.indexOf('--device')+1]='0';assert.equal(run(wrongDevice).status,1);assert.equal(existsSync(workspace),false);
  const badPython=[...args];badPython[badPython.indexOf('--python-sha256')+1]='0'.repeat(64);assert.equal(run(badPython).status,1);assert.equal(existsSync(workspace),false);
  const mountFlags=['--mount-point','--mount-source','--mount-filesystem'],invalidScope=process.platform==='linux'?args.filter((a,i)=>!mountFlags.includes(a)&&!mountFlags.includes(args[i-1])).concat('--local-filesystem-only'):args.filter(a=>a!=='--local-filesystem-only');assert.equal(run(invalidScope).status,1);assert.equal(existsSync(workspace),false);
  const first=run();assert.equal(first.status,0,first.stderr);assert.equal(first.stderr,'');const receipt=JSON.parse(first.stdout);assert.equal(receipt.synthetic,true);assert.equal(receipt.live_authority,false);assert.equal(receipt.export_verified,true);assert.equal(receipt.event_count,2);assert.equal(receipt.aws_requests,0);assert.equal(receipt.provider_requests,0);assert.equal(receipt.synthetic_source_requests,2);assert.equal(receipt.synthetic_destination_requests,2);assert.equal(receipt.archive_sha256,pins.archive_sha256);assert.equal(receipt.revision,pins.source_revision);assert.equal(receipt.readiness.mount_verified,process.platform==='linux');assert.equal(receipt.readiness.device,lstatSync(temporary).dev);
  assert.equal(receipt.protected_consent_verified,true);assert.equal(receipt.start_status,202);assert.equal(receipt.execution_started_at_start,false);assert.equal(receipt.assignment_discovery,'pinned-worker-slot');assert.equal(receipt.assignment_state,'released');assert.equal(receipt.result_audits,1);assert.equal(receipt.release_audits,1);assert.equal(receipt.cookies_forwarded,0);
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(workspace,'synthetic-result.json')))),JSON.stringify(receipt));const saved=readFileSync(join(workspace,receipt.job_id,'import-export.json'));const observations=JSON.parse(saved).runs.flatMap(run=>run.events.map(e=>e.data.observation));assert.equal(observations.find(r=>r.id==='child').parentObservationId,'root');assert.ok(observations.every(r=>r.prompt==='SYNTHETIC_PROMPT'));
  assert.doesNotMatch(first.stdout,/SYNTHETIC_MUST_NOT_BE_USED|synthetic-only-secret|write_key|parent_session|token_hash/);
  const replay=run();assert.equal(replay.status,1);assert.equal(replay.stdout,'');assert.equal(readFileSync(join(workspace,receipt.job_id,'import-export.json')).toString(),saved.toString());
  const interrupted=join(temporary,'interrupted'),killArgs=[...args];killArgs[killArgs.indexOf('--workspace')+1]=interrupted;const child=spawn(process.execPath,[join(directory,'scripts/private-host-synthetic.mjs'),...killArgs],{cwd:temporary,stdio:'ignore',env:{...inherited,NODE_OPTIONS:'--require='+blocker}});
  try{const deadline=Date.now()+10000;while(!existsSync(join(interrupted,'.private-host.lock'))&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,10));assert.equal(existsSync(join(interrupted,'.private-host.lock')),true);child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));const marker=readFileSync(join(interrupted,'synthetic-attempt.json'));assert.equal(run(killArgs).status,1);assert.equal(readFileSync(join(interrupted,'synthetic-attempt.json')).toString(),marker.toString());assert.equal(existsSync(join(interrupted,'.private-host.lock')),true);}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  const extra=run([...args,'--source','https://example.invalid']);assert.equal(extra.status,1);assert.equal(extra.stdout,'');
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
