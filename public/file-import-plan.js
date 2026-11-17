// Local command preparation only. No file reads, network, storage or execution.
export const formats = ['langsmith','braintrust','weave','opik','datadog','mlflow','helicone','otlp'];
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function prepareFileImport({input,format,namespace,project,directory,jsonl=false,content=false}) {
  if(!formats.includes(format)) throw Error('Choose a supported file format.');
  for(const path of [input,directory]) if(typeof path!=='string'||!path.startsWith('/')||path.length>4096||/[\u0000-\u001f\u007f]/.test(path)) throw Error('Use explicit absolute paths without control characters.');
  if(input===directory) throw Error('Choose a separate private staging directory.');
  if(typeof namespace!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(namespace)) throw Error('Use a stable source namespace: 1–200 letters, numbers, dots, underscores, colons or hyphens.');
  if(!/^proj_[a-f0-9]{32}$/.test(project||'')) throw Error('Copy the complete destination project ID from Agents.');
  if(typeof jsonl!=='boolean'||typeof content!=='boolean') throw Error('Choose content and encoding explicitly.');
  const args=['agent/import_traces.mjs',input,format,namespace,project,directory];
  if(jsonl)args.push('--jsonl');
  if(content)args.push('--include-content');
  return 'node '+args.map(quote).join(' ');
}
export function mountFileImport(document) {
  const form=document.getElementById('file-import-plan'); if(!form)return;
  const output=document.getElementById('file-import-command'),status=document.getElementById('file-import-status');
  const clear=()=>{output.textContent='';output.hidden=true;status.textContent='';};
  form.addEventListener('input',clear);form.addEventListener('change',clear);
  form.addEventListener('submit',event=>{event.preventDefault();clear();try{
    const value=id=>document.getElementById(id).value;
    output.textContent=prepareFileImport({input:value('file-source'),format:value('file-format'),namespace:value('file-namespace'),project:value('file-project'),directory:value('file-directory'),jsonl:document.getElementById('file-jsonl').checked,content:document.getElementById('file-content').checked});
    output.hidden=false;status.textContent='Staging command ready. Review it, then run it from the repository checkout. No upload was started.';
  }catch(error){status.textContent=error.message;}});
  document.defaultView.addEventListener('pagehide',()=>{clear();form.reset();});
}
if(typeof document!=='undefined')mountFileImport(document);
