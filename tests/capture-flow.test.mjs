import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {handle} from '../src/aws-api.mjs';import {digest} from '../src/aws-auth.mjs';
test('synthetic Claude snapshot converts, accepts, reads and exports with tenant isolation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'supatrace-flow-'));
 try{
 const input=join(dir,'explicit.jsonl');writeFileSync(input,JSON.stringify({type:'assistant',timestamp:'2026-10-21T00:00:00Z',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'synthetic.txt'}}]}})+'\n');
 const report=JSON.parse(execFileSync('python3',['agent/claude_snapshot.py',input,'--run-id','synthetic-flow','--out',join(dir,'batches')],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
 const raw=readFileSync(report.files[0],'utf8'),expected=JSON.parse(raw);let saved;const objects=new Map(),key='a'.repeat(43),sessionA='b'.repeat(43),sessionB='c'.repeat(43);
 const store={getTenant:async tenant_id=>({tenant_id}),consumeRate:async()=>({allowed:true}),lookupWriteKey:async h=>h===digest(key)?{tenant_id:'github-1'}:null,getSession:async h=>h===digest(sessionA)?{tenant_id:'github-1'}:h===digest(sessionB)?{tenant_id:'github-2'}:null,
 reserveBatch:async(t,b)=>saved||(saved={...b,tenant_id:t,status:'pending',object_key:`v1/${digest(t)}/${b.request_hash}.json`}),acceptReservedBatch:async()=>{saved.status='accepted'},
 listAcceptedBatchIndexes:async(t,r)=>({items:saved?.tenant_id===t&&saved.run_id===r&&saved.status==='accepted'?[saved]:[],next:null})};
 const env={ENABLED:true,APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects:{putImmutable:async(k,b)=>objects.set(k,b),get:async k=>objects.get(k)}};
 const result=await handle(new Request('https://supatrace.dev/api/batches',{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':digest(raw)},body:raw}),env);assert.equal(result.status,201);assert.equal((await result.json()).request_hash,digest(raw));
 for(const [session,events]of [[sessionA,expected.events],[sessionB,[]]]){const r=await handle(new Request('https://supatrace.dev/api/events?run=synthetic-flow',{headers:{cookie:'__Host-supatrace='+session}}),env);assert.equal(r.status,200);assert.deepEqual((await r.json()).events,events)}
 assert.equal(report.events,1);assert.equal(objects.size,1);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('synthetic native hook fields survive capture, real handler ACK, readback and tenant isolation',async()=>{
 const {alphaProject}=await import('../src/alpha-projects.mjs');
 const dir=mkdtempSync(join(tmpdir(),'supatrace-hooks-flow-'));
 const project=alphaProject('github-1').id,workspace=join(dir,'source'),spool=join(dir,'private'),config=join(dir,'access.json');
 try{
 const setup=String.raw`import sys, pathlib, json, io
sys.path.insert(0, 'agent')
import claude_hook as h
root=pathlib.Path(sys.argv[1]); workspace=root/'source'; workspace.mkdir()
config=root/'access.json'; config.write_text(json.dumps({'approved':True,'origin':'https://supatrace.dev','project_id':sys.argv[2],'write_key':'a'*43}));config.chmod(0o600)
spool=root/'private';h.initialize(spool, workspace, config, content=True, allow_content=True)
nested='synthetic-leaf'
for _ in range(21):nested={'x':nested}
base={'session_id':'native-session','prompt_id':'native-prompt','cwd':str(workspace),'transcript_path':'/must/not/read','agent_id':'native-agent'}
for fields in [{'hook_event_name':'UserPromptSubmit','prompt':'Synthetic task'}, {'hook_event_name':'PostToolUse','tool_name':'Read','tool_use_id':'native-tool','tool_input':{'file_path':'synthetic.txt'},'tool_response':nested}, {'hook_event_name':'Stop','stop_hook_active':False,'last_assistant_message':'Synthetic answer'}]:
 h.capture(spool,io.BytesIO(h.canonical({**base,**fields})),cwd=workspace)
with h.lock(spool):
 state=h.read_state(spool);batch=h.prepare_batch(state);h.save_state(spool,state)
print(h.body_for(h.read_state(spool),batch).decode())`;
 const raw=execFileSync('python3',['-c',setup,dir,project],{cwd:new URL('..',import.meta.url),encoding:'utf8'}).trim();
 const expected=JSON.parse(raw);let saved;const objects=new Map(),key='a'.repeat(43),sessionA='b'.repeat(43),sessionB='c'.repeat(43);
 const store={getTenant:async tenant_id=>({tenant_id}),consumeRate:async()=>({allowed:true}),lookupWriteKey:async h=>h===digest(key)?{tenant_id:'github-1',project_id:project}:null,getSession:async h=>h===digest(sessionA)?{tenant_id:'github-1'}:h===digest(sessionB)?{tenant_id:'github-2'}:null,
 reserveBatch:async(t,b)=>saved||(saved={...b,tenant_id:t,status:'pending',object_key:`v1/${digest(t)}/${b.request_hash}.json`}),acceptReservedBatch:async()=>{saved.status='accepted'},
 listAcceptedBatchIndexes:async(t,r)=>({items:saved?.tenant_id===t&&saved.run_id===r&&saved.status==='accepted'?[saved]:[],next:null})};
 const env={ENABLED:true,APP_ORIGIN:'https://supatrace.dev',GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic',store,objects:{putImmutable:async(k,b)=>objects.set(k,b),get:async k=>objects.get(k)}};
 const response=await handle(new Request('https://supatrace.dev/api/batches?project='+project,{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':key,'x-amz-content-sha256':digest(raw)},body:raw}),env);
 assert.equal(response.status,201);const ack=await response.json();assert.equal(ack.request_hash,digest(raw));assert.equal(ack.project_id,project);
 writeFileSync(join(dir,'ack.json'),JSON.stringify(ack));
 const finish=String.raw`import sys,pathlib,json
sys.path.insert(0,'agent');import claude_hook as h
root=pathlib.Path(sys.argv[1]);calls=[]
class Reply:
 status=201
 def __init__(self,request):self.request=request
 def __enter__(self):return self
 def __exit__(self,*_):pass
 def geturl(self):return self.request.full_url
 def read(self,size):return (root/'ack.json').read_bytes()[:size]
def transport(request,timeout):
 calls.append(request.data.decode());return Reply(request)
first=h.flush(root/'private',transport=transport);second=h.flush(root/'private',transport=transport)
print(json.dumps({'first':first,'second':second,'bodies':calls}))`;
 const result=JSON.parse(execFileSync('python3',['-c',finish,dir],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
 assert.deepEqual(result.bodies,[raw]);assert.equal(result.first.accepted,3);assert.equal(result.second.accepted,3);assert.equal(result.second.hosted_readback_verified,false);
 assert.deepEqual(expected.events.map(event=>event.name),['UserPromptSubmit','PostToolUse','Stop']);
 assert.equal(expected.events[1].data.tool_input.file_path,'synthetic.txt');
 for(const [session,events]of [[sessionA,expected.events],[sessionB,[]]]){
  const read=await handle(new Request('https://supatrace.dev/api/events?run='+expected.run_id,{headers:{cookie:'__Host-supatrace='+session}}),env);
  assert.equal(read.status,200);assert.deepEqual((await read.json()).events,events);
 }
 assert.equal(objects.size,1);assert.ok(expected.events.every(event=>event.data.timestamp_basis==='hook_received_at'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
