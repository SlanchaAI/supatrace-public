import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {composeStripeEntitlementSandbox} from '../src/stripe-entitlement-runtime.mjs';
import {createStripeRuntimeLoader} from '../src/stripe-runtime.mjs';
import {commercialPolicyHash} from '../src/commercial-policy.mjs';
import {stripeTestCatalogHash} from '../src/stripe-test-checkout.mjs';
import {MemoryDynamo,commandClasses} from './memory-dynamo.mjs';
import {configuration} from '../scripts/local-billing.mjs';
const fixture=()=>{const secrets=[],actions=[],hooks={storeOptions:{client:new MemoryDynamo(),commands:commandClasses()},awsAccountId:'123456789012',awsRegion:'us-east-1',StripeClient:Stripe,authorize:async a=>{actions.push(a);return true;},loadSecret:async arn=>{secrets.push(arn);return arn.includes('endpoint-')?'whsec_'+ 's'.repeat(24):'rk_test_'+ 'x'.repeat(24);}};return {hooks,secrets,actions};};
test('default disabled composition never reads credentials or creates a store',async()=>{const f=fixture();assert.equal(await composeStripeEntitlementSandbox({},f.hooks),null);assert.equal(f.secrets.length,0);});
test('policy, catalog, merchant, revision, ceilings and distinct tables fail before credentials',async()=>{
 for(const mutate of [c=>c.entitlements.policyHash='0'.repeat(64),c=>c.entitlements.catalogHash='0'.repeat(64),c=>c.runtime.catalogHash='0'.repeat(64),c=>c.tables.state=c.tables.metadata,c=>c.operationalCeiling=100,c=>c.runtime.runtimePurpose='worker',c=>c.entitlementActions=['sandbox.entitlement.reconcile'],c=>c.runtime.authorizedActions.push('subscription.reconcile'),c=>c.entitlements.policy.livemode=true]){const c=configuration(),f=fixture();mutate(c);await assert.rejects(composeStripeEntitlementSandbox(c,f.hooks));assert.equal(f.secrets.length,0);}
});
test('API view and worker reconcile are separate and do not imply provider writes',async()=>{
 const api=fixture(),worker=fixture(),a=await composeStripeEntitlementSandbox(configuration(),api.hooks),w=await composeStripeEntitlementSandbox(configuration('worker'),worker.hooks);
 const d={merchant_id:'acct_synthetic',environment_id:'synthetic-billing',livemode:false};
 assert.equal(await a.stripeBilling.authorize({...d,action:'sandbox.entitlement.view'}),true);assert.equal(await a.stripeBilling.authorize({...d,action:'sandbox.entitlement.reconcile'}),false);
 assert.equal(await w.stripeBilling.authorize({...d,action:'sandbox.entitlement.reconcile'}),true);assert.equal(await w.stripeBilling.authorize({...d,action:'sandbox.entitlement.view'}),false);
 for(const action of ['customer.create','checkout.create','portal.create']){assert.equal(await a.stripeBilling.authorize({...d,action}),false);assert.equal(await w.stripeBilling.authorize({...d,action}),false);}
 assert.equal(await a.stripeBilling.authorize({...d,merchant_id:'acct_foreign',action:'sandbox.entitlement.view'}),false);
 assert.equal(worker.secrets.length,1);assert.ok(worker.secrets[0].includes('worker-runtime-'));assert.equal(w.stripeBilling.endpointSecrets.length,0);assert.equal(a.store.sandboxEntitlementPolicy.hash,w.store.sandboxEntitlementPolicy.hash);assert.equal(w.sandboxComposition.quota_enforced,false);
});
test('production JSON loader still rejects entitlement actions before credential access',async()=>{const f=fixture(),c=configuration();c.runtime.authorizedActions.push('sandbox.entitlement.view');const result=await createStripeRuntimeLoader()(JSON.stringify(c.runtime),f.hooks);assert.equal(result.stripeBillingUnavailable,true);assert.equal(f.secrets.length,0);});
