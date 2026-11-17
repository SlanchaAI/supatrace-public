# AWS cost sensitivity, read 2026-10-21

Run `python3 aws/cost_model.py`. This deterministic model is a component estimate, not measured usage, a complete operating cost, a quote or authority to spend. It subtracts no free allowances because available account entitlement has not been verified.

Workload held constant: 100,000 events/day, 2 KiB/event, 1,000 users, 10% batch exports, 30-day month. Compare 1/10/100 events per object and 7/30/90-day steady-state retention. No compression assumed. The current 10 MiB/tenant, 100 MiB global, 100 account pilot caps cannot serve this larger modeled workload; lifting them requires a deliberate capacity/budget decision. Retention in the model is a sensitivity assumption, not an implemented deletion policy.

Count all six transactional metadata item writes in reservation+acceptance at two WRUs per <=1 KiB item. Add assumed rate-limiter/auth operations, metadata storage, Lambda request+duration, CloudFront upload-to-origin transfer, viewer requests/export egress, and one shared OAuth secret. No per-user AWS secret is required. Secret retrievals are cached in memory for five minutes, but actual cold starts determine retrieval count. 250 ms Lambda duration is an assumption, not a benchmark. Item-size rounding, failures and retries can raise DynamoDB charges.

The script explicitly lists unknown/excluded logs, static traffic, deployment artifacts, operations and engineering. Therefore its subtotal must not be presented as all-in workflow cost or a safe spending limit. Concurrency and throughput caps also do not create a hard dollar cap.

## Primary rate references
- S3 us-east-1 Standard storage $0.023/GiB-month, PUT $0.005/1,000, GET $0.0004/1,000: https://aws.amazon.com/s3/pricing/ . Rates reused from the October 20 verified investigation; current page read October 21, dynamic rate table not fully exposed in text.
- DynamoDB Standard on-demand $0.625/M WRU, $0.125/M RRU, $0.25/GiB-month: https://aws.amazon.com/dynamodb/pricing/ . Transaction writes require two units per rounded 1 KiB item: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html .
- Lambda x86 first tier $0.20/M requests, $0.0000166667/GB-second: https://aws.amazon.com/lambda/pricing/ .
- CloudFront US-edge HTTPS $0.010/10,000, upload transfer to origin $0.020/GB, export egress first paid tier $0.085/GB: https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ . Geography changes rates. AWS-origin transfer to CloudFront is not charged a second S3 internet-egress fee.
- Secrets Manager $0.40/secret-month and $0.05/10,000 API calls: https://aws.amazon.com/secrets-manager/pricing/ .

Confirm exact chosen region/account pricing and budget before deployment. No guaranteed free capacity or savings claim follows from this model.
