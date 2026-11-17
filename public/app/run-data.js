const fail=code=>{throw new Error(code);};
const cancelled=signal=>{if(signal?.aborted)fail('run_load_cancelled');};
const cursor=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&/^[A-Za-z0-9_-]+$/.test(value);
// Settle the caller even when a transport/body reader or injected wait ignores abort.
// Late work stays observed but cannot advance the scan or produce a partial catalog.
function abortable(work,signal) {
  cancelled(signal);
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('run_load_cancelled'));};
    signal.addEventListener('abort',abort,{once:true});
    let result;try{result=work();}catch(error){result=Promise.reject(error);}
    Promise.resolve(result).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
function wait(ms,signal) {
  return new Promise((resolve,reject)=>{
    cancelled(signal);
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('run_load_cancelled'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}
function validRun(row) {
  return row&&typeof row==='object'&&typeof row.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(row.id)&&
    typeof row.created_at==='string'&&Number.isFinite(Date.parse(row.created_at))&&
    (row.started_at===null||typeof row.started_at==='string'&&Number.isFinite(Date.parse(row.started_at)))&&
    (row.ended_at===null||typeof row.ended_at==='string'&&Number.isFinite(Date.parse(row.ended_at)))&&
    ['duration_ms','event_count','batch_count','byte_count'].every(key=>row[key]===null||Number.isSafeInteger(row[key])&&row[key]>=0)&&
    Array.isArray(row.agents)&&row.agents.every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))&&
    (row.status===null||row.status==='ok'||row.status==='error')&&
    // Additive: older APIs omit it. null means no expiry applies to this run.
    (row.expires_at===undefined||row.expires_at===null||typeof row.expires_at==='string'&&Number.isFinite(Date.parse(row.expires_at)));
}

// Only a complete catalog is returned. No partial page becomes a total or a search result.
export async function loadAccountRuns(fetchPage,{projectId,signal,onProgress=()=>{},
  maxRuns=100000,maxBytes=20*1024*1024,totalTimeoutMs=300000,sleep=wait}={}) {
  if(typeof fetchPage!=='function'||!/^proj_[a-f0-9]{32}$/.test(projectId)||
    !Number.isInteger(maxRuns)||maxRuns<1||maxRuns>100000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>20*1024*1024||
    !Number.isInteger(totalTimeoutMs)||totalTimeoutMs<1||totalTimeoutMs>300000||typeof onProgress!=='function'||typeof sleep!=='function')fail('invalid_run_load_scope');
  cancelled(signal);
  const controller=new AbortController(),relay=()=>controller.abort();
  signal?.addEventListener('abort',relay,{once:true});
  let expired=false;
  const timer=setTimeout(()=>{expired=true;controller.abort();},totalTimeoutMs);
  const runs=[],ids=new Set(),seen=new Set();let after=null,bytes=0;
  try {
    while(true) {
      cancelled(controller.signal);
      let page;
      for(let retries=0;;retries++) {
        try {
          page=await abortable(()=>fetchPage('runs/page'+(after?'?after='+encodeURIComponent(after):''),controller.signal),controller.signal);
          break;
        } catch(error) {
          cancelled(controller.signal);
          if(error.status!==429)throw error;
          if(retries>=5||!Number.isFinite(error.retryAfter)||error.retryAfter<1||error.retryAfter>60)fail('run_load_rate_limited');
          await abortable(()=>sleep(error.retryAfter*1000,controller.signal),controller.signal);
        }
      }
      cancelled(controller.signal);
      if(!page||page.project_id!==projectId||!Array.isArray(page.runs)||page.runs.length>800||
        typeof page.complete!=='boolean'||page.complete!==(page.next===null)||
        (page.next!==null&&(!cursor(page.next)||seen.has(page.next))))fail('invalid_run_page');
      bytes+=new TextEncoder().encode(JSON.stringify(page.runs)).length;
      if(bytes>maxBytes||runs.length+page.runs.length>maxRuns)fail('run_catalog_too_large');
      for(const run of page.runs) {
        if(!validRun(run)||ids.has(run.id))fail('invalid_run_page');
        ids.add(run.id);runs.push(run);
      }
      onProgress({loaded:runs.length,complete:page.complete});
      if(page.complete)return runs;
      if(seen.size>=10000)fail('run_catalog_too_large');
      after=page.next;seen.add(after);
    }
  } catch(error) {
    if(expired)fail('run_load_deadline');
    if(controller.signal.aborted)fail('run_load_cancelled');
    throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',relay);}
}

export function queryAccountRuns(catalog,search) {
  const params=search instanceof URLSearchParams?search:new URLSearchParams(search);
  const limit=params.has('limit')?Number(params.get('limit')):25,offset=params.has('offset')?Number(params.get('offset')):0;
  const sort=params.get('sort')||'started',dir=params.get('dir')||'desc',q=params.get('q')||'',agent=params.get('agent')||'';
  if(!Array.isArray(catalog)||!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>100000||
    !['started','agent','duration','events','status'].includes(sort)||!['asc','desc'].includes(dir)||q.length>128||/[^\w.:-]/.test(q)||agent&&!/^[a-f0-9]{64}$/.test(agent))fail('invalid_query');
  const bound=name=>{const value=params.get(name);if(!value)return null;const time=Date.parse(value);if(!Number.isFinite(time))fail('invalid_query');return time;};
  const from=bound('from'),to=bound('to'),start=run=>Date.parse(run.started_at||run.created_at);
  const status=value=>typeof value==='string'?value.toLowerCase():value;
  const rows=catalog.filter(run=>(!q||(run.id.includes(q)||status(run.status)===status(q)))&&(!agent||run.agents.includes(agent))&&
    (from===null||start(run)>=from)&&(to===null||start(run)<=to));
  const value=run=>sort==='agent'?run.agents[0]||'':sort==='duration'?run.duration_ms??-1:
    sort==='events'?run.event_count??-1:sort==='status'?run.status||'':start(run);
  rows.sort((a,b)=>{const left=value(a),right=value(b),order=left<right?-1:left>right?1:0;
    return(dir==='asc'?order:-order)||(a.id<b.id?-1:a.id>b.id?1:0);});
  return {runs:rows.slice(offset,offset+limit),total:rows.length,offset,limit,truncated:false,
    next:offset+limit<rows.length?String(offset+limit):null};
}
