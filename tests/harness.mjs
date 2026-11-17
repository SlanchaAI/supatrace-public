// Test-only local server. Serves public/ with the production CSP and runs the
// live API handler (src/aws-api.mjs) against an in-memory DynamoDB and object
// store. Never shipped: nothing under public/ or aws/ imports this file.
//
// The live handler only accepts APP_ORIGIN https://supatrace.dev, so the
// harness maps the local origin to it on the way in (same-origin requests stay
// same-origin; any other Origin passes through unchanged and is rejected by the
// handler's real Origin check). Sign-in bypasses provider/MFA setup in this test
// fixture but uses the production bounded session allocator. Tests never reach
// GitHub, Google, OpenAI, a SAML IdP, or SES.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {extname, join, normalize, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {digest,setCookie} from '../src/aws-auth.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';
import {createFixtureSession} from './fixture-session.mjs';

const LIVE_ORIGIN = 'https://supatrace.dev';
const root = normalize(fileURLToPath(new URL('../public/', import.meta.url)));
const agentRoot = normalize(fileURLToPath(new URL('../agent/', import.meta.url)));
const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.py': 'text/x-python; charset=utf-8'};
// Copied from aws/template.yaml SecurityHeaders.
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const pageHeaders = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': CSP};

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.startsWith('/agent/')) {
    const name = decoded.slice('/agent/'.length);
    if (!/^[A-Za-z0-9._-]+\.py$/.test(name)) return null;
    const full = normalize(join(agentRoot, name));
    if (full !== agentRoot && !full.startsWith(agentRoot.endsWith(sep) ? agentRoot : agentRoot + sep)) return null;
    return full;
  }
  let rel = decoded.replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const full = normalize(join(root, rel));
  if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return full;
}

function testCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'supatrace-sso-'));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=supatrace-test-idp'], {stdio: 'ignore'});
  const material = {cert: readFileSync(cert, 'utf8'), privateKey: readFileSync(key, 'utf8')};
  rmSync(dir, {recursive: true, force: true});
  return material;
}

// Plan of every account and organization a test file creates. Unset means Free, as in production. A file that tests a
// paid feature calls useTestPlan('pro') or useTestPlan('enterprise') once, or passes `plan` to start().
let defaultPlan = null;
export function useTestPlan(plan) { defaultPlan = plan; }
/** Stamps `plan_id` on each account row as it is created, the way a reconciled subscription or an operator would. */
export function stampPlan(store, plan) {
  const send = store._send.bind(store), tx = store._tx.bind(store), mark = item => { if (item?.sk === 'META' && typeof item.pk === 'string' && item.pk.startsWith('TENANT#') && item.plan_id === undefined) { item.plan_id = plan; item.plan_source = 'test_fixture'; } };
  store._send = (name, input) => { if (name === 'PutCommand') mark(input.Item); return send(name, input); };
  store._tx = items => { for (const entry of items) mark(entry.Put?.Item); return tx(items); };
}
export async function start({enabled = true, google = false, dashboard = false, mfa = false, mcp = false, importJobControl = false, localDev = false, port = 0, configureEnvironment = null, plan = defaultPlan} = {}) {
  // Real time, shifted only while seeding back-dated runs.
  let shift = 0;
  const now = () => Math.floor(Date.now() / 1000) + shift;
  const store = new DynamoMetadataStore({client: new MemoryDynamo(), commands: commandClasses(), tableName: 'metadata', now});
  // Fixture seeding must not depend on collisions in the bounded rate-slot table.
  // Production limiter tests use the real store; rateLimitEvents models UI recovery.
  store.consumeRate = async () => ({allowed: true, hits: 1, retry_after: 60});
  if (plan) stampPlan(store, plan);
  let rateLimitNext = 0;
  const saved = new Map();
  const objects = {
    async putImmutable(key, raw, hash) { if (digest(raw) !== hash) throw Object.assign(new Error('invalid_payload'), {status: 400, code: 'invalid_payload'}); saved.set(key, raw); },
    async get(key) { if (!saved.has(key)) throw Object.assign(new Error('missing'), {status: 503, code: 'object_read_unavailable'}); return saved.get(key); }
  };
  const env = enabled
    ? {ENABLED: true, MCP_BRIDGE_ENABLED: mcp, ...(importJobControl ? {importJobControl:{enabled:true,mode:'control-only'}} : {}), APP_ORIGIN: LIVE_ORIGIN, GITHUB_CLIENT_ID: 'local-github-client', GITHUB_CLIENT_SECRET: 'local-github-secret', ...(google ? {GOOGLE_CLIENT_ID: 'local-google-client', GOOGLE_CLIENT_SECRET: 'local-google-secret'} : {}), store, objects, sourceIp: '127.0.0.1'}
    : {sourceIp: '127.0.0.1'};
  if(configureEnvironment!==null){if(typeof configureEnvironment!=='function')throw Error('invalid_test_configuration');await configureEnvironment(env);}
  let origin;
  const api = async request => handle(request, env);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if(localDev&&env.localImports&&url.pathname.startsWith('/__local__/imports')){
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>2048){res.writeHead(413,pageHeaders);res.end('Local request too large');return;}chunks.push(chunk);}
        const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value)headers.set(name,Array.isArray(value)?value.join(', '):value);
        const request=new Request(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}),response=await env.localImports.handle(request,origin);
        res.writeHead(response.status,{...pageHeaders,...Object.fromEntries(response.headers)});res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      if(localDev&&req.method==='GET'&&(url.pathname==='/__local__/'||['/api/auth/login','/api/auth/google','/api/auth/chatgpt'].includes(url.pathname))){
        res.writeHead(200,{...pageHeaders,'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><title>SupaTrace local development</title><h1>Synthetic local workspace</h1><p>In-memory data only. No identity provider, AWS or Stripe request is made. Data resets when this process exits.</p><ul><li><a href="/__local__/signin?account=4242">Owner account</a></li><li><a href="/__local__/signin?account=5252">Team admin account</a></li><li><a href="/__local__/signin?account=6262">Team viewer account</a></li><li><a href="/__local__/imports">Synthetic private import</a> (owner account)</li></ul>');return;
      }
      if(localDev&&req.method==='GET'&&url.pathname==='/__local__/signin'){
        const id=Number(url.searchParams.get('account'));if(![4242,5252,6262].includes(id)){res.writeHead(400,pageHeaders);res.end('Unknown synthetic account');return;}
        const row=await store.getOrCreateTenant(id),token=await createFixtureSession(store,row.tenant_id);
        res.writeHead(303,{...pageHeaders,location:'/app/#home','set-cookie':setCookie('__Host-supatrace',token,3600)});res.end();return;
      }
      if(localDev&&env.localBilling&&req.method==='GET'&&url.pathname==='/__local__/checkout.js'){
        res.writeHead(200,{...pageHeaders,'content-type':'text/javascript; charset=utf-8'});res.end("document.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=document.querySelector('button');b.disabled=true;try{const r=await fetch(location.href,{method:'POST',headers:{'content-type':'application/json'},body:'{}',credentials:'same-origin'});if(!r.ok||new URL(r.url).pathname!=='/app/')throw Error();location.assign(r.url);}catch{document.querySelector('p').textContent='Synthetic completion could not be confirmed. Reload to inspect the local state.';b.disabled=false;}};");return;
      }
      if(localDev&&env.localBilling&&url.pathname==='/__local__/checkout'){
        const match=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-supatrace=')),token=match?.slice('__Host-supatrace='.length),session=token?await env.store.getSession(digest(token)):null,id=url.searchParams.get('session');
        if(session?.tenant_id!=='github-4242'||!env.localBilling.session(id)){res.writeHead(403,pageHeaders);res.end('Synthetic Checkout unavailable');return;}
        if(req.method==='GET'){res.writeHead(200,{...pageHeaders,'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><title>Local Checkout simulation</title><h1>Local Checkout simulation</h1><p>No payment or Stripe request occurs. This synthetic completion exercises signature verification, capture, stream handling and entitlement readback; '+(env.localBilling.planLimits?'the workspace then gets the chosen plan\u2019s limits (Stripe test-mode rehearsal).':'real quota remains unchanged.')+'</p><form method="post"><button type="submit">Complete synthetic Checkout</button></form><script src="/__local__/checkout.js"></script>');return;}
        if(req.method==='POST'&&req.headers.origin===origin){await env.localBilling.complete(id,session.tenant_id);res.writeHead(303,{...pageHeaders,location:'/app/?billing=success&session_id='+encodeURIComponent(id)+'#usage'});res.end();return;}
        res.writeHead(403,pageHeaders);res.end('Origin required');return;
      }
      // Stands in for the Stripe TEST portal under the test-mode plan rehearsal: switch the plan or cancel.
      if(localDev&&env.localBilling?.planLimits&&req.method==='GET'&&url.pathname==='/__local__/portal.js'){
        res.writeHead(200,{...pageHeaders,'content-type':'text/javascript; charset=utf-8'});res.end("for(const b of document.querySelectorAll('button[data-action]'))b.onclick=async()=>{for(const x of document.querySelectorAll('button'))x.disabled=true;try{const r=await fetch(location.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:b.dataset.action,plan:b.dataset.plan}),credentials:'same-origin'});if(!r.ok)throw Error();location.assign('/app/#billing');}catch{document.querySelector('p').textContent='The synthetic portal change could not be confirmed. Reload to inspect the local state.';for(const x of document.querySelectorAll('button'))x.disabled=false;}};");return;
      }
      if(localDev&&env.localBilling?.planLimits&&url.pathname==='/__local__/portal'){
        const match=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-supatrace=')),token=match?.slice('__Host-supatrace='.length),session=token?await env.store.getSession(digest(token)):null;
        if(session?.tenant_id!=='github-4242'){res.writeHead(403,pageHeaders);res.end('Synthetic portal unavailable');return;}
        if(req.method==='GET'){res.writeHead(200,{...pageHeaders,'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><title>Local billing portal simulation</title><h1>Local billing portal simulation</h1><p>No payment or Stripe request occurs. Each action emits the signed subscription event the Stripe test portal would cause; the worker reconciles it and the workspace plan limits follow.</p>'+(env.localBilling.subscribed()?env.localBilling.plans().map(p=>'<button type="button" data-action="change" data-plan="'+p.id+'">Switch to '+p.name+'</button> ').join('')+'<button type="button" data-action="cancel">Cancel subscription</button>':'<p>No active synthetic subscription. Upgrade from Billing first.</p>')+' <a href="/app/#billing">Back to Billing</a><script src="/__local__/portal.js"></script>');return;}
        if(req.method==='POST'&&req.headers.origin===origin){
          const chunks=[];for await(const chunk of req)chunks.push(chunk);let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{body=null;}
          try{if(body?.action==='cancel')await env.localBilling.cancel(session.tenant_id);else if(body?.action==='change')await env.localBilling.changePlan(session.tenant_id,body.plan);else throw Error('unknown action');}catch{res.writeHead(409,pageHeaders);res.end('Synthetic portal change refused');return;}
          res.writeHead(204,pageHeaders);res.end();return;
        }
        res.writeHead(403,pageHeaders);res.end('Origin required');return;
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/v1/traces') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        if (headers.get('origin') === origin) headers.set('origin', LIVE_ORIGIN);
        let response;
        if (rateLimitNext > 0 && url.pathname === '/api/events') {
          rateLimitNext--;
          response = new Response('{"error":"rate_limit"}', {status: 429, headers: {'content-type': 'application/json', 'retry-after': '1'}});
        } else {
          response = await api(new Request(LIVE_ORIGIN + url.pathname + url.search, {method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)}));
        }
        if(localDev&&env.localBilling&&url.pathname==='/api/billing/checkout'&&response.ok){const data=await response.json();response=new Response(JSON.stringify({...data,local_simulation:true,url:origin+'/__local__/checkout?session='+encodeURIComponent(data.session_id)}),{status:response.status,headers:response.headers});}
        if(localDev&&env.localBilling?.planLimits&&url.pathname==='/api/billing/portal'&&response.ok){const data=await response.json();response=new Response(JSON.stringify({...data,local_simulation:true,url:origin+'/__local__/portal'}),{status:response.status,headers:response.headers});}
        const out = {};
        for (const [name, value] of response.headers) if (name !== 'set-cookie') out[name] = value;
        // The live handler sets Secure __Host- cookies; Chromium accepts them on loopback.
        const cookies = response.headers.getSetCookie();
        if (cookies.length) out['set-cookie'] = cookies;
        res.writeHead(response.status, out);
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (url.pathname.startsWith('/fake/')) {
        res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
        res.end('<!doctype html><title>Identity provider</title><p>Redirect received.</p>');
        return;
      }
      const file = safePath(url.pathname);
      if (!file) { res.writeHead(404, pageHeaders); res.end('Not found'); return; }
      const bytes = await readFile(file);
      res.writeHead(200, {...pageHeaders, 'content-type': types[extname(file)] || 'application/octet-stream'});
      res.end(bytes);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR') { res.writeHead(404, pageHeaders); res.end('Not found'); return; }
      res.writeHead(500, pageHeaders); res.end('Local server error');
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const mailbox = [];
  let idp = null;
  if (mfa && enabled) env.MFA_ENABLED = true;
  if (dashboard && enabled) {
    idp = testCertificate();
    Object.assign(env, {
      CHATGPT_CLIENT_ID: 'local-chatgpt-client', CHATGPT_CLIENT_SECRET: 'local-chatgpt-secret',
      CHATGPT_AUTHORIZE_URL: origin + '/fake/chatgpt/authorize', CHATGPT_TOKEN_URL: origin + '/fake/chatgpt/token', CHATGPT_USERINFO_URL: origin + '/fake/chatgpt/userinfo',
      SSO_EMAIL_DOMAINS: 'hooli.com', SSO_IDP_SSO_URL: origin + '/fake/sso', SSO_IDP_ISSUER: 'http://www.okta.com/exk-test', SSO_IDP_CERT: idp.cert,
      EMAIL_FROM: 'member@example.com', sendEmail: async message => { mailbox.push({...message}); }
    });
  }

  async function signIn(context, githubId = 4242) {
    const {tenant_id} = await store.getOrCreateTenant(githubId);
    const token = await createFixtureSession(store,tenant_id);
    await context.addCookies([{name: '__Host-supatrace', value: token, domain: '127.0.0.1', path: '/', secure: true, httpOnly: true, sameSite: 'Lax'}]);
    return tenant_id;
  }
  // Starts an agent pairing the way public/agent/connect.py does; returns the code the owner approves.
  async function startSetup(key = randomBytes(32).toString('base64url')) {
    const keyHash = digest(key);
    return store.createSetup(keyHash);
  }
  async function writeKey(tenant) {
    const key = randomBytes(32).toString('base64url');
    const {user_code} = await store.createSetup(digest(key));
    await store.approveSetup(tenant, user_code);
    return key;
  }
  async function upload(key, batch) {
    const raw = JSON.stringify(batch);
    const response = await api(new Request(LIVE_ORIGIN + '/api/batches', {method: 'POST', headers: {'content-type': 'application/json', 'x-supatrace-key': key, 'x-amz-content-sha256': digest(raw)}, body: raw}));
    if (response.status !== 201) throw new Error('upload failed ' + response.status + ' ' + await response.text());
  }
  // Runs are one minute apart and run-000 is the oldest, so the API's id order
  // (ascending) is the reverse of newest-first.
  async function seedRuns(tenant, count) {
    const key = await writeKey(tenant);
    const ids = [];
    for (let i = 0; i < count; i++) {
      shift = -(count - 1 - i) * 60;
      const clock = now();
      const run = `run-${String(i).padStart(3, '0')}`;
      await upload(key, {version: 1, batch_id: run + '-b1', run_id: run, events: [
        {id: run + '-e1', time: new Date(clock * 1000).toISOString(), kind: 'request', name: 'Check the latest build', data: {text: 'Check the latest build'}},
        {id: run + '-e2', time: new Date(clock * 1000 + 2000).toISOString(), kind: 'tool_call', name: 'Read test output', data: {tool: 'read', ok: true}}
      ]});
      ids.push(run);
    }
    shift = 0;
    return ids;
  }
  return {origin, store, idp, signIn, startSetup, writeKey, upload, seedRuns,
    rateLimitEvents(times) { rateLimitNext = times; },
    close: async () => {await env.localImports?.close();return new Promise(done => { server.closeAllConnections?.(); server.close(done); });}};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const live = await start();
  console.log(live.origin);
}
