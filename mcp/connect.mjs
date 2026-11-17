// Browser-approved, nonrenewable delegation. Capability stays in this process.
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readSpec} from './cli.mjs';
import {bridgeScope} from '../src/mcp-bridge-store.mjs';
import {startStdio} from './server.mjs';
const scopeEqual=(a,b)=>JSON.stringify(Object.fromEntries(Object.keys(a??{}).sort().map(k=>[k,a[k]])))===JSON.stringify(Object.fromEntries(Object.keys(b??{}).sort().map(k=>[k,b[k]])));
function abortable(work,signal){
 if(signal.aborted)return Promise.reject(Error('cancelled'));
 return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('cancelled'));};signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{if(signal.aborted)throw Error('cancelled');return work();}).then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(Error('cancelled'));else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
const fail=()=>{throw Error('mcp_bridge_unavailable');};
export async function connectBridge(spec,client,{fetchImpl=globalThis.fetch,notify=()=>{},signal,requestTimeoutMs=10000,sleep=(ms,s)=>new Promise((resolve,reject)=>{const timer=setTimeout(done,ms);function done(){s.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);s.removeEventListener('abort',abort);reject(Error('cancelled'));}s.addEventListener('abort',abort,{once:true});if(s.aborted)abort();})}={}) {
  if(!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>10000)fail();
  const scope=bridgeScope({...spec,client}),controller=new AbortController();
  const relay=()=>controller.abort();signal?.addEventListener('abort',relay,{once:true});if(signal?.aborted)controller.abort();
  const expires=Date.now()+300000,timer=setTimeout(()=>controller.abort(),300000);timer.unref();
  let token=randomBytes(32).toString('base64url'),registered=false,closed=false,lease=null;
  async function call(path,body,withCredential=true,requestSignal=controller.signal) {
    if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||requestSignal.aborted)fail();
    const url=scope.origin+'/api/mcp/'+path;
    const wireSignal=AbortSignal.any([requestSignal,AbortSignal.timeout(requestTimeoutMs)]);
    const response=await abortable(()=>fetchImpl(url,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json',...(withCredential?{cookie:'__Host-supatrace-mcp='+token}:{})},redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:wireSignal}),wireSignal);
    if(response.redirected||response.url&&response.url!==url||!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>{});fail();}
    const reader=response.body?.getReader();if(!reader)fail();let bytes=0;const chunks=[];
    try{for(;;){const part=await abortable(()=>reader.read(),wireSignal);if(part.done)break;bytes+=part.value.byteLength;if(bytes>16384)fail();chunks.push(part.value);}const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(raw.includes(token))fail();return JSON.parse(raw);}
    finally{void reader.cancel().catch(()=>{});}
  }
  async function close() {
    if(closed)return;closed=true;controller.abort();clearTimeout(timer);signal?.removeEventListener('abort',relay);
    if(registered&&token){try{await call('stop',{},true,AbortSignal.timeout(2000));}catch{/* Expiry is server enforced even if revocation cannot be delivered. */}}
    token='';lease=null;
  }
  try{
    const pending=await call('requests',{tokenHash:createHash('sha256').update(token).digest('hex'),scope},false);
    registered=true;
    if(!/^[A-Za-z0-9_-]{12}$/.test(pending.code??'')||pending.approved!==false||!scopeEqual(pending.scope,scope)||!Number.isSafeInteger(pending.expiresAt)||pending.expiresAt<=Date.now()||pending.expiresAt>Date.now()+300000)fail();
    notify({approvalUrl:scope.origin+'/mcp/?code='+encodeURIComponent(pending.code),code:pending.code,client,expiresAt:pending.expiresAt});
    for(let polls=0;polls<100;polls++){
      if(controller.signal.aborted||Date.now()>=pending.expiresAt)fail();
      await sleep(3000,controller.signal);
      const status=await call('poll',{});
      if(status.code!==pending.code||!scopeEqual(status.scope,scope)||!Number.isSafeInteger(status.expiresAt)||status.expiresAt>pending.expiresAt||status.expiresAt<=Date.now()||typeof status.approved!=='boolean')fail();
      if(!status.approved)continue;
      lease=Object.freeze({type:'delegated_read',origin:scope.origin,tenantId:scope.tenantId,projectId:scope.projectId,readToken:token,expiresAt:Math.min(status.expiresAt,expires)});
      return {scope:spec,expiresAt:lease.expiresAt,dependencies:{lifecycleSignal:controller.signal,credentialProvider:async()=>{if(closed||controller.signal.aborted||!lease||Date.now()>=lease.expiresAt)fail();return lease;},authorize:async()=>!closed&&!controller.signal.aborted},close};
    }
    fail();
  }catch{await close();fail();}
}
export async function main(argv=process.argv.slice(2),dependencies={}) {
  const [path,flag,client,...options]=argv;
  if(!path||flag!=='--client'||!client||options.length>1||options.length===1&&options[0]!=='--include-content')fail();
  const scope=readSpec(path);if((scope.content==='include')!==options.includes('--include-content'))fail();
  const controller=new AbortController();let bridge,server,expiry,stopping;
  const stop=()=>stopping??=(async()=>{controller.abort();clearTimeout(expiry);process.off('SIGINT',stop);process.off('SIGTERM',stop);process.stdin.off('end',stop);process.stdin.off('close',stop);try{await server?.close();}finally{await bridge?.close();}})();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);process.stdin.once('end',stop);process.stdin.once('close',stop);
  try{
    server=startStdio(scope,{fetchImpl:dependencies.fetchImpl??globalThis.fetch,lifecycleSignal:controller.signal,authorize:async()=>!!bridge&&!controller.signal.aborted,credentialProvider:async(...args)=>{if(!bridge)fail();return bridge.dependencies.credentialProvider(...args);}});
    bridge=await connectBridge(scope,client,{...dependencies,signal:controller.signal,notify:info=>{dependencies.notify?.(info);process.stderr.write('Approve this exact client and code in your signed-in browser: '+info.approvalUrl+'\nClient label (self-reported): '+info.client+'\n');}});
    if(controller.signal.aborted){await bridge.close();fail();}
    expiry=setTimeout(stop,Math.max(1,bridge.expiresAt-Date.now()));expiry.unref();
    return {close:stop};
  }catch{await stop();throw Error('mcp_bridge_unavailable');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write('SupaTrace MCP consent connection stopped. No credential was printed.\n');process.exitCode=1;});
