#!/usr/bin/env python3
"""Offline sensitivity estimate, not a quote, measured usage or spending authorization."""
import json,math

def model(events_day=100000,event_bytes=2048,events_batch=100,retention_days=30,users=1000):
    events=events_day*30; batches=math.ceil(events/events_batch);read_batches=math.ceil(batches*.1)
    # Explicit assumptions, not measured execution:250ms at256MiB;20account/API calls per user-month.
    calls=batches+read_batches+users*20
    ingress_gib=events*event_bytes/2**30;retained_gib=events_day*event_bytes*retention_days/2**30
    # Six transaction item writes per accepted batch, two WRUs each for <=1KiB items,
    # plus four assumed limiter writes. Real condition failures/retries can add charges.
    wrus=batches*16+users*100+read_batches*2
    rrus=batches*7+read_batches*3+users*40
    rates={'s3_storage':retained_gib*.023,'s3_put':batches/1000*.005,'s3_get':read_batches/1000*.0004,
      'dynamodb_write':wrus/1e6*.625,'dynamodb_read':rrus/1e6*.125,
      'dynamodb_metadata_storage':(batches*4096*retention_days/30+users*4096)/2**30*.25,
      'lambda_requests':calls/1e6*.2,'lambda_compute':calls*.25*.25*.0000166667,
      'cloudfront_https_us_edges':calls/10000*.010,'cloudfront_upload_to_origin':ingress_gib*.020,
      'cloudfront_export_egress':ingress_gib*.1*.085,
      'secrets_manager_one_secret':.40,'secret_reads_assumed_1000':1000/10000*.05}
    return {'events_day':events_day,'event_bytes':event_bytes,'events_batch':events_batch,'retention_days':retention_days,'users':users,'monthly_batches':batches,'steady_state_payload_gib':retained_gib,'components_usd':{k:round(v,6)for k,v in rates.items()},'known_component_subtotal_usd':round(sum(rates.values()),4),'unknown_or_excluded':['CloudWatch logs ingestion and storage','static-site traffic and CloudFront Function invocations','deployment artifacts and requests','tax and support','engineering, incident response and maintenance','retries, denied-traffic charges and abusive traffic beyond assumptions','regional/account-specific pricing or committed plans'], 'free_allowances_subtracted':False,'fits_current_pilot_caps':retained_gib<=100/1024 and users<=100}
if __name__=='__main__':print(json.dumps([model(events_batch=b,retention_days=r)for b in [1,10,100]for r in [7,30,90]],indent=2))
