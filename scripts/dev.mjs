import {configureLocalBilling,requireDevTestKey} from './local-billing.mjs';
import {configureLocalImports} from './local-imports.mjs';
// Loopback-only developer composition. Reuses the real handlers and test AWS adapters.
import {start} from '../tests/harness.mjs';
import {randomBytes} from 'node:crypto';
import {digest} from '../src/aws-auth.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
export async function seedLocalWorkspace(live){
 const cookies={};for(const id of [4242,5252,6262])await live.signIn({addCookies:async value=>{cookies['github-'+id]=value.map(c=>c.name+'='+c.value).join('; ');}},id);
 const post=async(actor,path,data)=>{const r=await fetch(live.origin+'/api/'+path,{method:'POST',headers:{cookie:cookies[actor],origin:live.origin,'content-type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw Error('Local seed failed: '+path+' '+r.status+' '+await r.text());return r.json();};
 await post('github-4242','workspaces',{name:'Local demo team'});
 // The demo team (three people, three environments, a read-only member) is larger than Free allows, so it is built on
 // Enterprise and then returned to Free. A downgrade keeps what exists, which is also what the demo shows.
 const ownerRow=()=>live.store.client.items.get('TENANT#github-4242\0META');ownerRow().plan_id='enterprise';
 for(const [recipient_id,role] of [['github-5252','admin'],['github-6262','viewer']]){const invite=await post('github-4242','workspaces/invite',{recipient_id,role});await post(recipient_id,'workspaces/accept',{workspace_id:'github-4242',token:invite.token});}
 for(const environment of ['default','development','production']){
  if(environment!=='default')await post('github-4242','environments',{id:environment,name:environment==='development'?'Development':'Production'});
  const token=randomBytes(32).toString('base64url'),setup=await post('github-4242','setup/start?project='+alphaProject('github-4242').id+'&environment='+environment,{key_hash:digest(token)});
  await post('github-4242','setup/approve?environment='+environment,{user_code:setup.user_code});
  for(const n of [1,2]){const raw=JSON.stringify({version:1,batch_id:'local-batch-'+n,run_id:'local-run-'+n,events:[{id:'request',time:'2026-11-06T00:00:00Z',kind:'request',name:environment+' synthetic request',data:{environment,synthetic:true}},{id:'response',time:'2026-11-06T00:00:01Z',kind:'response',name:'Synthetic result',data:{ok:true}}]});
   const r=await fetch(live.origin+'/api/batches?environment='+environment,{method:'POST',headers:{'content-type':'application/json','x-supatrace-key':token,'x-amz-content-sha256':digest(raw)},body:raw});if(r.status!==201)throw Error('Local upload failed: '+r.status+' '+await r.text());
  }
  // Seed uploads are complete. Revoke their pairing keys so Free can create a new ingest key.
  await post('github-4242','keys/revoke?environment='+environment,{id:digest(token)});
 }
 delete ownerRow().plan_id;
 return {owner:'github-4242',admin:'github-5252',viewer:'github-6262',environments:['default','development','production']};
}
if(process.argv[1]?.endsWith('/scripts/dev.mjs')){
 const index=process.argv.indexOf('--port'),port=index===-1?3000:Number(process.argv[index+1]);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Use --port 1024..65535');
 const live=await start({localDev:true,port,configureEnvironment:async env=>{env.localBilling=await configureLocalBilling(env,{planLimits:true});env.localImports=await configureLocalImports(env);
  // Optional: drive the hosted plan-billing path (src/plan-billing.mjs) against a real Stripe TEST account. Test keys only.
  if(process.env.SUPATRACE_DEV_STRIPE_TEST_KEY){requireDevTestKey();const {default:Stripe}=await import('stripe');const {composePlanBilling}=await import('../src/plan-billing.mjs');env.planBilling=composePlanBilling({secretKey:process.env.SUPATRACE_DEV_STRIPE_TEST_KEY,StripeClient:Stripe});}
 }});try{await seedLocalWorkspace(live);}catch(e){await live.close();throw e;}
 console.log('SupaTrace local development: '+live.origin+'/__local__/');console.log('Synthetic owner/admin/viewer; Default, Development and Production traces. In-memory AWS adapters; synthetic Checkout/portal/signature/stream/entitlement simulation; a completed test Checkout moves the owner workspace to Base or Pro limits. No external provider calls or charges.');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void live.close().then(()=>process.exit(0)));
}
