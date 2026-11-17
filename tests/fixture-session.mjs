// Test-only provider/MFA setup bypass; production code never imports test files.
// Reuse the actual bounded allocator. Confirmed collisions may retry; unknown writes may not.
import {establishSession} from '../src/aws-auth.mjs';
export async function createFixtureSession(store,tenantId){
 // Let the store assign expiry using its own (possibly frozen) fixture clock.
 const sessionStore={createSession:(hash,tenant,_expiresAt,epoch)=>store.createSession(hash,tenant,undefined,epoch)};
 const response=await establishSession({store:sessionStore},tenantId,'json',[],true);
 const token=response.headers.getSetCookie().find(c=>c.startsWith('__Host-supatrace='))?.split(';')[0].split('=')[1];
 if(response.status!==204||!/^[A-Za-z0-9_-]{43}$/.test(token??''))throw Error('fixture_session_unavailable');
 return token;
}
