// Audit log (#125) against the real handler and store logic (in-memory DynamoDB adapter).
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {start as startHarness} from './harness.mjs';
// These tests exercise paid features, so every fixture organization is on Enterprise. tests/entitlements.test.mjs covers the gates.
const start = (options = {}) => startHarness({plan: 'enterprise', ...options});
import {digest, establishSession} from '../src/aws-auth.mjs';
import {totp} from '../src/dashboard-auth.mjs';
import {auditPut, auditCsv, AUDIT_ACTIONS, AUDIT_RETENTION_DAYS} from '../src/audit.mjs';
import {auditQuery, auditDetailText} from '../public/app/audit-log.js';

async function account(live, id) { let cookie = ''; const tenant = await live.signIn({addCookies: async value => { cookie = value.map(c => c.name + '=' + c.value).join('; '); }}, id); return {tenant, cookie}; }
const post = (live, who, path, data) => fetch(live.origin + '/api/' + path, {method: 'POST', headers: {cookie: who.cookie, origin: live.origin, 'content-type': 'application/json'}, body: JSON.stringify(data)});
const get = (live, who, path) => fetch(live.origin + '/api/' + path, {headers: {cookie: who.cookie}});
const ok = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.headers.get('content-type')?.includes('json') ? response.json() : response.text(); };
const log = async (live, who, query = '') => (await ok(await get(live, who, 'audit' + query))).events;
const actions = events => events.map(event => event.action);

test('a scripted sequence of real requests emits exactly one event per action, newest first, with no secrets', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), member = await account(live, 5252), scope = '?workspace=' + owner.tenant;
    assert.deepEqual(await log(live, owner), [], 'reads and the fixture session write nothing');
    await ok(await post(live, owner, 'workspaces', {name: 'Product team'}), 201);
    const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: member.tenant, role: 'viewer'}), 201);
    await ok(await post(live, member, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token}));
    const listed = (await ok(await get(live, owner, 'workspaces/members'))).members.find(row => row.user_id === member.tenant);
    await ok(await post(live, owner, 'workspaces/member', {user_id: member.tenant, role: 'admin', version: listed.version}));
    await ok(await post(live, owner, 'environments', {id: 'staging', name: 'Staging'}), 201);
    const key = randomBytes(32).toString('base64url'), setup = await live.store.createSetup(digest(key));
    await ok(await post(live, member, 'setup/approve' + scope, {user_code: setup.user_code}));
    await ok(await post(live, member, 'setup/approve' + scope, {user_code: setup.user_code}));  // repeat status: no second key, no second event
    await ok(await post(live, owner, 'keys/revoke', {id: digest(key)}));
    await ok(await post(live, owner, 'keys/revoke', {id: digest(key)}));  // already revoked: no second event
    const pat = 'stpat_' + randomBytes(32).toString('base64url');
    await ok(await post(live, owner, 'tokens', {name: 'ci', token_hash: digest(pat)}), 201);
    await ok(await post(live, owner, 'tokens/revoke', {id: digest(pat)}));
    const typed = randomBytes(32).toString('hex'), next = randomBytes(32).toString('hex');
    await ok(await post(live, owner, 'keys/create', {key_hash: typed, key_type: 'publishable'}), 201);
    await ok(await post(live, owner, 'keys/create', {key_hash: typed, key_type: 'publishable'}), 201);  // same request repeated: same key, no second event
    await ok(await post(live, owner, 'keys/rotate', {id: typed, key_hash: next}), 201);
    await ok(await post(live, owner, 'keys/rotate', {id: typed, key_hash: next}), 201);  // repeat: no second event
    await ok(await post(live, member, 'audit/events' + scope, {action: 'export.started', kind: 'trace', run_id: 'run-1'}), 201);
    await ok(await post(live, owner, 'workspaces/member', {user_id: member.tenant, role: 'removed', version: listed.version + 1}));

    const events = await log(live, owner);
    assert.deepEqual(actions(events), ['member.remove', 'export.started', 'key.rotate', 'key.create', 'token.revoke', 'token.create', 'key.revoke', 'key.create', 'environment.create', 'member.role_change', 'member.accept', 'member.invite', 'workspace.sharing_enabled']);
    assert.deepEqual([events[2].target, events[2].detail.replaced_by, events[2].detail.key_type, events[3].target], [typed.slice(0, 12), next.slice(0, 12), 'publishable', typed.slice(0, 12)]);
    const by = Object.fromEntries(events.filter((event, index) => index !== 3).map(event => [event.action, event]));
    assert.deepEqual([by['member.invite'].actor, by['member.invite'].target, by['member.invite'].detail.role], [owner.tenant, member.tenant, 'viewer']);
    assert.deepEqual([by['member.accept'].actor, by['member.accept'].target], [member.tenant, member.tenant]);
    assert.deepEqual(by['member.role_change'].detail, {from: 'viewer', to: 'admin'});
    assert.deepEqual([by['member.remove'].target, by['member.remove'].detail.role], [member.tenant, 'admin']);
    assert.deepEqual([by['key.create'].actor, by['key.create'].target, by['key.revoke'].target], [member.tenant, digest(key).slice(0, 12), digest(key).slice(0, 12)]);
    assert.deepEqual([by['token.create'].target, by['token.create'].detail.name, by['token.revoke'].target], [digest(pat).slice(0, 12), 'ci', digest(pat).slice(0, 12)]);
    assert.deepEqual([by['export.started'].source, by['export.started'].actor, by['export.started'].target, by['export.started'].detail.kind], ['client_reported', member.tenant, 'run-1', 'trace']);
    for (const event of events) { assert.equal(event.ip, '127.0.0.1'); assert.match(event.id, /^[a-f0-9]{16}$/); assert.ok(Number.isFinite(Date.parse(event.time))); assert.ok(AUDIT_ACTIONS.includes(event.action)); if (event.action !== 'export.started') assert.equal(event.source, 'server'); }
    const text = JSON.stringify(events);
    for (const secret of [typed, next, key, digest(key), pat, digest(pat), invite.token, digest(invite.token), owner.cookie.split('=')[1], member.cookie.split('=')[1]]) assert.equal(text.includes(secret), false, 'no key, token, hash or session value in the log');
    // The member's own workspace log holds nothing from the owner's workspace.
    assert.deepEqual(await log(live, member), []);
  } finally { await live.close(); }
});

test('only the owner reads or exports the log; members, outsiders and access tokens are refused', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), admin = await account(live, 5252), viewer = await account(live, 6262), outsider = await account(live, 7272), scope = '?workspace=' + owner.tenant;
    await ok(await post(live, owner, 'workspaces', {name: 'Team'}), 201);
    for (const [who, role] of [[admin, 'admin'], [viewer, 'viewer']]) { const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: who.tenant, role}), 201); await ok(await post(live, who, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token})); }
    for (const who of [admin, viewer]) for (const path of ['audit', 'audit/export', 'audit/export?format=csv']) {
      const response = await get(live, who, path + (path.includes('?') ? '&' : '?') + 'workspace=' + owner.tenant);
      assert.equal(response.status, 403); assert.equal((await response.json()).error, 'workspace_owner_required');
    }
    for (const path of ['audit', 'audit/export']) { const response = await get(live, outsider, path + scope); assert.equal(response.status, 403); assert.equal((await response.json()).error, 'workspace_unavailable'); }
    assert.equal((await post(live, outsider, 'audit/events' + scope, {action: 'export.started', kind: 'account'})).status, 403);
    assert.equal((await fetch(live.origin + '/api/audit')).status, 401);
    // A viewer may report its own export, and nothing else.
    await ok(await post(live, viewer, 'audit/events' + scope, {action: 'export.started', kind: 'workspace'}), 201);
    for (const body of [{action: 'key.revoke', kind: 'trace'}, {action: 'export.started', kind: 'everything'}, {action: 'export.started', kind: 'account', run_id: 'x'}, {action: 'export.started', kind: 'trace', actor: owner.tenant}, {action: 'export.started', kind: 'trace', run_id: '../x'}]) assert.equal((await post(live, viewer, 'audit/events' + scope, body)).status, 400, JSON.stringify(body));
    assert.equal((await fetch(live.origin + '/api/audit/events' + scope, {method: 'POST', headers: {cookie: viewer.cookie, origin: 'https://evil.example', 'content-type': 'application/json'}, body: JSON.stringify({action: 'export.started', kind: 'trace'})})).status, 403);
    // A personal access token reaches /api/v1 only, and /api/v1 has no audit route.
    const pat = 'stpat_' + randomBytes(32).toString('base64url'); await ok(await post(live, owner, 'tokens', {name: 'ci', token_hash: digest(pat)}), 201);
    assert.equal((await fetch(live.origin + '/api/v1/audit', {headers: {authorization: 'Bearer ' + pat}})).status, 404);
    assert.equal((await fetch(live.origin + '/api/audit', {headers: {authorization: 'Bearer ' + pat}})).status, 401);
    const mine = (await log(live, owner)).filter(event => event.action === 'export.started');
    assert.equal(mine.length, 1); assert.equal(mine[0].actor, viewer.tenant);
  } finally { await live.close(); }
});

test('refused and failed changes write no event', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), other = await account(live, 5252);
    assert.equal((await post(live, owner, 'workspaces/invite', {recipient_id: other.tenant, role: 'viewer'})).status, 403, 'sharing is not enabled yet');
    await ok(await post(live, owner, 'workspaces', {name: 'Team'}), 201);
    assert.equal((await post(live, owner, 'workspaces/invite', {recipient_id: 'github-999999', role: 'viewer'})).status, 400);
    assert.equal((await post(live, owner, 'workspaces/accept', {workspace_id: other.tenant, token: 'x'.repeat(43)})).status, 409);
    assert.equal((await post(live, owner, 'keys/revoke', {id: 'a'.repeat(64)})).status, 404);
    assert.equal((await post(live, owner, 'tokens/revoke', {id: 'b'.repeat(64)})).status, 404);
    assert.equal((await post(live, owner, 'environments', {id: 'default', name: 'x'})).status, 400);
    assert.ok((await post(live, owner, 'billing/checkout', {})).status >= 400);
    assert.ok((await post(live, owner, 'billing/portal', {})).status >= 400);
    assert.deepEqual(actions(await log(live, owner)), ['workspace.sharing_enabled']);
  } finally { await live.close(); }
});

test('filters, paging and both export formats; the export is itself recorded', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), member = await account(live, 5252);
    await ok(await post(live, owner, 'workspaces', {name: '=cmd, "Team"'}), 201);
    const invite = await ok(await post(live, owner, 'workspaces/invite', {recipient_id: member.tenant, role: 'viewer'}), 201);
    await ok(await post(live, member, 'workspaces/accept', {workspace_id: owner.tenant, token: invite.token}));
    for (const id of ['dev', 'staging', 'prod']) await ok(await post(live, owner, 'environments', {id, name: id}), 201);
    assert.deepEqual(actions(await log(live, owner, '?action=member')), ['member.accept', 'member.invite']);
    assert.deepEqual(actions(await log(live, owner, '?action=member.invite')), ['member.invite']);
    assert.deepEqual(actions(await log(live, owner, '?actor=' + member.tenant)), ['member.accept']);
    assert.equal((await log(live, owner, '?from=2100-01-01T00:00:00Z')).length, 0);
    assert.equal((await log(live, owner, '?to=2100-01-01T00:00:00Z&from=2000-01-01T00:00:00Z')).length, 6);
    for (const bad of ['?action=nope', '?actor=bad%20actor', '?from=yesterday', '?limit=0', '?limit=201', '?other=1', '?action=member&action=key', '?format=csv']) assert.equal((await get(live, owner, 'audit' + bad)).status, 400, bad);
    assert.equal((await get(live, owner, 'audit/export?format=xml')).status, 400);
    assert.equal((await get(live, owner, 'audit/export?limit=5')).status, 400);

    const jsonExport = await get(live, owner, 'audit/export?action=environment'); assert.equal(jsonExport.status, 200);
    assert.match(jsonExport.headers.get('content-disposition'), /^attachment; filename="supatrace-audit-github-4242\.json"$/); assert.equal(jsonExport.headers.get('x-audit-export-complete'), 'true');
    const body = await jsonExport.json();
    assert.deepEqual([body.version, body.workspace_id, body.retention_days, body.complete, body.filters.action], [1, owner.tenant, AUDIT_RETENTION_DAYS, true, 'environment']);
    assert.deepEqual(body.events.map(event => event.target), ['prod', 'staging', 'dev']);
    const csvExport = await get(live, owner, 'audit/export?format=csv'); assert.equal(csvExport.status, 200); assert.match(csvExport.headers.get('content-type'), /^text\/csv/);
    const lines = (await csvExport.text()).trimEnd().split('\r\n');
    assert.equal(lines[0], 'time,actor,action,target,ip,source,detail'); assert.equal(lines.length, 1 + 7, 'six changes and the JSON export');
    assert.ok(lines.some(line => line.includes('workspace.sharing_enabled') && line.includes('"{""name"":""=cmd, \\""Team\\""""}"')), 'quoted, with doubled quotes');
    // Each export wrote exactly one audit.export event, with its format and row count.
    const exports = await log(live, owner, '?action=audit');
    assert.deepEqual(exports.map(event => [event.action, event.detail.format, event.detail.events]), [['audit.export', 'csv', 7], ['audit.export', 'json', 3]]);
  } finally { await live.close(); }
});

test('paging returns exactly the limit and the cursor continues without a gap or a repeat', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), context = {workspace: owner.tenant, actor: owner.tenant, ip: '127.0.0.1'};
    for (let i = 0; i < 230; i++) await live.store._tx([auditPut(live.store.now(), context, i % 2 ? 'key.revoke' : 'key.create', 'k' + i)]);
    const seen = []; let after = '', pages = 0;
    do { const page = await ok(await get(live, owner, 'audit?limit=100' + after)); assert.ok(page.events.length <= 100); seen.push(...page.events.map(event => event.target)); after = page.next ? '&after=' + page.next : ''; pages++; } while (after && pages < 10);
    assert.equal(pages, 3); assert.deepEqual(seen, Array.from({length: 230}, (_, i) => 'k' + (229 - i)));
    const filtered = await ok(await get(live, owner, 'audit?limit=7&action=key.create')); assert.equal(filtered.events.length, 7); assert.ok(filtered.next);
    const rest = await ok(await get(live, owner, 'audit?limit=200&action=key.create&after=' + filtered.next)); assert.equal(rest.events.length, 108); assert.equal(rest.next, null);
    assert.equal((await get(live, owner, 'audit?after=' + Buffer.from(JSON.stringify({pk: 'AUDIT#github-5252', sk: 'EVENT#0'})).toString('base64url'))).status, 400, 'a cursor for another workspace is refused');
  } finally { await live.close(); }
});

test('a date range is exported in full even when more than one export budget of newer events exists', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), context = {workspace: owner.tenant, actor: owner.tenant, ip: '127.0.0.1'}, now = live.store.now(), day = 86400;
    // Three old events, then 5,200 newer ones: more than a single export scans.
    for (const target of ['old-1', 'old-2', 'old-3']) await live.store._tx([auditPut(now - 10 * day, context, 'member.invite', target)]);
    for (let i = 0; i < 5200; i += 25) await live.store._tx(Array.from({length: 25}, (_, j) => auditPut(now - day, context, 'key.create', 'new-' + (i + j))));
    const iso = seconds => new Date(seconds * 1000).toISOString(), range = '&from=' + iso(now - 11 * day) + '&to=' + iso(now - 9 * day);
    const old = await get(live, owner, 'audit/export?format=json' + range); assert.equal(old.status, 200); const body = await old.json();
    assert.deepEqual(body.events.map(event => event.target).sort(), ['old-1', 'old-2', 'old-3']); assert.equal(body.complete, true); assert.equal(body.next, null);
    assert.deepEqual((await log(live, owner, '?limit=10' + range)).map(event => event.target).sort(), ['old-1', 'old-2', 'old-3']);
    // Without a range the export is cut at its budget, says so, and its cursor continues to the oldest event.
    const first = await get(live, owner, 'audit/export?format=json&action=key'); const head = await first.json();
    assert.ok(head.events.length >= 4990 && head.events.length <= 5000, 'one export budget, less the audit.export rows it scanned past'); assert.equal(head.complete, false); assert.equal(first.headers.get('x-audit-export-complete'), 'false'); assert.equal(first.headers.get('x-audit-export-next'), head.next);
    const rest = await (await get(live, owner, 'audit/export?format=json&after=' + head.next)).json();
    assert.equal(rest.complete, true); assert.equal(head.events.length + rest.events.filter(event => event.action === 'key.create').length, 5200, 'no gap and no repeat across the two files'); assert.deepEqual(rest.events.filter(event => event.action === 'member.invite').map(event => event.target).sort(), ['old-1', 'old-2', 'old-3']);
  } finally { await live.close(); }
});

test('CSV cells that a spreadsheet would run are neutralised', () => {
  const csv = auditCsv([{time: 't', actor: '=HYPERLINK("x")', action: 'member.invite', target: '+1', ip: '-2', source: '@s', detail: {}}]);
  assert.equal(csv.split('\r\n')[1], 't,"\'=HYPERLINK(""x"")",member.invite,\'+1,\'-2,\'@s,');
});

test('sign-in writes one event after the session is written, and none when the session is refused', async () => {
  const live = await start(); try {
    const owner = await account(live, 4242), env = {store: live.store, sourceIp: '203.0.113.9'};
    const response = await establishSession(env, owner.tenant, 'json', [], true); assert.equal(response.status, 204);
    await assert.rejects(establishSession(env, owner.tenant, 'json', [], true, 41), {code: 'session_changed'});
    const events = await log(live, owner);
    assert.deepEqual(events.map(event => [event.action, event.actor, event.target, event.ip]), [['auth.sign_in', owner.tenant, owner.tenant, '203.0.113.9']]);
    assert.equal(JSON.stringify(events).includes(response.headers.get('set-cookie').match(/__Host-supatrace=([^;]+)/)[1]), false);
  } finally { await live.close(); }
});

test('turning two-factor authentication on and off writes one event each; a repeat off writes none', async () => {
  const live = await start({mfa: true}); try {
    const owner = await account(live, 4242);
    const enrolled = await ok(await post(live, owner, 'auth/mfa/enroll', {}));
    assert.equal((await post(live, owner, 'auth/mfa/confirm', {code: '000000'})).status, 401);
    await ok(await post(live, owner, 'auth/mfa/confirm', {code: totp(enrolled.secret)}));
    await ok(await post(live, owner, 'auth/mfa/disable', {code: totp(enrolled.secret)}));
    await ok(await post(live, owner, 'auth/mfa/disable', {}));
    const events = await log(live, owner);
    assert.deepEqual(actions(events), ['settings.mfa_disabled', 'settings.mfa_enabled']);
    assert.equal(JSON.stringify(events).includes(enrolled.secret), false);
  } finally { await live.close(); }
});

test('events are append-only items with a retention expiry, and reject unknown actions or unsafe values', async () => {
  const live = await start(); try {
    const context = {workspace: 'github-4242', actor: 'github-4242', ip: '127.0.0.1'}, item = auditPut(1000, context, 'key.revoke', 'abc', {environment: 'default'});
    assert.equal(item.Put.ConditionExpression, 'attribute_not_exists(pk)'); assert.equal(item.Put.Item.pk, 'AUDIT#github-4242'); assert.match(item.Put.Item.sk, /^EVENT#\d{12}#\d{7}#[a-f0-9]{16}$/);
    assert.equal(item.Put.Item.ttl, 1000 + AUDIT_RETENTION_DAYS * 86400); assert.equal(item.Put.Item.expires_at, item.Put.Item.ttl);
    await live.store._tx([item]); await assert.rejects(live.store._tx([item]), 'an existing event cannot be overwritten');
    assert.ok(auditPut(2000, context, 'key.revoke').Put.Item.sk < item.Put.Item.sk, 'a later event sorts first');
    assert.throws(() => auditPut(1000, context, 'key.delete_everything'), {code: 'invalid_audit_event'});
    assert.throws(() => auditPut(1000, context, 'key.revoke', null, {note: 'line\nbreak'}), {code: 'invalid_audit_event'});
    assert.throws(() => auditPut(1000, context, 'key.revoke', null, {nested: {a: 1}}), {code: 'invalid_audit_event'});
    assert.throws(() => auditPut(1000, {...context, actor: undefined}, 'key.revoke'), {code: 'invalid_audit_event'});
  } finally { await live.close(); }
});

test('dashboard helpers build the query and detail text', () => {
  assert.equal(auditQuery().toString(), ''); assert.equal(auditQuery({action: 'member', actor: ' github-1 '}).toString(), 'action=member&actor=github-1');
  const dated = auditQuery({from: '2026-11-01', to: '2026-11-02'}); assert.ok(Date.parse(dated.get('to')) - Date.parse(dated.get('from')) > 86400000);
  assert.equal(auditDetailText({from: 'viewer', to: 'admin'}), 'from: viewer, to: admin'); assert.equal(auditDetailText(null), '');
});
