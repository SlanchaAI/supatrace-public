#!/usr/bin/env python3
"""Build an explicit private source/runtime distribution. No uploads or installation."""
import argparse, hashlib, json, os, pathlib, stat, subprocess, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
FIELDS='core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context'
def digest(raw): return hashlib.sha256(raw).hexdigest()
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
 output=pathlib.Path(args.output)
 if not output.is_absolute() or output.parent.resolve()!=output.parent or output.exists() or output.is_symlink(): raise ValueError('explicit_new_output_required')
 parent=output.parent.stat()
 if parent.st_uid!=os.getuid() or parent.st_mode&0o022: raise ValueError('owned_output_parent_required')
 revision=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=5).strip()
 paths={};source_bytes={}
 names=subprocess.check_output(['git','-C',str(ROOT),'ls-tree','-r','--name-only',revision,'--','src'],text=True,timeout=5).splitlines()
 names=[n for n in names if n.endswith('.mjs') or '/vendor/' in n and n.rsplit('/',1)[-1] in ['LICENSE','provenance.json','source-pins.json','langsmith-provenance.json']]
 names.extend(['package.json','package-lock.json','scripts/hosted_upload_worker.py','scripts/package-private-import.py','scripts/private-host-synthetic.mjs','tests/memory-dynamo.mjs','agent/private_upload_runtime.py','agent/upload.py','agent/stage_import.py'])
 source=[ROOT/n for n in names]
 for p in source:
  name=p.relative_to(ROOT).as_posix();raw=p.read_bytes()
  committed=subprocess.check_output(['git','-C',str(ROOT),'show',revision+':'+name],timeout=5)
  if raw!=committed: raise ValueError('runtime_source_must_match_exact_commit')
  paths[name]=p;source_bytes[name]=committed
 lock=json.loads(source_bytes['package-lock.json']);inventory=[]
 for name,package in lock['packages'].items():
  if not name.startswith('node_modules/') or package.get('dev'): continue
  if '..' in pathlib.PurePosixPath(name).parts: raise ValueError('package_path_invalid')
  directory=ROOT/name;installed=json.loads((directory/'package.json').read_text())
  if installed.get('version')!=package.get('version'): raise ValueError('locked_dependency_missing_or_changed')
  inventory.append({'path':name,'version':package['version'],'integrity':package.get('integrity'),'license':package.get('license')})
  for current,dirs,files in os.walk(directory,followlinks=False):
   dirs[:]=[d for d in dirs if d not in ['node_modules','.git','.cache']]
   if any((pathlib.Path(current)/d).is_symlink() for d in dirs): raise ValueError('package_symlink_refused')
   for child in files: paths[(pathlib.Path(current)/child).relative_to(ROOT).as_posix()]=pathlib.Path(current)/child
 files=[];total=0
 for name,p in sorted(paths.items()):
  s=p.lstat()
  if p.suffix=='.node' or not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>20*1024*1024: raise ValueError('distribution_file_unsafe')
  raw=source_bytes[name] if name in source_bytes else p.read_bytes();total+=len(raw);files.append({'path':name,'bytes':len(raw),'sha256':digest(raw)})
 if len(files)>20000 or total>256*1024*1024: raise ValueError('distribution_bound')
 manifest=canonical({'schema_version':1,'purpose':'private-import-host','source_revision':revision,'node_major':22,'python_version':'3.12','source_fields':FIELDS,'synthetic_entrypoint':'scripts/private-host-synthetic.mjs','package_lock_sha256':digest(source_bytes['package-lock.json']),'dependency_inventory':inventory,'files':files})
 fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as stream:
  with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
   for f in files:
    raw=source_bytes[f['path']] if f['path'] in source_bytes else paths[f['path']].read_bytes()
    if digest(raw)!=f['sha256']: raise ValueError('distribution_source_changed')
    info=zipfile.ZipInfo(f['path'],date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;archive.writestr(info,raw)
   info=zipfile.ZipInfo('private-host-manifest.json',date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;archive.writestr(info,manifest)
  stream.flush();os.fsync(stream.fileno())
 receipt={'source_revision':revision,'archive_sha256':digest(output.read_bytes()),'manifest_sha256':digest(manifest),'files':len(files),'uncompressed_bytes':total,'provider_requests':0,'installed':False}
 print(json.dumps(receipt,sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('Private distribution unavailable; check exact committed source, locked dependencies and explicit new output. Nothing was uploaded or installed.')
