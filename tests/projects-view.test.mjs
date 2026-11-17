import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProjects,projectUrl,openProject} from '../public/app/projects.js';
const projects=[{id:'proj_'+'1'.repeat(32),name:'Default',workspace_id:'github-1',personal:true,role:'owner'},{id:'proj_'+'2'.repeat(32),name:'Staging',workspace_id:'github-1',personal:true,role:'owner'},{id:'proj_'+'3'.repeat(32),name:'Other',workspace_id:'github-2',role:'viewer'}];
test('project response validation and exact workspace/project selection',()=>{
 assert.deepEqual(validateProjects({projects}),{projects});
 for(const bad of [{},{projects:[]},{projects:[{...projects[0],id:'invalid'}]},{projects:[{...projects[0],role:'root'}]}])assert.throws(()=>validateProjects(bad),/invalid_response/);
 assert.equal(openProject(projects,''),projects[0]);assert.equal(openProject(projects,'?workspace=github-1&project='+projects[1].id),projects[1]);
 assert.equal(openProject(projects,'?workspace=github-2&project='+projects[1].id),null);assert.equal(openProject(projects,'?project='+projects[2].id),projects[2]);
 assert.equal(projectUrl('/app/','github-1',projects[1].id),'/app/?workspace=github-1&project='+projects[1].id+'&environment=default#home');
});
