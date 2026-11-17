#!/usr/bin/env python3
"""Convert one explicitly selected Claude Code JSONL transcript snapshot.
Does not search your disk, install hooks, or send anything. Review output before upload.
Reads user/assistant messages and tool_use/tool_result blocks only. Unknown rows are counted.
"""
import argparse,datetime,hashlib,json,pathlib
from upload import atomic_write,canonical

def convert(source,run_id,out):
    source=pathlib.Path(source)
    if source.stat().st_size>20*1024*1024:raise ValueError('Transcript exceeds 20 MiB snapshot limit')
    events=[];skipped=0
    for n,line in enumerate(source.read_text().splitlines(),1):
        if not line.strip():continue
        row=json.loads(line)
        if row.get('type') not in ('user','assistant'):skipped+=1;continue
        message=row.get('message',{});content=message.get('content');timestamp=row.get('timestamp')
        if not isinstance(timestamp,str):raise ValueError(f'Row {n} has no timestamp; refusing invented event time')
        # Event identity is stable for the same explicit snapshot and row.
        if isinstance(content,str):content=[{'type':'text','text':content}]
        if not isinstance(content,list):skipped+=1;continue
        for i,block in enumerate(content):
            if not isinstance(block,dict):skipped+=1;continue
            kind={'tool_use':'tool_call','tool_result':'tool_result','text':'request' if row['type']=='user' else 'response'}.get(block.get('type'))
            if not kind:skipped+=1;continue
            if len(canonical(block))>32768:raise ValueError(f'Row {n} block exceeds 32 KiB; refusing silent truncation')
            events.append({'id':hashlib.sha256(canonical([run_id,n,i,block])).hexdigest(),'time':timestamp,'kind':kind,'name':str(block.get('name') or block['type'])[:200],'data':block})
    # Each immutable chunk owns its own stable id; don't upload a changing transcript under the same run id.
    paths=[];chunk=[]
    def flush():
        if not chunk:return
        # DynamoDB pages BATCH#<id> lexicographically. Prefix the immutable hash
        # with explicit source-chunk order, independent of timestamps/upload order.
        b={'version':1,'run_id':run_id,'events':list(chunk)};b['batch_id']=f'{len(paths):016d}-'+hashlib.sha256(canonical(b)).hexdigest()
        path=pathlib.Path(out)/(b['batch_id']+'.json');atomic_write(path,canonical(b));paths.append(str(path));chunk.clear()
    for event in events:
        if len(chunk)>=100 or len(canonical(chunk+[event]))>480000:flush()
        chunk.append(event)
    flush();return {'files':paths,'events':len(events),'unsupported_blocks_or_rows':skipped}
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('transcript');p.add_argument('--run-id',required=True);p.add_argument('--out',required=True);a=p.parse_args();print(json.dumps(convert(a.transcript,a.run_id,a.out),indent=2))
