// Test preload (node --import): refuses and records any socket or DNS lookup that is not loopback.
// Used by tests/cli.test.mjs to prove `supatrace dev` stays on the machine. Inherited by child processes via NODE_OPTIONS.
import net from 'node:net';
import dns from 'node:dns';
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const record = (kind, host) => { try { appendFileSync(process.env.SUPATRACE_TEST_OUTBOUND_LOG, `${kind} ${host}\n`); } catch { /* no log path: still refused */ } };
const refused = host => Object.assign(new Error('outbound connection refused by test guard: ' + host), {code: 'ETESTGUARD'});

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first !== null && typeof first === 'object' ? first : {port: first, host: typeof args[1] === 'string' ? args[1] : undefined};
  if (options.path === undefined) { const host = options.host ?? 'localhost'; if (!LOOPBACK.has(String(host).toLowerCase())) { record('connect', host); process.nextTick(() => this.destroy(refused(host))); return this; } }
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (LOOPBACK.has(String(hostname).toLowerCase())) return lookup.call(this, hostname, ...rest);
  record('lookup', hostname);
  const callback = rest[rest.length - 1];
  if (typeof callback === 'function') process.nextTick(callback, refused(hostname));
  return {};
};
syncBuiltinESMExports();
