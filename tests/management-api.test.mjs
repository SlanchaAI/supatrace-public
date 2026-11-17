import {readFileSync} from 'node:fs';
// Personal access tokens and the read-only management API (/api/v1), against the real handler
// and store logic (in-memory DynamoDB adapter). Every operation in the served OpenAPI document
// is called and its response checked against the document's schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {start} from './harness.mjs';
import {digest} from '../src/aws-auth.mjs';
import {MANAGEMENT_OPENAPI} from '../src/management-openapi.mjs';
import {managementRoute, accessToken} from '../src/access-tokens.mjs';
import {ACCESS_TOKEN_CAP} from '../src/dynamodb-store.mjs';
import {minimumPlan} from '../src/entitlements.mjs';

const newToken = () => 'stpat_' + randomBytes(32).toString('base64url');
async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const post = (live, cookie, path, data, origin = live.origin) => fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie, origin, 'content-type': 'application/json'}, body: JSON.stringify(data)});
async function createToken(live, cookie, name = 'ci', days) { const token = newToken(), r = await post(live, cookie, 'tokens', {name, token_hash: digest(token), ...(days ? {expires_in_days: days} : {})}); assert.equal(r.status, 201, await r.clone().text()); return {token, row: await r.json()}; }
const v1 = (live, path, token, headers = {}) => fetch(live.origin + '/api/v1/' + path, {headers: {...(token ? {authorization: 'Bearer ' + token} : {}), ...headers}});

// A small JSON Schema checker for the subset the OpenAPI document uses.
function check(schema, value, at = '$') {
  if (schema.$ref) return check(MANAGEMENT_OPENAPI.components.schemas[schema.$ref.split('/').pop()], value, at);
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types) assert.ok(types.includes(kind) || kind === 'integer' && types.includes('number'), `${at}: expected ${types} got ${kind}`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${at}: ${JSON.stringify(value)} not in enum`);
  if (schema.format === 'date-time' && typeof value === 'string') assert.ok(Number.isFinite(Date.parse(value)), `${at}: not a date-time`);
  if (kind === 'object') { for (const name of schema.required ?? []) assert.ok(Object.hasOwn(value, name), `${at}: missing ${name}`); for (const [name, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, name)) check(child, value[name], at + '.' + name); }
  if (kind === 'array' && schema.items) value.forEach((item, index) => check(schema.items, item, `${at}[${index}]`));
}

test('every operation in the served OpenAPI document answers 200 with a body that matches its schema', async () => {
  const live = await start(); try {
    const {tenant, cookie} = await account(live), runs = await live.seedRuns(tenant, 3), {token} = await createToken(live, cookie);
    const served = await fetch(live.origin + '/api/v1/openapi.json'); assert.equal(served.status, 200); const spec = await served.json();
    assert.deepEqual(spec, JSON.parse(JSON.stringify(MANAGEMENT_OPENAPI))); assert.equal(spec.openapi, '3.1.0');
    const seen = [];
    for (const [path, item] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(item)) {
      assert.equal(method, 'get', 'the alpha is read-only');
      const url = path.replace('{trace_id}', runs[0]).replace('/api/v1/', ''), response = await v1(live, url, token);
      assert.equal(response.status, 200, path + ' ' + await response.clone().text());
      check(operation.responses[200].content['application/json'].schema, await response.json(), operation.operationId); seen.push(operation.operationId);
      // Documented query parameters are accepted; an undocumented one is refused.
      for (const parameter of (operation.parameters ?? []).filter(p => p.in === 'query' && p.schema.default !== undefined)) assert.equal((await v1(live, url + '?' + parameter.name + '=' + parameter.schema.default, token)).status, 200, path + ' ' + parameter.name);
      assert.equal((await v1(live, url + '?undocumented=1', token)).status, 400);
      const unauthenticated = await v1(live, url); assert.equal(unauthenticated.status, 401); check(operation.responses[401].content['application/json'].schema, await unauthenticated.json());
    }
    assert.deepEqual(seen.sort(), ['getMe', 'getUsage', 'listIngestLog', 'listKeys', 'listProjects', 'listTraceEvents', 'listTraces', 'listWorkspaces']);
    const traces = await (await v1(live, 'traces?limit=2&sort=started&dir=asc', token)).json(); assert.deepEqual(traces.runs.map(r => r.id), runs.slice(0, 2)); assert.equal(traces.total, 3);
    const events = await (await v1(live, 'traces/' + runs[1] + '/events', token)).json(); assert.equal(events.events.length, 2); assert.equal(events.events[0].name, 'Check the latest build');
    const keys = await (await v1(live, 'keys', token)).json(); assert.equal(keys.keys.length, 1); assert.match(keys.keys[0].id, /^[a-f0-9]{64}$/);
    const me = await (await v1(live, 'me', token)).json(); assert.equal(me.account_id, tenant); assert.equal(me.token.id, digest(token)); assert.ok(!JSON.stringify(me).includes(token));
    // The hosted edge replaces Authorization, so the same token is accepted as X-Supatrace-Key.
    assert.equal((await v1(live, 'projects', null, {'x-supatrace-key': token})).status, 200);
  } finally { await live.close(); }
});

test('tokens are read-only, account-bound, revocable and expire', async () => {
  const live = await start(); try {
    const owner = await account(live), other = await account(live, 5252), runs = await live.seedRuns(owner.tenant, 1), {token, row} = await createToken(live, owner.cookie, 'laptop', 1);
    assert.equal(row.id, digest(token)); assert.equal(row.scope, 'read'); assert.equal(row.expired, false); assert.ok(!JSON.stringify(row).includes(token));
    // No write or session route accepts a token, and /api/v1 accepts nothing but GET.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(live.origin + '/api/v1/keys', {method, headers: {authorization: 'Bearer ' + token, origin: live.origin, 'content-type': 'application/json'}, body: method === 'DELETE' ? undefined : '{}'})).status, 405);
    for (const path of ['runs', 'me', 'keys', 'tokens', 'usage', 'workspaces']) assert.equal((await fetch(live.origin + '/api/' + path, {headers: {authorization: 'Bearer ' + token, 'x-supatrace-key': token}})).status, 401, path);
    assert.equal((await fetch(live.origin + '/api/tokens/revoke', {method: 'POST', headers: {authorization: 'Bearer ' + token, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify({id: row.id})})).status, 401);
    assert.equal((await fetch(live.origin + '/api/keys/revoke', {method: 'POST', headers: {authorization: 'Bearer ' + token, origin: live.origin, 'content-type': 'application/json'}, body: '{}'})).status, 401);
    const raw = JSON.stringify({version: 1, batch_id: 'b', run_id: 'r', events: [{id: 'e', time: '2026-11-14T00:00:00Z', kind: 'note', name: 'n', data: {}}]});
    for (const headers of [{'x-supatrace-key': token}, {authorization: 'Bearer ' + token}]) assert.equal((await fetch(live.origin + '/api/batches', {method: 'POST', headers: {...headers, 'content-type': 'application/json', 'x-amz-content-sha256': digest(raw)}, body: raw})).status, 401);
    for (const path of ['nope', 'tokens', 'traces/' + runs[0], 'traces/' + runs[0] + '/events/extra', 'openapi.json/x']) assert.equal((await v1(live, path, token)).status, 404, path);
    // A write key is not a token; a token of the wrong shape or unknown value is refused.
    const writeKey = await live.writeKey(owner.tenant);
    for (const bad of [writeKey, 'stpat_' + 'b'.repeat(43), token.slice(0, -1), token + 'x', '']) assert.equal((await v1(live, 'me', bad)).status, 401);
    assert.equal((await v1(live, 'me', null, {authorization: 'Basic ' + Buffer.from('x:' + token).toString('base64')})).status, 401);
    assert.equal((await v1(live, 'me', null, {cookie: owner.cookie})).status, 401, 'a browser session is not a management credential');
    // Another account's workspace is not readable, and another account cannot see or revoke the token.
    assert.equal((await v1(live, 'traces?workspace=' + other.tenant, token)).status, 403); assert.equal((await v1(live, 'usage?workspace=' + other.tenant, token)).status, 403);
    assert.equal((await v1(live, 'traces/' + runs[0] + '/events?workspace=' + other.tenant, token)).status, 403);
    const foreign = await createToken(live, other.cookie); assert.equal((await (await v1(live, 'traces', foreign.token)).json()).total, 0);
    assert.deepEqual((await (await fetch(live.origin + '/api/tokens', {headers: {cookie: other.cookie}})).json()).tokens.map(t => t.id), [foreign.row.id]);
    assert.equal((await post(live, other.cookie, 'tokens/revoke', {id: row.id})).status, 404); assert.equal((await v1(live, 'me', token)).status, 200);
    // Creating and revoking need the browser session and its origin.
    assert.equal((await post(live, owner.cookie, 'tokens', {name: 'x', token_hash: digest(newToken())}, 'https://evil.example')).status, 403);
    assert.equal((await post(live, '', 'tokens', {name: 'x', token_hash: digest(newToken())})).status, 401);
    for (const body of [{name: '', token_hash: digest('a')}, {name: 'x'.repeat(81), token_hash: digest('a')}, {name: 'x', token_hash: 'nope'}, {name: 'x', token_hash: digest('a'), expires_in_days: 0}, {name: 'x', token_hash: digest('a'), expires_in_days: 366}, {name: 'x', token_hash: digest('a'), expires_in_days: 1.5}, []])
      assert.equal((await post(live, owner.cookie, 'tokens', body)).status, 400, JSON.stringify(body));
    assert.equal((await post(live, owner.cookie, 'tokens', {name: 'again', token_hash: digest(token)})).status, 409);
    // Listing shows metadata only; revoking stops the token at once and frees its slot.
    const listed = await (await fetch(live.origin + '/api/tokens', {headers: {cookie: owner.cookie}})).json();
    assert.deepEqual(listed.tokens.map(t => [t.id, t.name, t.scope]), [[row.id, 'laptop', 'read']]); assert.equal(listed.limit, ACCESS_TOKEN_CAP); assert.ok(!JSON.stringify(listed).includes(token));
    assert.equal((await post(live, owner.cookie, 'tokens/revoke', {id: row.id})).status, 200); assert.equal((await v1(live, 'me', token)).status, 401);
    assert.equal((await post(live, owner.cookie, 'tokens/revoke', {id: row.id})).status, 404);
    assert.deepEqual((await (await fetch(live.origin + '/api/tokens', {headers: {cookie: owner.cookie}})).json()).tokens, []);
    // Expiry: the store clock decides, not the token.
    const short = await createToken(live, owner.cookie, 'short', 1), realNow = live.store.now.bind(live.store);
    live.store.now = () => realNow() + 86401; try { assert.equal((await v1(live, 'me', short.token)).status, 401); assert.equal(await live.store.lookupAccessToken(digest(short.token)), null); } finally { live.store.now = realNow; }
    assert.equal((await v1(live, 'me', short.token)).status, 200);
  } finally { await live.close(); }
});

test('an account holds at most the capped number of tokens, and a shared workspace follows live membership', async () => {
  // The read-only (viewer) role is the rbac_roles feature, so the shared workspace is on the cheapest plan that has it.
  const live = await start({plan: minimumPlan('rbac_roles').id}); try {
    const owner = await account(live), member = await account(live, 5252);
    for (let i = 0; i < ACCESS_TOKEN_CAP; i++) await createToken(live, owner.cookie, 'token ' + i);
    const full = await post(live, owner.cookie, 'tokens', {name: 'one too many', token_hash: digest(newToken())}); assert.equal(full.status, 409); assert.equal((await full.json()).error, 'access_token_limit');
    const listed = (await (await fetch(live.origin + '/api/tokens', {headers: {cookie: owner.cookie}})).json()).tokens; assert.equal(listed.length, ACCESS_TOKEN_CAP);
    assert.equal((await post(live, owner.cookie, 'tokens/revoke', {id: listed[0].id})).status, 200); await createToken(live, owner.cookie, 'fits again');
    // A viewer's token can read a shared workspace's traces but not its keys, and loses access with the membership.
    await live.seedRuns(owner.tenant, 2);
    assert.equal((await post(live, owner.cookie, 'workspaces', {name: 'Team'})).status, 201);
    const invite = await (await post(live, owner.cookie, 'workspaces/invite', {recipient_id: member.tenant, role: 'viewer'})).json();
    assert.equal((await post(live, member.cookie, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token})).status, 200);
    const {token} = await createToken(live, member.cookie, 'viewer token');
    assert.equal((await (await v1(live, 'traces?workspace=' + owner.tenant, token)).json()).total, 2);
    assert.equal((await v1(live, 'keys?workspace=' + owner.tenant, token)).status, 403);
    const spaces = (await (await v1(live, 'workspaces', token)).json()).workspaces; assert.deepEqual(spaces.map(w => [w.id, w.role]).sort(), [[member.tenant, 'owner'], [owner.tenant, 'viewer']].sort());
    const members = (await (await fetch(live.origin + '/api/workspaces/members', {headers: {cookie: owner.cookie}})).json()).members, row = members.find(m => (m.user_id ?? m.id) === member.tenant);
    const removed = await post(live, owner.cookie, 'workspaces/member', {user_id: member.tenant, role: 'removed', version: row.version}); assert.equal(removed.status, 200, await removed.clone().text());
    assert.equal((await v1(live, 'traces?workspace=' + owner.tenant, token)).status, 403); assert.equal((await v1(live, 'traces', token)).status, 200);
    assert.deepEqual((await (await v1(live, 'workspaces', token)).json()).workspaces.map(w => w.id), [member.tenant]);
  } finally { await live.close(); }
});

test('route table: only listed GET paths resolve, and only with their documented query parameters', () => {
  const route = (path, method = 'GET') => managementRoute(method, new URL('https://supatrace.dev' + path));
  assert.equal(route('/api/v1/traces?limit=5&workspace=github-1').url.pathname + route('/api/v1/traces?limit=5&workspace=github-1').url.search, '/api/runs?workspace=github-1&limit=5');
  assert.equal(route('/api/v1/traces/run-1/events?after=abc').url.search, '?after=abc&run=run-1');
  assert.deepEqual(route('/api/v1/me'), {custom: 'me'});
  assert.equal(route('/api/v1/traces?project=p').url.search, '?project=p');
  for (const bad of ['/api/v1/traces?run=x', '/api/v1/usage?environment=production', '/api/v1/traces?limit=1&limit=2', '/api/v1/traces/a/events?run=b']) assert.throws(() => route(bad), {code: 'invalid_query'}, bad);
  for (const bad of ['/api/v1/', '/api/v1/batches', '/api/v1/traces/', '/api/v1/traces/a%2Fb/events', '/api/v1/../keys', '/api/v1/tokens']) assert.throws(() => route(bad), {code: 'not_found'}, bad);
  assert.throws(() => route('/api/v1/keys', 'POST'), {code: 'method_not_allowed'});
  const request = headers => new Request('https://supatrace.dev/', {headers}), token = 'stpat_' + 'a'.repeat(43);
  assert.equal(accessToken(request({authorization: 'Bearer ' + token})), token); assert.equal(accessToken(request({'x-supatrace-key': token})), token);
  assert.equal(accessToken(request({authorization: 'Bearer ' + 'a'.repeat(43)})), ''); assert.equal(accessToken(request({'x-supatrace-key': 'a'.repeat(43)})), ''); assert.equal(accessToken(request({})), '');
});

test('the public Management API page lists every path in the OpenAPI document and nothing else under /api/v1', () => {
  const page = readFileSync(new URL('../public/docs/management-api/index.html', import.meta.url), 'utf8'), guide = readFileSync(new URL('../docs/management-api.md', import.meta.url), 'utf8');
  const documented = Object.keys(MANAGEMENT_OPENAPI.paths).sort(), rows = [...page.matchAll(/<th scope="row"><code>GET (\/api\/v1\/[^<]+)<\/code><\/th>/g)].map(match => match[1]).sort();
  assert.deepEqual(rows, documented, 'the endpoint table and the OpenAPI document name the same paths');
  for (const path of documented) assert.ok(guide.includes('`GET ' + path + '`'), 'docs/management-api.md lists ' + path);
  // The limits the page states are the ones the code enforces.
  assert.ok(page.includes(`Up to ${ACCESS_TOKEN_CAP} tokens`)); assert.ok(page.includes('120 requests a minute')); assert.ok(page.includes('1 to 365 days, 30 by default'));
  assert.ok(page.includes('href="/api/v1/openapi.json"')); assert.match(readFileSync(new URL('../public/app/access-tokens.js', import.meta.url), 'utf8'), /href="\/docs\/management-api\/"/);
});
