import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {STATEFUL_RESOURCES, statefulProblems, reviewChangeSet} from '../aws/change-set-guard.mjs';
import {templateParameterNames, templateParameterDefaults, deployParameters} from '../aws/deploy-parameters.mjs';

const template = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const oidc = readFileSync(new URL('../aws/github-oidc-deploy-role.yaml', import.meta.url), 'utf8');

test('stateful resources keep their live logical ids and fixed names', () => {
  assert.deepEqual(statefulProblems(template), []);
  for (const resource of STATEFUL_RESOURCES) {
    assert.equal(template.split(`\n  ${resource.logicalId}:\n`).length, 2);
  }
});

test('a change set that would replace or remove a named resource is refused', () => {
  const bad = {Changes: [
    {ResourceChange: {LogicalResourceId: 'Metadata', ResourceType: 'AWS::DynamoDB::Table', Action: 'Modify', Replacement: 'True'}},
    {ResourceChange: {LogicalResourceId: 'Payloads', ResourceType: 'AWS::S3::Bucket', Action: 'Modify', Replacement: 'Conditional'}},
    {ResourceChange: {LogicalResourceId: 'Static', ResourceType: 'AWS::S3::Bucket', Action: 'Modify', Replacement: 'True'}},
    {ResourceChange: {LogicalResourceId: 'Api', ResourceType: 'AWS::Lambda::Function', Action: 'Modify', Replacement: 'True'}},
    {ResourceChange: {LogicalResourceId: 'ApiRole', ResourceType: 'AWS::IAM::Role', Action: 'Modify', Replacement: 'Conditional'}},
    {ResourceChange: {LogicalResourceId: 'Logs', ResourceType: 'AWS::Logs::LogGroup', Action: 'Remove', Replacement: 'False'}},
    {ResourceChange: {LogicalResourceId: 'Distribution', ResourceType: 'AWS::CloudFront::Distribution', Action: 'Remove', Replacement: 'False'}},
    {ResourceChange: {LogicalResourceId: 'ApiUrl', ResourceType: 'AWS::Lambda::Url', Action: 'Modify', Replacement: 'Conditional'}},
    {ResourceChange: {LogicalResourceId: 'InvokeUrl', ResourceType: 'AWS::Lambda::Permission', Action: 'Modify', Replacement: 'True'}}
  ]};
  const problems = reviewChangeSet(bad);
  for (const resource of [...STATEFUL_RESOURCES.map(item => item.logicalId), 'Distribution', 'ApiUrl', 'InvokeUrl']) assert.match(problems.join('\n'), new RegExp(resource));
  assert.deepEqual(reviewChangeSet({Changes: [
    {ResourceChange: {LogicalResourceId: 'Api', Action: 'Modify', Replacement: 'False'}},
    {ResourceChange: {LogicalResourceId: 'SecurityHeaders', Action: 'Modify', Replacement: 'False'}}
  ]}), []);
  const droppedNames = reviewChangeSet({Changes: [
    {ResourceChange: {LogicalResourceId: 'Metadata', Action: 'Modify', Replacement: 'True', Details: [{Target: {Name: 'TableName'}, Evaluation: 'Static', ChangeSource: 'DirectModification'}]}}
  ]});
  assert.match(droppedNames.join('\n'), /Metadata replacement True/);
});

test('the guard command fails closed and deletes nothing by itself', () => {
  const unsafe = JSON.stringify({Changes: [{ResourceChange: {LogicalResourceId: 'ApiRole', Action: 'Modify', Replacement: 'Conditional'}}]});
  const failed = spawnSync(process.execPath, ['aws/change-set-guard.mjs'], {input: unsafe, encoding: 'utf8'});
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /ApiRole replacement Conditional/);
  const safe = spawnSync(process.execPath, ['aws/change-set-guard.mjs'], {input: '{"Changes":[]}', encoding: 'utf8'});
  assert.equal(safe.status, 0);
});

test('deploy parameters keep every live value except the artifact key', () => {
  const names = templateParameterNames(template);
  const defaults = templateParameterDefaults(template);
  assert.ok(names.includes('ArtifactKey'));
  assert.equal(defaults.GoogleClientId, '');
  assert.equal(defaults.GoogleSecretArn, '');
  for (const name of ['ChatGptClientId', 'ChatGptSecretArn', 'ChatGptAuthorizeUrl', 'ChatGptTokenUrl', 'ChatGptUserinfoUrl', 'SsoEmailDomains', 'SsoIdpSsoUrl', 'SsoIdpIssuer', 'SsoIdpCertSecretArn', 'EmailFrom']) {
    assert.equal(defaults[name], '', name);
  }
  assert.equal(defaults.MfaEnabled, 'false');
  assert.equal(template.includes('SSO_IDP_CERT:'), false);
  const current = [
    {ParameterKey: 'ArtifactBucket', ParameterValue: 'supatrace-alpha-artifacts-123456789012-us-east-1'},
    {ParameterKey: 'ArtifactKey', ParameterValue: 'releases/old/supatrace-lambda.zip'},
    {ParameterKey: 'GitHubClientId', ParameterValue: 'public-client'},
    {ParameterKey: 'GitHubSecretArn', ParameterValue: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:example'},
    {ParameterKey: 'CertificateArn', ParameterValue: 'arn:aws:acm:us-east-1:123456789012:certificate/example'},
    {ParameterKey: 'Enabled', ParameterValue: 'true'}
  ];
  const next = deployParameters(names, current, 'releases/abc/supatrace-lambda.zip', defaults);
  assert.deepEqual(next.find(parameter => parameter.ParameterKey === 'ArtifactKey'), {ParameterKey: 'ArtifactKey', ParameterValue: 'releases/abc/supatrace-lambda.zip'});
  for (const parameter of current) {
    if (parameter.ParameterKey === 'ArtifactKey') continue;
    assert.deepEqual(next.find(item => item.ParameterKey === parameter.ParameterKey), {ParameterKey: parameter.ParameterKey, UsePreviousValue: true});
  }
  assert.deepEqual(next.find(parameter => parameter.ParameterKey === 'GoogleClientId'), {ParameterKey: 'GoogleClientId', ParameterValue: ''});
  assert.deepEqual(next.find(parameter => parameter.ParameterKey === 'GoogleSecretArn'), {ParameterKey: 'GoogleSecretArn', ParameterValue: ''});
  for (const name of ['ChatGptClientId', 'ChatGptSecretArn', 'ChatGptAuthorizeUrl', 'ChatGptTokenUrl', 'ChatGptUserinfoUrl', 'SsoEmailDomains', 'SsoIdpSsoUrl', 'SsoIdpIssuer', 'SsoIdpCertSecretArn', 'EmailFrom']) {
    assert.deepEqual(next.find(parameter => parameter.ParameterKey === name), {ParameterKey: name, ParameterValue: ''});
  }
  assert.deepEqual(next.find(parameter => parameter.ParameterKey === 'MfaEnabled'), {ParameterKey: 'MfaEnabled', ParameterValue: 'false'});
  assert.equal(JSON.stringify(next).includes('public-client'), false);
  assert.equal(JSON.stringify(next).includes('secret:example'), false);
});

test('workflows use OIDC and do not bake a browser path', () => {
  assert.match(deploy, /id-token: write/);
  assert.match(deploy, /vars\.AWS_DEPLOY_ROLE_ARN/);
  assert.match(deploy, /environment: production/);
  assert.match(deploy, /AWS_DEPLOY_ROLE_ARN is not set/);
  assert.match(ci, /npm ci --ignore-scripts/);
  assert.match(ci, /cfn-lint aws\/template\.yaml/);
  assert.match(ci, /playwright/);
  for (const source of [deploy, ci, oidc]) {
    assert.equal(source.includes('aws-access-key-id'), false);
    assert.equal(source.includes('AWS_ACCESS_KEY_ID'), false);
    assert.equal(source.includes('AWS_SECRET_ACCESS_KEY'), false);
    assert.equal(source.includes('/opt/cursor'), false);
  }
  assert.match(oidc, /repo:SlanchaAI@273274206\/supatrace@1427733390:environment:production/);
  assert.equal(oidc.includes('token.actions.githubusercontent.com:ref'), false);
  assert.equal(oidc.includes('repo:SlanchaAI/supatrace:environment:production'), false);
  assert.match(deploy, /github\.ref == 'refs\/heads\/main'/);
  assert.match(deploy, /GITHUB_REF" != "refs\/heads\/main"/);
  const deployRole = oidc.slice(oidc.indexOf('  DeployRole:'), oidc.indexOf('  ApiBoundary:'));
  assert.equal(deployRole.includes('secretsmanager:GetSecretValue'), false);
  // EventBridge may invoke only the existing API; the deployer cannot add an arbitrary principal.
  const invocation = deployRole.slice(deployRole.indexOf('              - Sid: AccountErasureInvocation'), deployRole.indexOf('              - Sid: UpdateFunction'));
  assert.match(invocation, /lambda:AddPermission/);
  assert.match(invocation, /lambda:RemovePermission/);
  assert.match(invocation, /function:supatrace-alpha-api/);
  assert.match(invocation, /'lambda:Principal': 'events.amazonaws.com'/);
  assert.match(deployRole, /s3:PutBucketPolicy/);
  assert.equal(deployRole.split('iam:PassRole').length, 2);
  assert.match(deployRole, /role\/supatrace-alpha-api/);
  assert.match(deployRole, /iam:DeleteRolePermissionsBoundary/);
  assert.match(oidc, /ManagedPolicyName: supatrace-alpha-api-boundary/);
  assert.match(template, /PermissionsBoundary:/);
  assert.match(deploy, /group: supatrace-production/);
  assert.match(deploy, /cancel-in-progress: false/);
  assert.match(deploy, /npm ci --omit=dev --ignore-scripts/);
  const publishAt = deploy.indexOf('Publish static files after the stack update');
  const executeAt = deploy.indexOf('execute-change-set');
  assert.ok(publishAt > executeAt);
  assert.ok(deploy.indexOf('static-snapshot') < executeAt);
  assert.match(deploy, /aws s3 cp static-snapshot\/ "s3:\/\/\$\{STATIC_BUCKET\}\/" --recursive/);
  assert.match(deploy, /static-snapshot\/ "s3:\/\/\$\{STATIC_BUCKET\}\/" --delete/);
  assert.ok(deploy.indexOf('aws s3 cp static-snapshot/') < deploy.indexOf('static-snapshot/ "s3://${STATIC_BUCKET}/" --delete'));
  assert.match(deploy, /PermissionsBoundary.PermissionsBoundaryArn/);
  assert.match(deploy, /aws cloudformation get-template --stack-name "\$STACK_NAME"/);
  assert.ok(deploy.indexOf('aws cloudformation get-template') < deploy.indexOf('npm ci --omit=dev --ignore-scripts'));
  assert.match(deployRole, /lambda:GetRuntimeManagementConfig/);
  assert.match(deployRole, /lambda:GetFunctionCodeSigningConfig/);
  assert.match(deployRole, /lambda:GetFunctionRecursionConfig/);
  assert.match(deployRole, /lambda:GetFunctionScalingConfig/);
  assert.match(deployRole, /lambda:PutFunctionConcurrency/);
  assert.match(deployRole, /lambda:DeleteFunctionConcurrency/);
  assert.match(deployRole, /s3:GetObjectVersion/);
  assert.match(deployRole, /cloudfront:UpdateDistributionWithStagingConfig/);
  assert.match(deployRole, /cloudfront:GetVpcOrigin/);
  assert.match(deployRole, /vpcorigin\/\*/);
});

test('the exact release SHA must pass every CI stage before deployment', () => {
  assert.match(ci, /workflow_call:/);
  assert.match(deploy, /verify:\s*\n\s+uses: \.\/\.github\/workflows\/ci\.yml/);
  const job = deploy.slice(deploy.indexOf('\n  deploy:'));
  assert.match(job, /needs: \[gate, verify\]/);
  assert.match(job, /needs\.verify\.result == 'success'/);
  for (const workflow of [ci, job]) {
    assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /git rev-parse HEAD\).*\$GITHUB_SHA/);
    assert.doesNotMatch(workflow, /continue-on-error|always\(\)/);
  }
  for (const check of ['npm test', 'npm run test:ui', 'cfn-lint aws/template.yaml', 'tests/stateful-guard.test.mjs']) assert.ok(ci.includes(check), check);
  const allowed = (gate, verify, ref) => gate === 'true' && verify === 'success' && ref === 'refs/heads/main';
  for (const result of ['failure', 'cancelled', 'skipped', 'timed_out', undefined]) assert.equal(allowed('true', result, 'refs/heads/main'), false);
  assert.equal(allowed('true', 'success', 'refs/heads/cursor/supabase-dashboard-97b2'), false);
  assert.equal(allowed('true', 'success', 'refs/heads/main'), true);
});

test('CloudFormation tag reads are limited to the existing directory-index function', () => {
  const statement = oidc.match(/              - Sid: UpdateDirectoryIndex\n([\s\S]*?)(?=\n              - Sid:|\n  ApiBoundary:)/)?.[1];
  assert.ok(statement, 'the existing function-scoped statement must remain');
  assert.match(statement, /Effect: Allow/);
  const actions = statement.match(/Action: \[([^\]]+)\]/)?.[1].split(',').map(action => action.trim());
  assert.deepEqual(actions, ['cloudfront:DescribeFunction', 'cloudfront:GetFunction', 'cloudfront:UpdateFunction', 'cloudfront:PublishFunction', 'cloudfront:ListTagsForResource']);
  assert.equal(statement.match(/Resource: (.+)/)?.[1], '!Sub arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:function/supatrace-alpha-retry-20261024-directory-index');
  assert.doesNotMatch(statement, /cloudfront:(?:TagResource|UntagResource)|\*/);
});
