// Separate, isolated sandbox entrypoint. No template, trigger or production loader installs it.
import Stripe from 'stripe';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,DeleteCommand,UpdateCommand,QueryCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {composeStripeEntitlementSandbox} from '../src/stripe-entitlement-runtime.mjs';
import {validateSandboxEntitlementConfiguration} from '../src/stripe-sandbox-entitlements.mjs';
import {createStripeStreamWorker} from '../src/stripe-worker.mjs';

const fields=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join()===keys.slice().sort().join();
const SHARED_TABLES=Object.freeze(['supatrace-alpha-metadata']);
const table=v=>typeof v==='string'&&/^[-A-Za-z0-9_.]{3,255}$/.test(v);
const fail=()=>{throw Error('stripe_entitlement_worker_scope_mismatch');};
export function createStripeEntitlementWorkerHandler(input,hooks={}){
 if(input?.enabled!==true)return async()=>{throw Error('stripe_entitlement_worker_disabled');};
 let c;try{c=structuredClone(input);}catch{fail();}
 const {awsAccountId,awsRegion,authorize,loadSecret,StripeClient,storeOptions}=hooks;
 if(!fields(c,['enabled','streamArn','merchantId','environmentId','approvalRef','authorizedActions','composition'])||!/^\d{12}$/.test(awsAccountId??'')||!/^[-a-z0-9]+$/.test(awsRegion??'')||typeof authorize!=='function'||typeof loadSecret!=='function'||typeof StripeClient!=='function'||!Array.isArray(hooks.protectedTableNames)||!hooks.protectedTableNames.length||hooks.protectedTableNames.length>32||hooks.protectedTableNames.some(n=>!table(n))||!/^[-A-Za-z0-9_:]{8,120}$/.test(c.approvalRef??'')||JSON.stringify(c.authorizedActions)!=='["worker.invoke"]')fail();
 const stream=/^arn:aws:dynamodb:([a-z0-9-]+):(\d{12}):table\/([A-Za-z0-9_.-]+)\/stream\/[0-9T:.\-]+$/.exec(c.streamArn??''),s=c.composition;
 if(!stream||stream[1]!==awsRegion||stream[2]!==awsAccountId||s?.enabled!==true||s.purpose!=='worker'||s.runtime?.runtimePurpose!=='worker'||s.runtime.endpointSecretArns?.length!==0||s.runtime.purchasesEnabled!==false||s.runtime.approvalRef!==c.approvalRef||!fields(s.tables,['metadata','inbox','state'])||Object.values(s.tables).some(n=>!table(n)||[...SHARED_TABLES,...hooks.protectedTableNames].includes(n))||new Set(Object.values(s.tables)).size!==3||stream[3]!==s.tables.inbox||JSON.stringify(s.entitlementActions)!=='["sandbox.entitlement.reconcile"]')fail();
 let view;try{view=validateSandboxEntitlementConfiguration(s.entitlements,s.operationalCeiling);}catch{fail();}
 if(!view||view.policy.merchant_id!==c.merchantId||view.policy.environment_id!==c.environmentId||s.runtime.catalogHash!==view.catalogHash||JSON.stringify(s.runtime.catalog)!==JSON.stringify(s.entitlements.catalog))fail();
 const workerActions=['runtime.credentials','capture.process','checkout.reconcile','subscription.reconcile','risk.resolve'];
 if(!Array.isArray(s.runtime.authorizedActions)||!s.runtime.authorizedActions.includes('runtime.credentials')||new Set(s.runtime.authorizedActions).size!==s.runtime.authorizedActions.length||s.runtime.authorizedActions.some(a=>!workerActions.includes(a)))fail();
 const actions=new Set([...c.authorizedActions,...s.runtime.authorizedActions,...s.entitlementActions]);
 const policy=async descriptor=>{
  if(!actions.has(descriptor.action)||descriptor.merchant_id!==c.merchantId||descriptor.environment_id!==c.environmentId||descriptor.livemode!==false)return false;
  let timer;try{return await Promise.race([Promise.resolve().then(()=>authorize(Object.freeze({...descriptor,policy_hash:view.hash,catalog_hash:view.catalogHash,approval_ref:c.approvalRef}))),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})])===true;}catch{return false;}finally{clearTimeout(timer);}
 };
 return createStripeStreamWorker({enabled:true,streamArn:c.streamArn,merchantId:c.merchantId,environmentId:c.environmentId,authorize:policy,loadEnvironment:()=>composeStripeEntitlementSandbox(s,{storeOptions,StripeClient,loadSecret,authorize:policy,awsAccountId,awsRegion})});
}

export async function handler(event){
 let c,protectedTableNames;
 try{const text=process.env.BILLING_ENTITLEMENT_WORKER_CONFIG;if(!text||text.length>32768)throw Error();c=JSON.parse(text);protectedTableNames=JSON.parse(process.env.BILLING_ENTITLEMENT_PROTECTED_TABLES??'["supatrace-alpha-metadata"]');}catch{throw Error('stripe_entitlement_worker_disabled');}
 // All permissions come from reviewed server configuration; an event cannot enable actions.
 const allowed=new Set([c.authorizedActions,c.composition?.runtime?.authorizedActions,c.composition?.entitlementActions].flatMap(v=>Array.isArray(v)?v:[]));
 const worker=createStripeEntitlementWorkerHandler(c,{awsAccountId:process.env.BILLING_INGRESS_ACCOUNT_ID,awsRegion:process.env.AWS_REGION,protectedTableNames,StripeClient:Stripe,authorize:async d=>allowed.has(d.action)&&d.merchant_id===c.merchantId&&d.environment_id===c.environmentId&&d.livemode===false,
  loadSecret:async arn=>(await new SecretsManagerClient({maxAttempts:1}).send(new GetSecretValueCommand({SecretId:arn}))).SecretString,
  storeOptions:{client:DynamoDBDocumentClient.from(new DynamoDBClient({maxAttempts:2}),{marshallOptions:{removeUndefinedValues:true}}),commands:{GetCommand,PutCommand,DeleteCommand,UpdateCommand,QueryCommand,TransactWriteCommand}}});
 return worker(event);
}
