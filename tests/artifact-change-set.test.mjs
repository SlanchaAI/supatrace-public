import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {reviewArtifactChangeSet} from '../aws/change-set-guard.mjs';
import {readCompleteChangeSet, inspectArtifactChangeSet} from '../aws/review-artifact-change-set.mjs';
import {templateParameterNames, templateParameterDefaults} from '../aws/deploy-parameters.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const oldKey = `releases/${'a'.repeat(64)}/supatrace-lambda.zip`, newKey = `releases/${'b'.repeat(64)}/supatrace-lambda.zip`;
const bucket = 'supatrace-alpha-artifacts-123456789012-us-east-1';
const stackId = 'arn:aws:cloudformation:us-east-1:123456789012:stack/supatrace-alpha-retry-20261024/synthetic';
const id = 'arn:aws:cloudformation:us-east-1:123456789012:changeSet/synthetic/immutable-id';
const template = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8');

function fixture(reverse = false) {
  const [beforeKey, afterKey] = reverse ? [newKey, oldKey] : [oldKey, newKey];
  const stack = {StackId: stackId, StackName: 'supatrace-alpha-retry-20261024', StackStatus: 'UPDATE_COMPLETE',
    Parameters: [
      {ParameterKey: 'ArtifactBucket', ParameterValue: bucket}, {ParameterKey: 'ArtifactKey', ParameterValue: beforeKey},
      {ParameterKey: 'McpBridgeEnabled', ParameterValue: 'false'}, {ParameterKey: 'Domains', ParameterValue: 'supatrace.dev,supatrace.tech'},
      {ParameterKey: 'GoogleSecretArn', ParameterValue: 'synthetic-secret-reference'}
    ], Tags: [], NotificationARNs: [], RollbackConfiguration: {RollbackTriggers: []}};
  const defaults = templateParameterDefaults(template);
  for (const key of templateParameterNames(template)) if (!stack.Parameters.some(row => row.ParameterKey === key)) {
    stack.Parameters.push({ParameterKey: key, ParameterValue: defaults[key] ?? 'synthetic-value'});
  }
  const before = {Properties: {FunctionName: 'supatrace-alpha-api', Runtime: 'nodejs22.x', Handler: 'aws/handler.handler',
    Role: 'arn:aws:iam::123456789012:role/supatrace-alpha-api', Code: {S3Bucket: bucket, S3Key: beforeKey},
    Environment: {Variables: {MCP_BRIDGE_ENABLED: 'false'}}, Timeout: '15', MemorySize: '256', ReservedConcurrentExecutions: '1'}};
  const after = structuredClone(before);
  after.Properties.Code.S3Key = afterKey;
  const target = {Attribute: 'Properties', Name: 'Code', RequiresRecreation: 'Never', Path: '/Properties/Code',
    AttributeChangeType: 'Modify', BeforeValue: JSON.stringify(before.Properties.Code), AfterValue: JSON.stringify(after.Properties.Code)};
  const plan = {ChangeSetId: id, StackId: stackId, StackName: stack.StackName, ChangeSetName: 'synthetic',
    Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Capabilities: ['CAPABILITY_NAMED_IAM'],
    Parameters: stack.Parameters.map(row => row.ParameterKey === 'ArtifactKey' ? {...row, ParameterValue: afterKey} : {...row, UsePreviousValue: true}),
    Tags: [], NotificationARNs: [], RollbackConfiguration: structuredClone(stack.RollbackConfiguration),
    Changes: [{Type: 'Resource', ResourceChange: {LogicalResourceId: 'Api', PhysicalResourceId: 'supatrace-alpha-api',
      ResourceType: 'AWS::Lambda::Function', Action: 'Modify', Replacement: 'False', Scope: ['Properties'],
      BeforeContext: JSON.stringify(before), AfterContext: JSON.stringify(after), Details: [
        {Evaluation: 'Static', ChangeSource: 'ParameterReference', CausingEntity: 'ArtifactKey', Target: target},
        {Evaluation: 'Dynamic', ChangeSource: 'DirectModification', Target: {...target}}
      ]}}]};
  return {plan, stack, next: afterKey};
}

function review(f) { return reviewArtifactChangeSet(f.plan, f.stack, id, f.next, undefined, '123456789012'); }
function context(f, update) {
  const resource = f.plan.Changes[0].ResourceChange, after = JSON.parse(resource.AfterContext);
  update(after);
  resource.AfterContext = JSON.stringify(after);
}

test('forward and reverse artifact-only proposals are bound to the uploaded and captured artifacts', () => {
  for (const reverse of [false, true]) assert.deepEqual(review(fixture(reverse)), {problems: [], noChanges: false});
  const leaf = fixture(), details = leaf.plan.Changes[0].ResourceChange.Details;
  for (const detail of details) Object.assign(detail.Target, {Path: '/Properties/Code/S3Key', BeforeValue: oldKey, AfterValue: newKey});
  assert.deepEqual(review(leaf).problems, []);
});

const rejected = {
  'empty object': f => { f.plan = {}; },
  'unknown proposal setting': f => { f.plan.FutureSetting = 'new'; },
  'missing changes': f => { delete f.plan.Changes; },
  'empty ready proposal': f => { f.plan.Changes = []; },
  'mismatched change-set ARN': f => { f.plan.ChangeSetId += 'other'; },
  'foreign stack ARN': f => { f.plan.StackId += 'other'; },
  'unexpected stack account': f => { f.stack.StackId = f.plan.StackId = stackId.replace('123456789012', '000000000000'); },
  'unstable snapshot': f => { f.stack.StackStatus = 'UPDATE_IN_PROGRESS'; },
  'pending proposal': f => { f.plan.Status = 'CREATE_IN_PROGRESS'; },
  'obsolete proposal': f => { f.plan.ExecutionStatus = 'OBSOLETE'; },
  'unfinished pagination': f => { f.plan.NextToken = 'more'; },
  'nested proposal': f => { f.plan.RootChangeSetId = id; },
  'nested stacks enabled': f => { f.plan.IncludeNestedStacks = true; },
  'drift reconciliation mode': f => { f.plan.DeploymentMode = 'REVERT_DRIFT'; },
  'express deployment configuration': f => { f.plan.DeploymentConfig = {Mode: 'EXPRESS'}; },
  'disabled rollback': f => { f.plan.DeploymentConfig = {DisableRollback: true}; },
  'unreviewed hook': f => { f.plan.Changes[0].HookInvocationCount = 1; },
  'stack tag modification': f => { f.plan.Tags.push({Key: 'policy', Value: 'new'}); },
  'stack notification modification': f => { f.plan.NotificationARNs.push('synthetic-topic'); },
  'rollback configuration modification': f => { f.plan.RollbackConfiguration.MonitoringTimeInMinutes = 5; },
  'new parameter': f => { f.plan.Parameters.push({ParameterKey: 'New', ParameterValue: 'new'}); },
  'missing parameter': f => { f.plan.Parameters.pop(); },
  'duplicate parameter': f => { f.plan.Parameters.push(f.plan.Parameters[0]); },
  'MCP activation': f => { f.plan.Parameters.find(p => p.ParameterKey === 'McpBridgeEnabled').ParameterValue = 'true'; },
  'new default instead of preserved setting': f => { delete f.plan.Parameters[0].UsePreviousValue; f.plan.Parameters[0].ParameterValue = 'new-default'; },
  'unapproved artifact': f => { f.plan.Parameters.find(p => p.ParameterKey === 'ArtifactKey').ParameterValue = oldKey; },
  'artifact previous-value flag': f => { f.plan.Parameters.find(p => p.ParameterKey === 'ArtifactKey').UsePreviousValue = true; },
  'unexpected bucket': f => { context(f, c => { c.Properties.Code.S3Bucket = 'other'; }); },
  'other Code field': f => { context(f, c => { c.Properties.Code.S3ObjectVersion = 'new'; }); },
  'role modification hidden from Details': f => { context(f, c => { c.Properties.Role = 'new-role'; }); },
  'environment modification hidden from Details': f => { context(f, c => { c.Properties.Environment.Variables.MCP_BRIDGE_ENABLED = 'true'; }); },
  'timeout modification': f => { context(f, c => { c.Properties.Timeout = '30'; }); },
  'tag modification in context': f => { context(f, c => { c.Properties.Tags = [{Key: 'new', Value: 'new'}]; }); },
  'policy modification in context': f => { context(f, c => { c.UpdatePolicy = {new: true}; }); },
  'unresolved artifact': f => { context(f, c => { c.Properties.Code.S3Key = {Ref: 'ArtifactKey'}; }); },
  'context absent': f => { delete f.plan.Changes[0].ResourceChange.BeforeContext; },
  'context malformed': f => { f.plan.Changes[0].ResourceChange.AfterContext = '{'; },
  'missing details': f => { delete f.plan.Changes[0].ResourceChange.Details; },
  'empty details': f => { f.plan.Changes[0].ResourceChange.Details = []; },
  'wrong physical function': f => { f.plan.Changes[0].ResourceChange.PhysicalResourceId = 'other'; },
  'wrong logical function': f => { f.plan.Changes[0].ResourceChange.LogicalResourceId = 'Other'; },
  'conditional replacement': f => { f.plan.Changes[0].ResourceChange.Replacement = 'Conditional'; },
  'replacement': f => { f.plan.Changes[0].ResourceChange.Replacement = 'True'; },
  'metadata scope': f => { f.plan.Changes[0].ResourceChange.Scope.push('Metadata'); },
  'resource addition': f => { f.plan.Changes[0].ResourceChange.Action = 'Add'; },
  'resource removal': f => { f.plan.Changes[0].ResourceChange.Action = 'Remove'; },
  'resource import': f => { f.plan.Changes[0].ResourceChange.Action = 'Import'; },
  'resource dynamic action': f => { f.plan.Changes[0].ResourceChange.Action = 'Dynamic'; },
  'resource policy action': f => { f.plan.Changes[0].ResourceChange.PolicyAction = 'Retain'; },
  'unknown resource effect': f => { f.plan.Changes[0].ResourceChange.FutureEffect = true; },
  'non-artifact target': f => { f.plan.Changes[0].ResourceChange.Details[0].Target.Name = 'Role'; },
  'conditional recreation': f => { f.plan.Changes[0].ResourceChange.Details[0].Target.RequiresRecreation = 'Conditionally'; },
  'unknown evaluation': f => { f.plan.Changes[0].ResourceChange.Details[0].Evaluation = 'Unknown'; },
  'independent dynamic effect': f => { f.plan.Changes[0].ResourceChange.Details[1].Target.Path = '/Properties/Code/S3Key'; },
  'unresolved dynamic value': f => { f.plan.Changes[0].ResourceChange.Details[1].Target.AfterValue = '{"Ref":"Other"}'; },
  'dynamic without static proof': f => { f.plan.Changes[0].ResourceChange.Details.shift(); },
  'unrelated static parameter': f => { f.plan.Changes[0].ResourceChange.Details[0].CausingEntity = 'McpBridgeEnabled'; },
  'truncated or missing static value': f => { delete f.plan.Changes[0].ResourceChange.Details[0].Target.AfterValue; },
  'unknown property detail': f => { f.plan.Changes[0].ResourceChange.Details[0].Target.FutureEffect = true; },
  'in-place IAM modification': f => { f.plan.Changes.push({Type: 'Resource', ResourceChange: {LogicalResourceId: 'ApiRole', ResourceType: 'AWS::IAM::Role', Action: 'Modify', Replacement: 'False'}}); }
};
for (const [name, mutate] of Object.entries(rejected)) test(`artifact-only gate rejects ${name}`, () => {
  const f = fixture(); mutate(f);
  assert.ok(review(f).problems.length, name);
});

test('only documented standard rollback-enabled deployment config defaults are compatible', () => {
  for (const DeploymentConfig of [{}, {Mode: 'STANDARD'}, {DisableRollback: false}, {Mode: 'STANDARD', DisableRollback: false}]) {
    for (const reverse of [false, true]) {
      const f = fixture(reverse); f.plan.DeploymentConfig = DeploymentConfig;
      assert.deepEqual(review(f), {problems: [], noChanges: false});
    }
  }
  for (const DeploymentConfig of [null, [], false, 'STANDARD', 0, {Mode: null}, {DisableRollback: null}, {Mode: false},
    {DisableRollback: 'false'}, {Mode: 'EXPRESS'}, {DisableRollback: true}, {Mode: 'FUTURE'}, {Unknown: false}]) {
    const f = fixture(); f.plan.DeploymentConfig = DeploymentConfig;
    assert.ok(review(f).problems.length, JSON.stringify(DeploymentConfig));
  }
});

test('unsupported mode diagnostics disclose fixed fields and known values, never arbitrary response content', () => {
  const f = fixture();
  Object.assign(f.plan, {IncludeNestedStacks: true, ImportExistingResources: true, DeploymentMode: 'REVERT_DRIFT',
    StackDriftStatus: 'IN_SYNC', OnStackFailure: 'ROLLBACK', RootChangeSetId: id, ParentChangeSetId: 'PRIVATE_PARENT',
    DeploymentConfig: {Mode: 'PRIVATE_MODE', DisableRollback: 'PRIVATE_FLAG', PRIVATE_FIELD: 'PRIVATE_VALUE'}});
  const result = review(f);
  assert.ok(result.problems.length);
  assert.deepEqual(result.modeDiagnostic.unsupportedFields, ['IncludeNestedStacks', 'ParentChangeSetId', 'RootChangeSetId',
    'DeploymentMode', 'DeploymentConfig', 'StackDriftStatus', 'ImportExistingResources', 'OnStackFailure']);
  assert.equal(result.modeDiagnostic.metadata.RootChangeSetId.relation, 'self');
  assert.equal(result.modeDiagnostic.metadata.ParentChangeSetId.relation, 'other');
  assert.equal(result.modeDiagnostic.metadata.DeploymentConfig.unknownFieldCount, 1);
  assert.deepEqual(result.modeDiagnostic.metadata.DeploymentMode, {type: 'string', value: 'REVERT_DRIFT'});
  assert.doesNotMatch(JSON.stringify(result.modeDiagnostic), /PRIVATE_|BeforeContext|AfterContext|Parameters/);
});

test('only positively verified no-change results may bypass execution', () => {
  const f = fixture(); f.next = oldKey;
  f.plan.Parameters.find(p => p.ParameterKey === 'ArtifactKey').ParameterValue = oldKey;
  Object.assign(f.plan, {Changes: [], Status: 'FAILED', ExecutionStatus: 'UNAVAILABLE',
    StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set."});
  assert.deepEqual(review(f), {problems: [], noChanges: true});
  for (const mutate of [x => { x.next = newKey; }, x => { x.plan.StatusReason = 'Permission denied; did not contain changes'; }, x => { delete x.plan.Changes; }]) {
    const changed = structuredClone(f); mutate(changed); assert.ok(review(changed).problems.length);
  }
});

test('literal rollback settings must equal fresh state; masked settings must use previous values', () => {
  const f = fixture(true), flag = f.plan.Parameters.find(p => p.ParameterKey === 'McpBridgeEnabled');
  delete flag.UsePreviousValue;
  assert.deepEqual(review(f).problems, []);
  flag.ParameterValue = 'true';
  assert.ok(review(f).problems.length);
  const masked = fixture();
  masked.stack.Parameters.find(p => p.ParameterKey === 'GoogleSecretArn').ParameterValue = '****';
  const proposed = masked.plan.Parameters.find(p => p.ParameterKey === 'GoogleSecretArn');
  proposed.ParameterValue = '****';
  assert.deepEqual(review(masked).problems, []);
  delete proposed.UsePreviousValue;
  assert.ok(review(masked).problems.length);
});

test('masked NoEcho setting passes only when the submitted request kept its previous value', () => {
  // DescribeStacks and DescribeChangeSet both mask NoEcho values as **** and do
  // not echo UsePreviousValue, so the submitted request is the only proof.
  const f = fixture();
  f.stack.Parameters.find(p => p.ParameterKey === 'ImportPolicyConfig').ParameterValue = '****';
  f.plan.Parameters = f.stack.Parameters.map(({ParameterKey, ParameterValue}) =>
    ({ParameterKey, ParameterValue: ParameterKey === 'ArtifactKey' ? newKey : ParameterValue}));
  const submitted = f.stack.Parameters.map(({ParameterKey}) =>
    ParameterKey === 'ArtifactKey' ? {ParameterKey, ParameterValue: newKey} : {ParameterKey, UsePreviousValue: true});
  const check = rows => reviewArtifactChangeSet(f.plan, f.stack, id, f.next, rows, '123456789012').problems;
  assert.deepEqual(check(submitted), []);
  const literal = submitted.map(row => row.ParameterKey === 'ImportPolicyConfig' ? {ParameterKey: row.ParameterKey, ParameterValue: 'changed'} : row);
  assert.deepEqual(check(literal), ['non-artifact parameter was not preserved']);
  const both = submitted.map(row => row.ParameterKey === 'ImportPolicyConfig' ? {...row, ParameterValue: 'changed'} : row);
  assert.deepEqual(check(both), ['non-artifact parameter was not preserved']);
  assert.deepEqual(check(undefined), ['non-artifact parameter was not preserved']);
  assert.deepEqual(check([...submitted, submitted.find(row => row.ParameterKey === 'ImportPolicyConfig')]), ['non-artifact parameter was not preserved']);
});

test('all pages are consumed and unsafe later-page changes are not discarded', () => {
  const f = fixture(), seen = [];
  const first = {...f.plan, NextToken: 'second'}, second = {...f.plan, Changes: [rejectedResource()]};
  function fetchPage(token) { seen.push(token); return token ? second : first; }
  const result = readCompleteChangeSet(fetchPage);
  assert.deepEqual(seen, [undefined, 'second']);
  assert.equal(result.Changes.length, 2);
  assert.throws(() => inspectArtifactChangeSet({accountId: '123456789012', stack: f.stack, changeSetId: id, artifactKey: newKey, fetchPage}), /exactly one/);
});
function rejectedResource() { return {Type: 'Resource', ResourceChange: {LogicalResourceId: 'ApiRole', Action: 'Modify', Replacement: 'False'}}; }

test('pagination rejects malformed pages, repeated tokens, bounds and metadata changes', () => {
  const {plan} = fixture();
  for (const page of [{}, null, {...plan, Changes: null}, {...plan, NextToken: ''}, {...plan, NextToken: 1}]) assert.throws(() => readCompleteChangeSet(() => page));
  assert.throws(() => readCompleteChangeSet(() => ({...plan, NextToken: 'repeat'})), /repeated/);
  let n = 0;
  assert.throws(() => readCompleteChangeSet(() => ({...plan, NextToken: String(n++)})), /exceeded/);
  for (const change of [{ChangeSetId: id + 'new'}, {StackId: stackId + 'new'}, {Status: 'FAILED'}, {ExecutionStatus: 'OBSOLETE'}, {Parameters: []}]) {
    assert.throws(() => readCompleteChangeSet(token => token ? {...plan, ...change} : {...plan, NextToken: 'next'}), /metadata changed/);
  }
});

// Execute the actual workflow shell sections with a synthetic CLI. The only AWS
// binary visible to these tests logs local calls and returns these local fixtures.
function runWorkflow(reverse, unsafe = false, noChanges = false, malformed = false, {failure = '', reviewOnly = false, planMetadata = {}} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-release-'));
  try {
    const f = fixture(reverse), initial = fixture().stack;
    Object.assign(f.plan, planMetadata);
    // Like AWS: NoEcho values read back as ****, and proposals do not echo UsePreviousValue.
    for (const rows of [f.stack.Parameters, initial.Parameters, f.plan.Parameters]) rows.find(p => p.ParameterKey === 'ImportPolicyConfig').ParameterValue = '****';
    if (noChanges) {
      f.next = f.stack.Parameters.find(p => p.ParameterKey === 'ArtifactKey').ParameterValue;
      f.plan.Parameters.find(p => p.ParameterKey === 'ArtifactKey').ParameterValue = f.next;
      Object.assign(f.plan, {Changes: [], Status: 'FAILED', ExecutionStatus: 'UNAVAILABLE', StatusReason: "The submitted information didn't contain changes."});
    }
    const pages = unsafe ? [{...f.plan, NextToken: 'later'}, {...f.plan, Changes: [rejectedResource()]}] : [f.plan];
    mkdirSync(join(dir, 'bin')); cpSync(join(root, 'aws'), join(dir, 'aws'), {recursive: true});
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({stack: f.stack, pages, malformed}));
    writeFileSync(join(dir, 'current-parameters.json'), JSON.stringify(initial.Parameters));
    writeFileSync(join(dir, 'bin/aws'), `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2); const f=JSON.parse(fs.readFileSync(process.env.FIXTURE));\nfs.appendFileSync(process.env.CALLS,JSON.stringify(args)+'\\n');\nconst value=flag=>args[args.indexOf(flag)+1];\nif(args[0]!=='cloudformation') process.exit(99);\nswitch(args[1]) {\ncase 'describe-stacks': console.log(JSON.stringify({Stacks:[f.stack]})); break;\ncase 'create-change-set': {\n const request=JSON.parse(fs.readFileSync(value('--parameters').replace('file://','')));\n for(const page of f.pages) page.Parameters=request.map(row=>row.UsePreviousValue===true ? {...f.stack.Parameters.find(p=>p.ParameterKey===row.ParameterKey)} : row);\n fs.writeFileSync(process.env.FIXTURE,JSON.stringify(f));\n console.log(${JSON.stringify(id)}); break; } \ncase 'wait': if(args[2]==='stack-update-complete'&&process.env.FAILURE==='wait') process.exit(90); break;\ncase 'delete-change-set': break;\ncase 'describe-change-set':\n if(f.malformed) {console.log('synthetic-private-value');break;}\n if(!args.includes('--include-property-values')||!args.includes('--no-paginate')||value('--change-set-name')!==${JSON.stringify(id)}) process.exit(98);\n console.log(JSON.stringify(f.pages[args.includes('--next-token')?1:0])); break;\ncase 'execute-change-set': if(process.env.FAILURE==='execute') process.exit(89); if(value('--change-set-name')!==${JSON.stringify(id)}) process.exit(97); break;\ndefault: process.exit(96);\n}\n`, {mode: 0o755});
    let shell;
    if (!reverse) shell = workflow.split('      - name: Create and review an update change set\n')[1].split('        run: |\n')[1].split('      - name: Publish static')[0];
    else shell = '          set -euo pipefail\n' + workflow.split('          node aws/deploy-parameters.mjs aws/template.yaml current-parameters.json "$PREVIOUS_ARTIFACT_KEY" restore > rollback-parameters.json\n')[1].split('          echo "Restored ArtifactKey')[0];
    if (reverse) shell = shell.replace('          # Bind', '          node aws/deploy-parameters.mjs aws/template.yaml current-parameters.json "$PREVIOUS_ARTIFACT_KEY" restore > rollback-parameters.json\n          # Bind');
    if (reviewOnly) {
      writeFileSync(join(dir, 'current-stack.json'), JSON.stringify({Stacks: [f.stack]}));
      shell = 'node aws/review-artifact-change-set.mjs current-stack.json "$REVIEW_ID" "$ARTIFACT_KEY" review.json';
    }
    shell = shell.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const run = spawnSync('/bin/bash', ['-c', shell], {cwd: dir, encoding: 'utf8', env: {...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAILURE: failure, REVIEW_ID: id, FIXTURE: join(dir, 'fixture.json'), CALLS: join(dir, 'calls'),
      AWS_ACCOUNT_ID: '123456789012', STACK_NAME: f.stack.StackName, ARTIFACT_KEY: f.next, PREVIOUS_ARTIFACT_KEY: oldKey, MCP_BRIDGE_MODE: 'preserve',
      GITHUB_RUN_ID: 'synthetic', GITHUB_ENV: join(dir, 'env'), GITHUB_OUTPUT: join(dir, 'output')}});
    const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
    return {run, calls};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

const markers = run => run.stderr.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
const reviewMarker = (reverse, noChanges = false) => ({StackId: stackId, ChangeSetId: id,
  PreviousArtifactKey: reverse ? newKey : oldKey,
  IntendedArtifactKey: noChanges ? oldKey : reverse ? oldKey : newKey,
  outcome: noChanges ? 'verified-no-change' : 'artifact-only-approved'});

for (const reverse of [false, true]) test(`actual ${reverse ? 'rollback' : 'forward'} workflow executes only its reviewed immutable ARN and blocks a late unsafe page`, () => {
  const safe = runWorkflow(reverse);
  assert.equal(safe.run.status, 0, safe.run.stderr);
  assert.equal(safe.calls.filter(row => row[1] === 'execute-change-set').length, 1);
  assert.deepEqual(markers(safe.run), [reviewMarker(reverse), {ChangeSetId: id, outcome: 'stack-update-complete'}]);
  assert.doesNotMatch(safe.run.stderr, /BeforeContext|AfterContext|Parameters|synthetic-secret-reference/);
  const unsafe = runWorkflow(reverse, true);
  assert.equal(unsafe.run.status, 1, unsafe.run.stderr);
  assert.equal(unsafe.calls.filter(row => row[1] === 'execute-change-set').length, 0);
  assert.equal(unsafe.calls.filter(row => row[1] === 'delete-change-set').length, 1);
  assert.deepEqual(markers(unsafe.run), []);
});

for (const reverse of [false, true]) {
  test(`${reverse ? 'rollback' : 'forward'} standard config passes; unsupported config logs sanitized rejection without approval or execution`, () => {
    const safe = runWorkflow(reverse, false, false, false, {planMetadata: {DeploymentConfig: {Mode: 'STANDARD', DisableRollback: false}}});
    assert.equal(safe.run.status, 0, safe.run.stderr);
    assert.deepEqual(markers(safe.run), [reviewMarker(reverse), {ChangeSetId: id, outcome: 'stack-update-complete'}]);
    const bad = runWorkflow(reverse, false, false, false, {planMetadata: {DeploymentConfig: {Mode: 'EXPRESS', PRIVATE_FIELD: 'PRIVATE_VALUE'}}});
    assert.equal(bad.run.status, 1);
    assert.equal(bad.calls.filter(row => row[1] === 'execute-change-set').length, 0);
    const [diagnostic] = markers(bad.run);
    assert.equal(markers(bad.run).length, 1);
    assert.equal(diagnostic.outcome, 'artifact-only-rejected');
    assert.equal(diagnostic.StackId, stackId);
    assert.equal(diagnostic.ChangeSetId, id);
    assert.deepEqual(diagnostic.unsupportedFields, ['DeploymentConfig']);
    assert.deepEqual(diagnostic.metadata.DeploymentConfig.Mode, {type: 'string', value: 'EXPRESS'});
    assert.doesNotMatch(bad.run.stderr, /PRIVATE_|BeforeContext|AfterContext|Parameters|synthetic-secret-reference/);
  });
  test(`${reverse ? 'rollback' : 'forward'} reviewer stdout stays exactly the ARN; approval alone is not completion`, () => {
    const {run, calls} = runWorkflow(reverse, false, false, false, {reviewOnly: true});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, id + '\n');
    assert.deepEqual(markers(run), [reviewMarker(reverse)]);
    assert.equal(calls.filter(row => row[1] === 'execute-change-set').length, 0);
  });
  for (const failure of ['execute', 'wait']) test(`${reverse ? 'rollback' : 'forward'} ${failure} failure produces approval but no completion`, () => {
    const {run} = runWorkflow(reverse, false, false, false, {failure});
    assert.notEqual(run.status, 0);
    assert.deepEqual(markers(run), [reviewMarker(reverse)]);
  });
}

test('actual workflow never executes a verified no-change proposal', () => {
  const {run, calls} = runWorkflow(false, false, true);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(calls.filter(row => row[1] === 'execute-change-set').length, 0);
  assert.equal(calls.filter(row => row[1] === 'delete-change-set').length, 1);
  assert.deepEqual(markers(run), [reviewMarker(false, true)]);
  const direct = runWorkflow(false, false, true, false, {reviewOnly: true});
  assert.equal(direct.run.status, 0, direct.run.stderr);
  assert.equal(direct.run.stdout, 'NO_CHANGES\n');
  assert.deepEqual(markers(direct.run), [reviewMarker(false, true)]);
});

test('malformed AWS response blocks execution without logging response values', () => {
  const {run, calls} = runWorkflow(false, false, false, true);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /invalid DescribeChangeSet JSON/);
  assert.doesNotMatch(run.stderr + run.stdout, /synthetic-private-value/);
  assert.equal(calls.filter(row => row[1] === 'execute-change-set').length, 0);
  assert.deepEqual(markers(run), []);
});

test('release preserves OIDC, serialization, exact CI and static rollback order without introducing another route', () => {
  for (const text of ['environment: production', 'role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}', 'group: supatrace-production',
    'cancel-in-progress: false', 'uses: ./.github/workflows/ci.yml', 'needs.verify.result == \'success\'', 'ref: ${{ github.sha }}']) assert.ok(workflow.includes(text), text);
  assert.equal((workflow.match(/execute-change-set/g) || []).length, 2);
  assert.equal((workflow.match(/REVIEWED_ID=\$\(node aws\/review-artifact-change-set.mjs/g) || []).length, 2);
  assert.ok(workflow.indexOf('aws s3 cp static-snapshot/') < workflow.indexOf('> rollback-stack.json'));
  assert.ok(workflow.indexOf('static-snapshot/ "s3://${STATIC_BUCKET}/" --delete') < workflow.indexOf('> rollback-stack.json'));
  assert.doesNotMatch(workflow, /aws login|aws sso|lambda update-function|--role-arn|--tags|--notification-arns/);
});
