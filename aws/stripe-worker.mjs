// Dedicated worker entry point; no deployment or schedule is configured by this file.
import Stripe from 'stripe';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,GetCommand,PutCommand,DeleteCommand,UpdateCommand,QueryCommand,TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {DynamoMetadataStore} from '../src/dynamodb-store.mjs';
import {createStripeRuntimeLoader} from '../src/stripe-runtime.mjs';
import {createStripeStreamWorker} from '../src/stripe-worker.mjs';
const loadRuntime=createStripeRuntimeLoader();
export async function handler(event) {
 let config;try{const text=process.env.BILLING_WORKER_CONFIG;if(!text||text.length>4096)throw Error();config=JSON.parse(text);}catch{throw Error('stripe_worker_disabled');}
 if(config.enabled!==true||!/^[-A-Za-z0-9_:]{8,120}$/.test(config.approvalRef||'')||Object.keys(config).some(k=>!['enabled','streamArn','merchantId','environmentId','approvalRef'].includes(k)))throw Error('invalid_stripe_worker_configuration');
 const stream=typeof config.streamArn==='string'&&config.streamArn.match(/^arn:aws:dynamodb:([a-z0-9-]+):(\d{12}):table\/([A-Za-z0-9_.-]+)\/stream\/[0-9T:.\-]+$/);
 const tables=[process.env.TABLE_NAME,process.env.BILLING_INBOX_TABLE_NAME,process.env.BILLING_STATE_TABLE_NAME];
 if(tables.some(n=>typeof n!=='string'||!/^[-A-Za-z0-9_.]{3,255}$/.test(n))||new Set(tables).size!==3)throw Error('stripe_worker_store_scope_mismatch');
 if(!stream||stream[1]!==process.env.AWS_REGION||stream[2]!==process.env.BILLING_INGRESS_ACCOUNT_ID||stream[3]!==process.env.BILLING_INBOX_TABLE_NAME||process.env.BILLING_INBOX_TABLE_NAME===process.env.TABLE_NAME||!process.env.BILLING_STATE_TABLE_NAME||[process.env.TABLE_NAME,process.env.BILLING_INBOX_TABLE_NAME].includes(process.env.BILLING_STATE_TABLE_NAME))throw Error('stripe_worker_store_scope_mismatch');
 const worker=createStripeStreamWorker({...config,authorize:async a=>a.action==='worker.invoke',loadEnvironment:async()=>{
  const text=process.env.BILLING_WORKER_SANDBOX_CONFIG;let approved;try{if(!text||text.length>16384)throw Error();const settings=JSON.parse(text);if(settings.runtimePurpose!=='worker')throw Error();approved=new Set(settings.authorizedActions);}catch{throw Error('stripe_worker_runtime_disabled');}
  const {stripeBilling}=await loadRuntime(text,{expectedPurpose:'worker',StripeClient:Stripe,awsAccountId:process.env.BILLING_INGRESS_ACCOUNT_ID,awsRegion:process.env.AWS_REGION,authorize:async a=>approved.has(a.action),loadSecret:async arn=>(await new SecretsManagerClient({maxAttempts:1}).send(new GetSecretValueCommand({SecretId:arn}))).SecretString});
  if(!stripeBilling||!process.env.TABLE_NAME)throw Error('stripe_worker_runtime_disabled');
  return {stripeBilling,store:new DynamoMetadataStore({client:DynamoDBDocumentClient.from(new DynamoDBClient({maxAttempts:2}),{marshallOptions:{removeUndefinedValues:true}}),commands:{GetCommand,PutCommand,DeleteCommand,UpdateCommand,QueryCommand,TransactWriteCommand},tableName:process.env.TABLE_NAME,stripeInboxTableName:process.env.BILLING_INBOX_TABLE_NAME,stripeStateTableName:process.env.BILLING_STATE_TABLE_NAME,stripeTestInbox:true,stripeTestEnvironment:stripeBilling.catalog.environment_id})};
 }});
 return worker(event);
}
