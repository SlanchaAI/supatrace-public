import {HttpError} from './http.mjs';
const cursor=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&/^[A-Za-z0-9_-]+$/.test(value);

// Bounded continuation over the existing tenant index. No new table/index or writes.
export async function accountRunsPage(store,tenant,url,{projectId,runView}) {
  for(const name of url.searchParams.keys()) {
    if(!['project','after','workspace','environment'].includes(name)||url.searchParams.getAll(name).length!==1)throw new HttpError(400,'invalid_query');
  }
  let after=url.searchParams.get('after')??null;
  if(after!==null&&!cursor(after))throw new HttpError(400,'invalid_cursor');
  const seen=new Set(after?[after]:[]),runs=[];
  for(let page=0;page<8;page++) {
    const result=await store.listRuns(tenant,{cursor:after,limit:100});
    if(!result||!Array.isArray(result.items)||result.items.length>100||
      (result.next!==null&&(!cursor(result.next)||seen.has(result.next))))throw new HttpError(503,'run_index_unavailable');
    runs.push(...result.items.map(runView));
    after=result.next;
    if(after===null)break;
    seen.add(after);
  }
  return {project_id:projectId,runs,next:after,complete:after===null};
}
