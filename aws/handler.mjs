import {apiDiagnostic} from '../src/api-diagnostic.mjs';
import {eraseAccounts} from '../src/account-deletion.mjs';
import {reportOverage} from '../src/plan-overage.mjs';
import {createHash} from 'node:crypto';
import {composePlanBilling} from '../src/plan-billing.mjs';
import {loadSandboxCommercialConfiguration} from '../src/commercial-policy.mjs';
import Stripe from 'stripe';
import {createStripeRuntimeLoader} from '../src/stripe-runtime.mjs';
import {isApiGatewayIngress,stripeIngressRequest,stripeIngressSourceIp} from '../src/stripe-ingress.mjs';
import {isIngestIngress,ingestIngressRequest} from '../src/ingest-ingress.mjs';
import {isIP} from 'node:net';
import {isIdentityIngress,identityIngressRequest} from '../src/identity-ingress.mjs';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,DeleteCommand,UpdateCommand,QueryCommand,ScanCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {S3Client,PutObjectCommand,GetObjectCommand,ListObjectVersionsCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {S3Objects} from '../src/s3-objects.mjs';
import {handle} from '../src/aws-api.mjs';
import {composeImportControllers,composeServerPullController} from '../src/import-composition.mjs';
import {parseHosts,viewerHost} from '../src/origins.mjs';
const loadStripeRuntime=createStripeRuntimeLoader();
const caches={github:{until:0,value:''},githubTech:{until:0,value:''},google:{until:0,value:''},chatgpt:{until:0,value:''},sso:{until:0,value:''},planBilling:{until:0,value:''},planBillingWebhook:{until:0,value:''}};
const denied={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
// Service-wide safety caps: the most accounts and the most reserved bytes the whole service accepts. They bound cost and
// abuse, and must stay above what a self-serve plan (Base, Pro) promises one organization (src/plans.mjs; tested).
// An Enterprise contract above the byte cap needs the cap raised with it. Raised from the alpha's 100
// accounts and 100 MiB on 2026-11-15; at the byte cap, S3 standard storage is about $1.15 a month.
export const SERVICE_CAPS=Object.freeze({accounts:1000,globalBytes:50*1024*1024*1024});
// One plan-billing runtime per container, rebuilt only when the secret changes, so its Stripe price lookup is cached.
let planBillingRuntime=null;
// After a failed secret read or a refused key, billing stays off and the read is not repeated for a minute, so a broken
// secret cannot slow every request.
let planBillingRetryAt=0;
async function readSecret(arn,slot){
 const cache=caches[slot];if(cache.until>Date.now()&&cache.value)return cache.value;
 const secret=await new SecretsManagerClient({maxAttempts:2}).send(new GetSecretValueCommand({SecretId:arn}));
 if(!secret.SecretString)throw Error('identity_configuration_unavailable');
 cache.value=secret.SecretString;cache.until=Date.now()+300000;return cache.value;
}
async function environment(){
 if(process.env.SUPATRACE_ENABLED!=='true')return {};
 for(const name of ['TABLE_NAME','PAYLOAD_BUCKET','GITHUB_SECRET_ARN','GITHUB_CLIENT_ID'])if(!process.env[name])return {};
 const githubSecret=await readSecret(process.env.GITHUB_SECRET_ARN,'github');
 let google={};
 if(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_SECRET_ARN){
  try{const value=await readSecret(process.env.GOOGLE_SECRET_ARN,'google');google={GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET:value};}
  catch{google={};}
 }
 let chatgpt={};
 if(process.env.CHATGPT_CLIENT_ID&&process.env.CHATGPT_SECRET_ARN&&process.env.CHATGPT_AUTHORIZE_URL&&process.env.CHATGPT_TOKEN_URL&&process.env.CHATGPT_USERINFO_URL){
  try{const value=await readSecret(process.env.CHATGPT_SECRET_ARN,'chatgpt');chatgpt={CHATGPT_CLIENT_ID:process.env.CHATGPT_CLIENT_ID,CHATGPT_CLIENT_SECRET:value,CHATGPT_AUTHORIZE_URL:process.env.CHATGPT_AUTHORIZE_URL,CHATGPT_TOKEN_URL:process.env.CHATGPT_TOKEN_URL,CHATGPT_USERINFO_URL:process.env.CHATGPT_USERINFO_URL};}
  catch{chatgpt={};}
 }
 let email={};
 if(process.env.EMAIL_FROM){
  email={EMAIL_FROM:process.env.EMAIL_FROM,sendEmail:async message=>{
   const {SESClient,SendEmailCommand}=await import('@aws-sdk/client-ses');
   await new SESClient({maxAttempts:2}).send(new SendEmailCommand({Source:process.env.EMAIL_FROM,Destination:{ToAddresses:[message.to]},Message:{Subject:{Data:message.subject,Charset:'UTF-8'},Body:{Text:{Data:message.text,Charset:'UTF-8'}}}}));
  }};
 }
 let sso={};
 if(process.env.SSO_EMAIL_DOMAINS&&process.env.SSO_IDP_SSO_URL&&process.env.SSO_IDP_ISSUER&&process.env.SSO_IDP_CERT_SECRET_ARN){
  try{const value=await readSecret(process.env.SSO_IDP_CERT_SECRET_ARN,'sso');sso={SSO_EMAIL_DOMAINS:process.env.SSO_EMAIL_DOMAINS,SSO_IDP_SSO_URL:process.env.SSO_IDP_SSO_URL,SSO_IDP_ISSUER:process.env.SSO_IDP_ISSUER,SSO_IDP_CERT:value};}
  catch{sso={};}
 }
 // Plan billing mode follows the secret key (src/plan-billing.mjs). A
 // missing, unreadable or malformed key leaves billing unavailable and never breaks sign-in or trace access.
 let planBilling;
 if(process.env.PLAN_BILLING_SECRET_ARN&&Date.now()>=planBillingRetryAt){
  try{
   const secretKey=await readSecret(process.env.PLAN_BILLING_SECRET_ARN,'planBilling'),webhookSecret=process.env.PLAN_BILLING_WEBHOOK_SECRET_ARN?await readSecret(process.env.PLAN_BILLING_WEBHOOK_SECRET_ARN,'planBillingWebhook'):null;
   // The runtime is rebuilt when either secret changes: a rotated webhook signing secret has the same length as the old one.
   const signature=createHash('sha256').update(secretKey+'\n'+(webhookSecret??'')).digest('hex');
   if(planBillingRuntime?.signature!==signature)planBillingRuntime={signature,value:composePlanBilling({secretKey:secretKey.trim(),webhookSecret:webhookSecret?.trim()??null,StripeClient:Stripe})};
   planBilling=planBillingRuntime.value;
  }catch(error){console.warn(JSON.stringify({event:'plan_billing_unavailable',reason:typeof error?.message==='string'&&/^plan_billing_[a-z_]+$/.test(error.message)?error.message:'secret_unreadable'}));planBilling=undefined;planBillingRetryAt=Date.now()+60000;}
 }
 const billingText=process.env.BILLING_SANDBOX_CONFIG;
 let approved=new Set();try{if(billingText?.length<=16384){const settings=JSON.parse(billingText);approved=new Set(Array.isArray(settings.authorizedActions)?settings.authorizedActions:[]);}}catch{/* Invalid billing configuration must not break account access. */}
 const {stripeBilling,stripeBillingUnavailable}=await loadStripeRuntime(billingText,{StripeClient:Stripe,awsAccountId:process.env.BILLING_INGRESS_ACCOUNT_ID,awsRegion:process.env.AWS_REGION,authorize:async action=>approved.has(action.action),loadSecret:async arn=>{const value=await new SecretsManagerClient({maxAttempts:1}).send(new GetSecretValueCommand({SecretId:arn}));return value.SecretString;}});
 const commercialText=process.env.BILLING_COMMERCIAL_POLICY_CONFIG;let commercialActions=new Set();try{if(commercialText?.length<=16384)commercialActions=new Set(JSON.parse(commercialText).authorizedActions);}catch{/* Isolate policy failure from authentication and trace access. */}
 const commercialRuntime=await loadSandboxCommercialConfiguration(commercialText,{stripeBilling,authorize:async metadata=>commercialActions.has(metadata.action)});
 const hosts=parseHosts(process.env.APP_HOSTS),origins=hosts.map(host=>'https://'+host);
 // The existing GitHub OAuth app has the supatrace.dev callback. GitHub allows one callback per app, so supatrace.tech needs its own app.
 const githubByOrigin={'https://supatrace.dev':{id:process.env.GITHUB_CLIENT_ID,secret:githubSecret}};
 if(process.env.GITHUB_TECH_CLIENT_ID&&process.env.GITHUB_TECH_SECRET_ARN){
  try{githubByOrigin['https://supatrace.tech']={id:process.env.GITHUB_TECH_CLIENT_ID,secret:await readSecret(process.env.GITHUB_TECH_SECRET_ARN,'githubTech')};}
  catch{/* Without its own app, GitHub sign-in stays off on that host; Google is unaffected. */}
 }
 const store=new DynamoMetadataStore({client:DynamoDBDocumentClient.from(new DynamoDBClient({maxAttempts:2}),{marshallOptions:{removeUndefinedValues:true}}),commands:{GetCommand,PutCommand,DeleteCommand,UpdateCommand,QueryCommand,ScanCommand,TransactWriteCommand},tableName:process.env.TABLE_NAME,...SERVICE_CAPS,stripeInboxTableName:process.env.BILLING_INBOX_TABLE_NAME||null,stripeStateTableName:stripeBilling?process.env.BILLING_STATE_TABLE_NAME||null:null,stripeTestInbox:!!stripeBilling,stripeTestEnvironment:stripeBilling?.catalog.environment_id}),objects=new S3Objects({client:new S3Client({maxAttempts:2}),commands:{PutObjectCommand,GetObjectCommand,ListObjectVersionsCommand,DeleteObjectCommand},bucket:process.env.PAYLOAD_BUCKET});
 store.planBillingMode=planBilling?.mode ?? 'test';
 return {ENABLED:true,RETENTION_ERASURE_MODE:process.env.RETENTION_ERASURE_MODE,APP_ORIGIN:origins[0],APP_ORIGINS:origins,GITHUB_BY_ORIGIN:githubByOrigin,MFA_ENABLED:process.env.MFA_ENABLED,MCP_BRIDGE_ENABLED:process.env.MCP_BRIDGE_ENABLED==='true',GITHUB_CLIENT_ID:process.env.GITHUB_CLIENT_ID,GITHUB_CLIENT_SECRET:githubSecret,...google,...chatgpt,...email,...sso,
 planBilling,stripeBilling:stripeBilling||undefined,stripeBillingUnavailable,...commercialRuntime,
 authDiagnostic:event=>console.warn(JSON.stringify(event)),apiDiagnostic:event=>console.error(JSON.stringify(event)),
 store,objects,...composeImportControllers(process.env.IMPORT_POLICY_CONFIG,{store,objects,origins}),...composeServerPullController(process.env.SERVER_PULL_CONFIG,{store,objects,origins})};
}
// Function URL result. OTLP protobuf responses are binary and travel base64-encoded; everything else stays text.
export async function lambdaResult(response){
 const headers=Object.fromEntries(response.headers),cookies=response.headers.getSetCookie();delete headers['set-cookie'];
 if((headers['content-type']||'').startsWith('application/x-protobuf'))return {statusCode:response.status,headers,cookies,body:Buffer.from(await response.arrayBuffer()).toString('base64'),isBase64Encoded:true};
 return {statusCode:response.status,headers,cookies,body:await response.text(),isBase64Encoded:false};
}
export async function handler(event){
 if(event?.source==='aws.events'){
  if(event['detail-type']==='Scheduled Event'&&process.env.PLAN_OVERAGE_RULE_ARN&&event.resources?.length===1&&event.resources[0]===process.env.PLAN_OVERAGE_RULE_ARN){const result=await reportOverage(await environment());console.info(JSON.stringify({event:'plan_overage',...result}));return result;}
  if(event['detail-type']!=='Scheduled Event'||!process.env.ACCOUNT_ERASURE_RULE_ARN||event.resources?.length!==1||event.resources[0]!==process.env.ACCOUNT_ERASURE_RULE_ARN)throw Error('invalid_erasure_schedule');
  const result=await eraseAccounts(await environment());console.info(JSON.stringify({event:'account_erasure',...result}));return result;
 }
 try{
 const gateway=isApiGatewayIngress(event);
 // Trace ingest and identity protocols share a guarded HTTP API; other Gateway events use the Stripe webhook adapter.
 const identity=gateway&&isIdentityIngress(event)?identityIngressRequest(event,{apiId:process.env.INGEST_API_ID,region:process.env.AWS_REGION,edgeToken:process.env.INGEST_EDGE_TOKEN,origins:parseHosts(process.env.APP_HOSTS).map(host=>'https://'+host)}):null;
 const ingest=gateway&&!identity&&isIngestIngress(event,process.env.INGEST_API_ID)?ingestIngressRequest(event,{apiId:process.env.INGEST_API_ID,region:process.env.AWS_REGION,edgeToken:process.env.INGEST_EDGE_TOKEN,appOrigin:'https://'+parseHosts(process.env.APP_HOSTS)[0]}):null;
 const ingress=identity?identity.request:ingest?ingest.request:gateway?stripeIngressRequest(event,{apiId:process.env.BILLING_INGRESS_API_ID,accountId:process.env.BILLING_INGRESS_ACCOUNT_ID,region:process.env.AWS_REGION}):null;
 const method=event.requestContext?.http?.method||'GET',path=event.rawPath||'/';
 if((event.body||'').length>720000)return {statusCode:413,body:'{"error":"batch_too_large"}',headers:denied};
 const headers=new Headers(event.headers||{});if(event.cookies?.length)headers.set('cookie',event.cookies.join('; '));
 const body=event.body?Buffer.from(event.body,event.isBase64Encoded?'base64':'utf8'):undefined;
 const env=await environment();
 if(gateway&&!identity&&!ingest&&env.stripeBilling)env.stripeBilling={...env.stripeBilling,captureOnly:true};
 const hosts=parseHosts(process.env.APP_HOSTS);
 const request=ingress||new Request('https://'+viewerHost(headers,hosts)+path+(event.rawQueryString?'?'+event.rawQueryString:''),{method,headers,body:['GET','HEAD'].includes(method)?undefined:body});
 const viewer=headers.get('cloudfront-viewer-address')||'';const match=viewer.match(/^(?:\[([^\]]+)\]|([^:]+)):\d+$/);const viewerIp=match&&(match[1]||match[2]);env.sourceIp=gateway?stripeIngressSourceIp(event):(viewerIp&&isIP(viewerIp)?viewerIp:(event.requestContext?.http?.sourceIp||'unknown'));
 // Behind the ingest edge the Gateway peer is CloudFront; the adapter has verified the viewer address the distribution stamped.
 if(ingest||identity)env.sourceIp=(identity||ingest).sourceIp;
 return await lambdaResult(await handle(request,env));
 }catch(error){if(error?.billingIngress||error?.edgeIngress)return {statusCode:error.status,headers:denied,body:JSON.stringify({error:error.code})};apiDiagnostic(error,'handler',entry=>console.error(JSON.stringify(entry)));return {statusCode:503,headers:denied,body:'{"error":"temporarily_unavailable"}'};}
}
