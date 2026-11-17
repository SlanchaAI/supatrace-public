// Test/staging adapter only. The product app is left untouched for serial
// integration after the startup PR. Refuse to rewrite an unexpected writer.
import {createHash} from 'node:crypto';
export const originalWriterHash = 'e791ae29b2f7c0a3b98265f48fc80fa35dee19c0c047bb848bd61637c49ec5ba';
const importLine = "import {saveTraceFile} from './trace-export.js';\n";
const replacement = `async function saveRunFile(id,signal,pick,project=activeProject,environment=activeEnvironment,workspace=activeWorkspace){
 $('status').textContent='Exporting original trace… Choose a file if prompted.';
 return saveTraceFile({runId:id,projectId:project,environmentId:environment,signal,pick,readEvents:(run,readSignal,sink,boundProject)=>allEvents(run,readSignal,sink,boundProject,{environmentId:environment,workspaceId:workspace}),onCommit:()=>{$('cancel-export').disabled=true;$('status').textContent='Saving completed export…';}});
}`;
export function integrateTraceWriter(source) {
  const start = source.indexOf('async function saveRunFile(');
  const end = source.indexOf('\nfunction cancelDetailLoad', start);
  if (start < 0 || end < 0) throw Error('trace_writer_integration_target_missing');
  const current = source.slice(start, end);
  if (current === replacement && source.includes(importLine)) return source;
  if (createHash('sha256').update(current).digest('hex') !== originalWriterHash) throw Error('trace_writer_integration_target_changed');
  return importLine + source.slice(0, start) + replacement + source.slice(end);
}
