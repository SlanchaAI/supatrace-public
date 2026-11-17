import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreScope,saveScope,clearScope,scopeEnvironment} from '../public/app/scope-choice.js';
const projects=[{id:'default',workspace_id:'one'},{id:'second',workspace_id:'one'},{id:'team',workspace_id:'shared'}];
function fixture(){const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};return {data,storage,restore:options=>restoreScope({account:'one',defaultProject:'default',projects,storage,...options})};}
test('first visit chooses Default; validated account preferences survive a clean URL and explicit links win',()=>{
 const f=fixture();assert.equal(f.restore().project.id,'default');
 saveScope('one',{workspace:'shared',project:'team',environment:'dev'},f.storage);
 assert.deepEqual(f.restore(),{project:projects[2],environment:'dev'});
 for(const search of ['?mfa_org=Team','?sso_org=Team'])assert.deepEqual(f.restore({search}),{project:projects[0],environment:'default'});
 assert.deepEqual(f.restore({search:'?environment=dev'}),{project:projects[0],environment:'dev'});
 assert.deepEqual(f.restore({search:'?workspace=one&project=second&environment=production'}),{project:projects[1],environment:'production'});
});
test('deleted projects, workspaces, malformed preferences and unavailable environments fall back',()=>{
 const f=fixture();
 for(const choice of [{workspace:'gone',project:'second',environment:'dev'},{workspace:'one',project:'gone',environment:'dev'}]){saveScope('one',choice,f.storage);assert.deepEqual(f.restore(),{project:projects[0],environment:'default'});}
 f.data.set('supatrace.scope:one','{');assert.equal(f.restore().project.id,'default');
 const environments=[{id:'default'},{id:'dev'},{id:'production'}];
 assert.equal(scopeEnvironment('gone',environments),'default');assert.equal(scopeEnvironment('dev',environments),'dev');
 assert.equal(scopeEnvironment('default',environments,['production']),'production');
 assert.equal(scopeEnvironment('default',environments,[]),null);
 assert.equal(scopeEnvironment('dev',[],['dev']),null);
 assert.equal(scopeEnvironment('dev',[{id:'default'}],['dev']),null);
 assert.equal(scopeEnvironment('dev',[{id:'qa'}],['dev','qa']),'qa');
 assert.throws(()=>scopeEnvironment('default',undefined),/environment_unavailable/);
});
test('account change clears the old preference and discards the previous account URL, even for shared membership',()=>{
 const f=fixture();saveScope('one',{workspace:'shared',project:'team',environment:'dev'},f.storage);
 const result=f.restore({account:'two',defaultProject:'two-default',projects:[...projects,{id:'two-default',workspace_id:'two'}],search:'?workspace=shared&project=team&environment=dev'});
 assert.equal(result.project.id,'two-default');assert.equal(result.environment,'default');assert.equal(f.data.has('supatrace.scope:one'),false);
 saveScope('two',{workspace:'two',project:'two-default',environment:'default'},f.storage);clearScope('two',f.storage);assert.equal(f.data.has('supatrace.scope:two'),false);assert.equal(f.data.has('supatrace.scope.account'),false);
});
test('disabled storage never blocks startup or sign-out',()=>{
 const storage={getItem(){throw Error('disabled');},setItem(){throw Error('disabled');},removeItem(){throw Error('disabled');}};
 assert.equal(restoreScope({account:'one',defaultProject:'default',projects,storage}).project.id,'default');
 const f=fixture();saveScope('one',{project:'second'},f.storage);clearScope(null,f.storage);assert.equal(f.data.size,0);
 saveScope('one',{},storage);clearScope('one',storage);
});
