// Existing application session authentication for a private same-origin POST transport.
// No route installation, body-supplied identity, cookie forwarding or credential discovery.
import {cookie, digest} from './aws-auth.mjs';
import {requireOrigin, HttpError} from './http.mjs';
import {hash} from './trace.mjs';

const fail = () => { throw new HttpError(401, 'private_import_authentication_required'); };
const fields = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join() === keys.slice().sort().join();

export function createPrivateImportAuthenticator({store, origin} = {}) {
  if (typeof store?.getImportSessionStamp !== 'function' ||
      !['https://supatrace.dev', 'https://supatrace.tech'].includes(origin)) fail();
  return async request => {
    let tokenHash;
    try {
      if (!(request instanceof Request) || request.method !== 'POST' || request.signal.aborted ||
          new URL(request.url).origin !== origin) fail();
      requireOrigin(request, origin);
      const token = cookie(request, '__Host-supatrace');
      if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) fail();
      tokenHash = digest(token); // Snapshot once, before any await. Never retain/forward raw cookie.
    } catch { fail(); }
    async function read() {
      let timer;
      try {
        const stamp = structuredClone(await Promise.race([
          Promise.resolve().then(() => store.getImportSessionStamp(tokenHash)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error()), 2000); })
        ]));
        if (!fields(stamp, ['token_hash', 'tenant_id', 'session_epoch']) ||
            stamp.token_hash !== tokenHash || typeof stamp.tenant_id !== 'string' ||
            !Number.isSafeInteger(stamp.session_epoch) || stamp.session_epoch < 0) fail();
        return stamp;
      } catch { fail(); }
      finally { clearTimeout(timer); }
    }
    // The existing store validates token-slot identity, expiry and account epoch.
    // Independent confirmation rejects removal/change during its first storage await.
    const first = await read(), current = await read();
    if (request.signal.aborted || hash(first) !== hash(current)) fail();
    return {tenant_id: current.tenant_id, parent_session: current};
  };
}
