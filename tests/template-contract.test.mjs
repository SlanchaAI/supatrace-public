import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {deployParameters, templateParameterNames, templateParameterDefaults, expectedMcpBridgeValue} from '../aws/deploy-parameters.mjs';
import {resourceBlock} from '../aws/change-set-guard.mjs';

const template = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8');
const handler = readFileSync(new URL('../aws/handler.mjs', import.meta.url), 'utf8');

function directoryIndex(source) {
  const start = source.indexOf('function handler(event) {');
  assert.ok(start > source.indexOf('DirectoryIndex:'), 'directory index handler is missing');
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return new Function(`${source.slice(start, i + 1)}\nreturn handler;`)();
    }
  }
  throw new Error('directory index handler is not closed');
}

function event(uri, querystring) {
  return {request: {uri, querystring: querystring || {}, headers: {host: {value: 'supatrace.dev'}}}};
}

test('the live template keeps Google optional and puts security headers on the API', () => {
  const api = template.slice(template.indexOf("PathPattern: '/api/*'"), template.indexOf('SecurityHeaders:'));
  assert.match(api, /ResponseHeadersPolicyId: !Ref SecurityHeaders/);
  assert.match(api, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);
  assert.equal(template.includes('413f1605-904b-4cee-83d7-1c1e4f964f43'), false);
  assert.match(template, /GoogleClientId:/);
  assert.match(template, /GoogleSecretArn:/);
  assert.match(template, /GoogleSecretConfigured/);
  assert.match(template, /StrictTransportSecurity:/);
  assert.match(template, /log-group:\/aws\/lambda\/supatrace-alpha-api:log-stream:\*/);
  assert.equal(template.includes('${Logs.Arn}'), false);
  assert.equal(template.includes('GOOGLE_CLIENT_SECRET:'), false);
  assert.equal(handler.includes('DEV_AUTH'), false);
  assert.match(handler, /GOOGLE_SECRET_ARN/);
  const policy=resourceBlock(template,'ApiRequestPolicy');
  assert.match(policy,/HeaderBehavior: whitelist/);
  assert.match(policy,/Headers: \[[^\]]*\bAccept\b/,'browser recovery content negotiation must reach the API through CloudFront');
});

test('extensionless paths redirect to a slash and the distribution stays in place', () => {
  const distribution = resourceBlock(template, 'Distribution');
  const fn = resourceBlock(template, 'DirectoryIndex');
  assert.equal(template.match(/Type: AWS::CloudFront::Distribution/g).length, 1);
  assert.match(distribution, /Aliases: !Ref Domains/);
  assert.match(distribution, /DefaultRootObject: index\.html/);
  assert.match(distribution, /FunctionARN: !GetAtt DirectoryIndex\.FunctionARN/);
  const api = distribution.slice(distribution.indexOf("PathPattern: '/api/*'"));
  assert.match(api, /EventType: viewer-request\s+FunctionARN: !GetAtt DirectoryIndex\.FunctionARN/, 'the API behavior runs the same function, which only stamps the viewer host on /api/ paths');
  assert.equal(template.match(/Type: AWS::CloudFront::Function/g).length, 1, 'no new function: the deploy role can update the existing one but not create another');
  assert.match(fn, /Type: AWS::CloudFront::Function/);
  assert.match(fn, /Name: !Sub '\$\{AWS::StackName\}-directory-index'/);
  assert.match(fn, /AutoPublish: true/);
  assert.match(fn, /Runtime: cloudfront-js-2\.0/);
  const index = directoryIndex(template);
  const root = index(event('/'));
  assert.equal(root.uri, '/index.html');
  assert.equal(root.statusCode, undefined);
  const directory = index(event('/app/'));
  assert.equal(directory.uri, '/app/index.html');
  const file = index(event('/app.html'));
  assert.equal(file.uri, '/app.html');
  assert.equal(file.statusCode, undefined);
  assert.equal(index(event('/favicon.svg')).uri, '/favicon.svg');
  assert.equal(index(event('/app/index.html')).uri, '/app/index.html');
  const moved = index(event('/app', {
    project: {value: 'proj_1'},
    tag: {value: 'a', multiValue: [{value: 'a'}, {value: 'b c'}]}
  }));
  assert.equal(moved.statusCode, 301);
  assert.equal(moved.statusDescription, 'Moved Permanently');
  assert.equal(moved.headers.location.value, 'https://supatrace.dev/app/?project=proj_1&tag=a&tag=b%20c');
  assert.equal(moved.headers['cache-control'].value, 'no-store');
  const bare = index({request: {uri: '/app', querystring: {}, headers: {}}});
  assert.equal(bare.headers.location.value, '/app/');
});

test('dashboard links point at /app/', () => {
  const root = new URL('..', import.meta.url);
  const collect = directory => {
    const found = [];
    for (const entry of readdirSync(new URL(directory, root), {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...collect(path));
      else if (/\.(html|js|css|py|mjs)$/.test(entry.name)) found.push(path);
    }
    return found;
  };
  const files = [...collect('public'), ...collect('agent'), 'src/aws-auth.mjs', 'src/dynamodb-store.mjs', 'src/dashboard-auth.mjs'];
  for (const file of files) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.equal(/\/app(?:\.html)?(?![\/.\w])/.test(text), false, file);
  }
});

test('dual-domain: both hostnames share one distribution, certificate and Lambda', () => {
  assert.match(template, /Domains:\n    Type: CommaDelimitedList\n    Default: 'supatrace\.dev'/, 'the default keeps today\'s single host until an admin sets both');
  assert.match(template, /APP_HOSTS: !Join \[',', !Ref Domains\]/);
  assert.match(template, /Approved us-east-1 ACM certificate covering every name in Domains/);
  assert.match(template, /GITHUB_TECH_CLIENT_ID: !Ref GitHubTechClientId/);
  assert.match(template, /GITHUB_TECH_SECRET_ARN: !Ref GitHubTechSecretArn/);
  assert.match(resourceBlock(template, 'ApiRequestPolicy'), /Headers: \[[^\]]*\bX-Supatrace-Host\b/);
  assert.match(template, /GitHubTechSecretConfigured/);
  assert.match(handler, /APP_HOSTS/);
  assert.equal(/'https:\/\/supatrace\.dev'\+path/.test(handler), false, 'the request URL must not hard-code a host');
});

test('the CloudFront function stamps the viewer host on API paths and overwrites client values', () => {
  const index = directoryIndex(template);
  const spoofed = index({request: {uri: '/api/me', querystring: {}, headers: {host: {value: 'SupaTrace.TECH'}, 'x-supatrace-host': {value: 'evil.example'}}}});
  assert.equal(spoofed.headers['x-supatrace-host'].value, 'supatrace.tech');
  assert.equal(spoofed.uri, '/api/me');
  const noHost = index({request: {uri: '/api/me', querystring: {}, headers: {'x-supatrace-host': {value: 'supatrace.tech'}}}});
  assert.equal(noHost.headers['x-supatrace-host'], undefined);
  const page = index({request: {uri: '/agent-setup.html', querystring: {}, headers: {host: {value: 'supatrace.dev'}}}});
  assert.equal(page.headers['x-supatrace-host'], undefined, 'static paths are untouched');
});

test('the deploy role template can read the second GitHub secret only when it is named', () => {
  const role = readFileSync(new URL('../aws/github-oidc-deploy-role.yaml', import.meta.url), 'utf8');
  assert.match(role, /GitHubTechSecretArn:\n    Type: String\n    Default: ''/);
  assert.match(role, /GitHubTechSecretSet: !Not \[!Equals \[!Ref GitHubTechSecretArn, ''\]\]/);
  assert.match(role, /Sid: GitHubTechSecret/);
});


test('MCP consent activation defaults off and preserves reviewed release parameters', () => {
  assert.match(template, /McpBridgeEnabled:\n    Type: String\n    Default: 'false'\n    AllowedValues: \['false', 'true'\]/);
  assert.match(template, /MCP_BRIDGE_ENABLED: !Ref McpBridgeEnabled/);
  assert.match(handler, /MCP_BRIDGE_ENABLED:process.env.MCP_BRIDGE_ENABLED==='true'/);
  assert.equal(directoryIndex(template)(event('/mcp/')).uri, '/mcp/index.html');
  const names=templateParameterNames(template), defaults=templateParameterDefaults(template);
  const prior=names.filter(name=>name!=='McpBridgeEnabled').map(ParameterKey=>({ParameterKey,ParameterValue:'existing'}));
  assert.deepEqual(deployParameters(names,prior,'releases/test/supatrace-lambda.zip',defaults).find(p=>p.ParameterKey==='McpBridgeEnabled'),{ParameterKey:'McpBridgeEnabled',ParameterValue:'false'});
  prior.push({ParameterKey:'McpBridgeEnabled',ParameterValue:'true'});
  assert.deepEqual(deployParameters(names,prior,'releases/test/supatrace-lambda.zip',defaults).find(p=>p.ParameterKey==='McpBridgeEnabled'),{ParameterKey:'McpBridgeEnabled',UsePreviousValue:true});
});

test('import policy config defaults empty and guarded deploys preserve the live value', () => {
  assert.match(template, /ImportPolicyConfig:\n    Type: String\n    NoEcho: true\n    Default: ''/);
  assert.match(template, /IMPORT_POLICY_CONFIG: !Ref ImportPolicyConfig/);
  const names = templateParameterNames(template), defaults = templateParameterDefaults(template);
  assert.equal(defaults.ImportPolicyConfig, '');
  const prior = names.filter(name => name !== 'ImportPolicyConfig').map(ParameterKey => ({ParameterKey, ParameterValue: 'existing'}));
  const pick = (rows, mode) => deployParameters(names, rows, 'releases/test/supatrace-lambda.zip', defaults, mode).find(p => p.ParameterKey === 'ImportPolicyConfig');
  assert.deepEqual(pick(prior), {ParameterKey: 'ImportPolicyConfig', ParameterValue: ''});
  prior.push({ParameterKey: 'ImportPolicyConfig', ParameterValue: '****'});
  for (const mode of ['preserve', 'true', 'false', 'restore']) {
    const rows = mode === 'restore' ? [...prior.filter(p => p.ParameterKey !== 'McpBridgeEnabled'), {ParameterKey: 'McpBridgeEnabled', ParameterValue: 'false'}] : prior;
    assert.deepEqual(pick(rows, mode), {ParameterKey: 'ImportPolicyConfig', UsePreviousValue: true});
  }
});


test('server pull config defaults to the approved .dev setting and guarded deploys preserve the live value', () => {
  assert.ok(template.includes("ServerPullConfig:"));
  assert.ok(template.includes(`Default: '{\"mode\":\"bounded-server-pull-v1\",\"origin\":\"https://supatrace.dev\"}'`));
  assert.match(template, /SERVER_PULL_CONFIG: !Ref ServerPullConfig/);
  const names = templateParameterNames(template), defaults = templateParameterDefaults(template);
  assert.equal(defaults.ServerPullConfig, '{"mode":"bounded-server-pull-v1","origin":"https://supatrace.dev"}');
  const prior = names.filter(name => name !== 'ServerPullConfig').map(ParameterKey => ({ParameterKey, ParameterValue: 'existing'}));
  const pick = (rows, mode) => deployParameters(names, rows, 'releases/test/supatrace-lambda.zip', defaults, mode).find(p => p.ParameterKey === 'ServerPullConfig');
  assert.deepEqual(pick(prior), {ParameterKey: 'ServerPullConfig', ParameterValue: '{"mode":"bounded-server-pull-v1","origin":"https://supatrace.dev"}'});
  prior.push({ParameterKey: 'ServerPullConfig', ParameterValue: '{"mode":"custom"}'});
  for (const mode of ['preserve', 'true', 'false', 'restore']) {
    const rows = mode === 'restore' ? [...prior.filter(p => p.ParameterKey !== 'McpBridgeEnabled'), {ParameterKey: 'McpBridgeEnabled', ParameterValue: 'false'}] : prior;
    assert.deepEqual(pick(rows, mode), {ParameterKey: 'ServerPullConfig', UsePreviousValue: true});
  }
});

test('explicit MCP release choice changes only its flag; invalid choices fail closed', () => {
  const names = templateParameterNames(template), defaults = templateParameterDefaults(template);
  const prior = names.map(ParameterKey => ({ParameterKey, ParameterValue: ParameterKey === 'McpBridgeEnabled' ? 'false' : 'existing'}));
  const normal = deployParameters(names, prior, 'releases/test/supatrace-lambda.zip', defaults);
  for (const mode of ['true', 'false']) {
    const chosen = deployParameters(names, prior, 'releases/test/supatrace-lambda.zip', defaults, mode);
    assert.deepEqual(chosen.filter(p => p.ParameterKey !== 'McpBridgeEnabled'), normal.filter(p => p.ParameterKey !== 'McpBridgeEnabled'));
    assert.deepEqual(chosen.find(p => p.ParameterKey === 'McpBridgeEnabled'), {ParameterKey: 'McpBridgeEnabled', ParameterValue: mode});
  }
  for (const mode of ['', true, false, 'yes', 'TRUE', 'arbitrary']) assert.throws(() => deployParameters(names, prior, 'releases/test/supatrace-lambda.zip', defaults, mode), /invalid MCP/);
  assert.throws(() => deployParameters(['ArtifactKey'], [], 'releases/test/supatrace-lambda.zip', {}, 'true'), /parameter is missing/);
});

test('MCP smoke rollback restores pre-release flag even when the artifact is unchanged', () => {
  const names = templateParameterNames(template), defaults = templateParameterDefaults(template);
  const prior = names.filter(n => n !== 'McpBridgeEnabled').map(ParameterKey => ({ParameterKey, ParameterValue: 'existing'}));
  const restored = rows => deployParameters(names, rows, 'releases/same/supatrace-lambda.zip', defaults, 'restore').find(p => p.ParameterKey === 'McpBridgeEnabled');
  assert.deepEqual(restored(prior), {ParameterKey: 'McpBridgeEnabled', ParameterValue: 'false'});
  for (const value of ['true', 'false']) assert.deepEqual(restored([...prior, {ParameterKey: 'McpBridgeEnabled', ParameterValue: value}]), {ParameterKey: 'McpBridgeEnabled', ParameterValue: value});
  for (const value of ['yes', undefined, true]) assert.throws(() => restored([...prior, {ParameterKey: 'McpBridgeEnabled', ParameterValue: value}]), /invalid MCP/);
  assert.throws(() => restored([...prior, {ParameterKey: 'McpBridgeEnabled', ParameterValue: 'true'}, {ParameterKey: 'McpBridgeEnabled', ParameterValue: 'false'}]), /ambiguous/);
});

test('workflow exposes only explicit manual MCP choices and uses the reviewed change-set path', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      mcp_bridge_enabled:/);
  assert.match(workflow, /default: preserve\n        options: \[preserve, 'true', 'false'\]/);
  assert.ok(workflow.includes("github.event_name == 'workflow_dispatch' && inputs.mcp_bridge_enabled || 'preserve'"));
  assert.ok(workflow.includes('"$ARTIFACT_KEY" "$MCP_BRIDGE_MODE" > parameters.json'));
  assert.ok(workflow.includes('"$PREVIOUS_ARTIFACT_KEY" restore > rollback-parameters.json'));
  assert.ok(!workflow.includes('[ "$PREVIOUS_ARTIFACT_KEY" = "$ARTIFACT_KEY" ]'));
  assert.match(workflow, /node aws\/review-artifact-change-set.mjs current-stack.json "\$CHANGE_SET_ID" "\$ARTIFACT_KEY" change-set.json/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /lambda update-function-configuration/);
  assert.match(workflow, /\/mcp\/ \/mcp\/consent.js \/mcp\/consent.css/);
  assert.match(workflow, /expectedMcpBridgeValue\(JSON.parse\(readFileSync\("parameters.json"\)\)/);
  assert.ok(workflow.includes('https://${host}/api/mcp/read/me'));
  assert.ok(workflow.includes('"$code" = "$expected_code"'));
  assert.ok(workflow.includes('"mcp_access_unavailable" if sys.argv[1]=="true" else "not_found"'));
});

test('credential-free smoke expectation uses the requested release value, including preserve and restore', () => {
  const names = templateParameterNames(template), defaults = templateParameterDefaults(template);
  for (const priorFlag of [undefined, 'false', 'true']) {
    const prior = names.filter(n => n !== 'McpBridgeEnabled').map(ParameterKey => ({ParameterKey, ParameterValue: 'existing'}));
    if (priorFlag !== undefined) prior.push({ParameterKey: 'McpBridgeEnabled', ParameterValue: priorFlag});
    for (const choice of ['preserve', 'true', 'false', 'restore']) {
      const params = deployParameters(names, prior, 'releases/test/supatrace-lambda.zip', defaults, choice);
      assert.equal(expectedMcpBridgeValue(params, prior), ['preserve', 'restore'].includes(choice) ? priorFlag ?? 'false' : choice);
    }
  }
  assert.throws(() => expectedMcpBridgeValue([], []), /ambiguous/);
  assert.throws(() => expectedMcpBridgeValue([{ParameterKey:'McpBridgeEnabled',UsePreviousValue:true}], []), /missing/);
  assert.throws(() => expectedMcpBridgeValue([{ParameterKey:'McpBridgeEnabled',ParameterValue:'yes'}], []), /invalid/);
});

test('plan billing is off by default, reads only its two secrets, and its webhook ingress is one route created with the key', () => {
  for (const name of ['PlanBillingSecretArn', 'PlanBillingWebhookSecretArn']) {
    const block = template.slice(template.indexOf('\n  ' + name + ':'), template.indexOf('\n  ', template.indexOf('\n  ' + name + ':') + 4 + name.length + 60));
    assert.match(block, /Default: ''/, name + ' defaults to empty');
    assert.match(readFileSync(new URL('../aws/github-oidc-deploy-role.yaml', import.meta.url), 'utf8'), new RegExp('Resource: !Ref ' + name), name + ' is in the permissions boundary');
  }
  assert.match(template, /PLAN_BILLING_SECRET_ARN: !Ref PlanBillingSecretArn/);
  assert.match(template, /PLAN_BILLING_WEBHOOK_SECRET_ARN: !If \[PlanBillingWebhookConfigured, !Ref PlanBillingWebhookSecretArn, ''\]/);
  assert.match(template, /BILLING_INGRESS_API_ID: !If \[PlanBillingConfigured, !Ref BillingIngressApi, ''\]/);
  // The key itself is never a parameter or an environment variable: only the secret's ARN is.
  assert.doesNotMatch(template, /sk_test_|sk_live_|STRIPE_SECRET_KEY|PLAN_BILLING_KEY/);
  assert.match(handler, /PLAN_BILLING_SECRET_ARN/); assert.match(handler, /composePlanBilling/);
  for (const name of ['BillingIngressApi', 'BillingIngressIntegration', 'BillingIngressRoute', 'BillingIngressStage', 'InvokeBillingIngress']) assert.match(resourceBlock(template, name), /Condition: PlanBillingConfigured/, name);
  // One route and no catch-all; the permission is scoped to that route.
  assert.equal((template.match(/ApiId: !Ref BillingIngressApi\n      RouteKey:/g) || []).length, 1);
  assert.match(resourceBlock(template, 'BillingIngressRoute'), /RouteKey: 'POST \/api\/billing\/webhook'/);
  assert.match(resourceBlock(template, 'InvokeBillingIngress'), /\$\{BillingIngressApi\}\/\*\/POST\/api\/billing\/webhook'/);
  // Like the ingest integration, a literal function ARN keeps artifact releases from touching it.
  assert.match(resourceBlock(template, 'BillingIngressIntegration'), /IntegrationUri: !Sub 'arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:supatrace-alpha-api'/);
  assert.match(template, /BillingWebhookUrl:\n    Condition: PlanBillingConfigured/);
});

test('function concurrency has one bounded parameter and preserves the bootstrap default', () => {
  assert.equal(template.split('\n  ApiConcurrency:').length - 1, 1);
  const block = template.slice(template.indexOf('\n  ApiConcurrency:'), template.indexOf('\n  PlanBillingSecretArn:'));
  assert.match(block, /Type: Number\n    Default: 1\n    MinValue: 1\n    MaxValue: 20/);
  assert.match(resourceBlock(template, 'Api'), /ReservedConcurrentExecutions: !Ref ApiConcurrency/);
  assert.equal(templateParameterDefaults(template).ApiConcurrency, '1');
});
