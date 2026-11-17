// USD list-price sensitivity, not a bill, profit forecast, or commercial policy.
import {readFileSync} from 'node:fs';
export const rates=Object.freeze(JSON.parse(readFileSync(new URL('../tests/fixtures/economics/rates.json',import.meta.url),'utf8')).usd);
const GB=2**30;
const number=(n,label,max=1e12)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>max)throw Error('invalid_'+label);return n;};
const sum=(phases,key)=>phases.reduce((total,p)=>total+number(p[key],key),0);
const count=(phases,map,key)=>phases.reduce((total,p)=>total+number(p[map]?.[key]??0,key),0);

// Each argument that is not measured is required. Never substitute the local
// simulator's elapsed time for Lambda's billed duration (including cold init).
export function estimateWorkloadCost(profile,{billedMs,ingestedLogBytesPerRequest,storedLogBytesPerRequest,storageMonths,secretReads}={}){
 if(profile?.mode!=='offline_handler_and_adapter_simulation'||profile.network_calls!==0)throw Error('unsupported_profile');
 for(const [k,v]of Object.entries({billedMs,ingestedLogBytesPerRequest,storedLogBytesPerRequest,storageMonths,secretReads}))number(v,k);
 const phases=Object.values(profile.phases),measured=profile.measured;
 const requests=sum(phases,'http_requests'),responseBytes=sum(phases,'response_body_bytes'),uploadBytes=sum(phases,'request_body_bytes');
 const units={requests,rrus:sum(phases,'estimated_rrus'),wrus:sum(phases,'estimated_wrus'),s3_puts:count(phases,'s3_commands','PutObjectCommand'),s3_gets:count(phases,'s3_commands','GetObjectCommand'),response_bytes:responseBytes,upload_bytes:uploadBytes};
 const components={
  s3_puts:units.s3_puts*rates.s3_put_per_1000/1000,
  s3_gets:units.s3_gets*rates.s3_get_per_1000/1000,
  s3_storage:number(measured.payload_bytes,'payload_bytes')/GB*storageMonths*rates.s3_gb_month,
  dynamodb_writes:units.wrus*rates.dynamodb_wru_per_million/1e6,
  dynamodb_reads:units.rrus*rates.dynamodb_rru_per_million/1e6,
  dynamodb_storage_proxy:number(measured.metadata_storage_proxy_bytes,'metadata_storage_proxy_bytes')/GB*storageMonths*rates.dynamodb_gb_month,
  lambda_requests:requests*rates.lambda_requests_per_million/1e6,
  lambda_compute_assumed:requests*Math.ceil(billedMs)/1000*0.25*rates.lambda_gb_second,
  cloudfront_https:requests*rates.cloudfront_https_per_10000/10000,
  cloudfront_functions:requests*rates.cloudfront_functions_per_million/1e6,
  cloudfront_viewer_egress:responseBytes/GB*rates.cloudfront_viewer_gb,
  cloudfront_origin_upload:uploadBytes/GB*rates.cloudfront_origin_upload_gb,
  logs_ingest_assumed:requests*ingestedLogBytesPerRequest/GB*rates.logs_ingested_gb,
  logs_storage_assumed:requests*storedLogBytesPerRequest/GB*storageMonths*rates.logs_stored_gb_month,
  secret_reads_assumed:secretReads*rates.secret_reads_per_10000/10000
 };
 return{currency:'USD',rate_date:'2026-11-04',kind:'illustrative_variable_cost_plus_full_month_storage',units,assumptions:{billedMs,ingestedLogBytesPerRequest,storedLogBytesPerRequest,storageMonths,secretReads},components,total_usd:Object.values(components).reduce((a,b)=>a+b,0),includes_full_login_or_support:false};
}

// Repetition is a what-if across independent fixture lifecycles, not a claim
// that the alpha accepts this many bytes each month or resets cumulative usage.
export function contributionScenario({workloadCostUsd,workloadsPerMonth,revenueUsd,supportMinutes,supportHourlyUsd,sharedInfraUsd,authUsd,paymentCount,billingVolumeUsd}){
 for(const [k,v]of Object.entries(arguments[0]))number(v,k);
 for(const key of ['workloadCostUsd','workloadsPerMonth','revenueUsd','supportMinutes','supportHourlyUsd','sharedInfraUsd','authUsd','paymentCount','billingVolumeUsd'])if(arguments[0][key]===undefined)throw Error('missing_'+key);
 const costs={workload:workloadCostUsd*workloadsPerMonth,support:supportMinutes/60*supportHourlyUsd,shared_infra:sharedInfraUsd,authentication:authUsd,payments:revenueUsd*rates.stripe_domestic_fraction+paymentCount*rates.stripe_domestic_fixed,billing:billingVolumeUsd*rates.stripe_billing_fraction};
 const total=Object.values(costs).reduce((a,b)=>a+b,0);
 return{currency:'USD',hypothetical_price_not_approved:true,revenue_usd:revenueUsd,costs,total_cost_usd:total,contribution_usd:revenueUsd-total,contribution_percent:revenueUsd?100*(revenueUsd-total)/revenueUsd:null,not_net_profit:true};
}
