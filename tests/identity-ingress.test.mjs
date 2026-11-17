import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {identityIngressRequest, IDENTITY_ROUTES} from '../src/identity-ingress.mjs';
import {resourceBlock} from '../aws/change-set-guard.mjs';

const config = {apiId: 'identity1', region: 'us-east-1', edgeToken: 'E'.repeat(40)};
function event(method = 'POST', path = '/api/auth/sso/callback', body = 'SAMLResponse=synthetic&RelayState=synthetic') {
  const route = path.startsWith('/api/auth/') ? IDENTITY_ROUTES[0] : path === '/api/scim/v2' ? IDENTITY_ROUTES[1] : IDENTITY_ROUTES[2];
  return {version: '2.0', routeKey: route, rawPath: path, rawQueryString: '', headers: {'x-supatrace-edge': config.edgeToken, 'x-supatrace-viewer-ip': '203.0.113.7', 'x-supatrace-host': 'supatrace.dev', 'content-type': 'application/x-www-form-urlencoded'},
    cookies: ['__Host-supatrace=ignore-me', 'supatrace-sso=relay'],
    requestContext: {apiId: config.apiId, domainName: 'identity1.execute-api.us-east-1.amazonaws.com', stage: '$default', routeKey: route, http: {method, path}},
    ...(body === undefined ? {} : {body, isBase64Encoded: false})};
}
const refused = (value, cfg = config) => { try { identityIngressRequest(value, cfg); } catch (e) { assert.equal(e.edgeIngress, true); return e.status; } return null; };

test('native SAML body and only relay cookie survive the HTTP API without caller hashing', async () => {
  for (const encoded of [false, true]) {
    const e = event(), raw = e.body; e.isBase64Encoded = encoded;
    if (encoded) e.body = Buffer.from(raw).toString('base64');
    e.headers.authorization = 'Bearer ignored'; e.headers.origin = 'https://idp.example';
    const {request, sourceIp} = identityIngressRequest(e, config);
    assert.equal(request.url, 'https://supatrace.dev/api/auth/sso/callback');
    assert.equal(await request.text(), raw); assert.equal(request.headers.get('cookie'), 'supatrace-sso=relay');
    assert.equal(request.headers.has('authorization'), false); assert.equal(request.headers.has('origin'), false);
    assert.equal(request.headers.has('x-amz-content-sha256'), false); assert.equal(sourceIp, '203.0.113.7');
  }
});

test('standard SCIM bearer CRUD and query strings pass without session cookies or hashes', async () => {
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
    const body = ['GET', 'DELETE'].includes(method) ? undefined : '{"active":false}';
    const e = event(method, '/api/scim/v2/Users/sso-person', body); if (body === undefined) delete e.body;
    e.rawQueryString = 'filter=userName%20eq%20%22person%40example.com%22&count=1';
    e.headers.authorization = 'Bearer synthetic-token';
    const {request} = identityIngressRequest(e, config);
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-token'); assert.equal(request.headers.has('cookie'), false);
    assert.equal(new URL(request.url).searchParams.get('count'), '1'); assert.equal(request.method, method);
    if (body !== undefined) assert.equal(await request.text(), body);
  }
});

test('each transport scope and edge guard fails independently before application access', () => {
  const mutations = [
    e => {e.version = '1.0';}, e => {e.routeKey = 'POST /api/keys';}, e => {e.requestContext.routeKey = 'other';},
    e => {e.requestContext.apiId = 'other';}, e => {e.requestContext.domainName = 'other.execute-api.us-east-1.amazonaws.com';},
    e => {e.requestContext.stage = 'production';}, e => {e.requestContext.http.path = '/api/me';},
    e => {e.requestContext.http.method = 'GET';}, e => {e.rawPath = e.requestContext.http.path = '/api/me';},
    e => {delete e.headers['x-supatrace-edge'];}, e => {e.headers['x-supatrace-edge'] = 'wrong';},
    e => {e.headers['x-supatrace-viewer-ip'] = 'not-an-ip';}, e => {e.headers['x-supatrace-host'] = 'evil.example';},
    e => {e.headers['X-Supatrace-Edge'] = config.edgeToken;}, e => {e.headers.accept = 'bad\r\nvalue';},
    e => {e.rawQueryString = 'unexpected=1';}, e => {e.cookies.push('supatrace-sso=duplicate');},
    e => {e.cookies = ['supatrace-sso=x\r\n'];}, e => {e.body = 'x'.repeat(40001);},
    e => {e.body = '!'; e.isBase64Encoded = true;}, e => {delete e.body;}
  ];
  for (const mutate of mutations) {const e = event(); mutate(e); assert.ok(refused(e), mutate.toString());}
  for (const [key, value] of [['apiId', 'bad/'], ['region', '../bad'], ['edgeToken', 'short'], ['origins', ['https://evil.example']]]) assert.equal(refused(event(), {...config, [key]: value}), 503);
  for (const path of ['/api/scim/v20/Users', '/api/scim/v2/../me', '/api/scim/v2/Users/a/b', '/api/scim/v2/Unknown']) assert.equal(refused(event('GET', path, undefined)), 403);
  for (const method of ['HEAD', 'OPTIONS', 'TRACE']) assert.equal(refused(event(method, '/api/scim/v2/Users', undefined)), 403);
  const readWithBody = event('GET', '/api/scim/v2/Users', 'body'); assert.equal(refused(readWithBody), 400);
});

test('CloudFront and Gateway wire only identity protocol paths to the guarded adapter', () => {
  const template = readFileSync(new URL('../aws/template.yaml', import.meta.url), 'utf8');
  for (const path of ['/api/auth/sso/callback', '/api/scim/v2', '/api/scim/v2/*']) {
    const start = template.indexOf("PathPattern: '" + path + "'"); assert.ok(start > 0);
    const behavior = template.slice(start, template.indexOf("          - PathPattern:", start + 1));
    assert.match(behavior, /TargetOriginId: ingest/); assert.match(behavior, /FunctionARN: !GetAtt DirectoryIndex.FunctionARN/);
    assert.match(behavior, /OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac/);
  }
  for (const [name, route] of [['IdentityRouteSamlCallback', IDENTITY_ROUTES[0]], ['IdentityRouteScimRoot', IDENTITY_ROUTES[1]], ['IdentityRouteScim', IDENTITY_ROUTES[2]]]) {
    const block = resourceBlock(template, name); assert.ok(block.includes("RouteKey: '" + route + "'")); assert.match(block, /ApiId: !Ref IngestApi/);
  }
  const handler = readFileSync(new URL('../aws/handler.mjs', import.meta.url), 'utf8');
  assert.match(handler, /gateway&&isIdentityIngress\(event\)\?identityIngressRequest/);
  assert.match(handler, /const ingress=identity\?identity.request/);
});
