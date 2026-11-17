import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handle} from '../src/aws-api.mjs';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {digest} from '../src/aws-auth.mjs';
import {MemoryDynamo, commandClasses} from './memory-dynamo.mjs';

const root = normalize(fileURLToPath(new URL('../public/', import.meta.url)));
const types = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml'};
const pageHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function safePath(pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const full = normalize(join(root, rel));
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return full;
}

export function start() {
  const dynamo = new MemoryDynamo();
  const store = new DynamoMetadataStore({client: dynamo, commands: commandClasses(), tableName: 'metadata'});
  const original = store.consumeRate.bind(store);
  store.consumeRate = input => original({...input, limit: Math.max(input.limit, 10000)});
  const saved = new Map();
  const env = {
    ENABLED: true, DEV_AUTH: true, APP_ORIGIN: 'http://127.0.0.1:9',
    GITHUB_CLIENT_ID: 'local-github-client', GITHUB_CLIENT_SECRET: 'local-github-secret',
    GOOGLE_CLIENT_ID: 'local-google-client', GOOGLE_CLIENT_SECRET: 'local-google-secret',
    store, sourceIp: '127.0.0.1',
    objects: {
      async putImmutable(key, raw, hash) {
        if (digest(raw) !== hash) throw Object.assign(new Error('invalid_payload'), {status: 400, code: 'invalid_payload'});
        const old = saved.get(key);
        if (old !== undefined && old !== raw) throw Object.assign(new Error('object_conflict'), {status: 409, code: 'object_conflict'});
        saved.set(key, raw);
      },
      async get(key) {
        if (!saved.has(key)) throw Object.assign(new Error('missing'), {status: 503, code: 'object_read_unavailable'});
        return saved.get(key);
      }
    }
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, env.APP_ORIGIN);
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const request = new Request(url, {method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body});
        const response = await handle(request, env);
        const out = {};
        for (const [name, value] of response.headers) if (name !== 'set-cookie') out[name] = value;
        const cookies = response.headers.getSetCookie();
        if (cookies.length) out['set-cookie'] = cookies;
        res.writeHead(response.status, out);
        res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
        return;
      }
      const file = safePath(url.pathname);
      if (!file) { res.writeHead(404, pageHeaders); res.end('Not found'); return; }
      const bytes = await readFile(file);
      res.writeHead(200, {...pageHeaders, 'content-type': types[extname(file)] || 'application/octet-stream'});
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error?.code === 'ENOENT') { res.writeHead(404, pageHeaders); res.end('Not found'); return; }
      res.writeHead(500, pageHeaders); res.end('Local server error');
    }
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      env.APP_ORIGIN = `http://127.0.0.1:${port}`;
      resolve({origin: env.APP_ORIGIN, close: () => new Promise(done => server.close(done))});
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const live = await start();
  console.log(live.origin);
}
