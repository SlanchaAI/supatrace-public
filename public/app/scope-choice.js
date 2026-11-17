// Preferences are hints, never authority: restore only projects and environments
// returned for the current account before issuing trace/key reads.
const accountKey='supatrace.scope.account';
const choiceKey=account=>'supatrace.scope:'+account;
export function restoreScope({account,defaultProject,projects,search='',storage}){
 let saved=null,changed=false;
 try{
  storage??=globalThis.localStorage;
  const previous=storage.getItem(accountKey);
  changed=!!previous&&previous!==account;
  if(changed)storage.removeItem(choiceKey(previous));
  storage.setItem(accountKey,account);
  saved=JSON.parse(storage.getItem(choiceKey(account))??'null');
 }catch{/* Storage can be disabled; the current URL and defaults still work. */}
 const q=new URLSearchParams(changed?'':search);
 // Security enrollment returns to the personal workspace, regardless of saved scope.
 const explicit=q.has('workspace')||q.has('project')||q.has('environment')||q.has('mfa_org')||q.has('sso_org');
 const choice=explicit?{workspace:q.get('workspace'),project:q.get('project'),environment:q.get('environment')}:saved;
 const fallback=projects.find(p=>p.id===defaultProject);
 const selected=choice&&(choice.workspace||choice.project)?projects.find(p=>(!choice.workspace||(p.workspace_id??account)===choice.workspace)&&(!choice.project||p.id===choice.project)):choice?fallback:null;
 const project=selected??fallback;
 return {project,environment:selected&&typeof choice.environment==='string'?choice.environment:'default'};
}
export function scopeEnvironment(selected,environments,allowed){
 if(!Array.isArray(environments))throw Error('environment_unavailable');
 const available=environments.filter(e=>!Array.isArray(allowed)||allowed.includes(e.id));
 const environment=available.find(e=>e.id===selected)??available.find(e=>e.id==='default')??available[0];
 // No accessible environment means the caller must try the personal scope.
 return environment?.id??null;
}
export function saveScope(account,choice,storage){
 try{storage??=globalThis.localStorage;storage.setItem(accountKey,account);storage.setItem(choiceKey(account),JSON.stringify(choice));}catch{}
}
export function clearScope(account,storage){
 try{storage??=globalThis.localStorage;account??=storage.getItem(accountKey);if(account)storage.removeItem(choiceKey(account));if(storage.getItem(accountKey)===account)storage.removeItem(accountKey);}catch{}
}
