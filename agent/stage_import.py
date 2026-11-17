#!/usr/bin/env python3
"""Stage explicit converted files with the unchanged SupaTrace uploader. No network."""
import argparse,hashlib,importlib.util,json,pathlib,re

def uploader():
    path=pathlib.Path(__file__).parent/'upload.py'
    spec=importlib.util.spec_from_file_location('supatrace_existing_upload',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def stage_directory(directory,spool):
    directory=pathlib.Path(directory);spool=pathlib.Path(spool)
    report=json.loads((directory/'report.json').read_text())
    prefix={'connector-file-v1':'imp','langfuse-experiment-result-summary-file':'lf-result','langfuse-observations-v2-file':'lf','langsmith-runs-feedback-file':'ls','braintrust-span-rows-file':'bt','weave-call-rows-file':'wv','opik-traces-spans-file':'op','confident-v2-trace-detail-file':'cf','maxim-full-trace-file':'mx','arize-ax-cli-span-json-file':'ax'}.get(report.get('format'))
    if prefix is None:raise ValueError('Unsupported conversion report')
    if report.get('rejected'):raise ValueError('Conversion has rejections; review and explicitly resolve before staging')
    sources=sorted(directory.glob(prefix+'.*.json'))
    if len(sources)!=report.get('outputBatches'):raise ValueError('Batch count does not match conversion report')
    # Preflight all source files before writing pending data.
    checked=[];identities={}
    prior={'batches':[]};prior_path=spool/'import-manifest.json'
    if prior_path.exists():
        prior=json.loads(prior_path.read_text())
        if prior.get('mode')!='stage-only-no-network':raise ValueError('Unsupported existing manifest')
        for item in prior['batches']:identities[item['batch_id']]=item['request_hash']
    # Recover interrupted staging before its final manifest write. Existing
    # content-addressed pending files are also an identity authority.
    for pending in sorted(spool.glob('*.json')):
        if pending.name=='import-manifest.json':continue
        if not re.fullmatch(r'[a-f0-9]{64}\.json',pending.name):raise ValueError('Unknown pending file')
        body=pending.read_bytes();batch=json.loads(body);identity=batch.get('batch_id')
        digest=hashlib.sha256(body).hexdigest()
        if pending.name!=digest+'.json' or not isinstance(identity,str):raise ValueError('Invalid pending identity')
        if identity in identities and identities[identity]!=digest:raise ValueError('Conflicting pending identity')
        identities[identity]=digest
        if not any(i['batch_id']==identity for i in prior['batches']):prior['batches'].append({'batch_id':identity,'request_hash':digest,'pending_file':pending.name})
    for source in sources:
        raw=source.read_bytes()
        if len(raw)>524288:raise ValueError('Batch exceeds 512 KiB')
        batch=json.loads(raw);identity=batch.get('batch_id')
        if batch.get('version')!=1 or not isinstance(identity,str) or not re.fullmatch(prefix+r'\.[a-f0-9]{64}',identity) or source.name!=identity+'.json':raise ValueError('Invalid converted batch identity')
        if not isinstance(batch.get('events'),list) or len(batch['events'])!=1:raise ValueError('Expected exactly one source record per batch')
        digest=hashlib.sha256(uploader().canonical(batch)).hexdigest()
        if identity in identities and identities[identity]!=digest:raise ValueError('Conflicting batch identity')
        identities[identity]=digest;checked.append((source,digest,identity))
    spool.mkdir(mode=0o700,parents=True,exist_ok=True)
    module=uploader();items={i['batch_id']:i for i in prior['batches']}
    for source,digest,identity in checked:
        pending=module.stage(source,spool)
        if pending.name!=digest+'.json':raise ValueError('Unexpected staged content hash')
        items[identity]={'batch_id':identity,'request_hash':digest,'pending_file':pending.name}
    manifest={'version':1,'mode':'stage-only-no-network','batches':sorted(items.values(),key=lambda i:i['batch_id']),'count':len(items),'notes':['Re-staging identical batches is idempotent.','Pending files survive process exit; exact accepted receipt is required for deletion.','This manifest does not authorize uploading or guarantee import completion.']}
    module.atomic_write(spool/'import-manifest.json',json.dumps(manifest,sort_keys=True).encode())
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('converted_directory');p.add_argument('--spool',required=True);args=p.parse_args()
    try:
        result=stage_directory(args.converted_directory,args.spool)
        print(json.dumps({'staged':result['count'],'mode':result['mode']}))
    except (OSError,ValueError,KeyError,TypeError):
        p.exit(1,'Staging failed. Review the conversion report, batch files and spool permissions. No upload was attempted.\n')
