// Operator-pinned local readiness. Does not establish EBS identity, IAM or approval.
import {openSync,readSync,closeSync,fstatSync,lstatSync,realpathSync,statfsSync,constants} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const fail=(code='mount_records')=>{throw Object.assign(Error('private_synthetic_readiness_unverified'),{code:'synthetic_'+code});};
const within=(path,parent)=>path===parent||path.startsWith(parent==='/'?'/':parent+'/');
function decode(value){return value.replace(/\\([0-7]{3})/g,(_,oct)=>String.fromCharCode(parseInt(oct,8)));}
export function selectLinuxMount(text,directory){
 if(typeof text!=='string'||Buffer.byteLength(text)>1048576||!isAbsolute(directory)||resolve(directory)!==directory)fail();
 const rows=text.trim().split('\n');if(rows.length>10000)fail();let selected,ambiguous=false;
 for(const row of rows){const parts=row.split(' - ');if(parts.length!==2)fail();const left=parts[0].split(' '),right=parts[1].split(' ');if(left.length<6||right.length<3||!/^\d+:\d+$/.test(left[2]))fail();const mount=decode(left[4]);if(!isAbsolute(mount)||resolve(mount)!==mount)fail();
  if(within(directory,mount)){if(!selected||mount.length>selected.point.length){selected={point:mount,device:left[2],root:decode(left[3]),filesystem:right[0],source:decode(right[1]),writable:[left[5],right[2]].every(options=>options.split(',').includes('rw')&&!options.split(',').includes('ro'))};ambiguous=false;}else if(mount.length===selected.point.length)ambiguous=true;}
 }
 if(!selected||ambiguous)fail();return selected;
}
function read(path,max,hashOnly=false,kind='readiness_file'){let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd);if(!before.isFile()||before.mode&0o022||before.size>max)fail(kind);let total=0,n;const buffer=Buffer.alloc(65536),hash=createHash('sha256'),chunks=[];while((n=readSync(fd,buffer,0,Math.min(buffer.length,max+1-total),null))){total+=n;if(total>max)fail(kind);hash.update(buffer.subarray(0,n));if(!hashOnly)chunks.push(Buffer.from(buffer.subarray(0,n)));}const after=fstatSync(fd);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail(kind);return hashOnly?hash.digest('hex'):Buffer.concat(chunks).toString('utf8');}finally{if(fd!==undefined)closeSync(fd);}}
function linuxDevice(value){const d=BigInt(value);return String((d>>8n&0xfffn)|(d>>32n&0xfffff000n))+':'+String((d&0xffn)|(d>>12n&0xffffff00n));}
export function inspectPrivateHostReadiness({directory,uid,device,filesystemType,architecture,pythonExecutable,pythonHash,mountPoint,mountSource,mountFilesystem,localFilesystemOnly=false}){
 if(!isAbsolute(directory)||realpathSync(directory)!==directory||!Number.isSafeInteger(uid)||uid<=0||uid!==process.getuid()||!Number.isSafeInteger(device)||device<0||!Number.isSafeInteger(filesystemType)||!['arm64','x64'].includes(architecture)||process.arch!==architecture||Number(process.versions.node.split('.')[0])!==22||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('runtime_identity');
 if(localFilesystemOnly&&process.platform!=='darwin')fail('platform_override');
 const s=lstatSync(directory),fs=statfsSync(directory);
 if(!s.isDirectory()||s.uid!==uid||s.dev!==device||s.mode&0o077||fs.type!==filesystemType||fs.bavail*fs.bsize<64*1024*1024)fail('directory_identity');
 if(!isAbsolute(pythonExecutable)||realpathSync(pythonExecutable)!==pythonExecutable||!(/^[a-f0-9]{64}$/).test(pythonHash??''))fail('interpreter_pin');const binary=lstatSync(pythonExecutable);if(!binary.isFile()||!(binary.mode&0o111)||![0,uid].includes(binary.uid)||read(pythonExecutable,128*1024*1024,true,'interpreter_file')!==pythonHash)fail('interpreter_pin');
 let version;try{version=execFileSync(pythonExecutable,['-I','-B','-c','import sys;print(str(sys.version_info.major)+"."+str(sys.version_info.minor))'],{encoding:'utf8',timeout:2000,env:{LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}}).trim();}catch{fail('interpreter_version');}if(version!=='3.12')fail('interpreter_version');
 let mount=null;if(!localFilesystemOnly){
  if(process.platform!=='linux'||!isAbsolute(mountPoint??'')||realpathSync(mountPoint)!==mountPoint||typeof mountSource!=='string'||!mountSource||typeof mountFilesystem!=='string'||!mountFilesystem)fail('mount_config');
  mount=selectLinuxMount(read('/proc/self/mountinfo',1048576,false,'mount_file'),directory);
  if(mount.point!==mountPoint||mount.source!==mountSource||mount.filesystem!==mountFilesystem||mount.device!==linuxDevice(s.dev)||mount.root!=='/'||!mount.writable||lstatSync(mountPoint).dev!==s.dev)fail('mount_identity');
 }
 return Object.freeze({uid,device,filesystem_type:fs.type,architecture:process.arch,node_version:process.versions.node,python_version:version,python_sha256:pythonHash,mount_verified:!localFilesystemOnly,mount});
}
