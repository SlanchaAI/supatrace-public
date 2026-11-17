// Explicit localhost fixture. No actual browser/session, provider or hosted call.
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main} from '../connect.mjs';
import {start} from '../../tests/harness.mjs';
import {alphaProject} from '../../src/alpha-projects.mjs';
const live=await start({mcp:true}),dir=mkdtempSync(join(tmpdir(),'mcp-bridge-stdio-'));let cookies;
const localFetch=globalThis.fetch;globalThis.fetch=(url,init)=>{if(new URL(url).origin!==live.origin)throw Error('External network forbidden in synthetic fixture');return localFetch(url,init);};
const tenant=await live.signIn({addCookies:async c=>cookies=c}),project=alphaProject(tenant).id,key=await live.writeKey(tenant);
const event={id:'proof',time:'2026-11-01T00:00:00.000Z',kind:'note',name:'Synthetic trace',data:{value:'synthetic',parent:'source-root'}};
await live.upload(key,{version:1,run_id:'bridge-proof',batch_id:'one',events:[event]});
const spec={origin:'https://supatrace.dev',tenantId:tenant,projectId:project,content:'include',runIds:['bridge-proof']};
const path=join(dir,'scope.json');writeFileSync(path,JSON.stringify(spec),{mode:0o600});
let approval,handle;
const cleanup=async()=>{await handle?.close();await live.close();rmSync(dir,{recursive:true,force:true});};
try{
 handle=await main([path,'--client','Synthetic stdio client','--include-content'],{
  fetchImpl:async(url,init)=>{const u=new URL(url),r=await fetch(live.origin+u.pathname+u.search,init);return new Response(r.body,{status:r.status,headers:r.headers});},
  sleep:async()=>{await approval;},
  notify:info=>{approval=(async()=>{const headers={'content-type':'application/json',origin:'https://supatrace.dev',cookie:cookies.map(c=>c.name+'='+c.value).join('; ')};const pending=await(await fetch(live.origin+'/api/mcp/request?code='+info.code,{headers})).json();const r=await fetch(live.origin+'/api/mcp/approve',{method:'POST',headers,body:JSON.stringify({code:info.code,consent:{confirmed:true,content:'include',scopeHash:pending.scopeHash}})});if(r.status!==200)throw Error('synthetic approval failed');})();}
 });
 process.stderr.write('BRIDGE_READY\n');process.stdin.once('end',cleanup);
}catch{await cleanup();process.exitCode=1;}
