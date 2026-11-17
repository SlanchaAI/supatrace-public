// Explicit synthetic process used by the real SDK stdio client. Never a runtime entrypoint.
import {fixture} from './fixture.mjs';
import {startStdio} from '../server.mjs';
const env = await fixture({content: 'include'});
const server = startStdio(env.scope, env.dependencies);
const stop = async () => {await server.close(); await env.close();};
process.stdin.once('end', stop); process.once('SIGTERM', stop);
