import {boundedText,requireOrigin,HttpError,json} from './http.mjs';
import {session,cookie,digest} from './aws-auth.mjs';
import {mcpBridgeStore} from './mcp-bridge-store.mjs';
const fail=(status,code)=>{throw new HttpError(status,code);};
const object=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>{if(!object(v)||Object.keys(v).sort().join()!==[...keys].sort().join())fail(400,'invalid_mcp_request');};
const capability=request=>{const value=cookie(request,'__Host-supatrace-mcp');if(!/^[A-Za-z0-9_-]{43}$/.test(value??''))fail(401,'mcp_access_unavailable');return digest(value);};
export async function mcpBridgeApi(request,env,{runView}) {
  if(env.MCP_BRIDGE_ENABLED!==true)fail(404,'not_found');
  const url=new URL(request.url),path=url.pathname,db=mcpBridgeStore(env.store),origin=env.APP_ORIGIN;
  if(request.method==='POST'&&path==='/api/mcp/requests'){
    const data=JSON.parse(await boundedText(request,8192));exact(data,['tokenHash','scope']);
    return json(await db.register(data.tokenHash,data.scope,origin),201);
  }
  if(request.method==='POST'&&['/api/mcp/poll','/api/mcp/stop'].includes(path)){
    const data=JSON.parse(await boundedText(request,16));exact(data,[]);
    return json(await (path.endsWith('/stop')?db.revoke(capability(request),origin):db.poll(capability(request),origin)));
  }
  if(path==='/api/mcp/request'&&request.method==='GET'){
    const tenant=await session(request,env.store);
    if(url.searchParams.size!==1||url.searchParams.getAll('code').length!==1)fail(400,'invalid_mcp_request');
    return json(await db.inspect(url.searchParams.get('code'),origin,tenant));
  }
  if(request.method==='POST'&&['/api/mcp/approve','/api/mcp/revoke'].includes(path)){
    requireOrigin(request,origin);const tenant=await session(request,env.store),data=JSON.parse(await boundedText(request,1024));
    if(path.endsWith('/revoke')){exact(data,['code']);return json(await db.revokeByCode(data.code,origin,tenant));}
    exact(data,['code','consent']);return json(await db.approve(data.code,origin,tenant,digest(cookie(request,'__Host-supatrace')),data.consent));
  }
  // Capabilities are accepted only in this explicit GET namespace. They cannot
  // authenticate normal account APIs, uploads, billing or approval operations.
  if(request.method!=='GET'||!['/api/mcp/read/me','/api/mcp/read/runs/page','/api/mcp/read/events'].includes(path))fail(404,'not_found');
  const hash=capability(request),lease=await db.lease(hash,origin),scope=lease.scope;
  const eventsRoute=path.endsWith('/events');
  for(const name of url.searchParams.keys())if(!(eventsRoute?['project','run','after','content']:['project']).includes(name)||url.searchParams.getAll(name).length!==1)fail(400,'invalid_mcp_query');
  if(url.searchParams.get('project')!==scope.projectId)fail(403,'mcp_scope_mismatch');
  let result;
  if(path.endsWith('/me'))result={tenant_id:scope.tenantId,project_id:scope.projectId};
  else if(path.endsWith('/runs/page')){
    const runs=[];
    for(const id of scope.runIds){const row=await env.store.getRun(scope.tenantId,id);if(row)runs.push(runView(row));}
    result={project_id:scope.projectId,runs,next:null,complete:true};
  }else{
    const run=url.searchParams.get('run'),content=url.searchParams.get('content')??'metadata';
    if(!scope.runIds.includes(run))fail(403,'mcp_scope_mismatch');
    if(!['metadata','include'].includes(content)||content==='include'&&scope.content!=='include')fail(403,'mcp_content_not_authorized');
    const page=await env.store.listAcceptedBatchIndexes(scope.tenantId,run,{cursor:url.searchParams.get('after')||undefined,limit:1}),events=[];
    for(const row of page.items){
      const raw=await env.objects.get(row.object_key);
      if(digest(raw)!==row.request_hash)fail(503,'stored_content_mismatch');
      const parsed=JSON.parse(raw);if(parsed.run_id!==run)fail(503,'stored_run_mismatch');
      for(const event of parsed.events)events.push(content==='include'?event:{id:event.id,time:event.time,kind:event.kind,name:'Metadata event',data:null});
    }
    result={events,next:page.next};
  }
  // Recheck after storage awaits: expiry/revocation during a read cannot produce
  // a newly authorized response. Already delivered bytes cannot be retracted.
  const current=await db.lease(hash,origin);if(current.code!==lease.code||current.scope_hash!==lease.scope_hash||current.parent_session_hash!==lease.parent_session_hash)fail(401,'mcp_access_unavailable');if(request.signal.aborted)fail(499,'mcp_cancelled');return json(result);
}
