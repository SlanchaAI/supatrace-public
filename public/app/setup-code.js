// Same-tab storage survives email and provider round trips without putting the code in OAuth state.
const slot='supatrace-setup-code';
export function rememberSetupCode(){
 const [view,query='']=(location.hash||'').slice(1).split('?');
 const code=new URLSearchParams(query).get('code');
 if(view!=='agents'||!/^[A-Za-z0-9_-]{12}$/.test(code||''))return;
 const scope=new URLSearchParams();
 for(const name of ['project','workspace','environment']){const value=new URLSearchParams(location.search).get(name);if(value)scope.set(name,value);}
 try{sessionStorage.setItem(slot,JSON.stringify({code,search:scope.toString()}));}catch{/* The link still prefills when storage is unavailable. */}
}
export function pendingSetupCode(){
 try{const saved=JSON.parse(sessionStorage.getItem(slot));return /^[A-Za-z0-9_-]{12}$/.test(saved?.code||'')&&typeof saved.search==='string'?saved:null;}catch{return null;}
}
export function clearSetupCode(){try{sessionStorage.removeItem(slot);}catch{/* Storage may be unavailable. */}}
export function setupReturnUrl(){const saved=pendingSetupCode();return saved?'/app/'+(saved.search?'?'+saved.search:'')+'#agents':'/app/';}
