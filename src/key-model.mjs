// Publishable/secret API key model (#105). Pure rules shared by auth, store and API.
// A typed key is `st_pub_` or `st_sec_` followed by 43 base64url characters. The stored
// hash covers the whole string, prefix included, so a key cannot be presented as another type.
// A bare 43-character key is a legacy pairing key: write-only, with the expiry it was issued with.
// One compatibility exception to write-only: GET /api/public/projects (the Langfuse SDK's auth check) answers any
// valid key with its own project's id and name. It returns no trace, event, key or usage data.
export const KEY_PREFIX=Object.freeze({publishable:'st_pub_',secret:'st_sec_'});
/** Stored in `expires_at` for a key with no expiry (9999-12-31T23:59:59Z), so existing expiry comparisons keep working. */
export const NO_EXPIRY=253402300799;
export const KEY_LIFETIME=Object.freeze({min:3600,max:31536000});
export const ROTATION_OVERLAP=Object.freeze({default:86400,max:604800});
const SCOPES=Object.freeze({legacy:Object.freeze(['write']),publishable:Object.freeze(['write']),secret:Object.freeze(['read','write'])});
export function parseKeyToken(token){
 if(typeof token!=='string')return null;
 if(/^[A-Za-z0-9_-]{43}$/.test(token))return {type:'legacy'};
 for(const [type,prefix] of Object.entries(KEY_PREFIX))if(token.length===prefix.length+43&&token.startsWith(prefix)&&/^[A-Za-z0-9_-]{43}$/.test(token.slice(prefix.length)))return {type};
 return null;
}
export const storedKeyType=row=>Object.hasOwn(KEY_PREFIX,row?.key_type)?row.key_type:'legacy';
export const keyScopes=type=>Object.hasOwn(SCOPES,type)?SCOPES[type]:[];
export const keyAllows=(type,scope)=>keyScopes(type).includes(scope);
/** What the key list shows. A publishable or legacy key is never anything but write-only. */
export const keyScopeLabel=type=>type==='secret'?'read_write':'write_only';
