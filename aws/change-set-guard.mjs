import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const STATEFUL_RESOURCES = [
  {logicalId: 'Metadata', type: 'AWS::DynamoDB::Table', name: 'TableName: supatrace-alpha-metadata'},
  {logicalId: 'Payloads', type: 'AWS::S3::Bucket', name: "BucketName: !Sub 'supatrace-alpha-payloads-${AWS::AccountId}-us-east-1'"},
  {logicalId: 'Static', type: 'AWS::S3::Bucket', name: "BucketName: !Sub 'supatrace-alpha-static-${AWS::AccountId}-us-east-1'"},
  {logicalId: 'Api', type: 'AWS::Lambda::Function', name: 'FunctionName: supatrace-alpha-api'},
  {logicalId: 'ApiRole', type: 'AWS::IAM::Role', name: 'RoleName: supatrace-alpha-api'},
  {logicalId: 'Logs', type: 'AWS::Logs::LogGroup', name: 'LogGroupName: /aws/lambda/supatrace-alpha-api'}
];

export function resourceBlock(template, logicalId) {
  const marker = `\n  ${logicalId}:\n`;
  const start = template.indexOf(marker);
  if (start < 0) return '';
  const rest = template.slice(start + 1);
  const next = rest.slice(marker.length - 1).search(/\n  [A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, next + marker.length - 1);
}

export function statefulProblems(template) {
  const problems = [];
  for (const resource of STATEFUL_RESOURCES) {
    const block = resourceBlock(template, resource.logicalId);
    if (!block) problems.push(`${resource.logicalId} logical id missing`);
    else {
      if (!block.includes(`Type: ${resource.type}`)) problems.push(`${resource.logicalId} type changed`);
      if (!block.includes(resource.name)) problems.push(`${resource.logicalId} fixed name changed`);
    }
  }
  return problems;
}

const replacements = new Set(['True', 'Conditional', true]);
const removals = new Set(['Remove', 'Delete']);

export function reviewChangeSet(description) {
  const changes = description?.Changes || [];
  const problems = [];
  for (const change of changes) {
    const resource = change.ResourceChange || {};
    const id = resource.LogicalResourceId || '(unknown)';
    if (replacements.has(resource.Replacement)) problems.push(`${id} replacement ${resource.Replacement}`);
    if (removals.has(resource.Action)) problems.push(`${id} removal`);
  }
  return problems;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const artifactKey = value => typeof value === 'string' && /^releases\/[a-f0-9]{64}\/supatrace-lambda\.zip$/.test(value);
const same = isDeepStrictEqual;

function standardDeploymentConfig(config) {
  // AWS documents these optional fields and their defaults. No other value or
  // field is equivalent to the existing standard, rollback-enabled operation.
  return config === undefined || object(config) && Object.keys(config).every(key => ['Mode', 'DisableRollback'].includes(key)) &&
    (!Object.hasOwn(config, 'Mode') || config.Mode === 'STANDARD') &&
    (!Object.hasOwn(config, 'DisableRollback') || config.DisableRollback === false);
}

// Only fixed field names, boolean values and documented enums may reach logs.
// Arbitrary strings/objects (including unknown future fields) are never echoed.
export function proposalModeMetadata(plan, expectedId) {
  const scalar = (value, enums = []) => value === null ? {type: 'null'} :
    typeof value === 'boolean' || typeof value === 'string' && enums.includes(value) ? {type: typeof value, value} :
      {type: Array.isArray(value) ? 'array' : typeof value};
  const result = {};
  for (const key of ['IncludeNestedStacks', 'ImportExistingResources']) if (Object.hasOwn(plan, key)) result[key] = scalar(plan[key]);
  for (const key of ['ParentChangeSetId', 'RootChangeSetId']) if (Object.hasOwn(plan, key)) {
    result[key] = {...scalar(plan[key]), ...(typeof plan[key] === 'string' ? {relation: plan[key] === expectedId ? 'self' : 'other'} : {})};
  }
  for (const [key, enums] of [['DeploymentMode', ['REVERT_DRIFT']], ['StackDriftStatus', ['DRIFTED', 'IN_SYNC', 'NOT_CHECKED', 'UNKNOWN']],
    ['OnStackFailure', ['DELETE', 'DO_NOTHING', 'ROLLBACK']]]) if (Object.hasOwn(plan, key)) result[key] = scalar(plan[key], enums);
  if (Object.hasOwn(plan, 'DeploymentConfig')) {
    const config = plan.DeploymentConfig;
    result.DeploymentConfig = object(config) ? {
      type: 'object', unknownFieldCount: Object.keys(config).filter(key => !['Mode', 'DisableRollback'].includes(key)).length,
      ...(Object.hasOwn(config, 'Mode') ? {Mode: scalar(config.Mode, ['STANDARD', 'EXPRESS'])} : {}),
      ...(Object.hasOwn(config, 'DisableRollback') ? {DisableRollback: scalar(config.DisableRollback)} : {})
    } : scalar(config);
  }
  return result;
}

function parameters(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('parameters missing');
  const result = new Map();
  for (const row of rows) {
    if (!object(row) || typeof row.ParameterKey !== 'string' || result.has(row.ParameterKey)) throw new Error('ambiguous parameters');
    result.set(row.ParameterKey, row);
  }
  return result;
}

// This is deliberately narrower than the general replacement/removal check above.
// It is the release gate: no resource/settings update other than this Code.S3Key.
// `submitted` is the parameter list this runner sent to CreateChangeSet.
// DescribeChangeSet does not echo UsePreviousValue, and it masks NoEcho values
// as **** exactly as DescribeStacks does, so for a masked value the request is
// the only proof that CloudFormation kept the previous value.
const keptPrevious = (submitted, key) => {
  const rows = Array.isArray(submitted) ? submitted.filter(row => object(row) && row.ParameterKey === key) : [];
  return rows.length === 1 && rows[0].UsePreviousValue === true && !Object.hasOwn(rows[0], 'ParameterValue');
};

export function reviewArtifactChangeSet(plan, stack, expectedId, nextArtifact, submitted, accountId = process.env.AWS_ACCOUNT_ID) {
  const problems = [];
  let modeDiagnostic;
  try {
    if (!object(plan) || !object(stack)) throw new Error('proposal or stack snapshot missing');
    const planFields = ['Capabilities', 'Changes', 'ChangeSetId', 'ChangeSetName', 'CreationTime', 'Description', 'ExecutionStatus',
      'IncludeNestedStacks', 'NextToken', 'NotificationARNs', 'OnStackFailure', 'Parameters', 'ParentChangeSetId', 'RollbackConfiguration',
      'RootChangeSetId', 'StackId', 'StackName', 'Status', 'StatusReason', 'Tags', 'ImportExistingResources', 'DeploymentMode', 'DeploymentConfig', 'StackDriftStatus'];
    if (Object.keys(plan).some(key => !planFields.includes(key))) throw new Error('unknown proposal field');
    if (typeof accountId !== 'string' || !/^[0-9]{12}$/.test(accountId)) throw new Error('deployment account missing');
    const stackPrefix = `arn:aws:cloudformation:us-east-1:${accountId}:stack/supatrace-alpha-retry-20261024/`;
    const changePrefix = `arn:aws:cloudformation:us-east-1:${accountId}:changeSet/`;
    const stackSuffix = typeof stack.StackId === 'string' && stack.StackId.startsWith(stackPrefix) ? stack.StackId.slice(stackPrefix.length) : '';
    if (!stackSuffix || stackSuffix.includes('/') || stack.StackName !== 'supatrace-alpha-retry-20261024') throw new Error('unexpected stack');
    if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus)) throw new Error('stack is not stable');
    if (!(typeof expectedId === 'string' && expectedId.startsWith(changePrefix) && /^[^/]+\/[^/]+$/.test(expectedId.slice(changePrefix.length))) || plan.ChangeSetId !== expectedId || plan.StackId !== stack.StackId || plan.StackName !== stack.StackName) throw new Error('proposal identity mismatch');
    if (plan.NextToken != null) throw new Error('proposal pagination incomplete');
    const unsupportedFields = [
      ['IncludeNestedStacks', plan.IncludeNestedStacks != null && plan.IncludeNestedStacks !== false],
      ['ParentChangeSetId', Boolean(plan.ParentChangeSetId)], ['RootChangeSetId', Boolean(plan.RootChangeSetId)],
      ['DeploymentMode', Boolean(plan.DeploymentMode)], ['DeploymentConfig', !standardDeploymentConfig(plan.DeploymentConfig)],
      ['StackDriftStatus', plan.StackDriftStatus != null],
      ['ImportExistingResources', plan.ImportExistingResources != null && plan.ImportExistingResources !== false],
      ['OnStackFailure', Boolean(plan.OnStackFailure)]
    ].filter(([, unsupported]) => unsupported).map(([key]) => key);
    if (unsupportedFields.length) {
      modeDiagnostic = {StackId: plan.StackId, ChangeSetId: plan.ChangeSetId, unsupportedFields, metadata: proposalModeMetadata(plan, expectedId)};
      throw new Error('unsupported proposal mode');
    }
    if (!same(plan.Tags || [], stack.Tags || []) || !same(plan.NotificationARNs || [], stack.NotificationARNs || []) || !same(plan.RollbackConfiguration || {}, stack.RollbackConfiguration || {})) throw new Error('stack settings changed');
    if (!same(plan.Capabilities, ['CAPABILITY_NAMED_IAM'])) throw new Error('unexpected capabilities');
    const prior = parameters(stack.Parameters), proposed = parameters(plan.Parameters);
    if (prior.size !== proposed.size) throw new Error('parameter set changed');
    const oldArtifact = prior.get('ArtifactKey')?.ParameterValue;
    const bucket = prior.get('ArtifactBucket')?.ParameterValue;
    if (!artifactKey(oldArtifact) || !artifactKey(nextArtifact) || bucket !== `supatrace-alpha-artifacts-${accountId}-us-east-1`) throw new Error('unexpected artifact binding');
    for (const [key, before] of prior) {
      const after = proposed.get(key);
      if (!after) throw new Error('parameter missing');
      if (key === 'ArtifactKey') {
        if (after.UsePreviousValue === true || after.ParameterValue !== nextArtifact) throw new Error('artifact parameter mismatch');
      } else {
        // Rollback supplies a literal MCP snapshot. It is safe only if it equals
        // the fresh pre-rollback value. Masked values require UsePreviousValue,
        // either echoed in the proposal or proved by the submitted request.
        const masked = before.ParameterValue === '****';
        const unchanged = after.UsePreviousValue === true
          ? after.ParameterValue == null || after.ParameterValue === before.ParameterValue
          : (after.UsePreviousValue == null || after.UsePreviousValue === false) && typeof before.ParameterValue === 'string' &&
            after.ParameterValue === before.ParameterValue && (!masked || keptPrevious(submitted, key));
        if (!unchanged) throw new Error('non-artifact parameter was not preserved');
      }
    }
    if (!Array.isArray(plan.Changes)) throw new Error('changes missing');
    const noChanges = plan.Status === 'FAILED' && plan.ExecutionStatus === 'UNAVAILABLE' && plan.Changes.length === 0 &&
      /^The submitted information didn't contain changes\.(?: Submit different information to create a change set\.)?$/.test(plan.StatusReason || '') && oldArtifact === nextArtifact;
    if (noChanges) return {problems, noChanges: true};
    if (plan.Status !== 'CREATE_COMPLETE' || plan.ExecutionStatus !== 'AVAILABLE') throw new Error('proposal is not executable');
    if (plan.Changes.length !== 1 || oldArtifact === nextArtifact) throw new Error('expected exactly one artifact update');
    const change = plan.Changes[0], resource = change?.ResourceChange;
    if (change?.Type !== 'Resource' || !object(resource) || (change.HookInvocationCount != null && change.HookInvocationCount !== 0) ||
      Object.keys(change).some(key => !['Type', 'ResourceChange', 'HookInvocationCount'].includes(key))) throw new Error('unsupported change');
    const fields = ['Action', 'LogicalResourceId', 'PhysicalResourceId', 'ResourceType', 'Replacement', 'Scope', 'Details', 'BeforeContext', 'AfterContext'];
    if (Object.keys(resource).some(key => !fields.includes(key))) throw new Error('unsupported resource effect');
    if (resource.LogicalResourceId !== 'Api' || resource.ResourceType !== 'AWS::Lambda::Function' || resource.PhysicalResourceId !== 'supatrace-alpha-api' || resource.Action !== 'Modify' || resource.Replacement !== 'False' || !same(resource.Scope, ['Properties'])) throw new Error('only an in-place Api artifact update is allowed');
    const contexts = ['BeforeContext', 'AfterContext'].map(key => {
      if (typeof resource[key] !== 'string') throw new Error('property context missing');
      const context = JSON.parse(resource[key]);
      if (!object(context) || !object(context.Properties) || !object(context.Properties.Code)) throw new Error('property context incomplete');
      return context;
    });
    const [before, after] = contexts, codes = contexts.map(context => context.Properties.Code);
    for (const [index, code] of codes.entries()) {
      if (!same(Object.keys(code).sort(), ['S3Bucket', 'S3Key']) || code.S3Bucket !== bucket || code.S3Key !== [oldArtifact, nextArtifact][index]) throw new Error('code values are unresolved or differ from the pinned artifacts');
    }
    if (before.Properties.FunctionName !== 'supatrace-alpha-api' || after.Properties.FunctionName !== 'supatrace-alpha-api') throw new Error('function binding missing');
    const normalized = structuredClone(after);
    normalized.Properties.Code.S3Key = oldArtifact;
    if (!same(before, normalized)) throw new Error('non-artifact property/context changed');
    if (!Array.isArray(resource.Details) || !resource.Details.length) throw new Error('property details missing');
    const targets = new Set();
    const valueMatches = (value, path, index) => {
      if (path === '/Properties/Code/S3Key') return value === [oldArtifact, nextArtifact][index];
      if (typeof value !== 'string') return false;
      try { return same(JSON.parse(value), codes[index]); } catch { return false; }
    };
    for (const detail of resource.Details) {
      const target = detail?.Target;
      if (!object(target) || target.Attribute !== 'Properties' || target.Name !== 'Code' || target.RequiresRecreation !== 'Never' || target.AttributeChangeType !== 'Modify' || !['/Properties/Code', '/Properties/Code/S3Key'].includes(target.Path)) throw new Error('non-artifact or incomplete property target');
      if (Object.keys(detail).some(key => !['Target', 'Evaluation', 'ChangeSource', 'CausingEntity'].includes(key)) || Object.keys(target).some(key => !['Attribute', 'Name', 'RequiresRecreation', 'Path', 'BeforeValue', 'AfterValue', 'AttributeChangeType'].includes(key))) throw new Error('unknown property detail');
      if (detail.Evaluation === 'Static' && detail.ChangeSource === 'ParameterReference' && detail.CausingEntity === 'ArtifactKey') {
        if (!valueMatches(target.BeforeValue, target.Path, 0) || !valueMatches(target.AfterValue, target.Path, 1)) throw new Error('artifact property values incomplete or mismatched');
        targets.add(target.Path);
      } else if (!(detail.Evaluation === 'Dynamic' && detail.ChangeSource === 'DirectModification' && detail.CausingEntity == null)) {
        throw new Error('unresolved or unrelated property evaluation');
      }
    }
    // AWS emits a Dynamic DirectModification companion to a Static parameter
    // change. Accept only that exact target, proved by the static values AND the
    // complete resolved contexts. An independent dynamic effect remains blocked.
    if (!targets.size) throw new Error('static ArtifactKey proof missing');
    for (const detail of resource.Details.filter(row => row.Evaluation === 'Dynamic')) {
      const target = detail.Target;
      if (!targets.has(target.Path) || (target.BeforeValue != null && !valueMatches(target.BeforeValue, target.Path, 0)) || (target.AfterValue != null && !valueMatches(target.AfterValue, target.Path, 1))) throw new Error('unproved dynamic companion');
    }
  } catch (error) {
    problems.push(error instanceof SyntaxError ? 'invalid property context JSON' : error.message);
  }
  return {problems, noChanges: false, ...(modeDiagnostic ? {modeDiagnostic} : {})};
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const input = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
  const problems = reviewChangeSet(JSON.parse(input));
  if (problems.length) {
    console.error('Refusing this change set. It would replace or remove a resource:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('Change set does not replace or remove any resource.');
}
