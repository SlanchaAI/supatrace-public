// Trace-ingest edge: API Gateway v2 events for OTLP and the Langfuse-compatible routes, adapted for the
// real handler. Bodies are the ones captured from stock exporters (tests/fixtures/otlp).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {handle} from '../src/aws-api.mjs';
import {digest} from '../src/aws-auth.mjs';
import {ingestIngressRequest, isIngestIngress, INGEST_ROUTES} from '../src/ingest-ingress.mjs';
import {IDENTITY_ROUTES} from '../src/identity-ingress.mjs';
import {isApiGatewayIngress} from '../src/stripe-ingress.mjs';
import {handler as awsHandler, lambdaResult} from '../aws/handler.mjs';
import {templateParameterNames, templateParameterDefaults, deployParameters} from '../aws/deploy-parameters.mjs';
import {resourceBlock} from '../aws/change-set-guard.mjs';

const cfg = {apiId: 'ingestapi1', region: 'us-east-1', edgeToken: 'E'.repeat(40)};
const pythonProto = readFileSync(new URL('./fixtures/otlp/python-1.45.2-http-protobuf.bin', import.meta.url));
const nodeJson = readFileSync(new URL('./fixtures/otlp/node-0.301.2-http-json.json', import.meta.url));
const template = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8');

// The shape API Gateway HTTP APIs deliver (payload format 2.0): lower-case header names, binary bodies base64.
function event(route, {body, base64 = false, headers = {}} = {}) {
  const [method, path] = route.split(' ');
  return {version: '2.0', routeKey: route, rawPath: path, rawQueryString: '',
    headers: {'x-supatrace-edge': cfg.edgeToken, 'x-supatrace-viewer-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 192.0.2.44', host: 'ingestapi1.execute-api.us-east-1.amazonaws.com', ...headers},
    requestContext: {accountId: '123456789012', apiId: cfg.apiId, domainName: 'ingestapi1.execute-api.us-east-1.amazonaws.com', routeKey: route, stage: '$default',
      http: {method, path, sourceIp: '192.0.2.44', protocol: 'HTTP/1.1'}},
    ...(body === undefined ? {} : {body: base64 ? Buffer.from(body).toString('base64') : body.toString(), isBase64Encoded: base64})};
}
const otlp = (extra = {}) => event('POST /v1/traces', {body: pythonProto, base64: true, headers: {'content-type': 'application/x-protobuf', ...extra}});

function fixture() {
  const token = 'a'.repeat(43), rows = new Map(), objects = new Map(), rates = [];
  const store = {getTenant: async tenant_id => ({tenant_id}), now: () => 0, consumeRate: async rate => { rates.push(rate); return {allowed: true}; },
    lookupWriteKey: async h => h === digest(token) ? {tenant_id: 'github-1', token_hash: h} : null, _get: async () => null,
    reserveBatch: async (t, b) => { if (rows.has(b.batch_id)) return rows.get(b.batch_id); const row = {...b, status: 'pending', object_key: t + '/' + b.request_hash}; rows.set(b.batch_id, row); return row; },
    acceptReservedBatch: async (t, id) => { rows.get(id).status = 'accepted'; }};
  return {token, rows, rates, env: {ENABLED: true, APP_ORIGIN: 'https://supatrace.dev', GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic-not-secret', store, objects: {putImmutable: async (k, v) => { objects.set(k, v); }}}};
}
const through = async (f, e) => { const {request, sourceIp} = ingestIngressRequest(e, cfg); return lambdaResult(await handle(request, {...f.env, sourceIp})); };
const refused = (e, config = cfg) => { try { ingestIngressRequest(e, config); } catch (error) { assert.equal(error.edgeIngress, true); return [error.status, error.code]; } return null; };

test('a stock exporter body crosses the edge byte for byte with no body hash, in protobuf, gzip and JSON', async () => {
  for (const [bytes, base64, headers] of [
    [pythonProto, true, {'content-type': 'application/x-protobuf'}],
    [gzipSync(pythonProto), true, {'content-type': 'application/x-protobuf', 'content-encoding': 'gzip'}],
    [nodeJson, false, {'content-type': 'application/json'}]]) {
    const {request, sourceIp} = ingestIngressRequest(event('POST /v1/traces', {body: bytes, base64, headers: {...headers, 'x-supatrace-key': 'k'}}), cfg);
    assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
    assert.equal(request.url, 'https://supatrace.dev/v1/traces'); assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('content-type'), headers['content-type']); assert.equal(request.headers.get('content-encoding'), headers['content-encoding'] || null);
    assert.equal(request.headers.has('x-amz-content-sha256'), false); assert.equal(sourceIp, '203.0.113.7');
  }
});

test('only credentials and content headers cross: no cookie, origin, host, edge token or forwarded address', () => {
  const e = otlp({authorization: 'Bearer ' + 'a'.repeat(43), 'x-supatrace-key': 'k', cookie: '__Host-supatrace=x', origin: 'https://evil.invalid', 'x-supatrace-host': 'supatrace.tech', 'user-agent': 'OTel-OTLP-Exporter-Python/1.45.2'});
  e.cookies = ['__Host-supatrace=x'];
  const {request} = ingestIngressRequest(e, cfg);
  assert.deepEqual([...request.headers.keys()].sort(), ['authorization', 'content-type', 'user-agent', 'x-supatrace-key']);
});

test('the real handler stores an OTLP export sent with x-supatrace-key or a bearer key, and answers in protobuf', async () => {
  for (const credential of [t => ({'x-supatrace-key': t}), t => ({authorization: 'Bearer ' + t})]) {
    const f = fixture(), ok = await through(f, otlp(credential(f.token)));
    assert.equal(ok.statusCode, 200); assert.equal(ok.isBase64Encoded, true); assert.equal(ok.body, ''); assert.equal(f.rows.size, 1);
    assert.equal([...f.rows.values()][0].status, 'accepted');
    // The per-address limit is charged to the viewer, not to the gateway or CloudFront address.
    assert.equal(f.rates.find(r => r.scope === 'request').identity, '203.0.113.7');
    const wrong = await through(f, otlp(credential('b'.repeat(43)))); assert.equal(wrong.statusCode, 401);
  }
  const none = await through(fixture(), otlp()); assert.equal(none.statusCode, 401);
});

test('Langfuse SDK routes pass HTTP Basic through; Basic is not a credential on /v1/traces', async () => {
  const f = fixture(), basic = 'Basic ' + Buffer.from('pk-lf-anything:' + f.token).toString('base64');
  const projects = await through(f, event('GET /api/public/projects', {headers: {authorization: basic}}));
  assert.equal(projects.statusCode, 200); assert.equal(JSON.parse(projects.body).data.length, 1);
  const health = await through(f, event('GET /api/public/health')); assert.equal(health.statusCode, 200); assert.equal(JSON.parse(health.body).status, 'OK');
  const lfOtel = await through(f, event('POST /api/public/otel/v1/traces', {body: pythonProto, base64: true, headers: {'content-type': 'application/x-protobuf', authorization: basic}}));
  assert.equal(lfOtel.statusCode, 200); assert.equal(f.rows.size, 1);
  const batch = JSON.stringify({batch: [{id: 'e1', type: 'trace-create', timestamp: '2026-11-14T20:00:00.000Z', body: {id: 'trace-1', name: 'synthetic'}}]});
  const ingestion = await through(f, event('POST /api/public/ingestion', {body: batch, headers: {'content-type': 'application/json', authorization: basic}}));
  assert.equal(ingestion.statusCode, 207); assert.equal(JSON.parse(ingestion.body).successes.length, 1);
  assert.equal((await through(f, event('GET /api/public/projects', {headers: {authorization: 'Basic ' + Buffer.from('pk:' + 'b'.repeat(43)).toString('base64')}}))).statusCode, 401);
  assert.equal((await through(fixture(), otlp({authorization: basic}))).statusCode, 401);
});

test('a request that did not come through the distribution is refused before any application work', () => {
  assert.deepEqual(refused(otlp({'x-supatrace-edge': 'F'.repeat(40)})), [403, 'ingest_ingress_forbidden']);
  const missing = otlp(); delete missing.headers['x-supatrace-edge']; assert.deepEqual(refused(missing), [403, 'ingest_ingress_forbidden']);
  assert.deepEqual(refused(otlp({'x-supatrace-edge': 'disabled'})), [403, 'ingest_ingress_forbidden']);
  // An unset or malformed token turns the whole ingress off; it never matches a presented value.
  for (const edgeToken of [undefined, '', 'disabled', 'short', 'E'.repeat(31), 'E'.repeat(39) + '!']) {
    assert.deepEqual(refused(otlp({'x-supatrace-edge': String(edgeToken)}), {...cfg, edgeToken}), [503, 'ingest_ingress_disabled']);
  }
  for (const ip of ['', 'not-an-ip', '203.0.113.7:443', '203.0.113.7, 198.51.100.1']) assert.deepEqual(refused(otlp({'x-supatrace-viewer-ip': ip})), [400, 'invalid_ingress_source_ip']);
  const noIp = otlp(); delete noIp.headers['x-supatrace-viewer-ip']; assert.deepEqual(refused(noIp), [400, 'invalid_ingress_source_ip']);
  assert.deepEqual(refused(otlp({'X-Supatrace-Edge': cfg.edgeToken})), [400, 'duplicate_ingress_header']);
});

test('wrong route, API, stage, domain, method, path or a query string fails closed', () => {
  for (const mutate of [e => e.routeKey = 'POST /api/batches', e => e.requestContext.routeKey = 'GET /api/public/health', e => e.routeKey = e.requestContext.routeKey = 'POST /api/me',
    e => e.requestContext.apiId = 'otherapi', e => e.requestContext.stage = 'prod', e => e.requestContext.domainName = 'evil.invalid', e => e.requestContext.domainName = 'ingestapi1.execute-api.eu-west-1.amazonaws.com',
    e => e.requestContext.http.method = 'GET', e => e.rawPath = '/api/batches', e => e.requestContext.http.path = '/v1/traces/', e => e.rawQueryString = 'workspace=other', e => e.version = '1.0']) {
    const e = otlp(); mutate(e); assert.deepEqual(refused(e), [403, 'ingest_ingress_scope_mismatch']);
  }
  assert.equal(INGEST_ROUTES.every(route => /^(POST|GET) \/(v1\/traces|api\/public\/[a-z0-9/]+)$/.test(route)), true);
});

test('body rules: POST needs a bounded, valid body; GET carries none', () => {
  const base = () => otlp();
  for (const [mutate, expected] of [[e => delete e.body, [400, 'invalid_ingress_body']], [e => e.body = '', [400, 'invalid_ingress_body']], [e => delete e.isBase64Encoded, [400, 'invalid_ingress_body']],
    [e => e.body = 'not base64 %%%', [400, 'invalid_ingress_base64']], [e => e.body = 'A'.repeat(720004), [413, 'ingest_ingress_body_limit']],
    [e => e.headers['content-type'] = 'a\r\nb', [400, 'invalid_ingress_header']], [e => e.headers.authorization = 'x'.repeat(8193), [400, 'invalid_ingress_header']], [e => e.headers.accept = ['a'], [400, 'invalid_ingress_header']]]) {
    const e = base(); mutate(e); assert.deepEqual(refused(e), expected);
  }
  assert.deepEqual(refused(event('GET /api/public/health', {body: 'x'})), [400, 'invalid_ingress_body']);
});

test('the Lambda entry routes ingest events to this adapter and leaves other Gateway events to the Stripe ingress', async () => {
  const saved = {id: process.env.INGEST_API_ID, token: process.env.INGEST_EDGE_TOKEN, region: process.env.AWS_REGION, billing: process.env.BILLING_INGRESS_API_ID};
  try {
    process.env.AWS_REGION = 'us-east-1'; delete process.env.BILLING_INGRESS_API_ID;
    assert.equal(isApiGatewayIngress(otlp()), true); assert.equal(isIngestIngress(otlp(), cfg.apiId), true);
    assert.equal(isIngestIngress(otlp(), undefined), false); assert.equal(isIngestIngress(otlp(), ''), false); assert.equal(isIngestIngress(otlp(), 'otherapi'), false);
    // Not configured: the event is not an ingest event, and the Stripe adapter refuses it.
    delete process.env.INGEST_API_ID; delete process.env.INGEST_EDGE_TOKEN;
    let r = await awsHandler(otlp()); assert.equal(r.statusCode, 503); assert.equal(JSON.parse(r.body).error, 'billing_ingress_disabled');
    // API named but no token: ingest stays off.
    process.env.INGEST_API_ID = cfg.apiId;
    r = await awsHandler(otlp()); assert.equal(r.statusCode, 503); assert.equal(JSON.parse(r.body).error, 'ingest_ingress_disabled');
    // Configured: a caller without the distribution's token is refused before secrets, the table or S3 are read.
    process.env.INGEST_EDGE_TOKEN = cfg.edgeToken;
    r = await awsHandler(otlp({'x-supatrace-edge': 'F'.repeat(40)})); assert.equal(r.statusCode, 403); assert.equal(JSON.parse(r.body).error, 'ingest_ingress_forbidden');
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally {
    for (const [name, value] of [['INGEST_API_ID', saved.id], ['INGEST_EDGE_TOKEN', saved.token], ['AWS_REGION', saved.region], ['BILLING_INGRESS_API_ID', saved.billing]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('template: ingest routes sit ahead of /api/*, stay off until a token is set, and survive artifact-only releases', () => {
  const distribution = resourceBlock(template, 'Distribution');
  const order = [...distribution.matchAll(/PathPattern: '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(order, ['/v1/traces', '/api/public/*', '/api/auth/sso/callback', '/api/scim/v2', '/api/scim/v2/*', '/api/*']);
  const behaviors = distribution.split('- PathPattern: ').slice(1);
  for (const block of behaviors.slice(0, 5)) {
    assert.match(block, /TargetOriginId: ingest\n/); assert.match(block, /ViewerProtocolPolicy: https-only/);
    assert.match(block, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);          // CachingDisabled
    assert.match(block, /OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac/);  // AllViewerExceptHostHeader: forwards Authorization
    assert.match(block, /FunctionARN: !GetAtt DirectoryIndex\.FunctionARN/); assert.match(block, /ResponseHeadersPolicyId: !Ref SecurityHeaders/);
  }
  assert.match(behaviors[5], /TargetOriginId: api\n/);
  assert.match(distribution, /HeaderName: X-Supatrace-Edge\n\s+HeaderValue: !If \[IngestEdgeConfigured, !Ref IngestEdgeToken, disabled\]/);
  // The existing viewer function stamps the viewer address on ingest paths and drops a client-sent edge value.
  assert.ok(resourceBlock(template, 'DirectoryIndex').match(/Comment: (.*)/)[1].length <= 128, 'CloudFront rejects a function comment over 128 characters');
  const fn = resourceBlock(template, 'DirectoryIndex'), code = fn.slice(fn.indexOf('FunctionCode: |') + 15).split('\n').map(line => line.slice(8)).join('\n');
  const run = new Function(code + '\nreturn handler;')();
  for (const uri of ['/v1/traces', '/api/public/ingestion', '/api/public/otel/v1/traces', '/api/me']) {
    const out = run({viewer: {ip: '203.0.113.7'}, request: {uri, querystring: {}, headers: {host: {value: 'SupaTrace.dev'}, 'x-supatrace-viewer-ip': {value: '10.0.0.1'}, 'x-supatrace-edge': {value: 'guess'}, authorization: {value: 'Bearer k'}}}});
    assert.equal(out.uri, uri); assert.equal(out.statusCode, undefined);
    assert.equal(out.headers['x-supatrace-viewer-ip'].value, '203.0.113.7'); assert.equal('x-supatrace-edge' in out.headers, false);
    assert.equal(out.headers['x-supatrace-host'].value, 'supatrace.dev'); assert.equal(out.headers.authorization.value, 'Bearer k');
  }
  assert.equal('x-supatrace-viewer-ip' in run({request: {uri: '/v1/traces', querystring: {}, headers: {'x-supatrace-viewer-ip': {value: '10.0.0.1'}}}}).headers, false);
  assert.equal(run({viewer: {ip: '203.0.113.7'}, request: {uri: '/v1/traces/', querystring: {}, headers: {}}}).uri, '/v1/traces/index.html', 'only the exact OTLP path is an ingest path');
  // Ingest, identity protocols and the separate billing webhook are the complete allow-list; no $default catch-all.
  const routes = [...template.matchAll(/RouteKey: '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(routes.sort(), [...INGEST_ROUTES, ...IDENTITY_ROUTES, 'POST /api/billing/webhook'].sort());
  // A reference to the function's attributes would be re-evaluated on every artifact release.
  const integration = resourceBlock(template, 'IngestIntegration');
  assert.match(integration, /IntegrationUri: !Sub 'arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:supatrace-alpha-api'/);
  assert.equal(/!GetAtt Api\./.test(integration), false);
  assert.match(resourceBlock(template, 'AccountErasureSchedule'), /Arn: !GetAtt Api\.Arn/);
  assert.match(resourceBlock(template, 'InvokeIngest'), /Principal: apigateway\.amazonaws\.com[\s\S]+SourceArn: !Sub 'arn:\$\{AWS::Partition\}:execute-api:\$\{AWS::Region\}:\$\{AWS::AccountId\}:\$\{IngestApi\}\/\*'/);
  assert.match(resourceBlock(template, 'Api'), /INGEST_API_ID: !Ref IngestApi\n\s+INGEST_EDGE_TOKEN: !Ref IngestEdgeToken/);
  assert.match(template, /  IngestEdgeToken:\n    Type: String\n    NoEcho: true\n    Default: ''\n    AllowedPattern: '\^\$\|\^\[A-Za-z0-9\]\{32,128\}\$'/);
  const names = templateParameterNames(template), defaults = templateParameterDefaults(template);
  assert.equal(defaults.IngestEdgeToken, '');
  const prior = names.filter(name => name !== 'IngestEdgeToken').map(ParameterKey => ({ParameterKey, ParameterValue: 'existing'}));
  const pick = rows => deployParameters(names, rows, 'releases/test/supatrace-lambda.zip', defaults).find(p => p.ParameterKey === 'IngestEdgeToken');
  assert.deepEqual(pick(prior), {ParameterKey: 'IngestEdgeToken', ParameterValue: ''});
  assert.deepEqual(pick([...prior, {ParameterKey: 'IngestEdgeToken', ParameterValue: '****'}]), {ParameterKey: 'IngestEdgeToken', UsePreviousValue: true});
});
