// Synthetic fixture only: a paid TEST subscription and the real API's required meter contract.
export async function paidOverageFixture(live,env,owner='github-4242',mode='test') {
 const livemode=mode==='live';live.store.planBillingMode=mode;
 const end=live.store.now()+86400, customer='cus_synthetic', id='sub_synthetic';
 await live.store._send('UpdateCommand',{Key:{pk:'TENANT#'+owner,sk:'META'},UpdateExpression:'SET stripe_mode = :mode, plan_source = :source, stripe_customer_id = :customer, stripe_subscription_id = :subscription, plan_period_end = :end',ExpressionAttributeValues:{':mode':mode,':source':'stripe_'+mode,':customer':customer,':subscription':id,':end':end}});
 const fixed={id:'price_pro',livemode,lookup_key:'supatrace_pro_monthly',currency:'usd',unit_amount:2599,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
 const price={id:'price_overage',livemode,lookup_key:'supatrace_pro_overage_monthly',currency:'usd',billing_scheme:'per_unit',unit_amount_decimal:'0.0005',recurring:{interval:'month',interval_count:1,usage_type:'metered',meter:'mtr_synthetic'}};
 const subscription={id,livemode,customer,metadata:{supatrace_org:owner},status:'active',items:{data:[{id:'si_fixed',price:fixed,current_period_end:end}]}};
 env.planBilling={mode,stripe:{prices:{list:async()=>({data:[fixed,price]})},subscriptions:{retrieve:async()=>subscription,update:async()=>{subscription.items.data.push({id:'si_meter',price});return subscription;}},billing:{meters:{retrieve:async()=>({livemode,status:'active',event_name:'supatrace_pro_overage',default_aggregation:{formula:'sum'},customer_mapping:{type:'by_id',event_payload_key:'stripe_customer_id'},value_settings:{event_payload_key:'value'}})}}}};
}
