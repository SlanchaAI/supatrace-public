// Check a pinned, privately extracted distribution; never downloads, extracts or grants access.
import {constants,openSync,closeSync,fstatSync,readSync,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPrivateImportHost} from './private-import-host.mjs';
import {createPrivateImportLauncher,createPrivateImportWorker} from './private-import-launcher.mjs';
import {LANGFUSE_HOST_FIELDS} from './private-import-dispatch.mjs';
const fail=()=>{throw Error('private_distribution_unverified');};
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function read(path,max,retain=false){let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>max||s.mode&0o022)fail();const hash=createHash('sha256'),chunks=[];let total=0,n;const buf=Buffer.alloc(65536);while((n=readSync(fd,buf,0,buf.length,null))){total+=n;if(total>max)fail();hash.update(buf.subarray(0,n));if(retain)chunks.push(Buffer.from(buf.subarray(0,n)));}const end=fstatSync(fd);if(total!==s.size||end.mtimeMs!==s.mtimeMs||end.ctimeMs!==s.ctimeMs)fail();return {sha256:hash.digest('hex'),bytes:total,...(retain?{raw:Buffer.concat(chunks)}:{})};}finally{if(fd!==undefined)closeSync(fd);}}
export function verifyPrivateImportDistribution({directory,manifestHash,archivePath,archiveHash,revision}){
 try{
  if(!isAbsolute(directory)||realpathSync(directory)!==directory||!hex(manifestHash)||!hex(archiveHash)||!isAbsolute(archivePath)||realpathSync(resolve(archivePath,'..'))!==resolve(archivePath,'..')||!/^[a-f0-9]{40}$/.test(revision??''))fail();
  const root=lstatSync(directory);if(!root.isDirectory()||root.mode&0o022)fail();
  if(read(archivePath,128*1024*1024).sha256!==archiveHash)fail();
  const raw=read(join(directory,'private-host-manifest.json'),4*1024*1024,true);if(raw.sha256!==manifestHash)fail();const manifest=JSON.parse(raw.raw);
  if(manifest.schema_version!==1||manifest.purpose!=='private-import-host'||manifest.source_revision!==revision||manifest.node_major!==22||manifest.python_version!=='3.12'||manifest.source_fields!==LANGFUSE_HOST_FIELDS||!Array.isArray(manifest.files)||manifest.files.length>20000)fail();
  const allowed=new Set(['private-host-manifest.json']);let total=0;
  for(const f of manifest.files){if(typeof f.path!=='string'||!f.path||f.path.includes('\\')||isAbsolute(f.path)||resolve(directory,f.path)!==join(directory,f.path)||f.path.split('/').some(s=>['.','..',''].includes(s))||allowed.has(f.path)||!hex(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>20*1024*1024)fail();const path=join(directory,f.path);if(realpathSync(resolve(path,'..'))!==resolve(path,'..'))fail();const observed=read(path,20*1024*1024);if(observed.bytes!==f.bytes||observed.sha256!==f.sha256)fail();allowed.add(f.path);if((total+=f.bytes)>256*1024*1024)fail();}
  const stack=[directory];let entries=0;while(stack.length){const path=stack.pop();for(const name of readdirSync(path)){if(++entries>30000)fail();const child=join(path,name),s=lstatSync(child);if(s.isSymbolicLink()||s.mode&0o022)fail();if(s.isDirectory())stack.push(child);else if(!s.isFile()||!allowed.delete(child.slice(directory.length+1)))fail();}}
  if(allowed.size||manifest.package_lock_sha256!==read(join(directory,'package-lock.json'),1024*1024).sha256)fail();return Object.freeze({revision,artifact_hash:archiveHash,manifest_hash:manifestHash,files:manifest.files.length});
 }catch{fail();}
}
function verifiedHostOptions(distribution,hostOptions){
 distribution=structuredClone(distribution);
 const proof=verifyPrivateImportDistribution(distribution),ownRoot=resolve(fileURLToPath(new URL('../',import.meta.url)));
 if(ownRoot!==distribution.directory||hostOptions.runtime.artifact_hash!==proof.artifact_hash||hostOptions.runtime.revision!==proof.revision)fail();
 const readiness=hostOptions.readiness;
 return {...hostOptions,readiness:async input=>{const current=verifyPrivateImportDistribution(distribution);if(JSON.stringify(current)!==JSON.stringify(proof))fail();return await readiness(input)===true;}};
}
export function loadPrivateImportHost({distribution,hostOptions}){
 return createPrivateImportHost(verifiedHostOptions(distribution,hostOptions));
}
export function loadPrivateImportLauncher({distribution,launcherOptions}){
 return createPrivateImportLauncher({...launcherOptions,hostOptions:verifiedHostOptions(distribution,launcherOptions.hostOptions)});
}
export function loadPrivateImportWorker({distribution,workerOptions}){
 return createPrivateImportWorker({...workerOptions,hostOptions:verifiedHostOptions(distribution,workerOptions.hostOptions)});
}
