// Projects share organization billing and quotas; their traces, keys and environments stay separate.
import {switchAllowed} from './switch-guard.js';
const messages={plan_limit_reached:'This organization has reached its project limit. Upgrade in Billing.',workspace_admin_required:'Only organization owners and admins can manage projects.',invalid_project:'Type the project ID exactly to confirm deletion.',invalid_workspace_name:'Use a project name of 1 to 60 characters.',workspace_changed:'The organization changed. Reload and try again.'};
async function request(path,body){
 const query=new URLSearchParams(),workspace=new URLSearchParams(location.search).get('workspace')??document.documentElement.dataset.workspace;
 if(workspace&&path!=='projects')query.set('workspace',workspace);
 if(workspace&&body!==undefined)query.set('workspace',workspace);
 const raw=body===undefined?undefined:JSON.stringify(body),headers={};
 if(raw){headers['Content-Type']='application/json';headers['x-amz-content-sha256']=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),v=>v.toString(16).padStart(2,'0')).join('');}
 const r=await fetch('/api/'+path+(query.size?'?'+query:''),{method:raw?'POST':'GET',body:raw,headers,credentials:'same-origin',cache:'no-store'}),value=await r.json();
 if(!r.ok)throw new Error(value.error??'request_failed');return value;
}
export function validateProjects(data){
 if(!data||!Array.isArray(data.projects)||!data.projects.length||data.projects.length>500)throw Error('invalid_response');
 for(const p of data.projects)if(!/^proj_[a-f0-9]{32}$/.test(p?.id??'')||typeof p.name!=='string'||!p.name||typeof p.workspace_id!=='string'||!['owner','admin','developer','viewer'].includes(p.role))throw Error('invalid_response');
 return data;
}
export const projectUrl=(pathname,workspace,project)=>pathname+'?workspace='+encodeURIComponent(workspace)+(project?'&project='+encodeURIComponent(project):'')+'&environment=default#home';
export function openProject(projects,search){
 const q=new URLSearchParams(search||''),workspace=q.get('workspace'),project=q.get('project');
 if(project)return projects.find(p=>p.id===project&&(!workspace||p.workspace_id===workspace))??null;
 if(workspace)return projects.find(p=>p.workspace_id===workspace)??null;
 return projects.find(p=>p.personal)??null;
}
const PANEL='<h2>Projects</h2><p>Projects separate traces, keys and environments. All projects in an organization share its members, billing and usage limits.</p><p id="projects-status" role="status"></p><ul id="project-list" aria-label="Projects"></ul><p id="projects-count" class="hint"></p><form id="rename-project" hidden><h3>Rename this project</h3><label>Project name<input name="name" maxlength="60" required></label><button type="submit">Rename project</button></form><form id="create-project"><h3>Create project</h3><p>Add a project to the organization currently open. Its plan limits apply.</p><label>Project name<input name="name" placeholder="My project" maxlength="60" required></label><button type="submit">Create project</button></form>';
export function mountProjects(document,{api=request,navigate=url=>location.assign(url),reload=()=>location.reload()}={}){
 const settings=document.querySelector('#view-settings .settings');if(!settings||document.getElementById('projects-section'))return null;
 const section=document.createElement('div');section.className='setting';section.id='projects-section';section.innerHTML=PANEL;settings.insertBefore(section,settings.children[1]??null);
 const remove=document.createElement('form');remove.id='delete-project';remove.hidden=true;remove.innerHTML='<h3>Delete this project</h3><p>Ends access immediately. Traces and keys are permanently erased after active requests drain. Recovery backups expire within 35 days. Default project stays.</p><label>Type the project ID to confirm<input name="confirm" required autocomplete="off"></label><button type="submit">Delete project</button>';section.append(remove);
 const $=id=>document.getElementById(id),status=$('projects-status'),list=$('project-list'),rename=$('rename-project'),create=$('create-project');let version=0,loaded=false,current=null;
 const fail=error=>{status.textContent=messages[error?.message]??'Projects could not be saved. Reload and try again.';};
 const blocked=()=>{if(switchAllowed())return false;status.textContent='Finish or cancel the current operation before changing projects.';return true;};
 const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
 async function refresh(initial){
  const mine=++version;status.textContent='Loading projects…';
  try{const data=validateProjects(initial??await api('projects'));if(mine!==version)return false;current=openProject(data.projects,location.search);
   list.replaceChildren(...data.projects.map(p=>{const li=el('li','');li.dataset.project=p.id;li.dataset.organization=p.workspace_id;li.append(el('strong',p.name),el('span',' · '+p.workspace_name+' · '+p.role+' · '),el('code',p.id));
    if(p.id===current?.id){li.dataset.current='true';li.append(el('span',' · open now'));}else{const b=el('button','Open project');b.type='button';b.setAttribute('aria-label','Open project '+p.name);b.onclick=()=>{if(!blocked())navigate(projectUrl(location.pathname,p.workspace_id,p.id));};li.append(' ',b);}return li;}));
   const manageable=current&&['owner','admin'].includes(current.role)&&!Array.isArray(current.environments);rename.hidden=create.hidden=!manageable;
   remove.hidden=!manageable||data.projects.find(p=>p.workspace_id===current.workspace_id)?.id===current.id;
   if(manageable&&document.activeElement!==rename.elements.name)rename.elements.name.value=current.name;
   $('projects-count').textContent=current?data.projects.filter(p=>p.workspace_id===current.workspace_id).length+' projects in this organization. See Billing for its plan limit.':'';loaded=true;status.textContent='';return true;
  }catch(error){if(mine===version){list.replaceChildren();rename.hidden=create.hidden=remove.hidden=true;fail(error);}return false;}
 }
 const submit=(form,action)=>form.addEventListener('submit',event=>{event.preventDefault();if(blocked())return;const b=form.querySelector('button');b.disabled=true;status.textContent='Saving…';void action(form.elements.name.value).catch(fail).finally(()=>{b.disabled=false;});});
 submit(create,async name=>{const made=await api('projects',{name});if(!/^proj_[a-f0-9]{32}$/.test(made?.id??'')||typeof made.workspace_id!=='string')throw Error('invalid_response');if(!switchAllowed()){await refresh();status.textContent='Project created. Open it when the current operation finishes.';return;}navigate(projectUrl(location.pathname,made.workspace_id,made.id));});
 submit(rename,async name=>{if(!current)return;await api('projects/rename',{id:current.id,name});if(!switchAllowed()){await refresh();return;}reload();});
 remove.addEventListener('submit',event=>{event.preventDefault();if(!current||blocked())return;const button=remove.querySelector('button');button.disabled=true;status.textContent='Deleting project…';void api('projects/delete',{id:current.id,confirm:remove.elements.confirm.value}).then(()=>navigate(projectUrl(location.pathname,current.workspace_id,null))).catch(fail).finally(()=>{button.disabled=false;});});
 function reset(){version++;loaded=false;current=null;list.replaceChildren();status.textContent='';rename.hidden=create.hidden=remove.hidden=true;}
 const sync=()=>{if(!document.body.classList.contains('signed-in')){if(loaded)reset();return;}if(!loaded)void refresh();};new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['class']});sync();return {refresh,reset};
}
export const projectsPanel=typeof document !== 'undefined'?mountProjects(document):null;
