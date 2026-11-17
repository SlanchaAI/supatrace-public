import {resolveBillingPrincipal,guardBillingRuntime} from './billing-principal.mjs';
import {sandboxEntitlementConfiguration,planSandboxEntitlement} from './stripe-sandbox-entitlements.mjs';
import {resolveCommercialCheckout} from './commercial-policy.mjs';
// Server-only sandbox execution. No default client, key lookup, live mode or entitlement grant.
import {HttpError,json} from './http.mjs';
import {verifyStripeTestSnapshot,stripeTestIntent,resolvedStripeTestRisk} from './stripe-test-webhook.mjs';
import {stripeTestCatalogHash,planStripeTestReconciliation} from './stripe-test-checkout.mjs';
const fail=(status,code)=>{throw new HttpError(status,code);};
function configuration(env){let c=env.stripeBilling;if(c?.enabled!==true)fail(503,'billing_disabled');if(c.mode!=='isolated_sandbox'||c.catalog?.livemode!==false||c.catalogHash!==stripeTestCatalogHash(c.catalog)||typeof c.authorize!=='function'||!c.client||typeof c.integrationIdentifier!=='string'||c.purchasesEnabled!==false)fail(503,'billing_not_configured');c={...c,catalog:structuredClone(c.catalog),endpointSecrets:c.endpointSecrets?[...c.endpointSecrets]:undefined};const sdk=c.client;c.methods={account:sdk.accounts?.retrieve?.bind(sdk.accounts),customer:sdk.customers?.retrieve?.bind(sdk.customers),customerCreate:sdk.customers?.create?.bind(sdk.customers),create:sdk.checkout?.sessions?.create?.bind(sdk.checkout.sessions),subscription:sdk.subscriptions?.retrieve?.bind(sdk.subscriptions),invoice:sdk.invoices?.retrieve?.bind(sdk.invoices),session:sdk.checkout?.sessions?.retrieve?.bind(sdk.checkout.sessions),charge:sdk.charges?.retrieve?.bind(sdk.charges),invoicePayments:sdk.invoicePayments?.list?.bind(sdk.invoicePayments),portalConfig:sdk.billingPortal?.configurations?.retrieve?.bind(sdk.billingPortal.configurations),portalCreate:sdk.billingPortal?.sessions?.create?.bind(sdk.billingPortal.sessions)};c.deadline=Date.now()+25000;for(const key of Object.keys(c.methods)){const method=c.methods[key];c.methods[key]=(...args)=>bounded(()=>method(...args),c.deadline);}return c;}
const requestOptions=c=>({apiVersion:c.catalog.api_version,maxNetworkRetries:0,timeout:10000});
async function bounded(fn,deadline=Date.now()+11000){let timer;if(deadline<=Date.now())fail(503,'billing_operation_timeout');try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(503,'billing_operation_timeout')),Math.min(11000,Math.max(1,deadline-Date.now())));})]);}catch{fail(503,'billing_operation_unavailable');}finally{clearTimeout(timer);}}
async function authorize(c,action,tenant){if(await bounded(()=>c.authorize(Object.freeze({action,tenant_id:tenant,merchant_id:c.catalog.merchant_id,environment_id:c.catalog.environment_id,livemode:false})))!==true)fail(403,'billing_action_not_authorized');}
async function merchant(c){const account=await bounded(()=>c.methods.account(null,{},requestOptions(c)));if(account?.object!=='account'||account.id!==c.catalog.merchant_id)fail(503,'billing_merchant_mismatch');return account;}
function validSession(s,b,request){let url;try{url=new URL(s?.url);}catch{fail(503,'checkout_response_invalid');}if(s.object!=='checkout.session'||!/^cs_test_[A-Za-z0-9]+$/.test(s.id)||s.livemode!==false||s.mode!=='subscription'||s.customer!==b.customer_id||s.client_reference_id!==request||s.status!=='open'||url.origin!=='https://checkout.stripe.com'||url.username||url.password)fail(503,'checkout_response_invalid');return {session_id:s.id,url:url.href,livemode:false,status:'open'};}
export async function checkout(request,env,tenant,data){
 try{data=structuredClone(data);}catch{fail(400,'invalid_checkout_request');}
 const principal=await resolveBillingPrincipal(request,env,tenant);env={...env,store:principal.store};
 if(env.commercialUnavailable===true)fail(503,'commercial_policy_unavailable');
 let commercialSelection;if(data&&Object.hasOwn(data,'plan_id')){const selected=await resolveCommercialCheckout(env,tenant,data);data=selected.data;commercialSelection=selected.binding;}else if(env.commercial?.enabled===true)fail(400,'commercial_plan_required');
 const c=guardBillingRuntime(configuration(env),principal);if(commercialSelection&&(c.catalog.revision!==commercialSelection.policy_hash||c.catalogHash!==commercialSelection.catalog_hash||c.catalog.merchant_id!==commercialSelection.merchant_id||c.catalog.environment_id!==commercialSelection.environment_id))fail(409,'commercial_checkout_configuration_changed');if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).some(k=>!['price_id','request_id'].includes(k)))fail(400,'invalid_checkout_request');
 if(typeof data.price_id!=='string'||!Object.hasOwn(c.catalog.prices,data.price_id)||typeof data.request_id!=='string'||!/^checkout_test_[A-Za-z0-9]{16,100}$/.test(data.request_id))fail(400,'invalid_checkout_request');
 await authorize(c,'checkout.create',tenant);await merchant(c);
 let binding;try{binding=await env.store.getStripeTestBinding(tenant,c.catalog.merchant_id);}catch(error){
  if(error?.code!=='billing_customer_unbound'||c.bootstrapCustomers!==true)throw error;
  await authorize(c,'customer.create',tenant);
  const pending=await env.store.prepareStripeSandboxCustomerIntent(tenant,c.catalog.merchant_id);
  if(pending.bound===true)binding=await env.store.getStripeTestBinding(tenant,c.catalog.merchant_id);else{
  const created=await c.methods.customerCreate({},{...requestOptions(c),idempotencyKey:pending.idempotency_key});
  if(created?.object!=='customer'||created.deleted||created.livemode!==false||!/^cus_[A-Za-z0-9]{1,180}$/.test(created.id||''))fail(503,'customer_creation_response_invalid');
  binding=await env.store.completeStripeSandboxCustomerIntent(tenant,{merchant_id:c.catalog.merchant_id,intent_id:pending.intent_id,customer_id:created.id});}
 }

 const customer=await bounded(()=>c.methods.customer(binding.customer_id,{},requestOptions(c)));if(customer?.deleted||customer?.object!=='customer'||customer.id!==binding.customer_id||customer.livemode!==false)fail(409,'billing_customer_mismatch');
 const intent=await env.store.prepareStripeTestCheckoutIntent(tenant,{merchant_id:c.catalog.merchant_id,price_id:data.price_id,request_id:data.request_id,integration_identifier:c.integrationIdentifier},{enabled:true,catalog:c.catalog,catalogHash:c.catalogHash,returnOrigin:env.APP_ORIGIN,checkoutScope:principal.descriptor});
 await principal.assertCurrent();
 const saved=await env.store.getStripeSandboxCheckoutSession(tenant,{merchant_id:c.catalog.merchant_id,intent_id:intent.intent_id,checkout_scope:principal.descriptor});await principal.assertCurrent();if(saved)return json({...saved,replayed:true,purchases_enabled:false});
 // Use exact durable descriptor and stable Stripe idempotency key; retries never create a new key.
 const p=new URLSearchParams(intent.descriptor.body),params={mode:'subscription',integration_identifier:p.get('integration_identifier'),customer:p.get('customer'),line_items:[{price:p.get('line_items[0][price]'),quantity:1}],client_reference_id:p.get('client_reference_id'),success_url:p.get('success_url'),cancel_url:p.get('cancel_url')};
 const session=validSession(await bounded(()=>c.methods.create(params,{...requestOptions(c),idempotencyKey:intent.descriptor.headers['Idempotency-Key']})),binding,data.request_id);
 const receipt=await env.store.recordStripeSandboxCheckoutSession(tenant,{merchant_id:c.catalog.merchant_id,intent_id:intent.intent_id,...session,checkout_scope:principal.descriptor});await principal.assertCurrent();return json({...receipt,purchases_enabled:false},201);
}
async function rawBody(request){if(request.headers.get('content-encoding')||request.headers.get('content-type')?.split(';')[0]!=='application/json')fail(415,'webhook_json_required');if(!request.body)fail(400,'empty_webhook');const reader=request.body.getReader(),parts=[];let bytes=0,timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{reader.cancel().catch(()=>{});reject(new HttpError(408,'webhook_body_timeout'));},10000);});try{while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;bytes+=value.byteLength;if(bytes>262144){reader.cancel().catch(()=>{});fail(413,'webhook_too_large');}parts.push(value);}}finally{clearTimeout(timer);reader.releaseLock();}return Buffer.concat(parts.map(p=>Buffer.from(p)));}
export async function webhook(request,env){const c=configuration(env);await authorize(c,'webhook.record',undefined);const raw=await rawBody(request);let token;try{token=verifyStripeTestSnapshot(raw,request.headers.get('stripe-signature'),{endpointSecrets:c.endpointSecrets,merchantAccount:c.catalog.merchant_id,environmentId:c.catalog.environment_id,apiVersion:c.catalog.api_version,now:Math.floor(Date.now()/1000),purchasesEnabled:false});}catch{fail(400,'webhook_verification_failed');}const hint=stripeTestIntent(token);if(c.captureOnly===true){if(!env.store.stripeInboxTableName||!env.store.stripeStateTableName)fail(503,'billing_inbox_not_configured');const receipt=(hint.event_type.startsWith('checkout.session.')||hint.action==='risk_review_required')?await env.store.recordStripeSandboxReview(token):await env.store.recordStripeTestEvent(token);return json({...receipt,captured_only:true,entitlements_applied:false},202);}if(hint.event_type.startsWith('checkout.session.'))return json(await checkoutEvent(env,c,token),202);if(hint.action==='risk_review_required')return json(await riskEvent(env,c,token),202);const receipt=await env.store.recordStripeTestEvent(token);return json({...receipt,entitlements_applied:false},202);}
// Internal worker entry point only. No client-supplied current-state snapshot accepted.
export async function reconcile(env,tenant,verifiedEvent){const c=configuration(env),hint=stripeTestIntent(verifiedEvent),sandbox=sandboxEntitlementConfiguration(env);if(sandbox)await authorize(c,'sandbox.entitlement.reconcile',tenant);await authorize(c,'subscription.reconcile',tenant);const b=await env.store.getStripeTestBinding(tenant,c.catalog.merchant_id);if(hint.customer_id!==b.customer_id||hint.merchant_id!==b.merchant_id||hint.environment_id!==b.environment_id||!b.subscription_id)fail(409,'billing_binding_mismatch');
 await env.store.recordStripeTestEvent(verifiedEvent);
 try{return await env.store.getStripeTestReconciliationReceipt(tenant,{merchant_id:b.merchant_id,event_id:hint.event_id});}catch(e){if(e.status!==404)throw e;}
 const account=await merchant(c);
 const previous=await env.store.getStripeTestReconciliationWatermark(tenant,b.merchant_id),observedAt=Math.floor(Date.now()/1000);const subscription=await bounded(()=>c.methods.subscription(b.subscription_id,{},requestOptions(c)));const invoice=typeof subscription.latest_invoice==='string'?await bounded(()=>c.methods.invoice(subscription.latest_invoice,{},requestOptions(c))):null;const now=Math.floor(Date.now()/1000);if(subscription.lastResponse?.apiVersion&&subscription.lastResponse.apiVersion!==c.catalog.api_version||invoice?.lastResponse?.apiVersion&&invoice.lastResponse.apiVersion!==c.catalog.api_version)fail(503,'billing_api_version_mismatch');
 if(sandbox){
  const customer=await c.methods.customer(b.customer_id,{},requestOptions(c));
  if(customer?.object!=='customer'||customer.id!==b.customer_id||customer.deleted||customer.livemode!==false)fail(409,'billing_customer_mismatch');
  for(const object of [account,customer,subscription,...(invoice?[invoice]:[])])if(object.lastResponse?.apiVersion!==c.catalog.api_version||object.lastResponse.stripeAccount!=null&&object.lastResponse.stripeAccount!==b.merchant_id)fail(503,'billing_response_attestation_failed');
 }
 const current={environment_id:b.environment_id,merchant_id:b.merchant_id,api_version:c.catalog.api_version,livemode:false,observed_at:observedAt,subscription,invoice};
 const decision=planStripeTestReconciliation({tenant_id:tenant,merchant_id:b.merchant_id,verifiedEvent,current,now,...(previous===undefined?{}:{previous_observed_at:previous})},{enabled:true,catalog:c.catalog,catalogHash:c.catalogHash,binding:b});
 return env.store.recordStripeTestReconciliation(tenant,decision,sandbox?planSandboxEntitlement(decision,sandbox):undefined);
}

// Composition helper only: caller supplies the official SDK constructor and an ephemeral restricted TEST key.
// No global key, automatic lookup, arbitrary API origin or implicit retry. Never called during import/build.
export function createStripeSandboxClient(StripeClient,restrictedTestKey){
 if(typeof StripeClient!=='function'||typeof restrictedTestKey!=='string'||!/^rk_test_[A-Za-z0-9]{16,256}$/.test(restrictedTestKey))fail(503,'restricted_sandbox_key_required');
 return new StripeClient(restrictedTestKey,{apiVersion:'2026-10-28.endive',host:'api.stripe.com',protocol:'https',port:443,timeout:10000,maxNetworkRetries:0});
}

async function checkoutEvent(env,c,token){
 const hint=stripeTestIntent(token),existing=await env.store.recordStripeSandboxReview(token);if(existing.status!=='resolution_required')return existing;await authorize(c,'checkout.reconcile',undefined);await merchant(c);
 const session=await bounded(()=>c.methods.session(hint.object_id,{},requestOptions(c)));if(session?.object!=='checkout.session'||session.id!==hint.object_id||session.customer!==hint.customer_id||session.livemode!==false||session.mode!=='subscription')fail(409,'checkout_session_mismatch');
 if(hint.event_type==='checkout.session.async_payment_failed'||session.payment_status!=='paid')return env.store.recordStripeSandboxReview(token,{status:'unpaid_no_binding'});
 const binding=await env.store.bindStripeSandboxCheckoutSubscription(token,session);return env.store.recordStripeSandboxReview(token,{status:'checkout_bound',subscription_ids:[binding.subscription_id]});
}
async function riskEvent(env,c,token){
 const hint=stripeTestIntent(token),existing=await env.store.recordStripeSandboxReview(token);if(existing.status!=='resolution_required')return existing;await authorize(c,'risk.resolve',undefined);await merchant(c);
 let paymentIntent=hint.payment_intent_id;if(!paymentIntent){if(!hint.charge_id)fail(409,'risk_payment_unresolved');const charge=await bounded(()=>c.methods.charge(hint.charge_id,{},requestOptions(c)));if(charge?.object!=='charge'||charge.id!==hint.charge_id||charge.livemode!==false||typeof charge.payment_intent!=='string'||!/^pi_[A-Za-z0-9]+$/.test(charge.payment_intent))fail(409,'risk_payment_unresolved');paymentIntent=charge.payment_intent;}
 const invoices=new Set();let cursor;for(let page=0;page<2;page++){const result=await bounded(()=>c.methods.invoicePayments({payment:{type:'payment_intent',payment_intent:paymentIntent},status:'paid',limit:5,...(cursor?{starting_after:cursor}:{})},requestOptions(c)));if(result?.object!=='list'||!Array.isArray(result.data)||result.data.length>5||typeof result.has_more!=='boolean')fail(409,'risk_invoice_page_invalid');for(const p of result.data){if(p.object!=='invoice_payment'||p.livemode!==false||p.status!=='paid'||p.payment?.type!=='payment_intent'||p.payment.payment_intent!==paymentIntent||!/^in_[A-Za-z0-9]+$/.test(p.invoice)||!/^inpay_[A-Za-z0-9]+$/.test(p.id))fail(409,'risk_invoice_link_invalid');invoices.add(p.invoice);}if(!result.has_more)break;if(page===1||!result.data.length)fail(409,'risk_invoice_history_requires_review');const next=result.data.at(-1).id;if(next===cursor)fail(409,'risk_invoice_cursor_invalid');cursor=next;}
 if(!invoices.size)fail(409,'risk_invoice_unresolved');const subscriptions=new Set();let customer;for(const id of invoices){const invoice=await bounded(()=>c.methods.invoice(id,{},requestOptions(c)));const sub=invoice?.parent?.subscription_details?.subscription;if(invoice?.object!=='invoice'||invoice.id!==id||invoice.livemode!==false||invoice.parent?.type!=='subscription_details'||typeof sub!=='string'||!/^sub_[A-Za-z0-9]+$/.test(sub)||!/^cus_[A-Za-z0-9]+$/.test(invoice.customer))fail(409,'risk_subscription_unresolved');if(customer&&customer!==invoice.customer)fail(409,'risk_cross_customer');customer=invoice.customer;const b=await env.store.getStripeTestBindingByCustomer(c.catalog.merchant_id,customer);if(b.subscription_id!==sub)fail(409,'risk_subscription_binding_mismatch');subscriptions.add(sub);}
 const resolved=resolvedStripeTestRisk(token,customer);return env.store.recordStripeSandboxReview(resolved,{status:'risk_review_required',subscription_ids:[...subscriptions]});
}

export function billingStatus(env){
 if(env.stripeBilling?.enabled!==true)return {sandbox:false,portal_available:false,purchases_enabled:false,paid_access:false,policy_status:'not_approved',reason:env.stripeBillingUnavailable===true?'billing_runtime_unavailable':'billing_disabled'};
 const c=configuration(env);return {sandbox:true,portal_available:c.portalEnabled===true&&typeof c.portalConfigurationId==='string'&&/^bpc_[A-Za-z0-9]+$/.test(c.portalConfigurationId),purchases_enabled:false,paid_access:false,policy_status:'not_approved',reason:'sandbox_configuration_only_not_provider_acceptance',...(env.stripeSandboxEntitlements?.enabled===true&&env.store.sandboxEntitlementPolicy?{entitlement_preview_available:true,...(env.store.sandboxEntitlementPolicy.planLimits===true?{test_plan_limits:true}:{})}:{})};
}
export async function portal(request,env,tenant,data){
 const principal=await resolveBillingPrincipal(request,env,tenant);env={...env,store:principal.store};
 const c=guardBillingRuntime(configuration(env),principal);if(c.portalEnabled!==true||typeof c.portalConfigurationId!=='string'||!/^bpc_[A-Za-z0-9]+$/.test(c.portalConfigurationId))fail(503,'billing_portal_disabled');if(!data||Object.getPrototypeOf(data)!==Object.prototype||Object.keys(data).length)fail(400,'invalid_portal_request');if(!['https://supatrace.dev','https://supatrace.tech'].includes(env.APP_ORIGIN))fail(503,'billing_return_origin_invalid');
 await authorize(c,'portal.create',tenant);await merchant(c);const b=await env.store.getStripeTestBinding(tenant,c.catalog.merchant_id);const customer=await bounded(()=>c.methods.customer(b.customer_id,{},requestOptions(c)));if(customer?.object!=='customer'||customer.deleted||customer.id!==b.customer_id||customer.livemode!==false)fail(409,'billing_customer_mismatch');
  // Read-only by default. Under the opt-in test-mode plan assignment the TEST portal may also change or cancel
 // the subscription, because the webhook path then moves the account's plan with it. Payment-method and
 // customer edits, and any feature this code does not know, must still be off.
 const manage=sandboxEntitlementConfiguration(env)?.planLimits===true?['subscription_cancel','subscription_update']:[];
 const config=await bounded(()=>c.methods.portalConfig(c.portalConfigurationId,{},requestOptions(c)));const writeFeatures=['subscription_cancel','subscription_update','payment_method_update','customer_update'];if(config?.object!=='billing_portal.configuration'||config.id!==c.portalConfigurationId||config.livemode!==false||config.active!==true||config.features?.invoice_history?.enabled!==true||writeFeatures.some(k=>!manage.includes(k)&&config.features?.[k]?.enabled!==false)||Object.entries(config.features||{}).some(([k,v])=>k!=='invoice_history'&&(manage.includes(k)?typeof v?.enabled!=='boolean':v?.enabled!==false)))fail(409,manage.length?'test_portal_configuration_required':'read_only_portal_configuration_required');
 const readOnly=!manage.some(k=>config.features[k]?.enabled===true);
 const returnUrl=env.APP_ORIGIN+'/app/#usage',session=await bounded(()=>c.methods.portalCreate({customer:b.customer_id,configuration:c.portalConfigurationId,return_url:returnUrl},requestOptions(c)));let url;try{url=new URL(session?.url);}catch{fail(503,'portal_response_invalid');}if(session.object!=='billing_portal.session'||!/^bps_[A-Za-z0-9]+$/.test(session.id)||session.customer!==b.customer_id||session.configuration!==c.portalConfigurationId||session.livemode!==false||session.on_behalf_of!=null||session.return_url!==returnUrl||url.origin!=='https://billing.stripe.com'||url.username||url.password)fail(503,'portal_response_invalid');
 // Temporary portal URL is returned only to the authenticated owner, never stored/logged.
 return json({url:url.href,sandbox:true,read_only:readOnly,purchases_enabled:false,entitlements_applied:false},201);
}

// Internal one-event worker callable. No public route or scheduler exposes it.
export async function processStoredStripeBillingEvent(env,eventId){
 const c=configuration(env);await authorize(c,'capture.process',undefined);const token=await env.store.loadStripeCapturedEvent(c.catalog.merchant_id,eventId),hint=stripeTestIntent(token);
 if(hint.event_type.startsWith('checkout.session.')){const capture=await checkoutEvent(env,c,token);if(capture.status!=='checkout_bound')return {...capture,entitlements_applied:false};const b=await env.store.getStripeTestBindingByCustomer(c.catalog.merchant_id,hint.customer_id);return {capture,reconciliation:await reconcile(env,b.tenant_id,token),entitlements_applied:false};}
 if(hint.action==='risk_review_required')return riskEvent(env,c,token);const b=await env.store.getStripeTestBindingByCustomer(c.catalog.merchant_id,hint.customer_id);return reconcile(env,b.tenant_id,token);
}

// Authenticated read projection only; it is never consulted by production admission controls.
export async function sandboxEntitlement(env,tenant,projectId){
 const c=configuration(env);
 if(!sandboxEntitlementConfiguration(env))fail(503,'sandbox_entitlements_disabled');
 await authorize(c,'sandbox.entitlement.view',tenant);
 return json(await env.store.getStripeSandboxEntitlement(tenant,projectId));
}
