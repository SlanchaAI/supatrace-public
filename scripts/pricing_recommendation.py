"""Offline decision model: retained aggregates only; no product policy or AWS calls."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = json.loads((ROOT / 'tests/fixtures/economics/workloads.json').read_text())
RATES = json.loads((ROOT / 'tests/fixtures/economics/rates.json').read_text())['usd']
GIB = 2**30
PLANS = {
    'Core': dict(price=39, retention_days=30, support_minutes=2, logins=20,
                 misc_requests=1000, monthly_events=25000, monthly_batches=25000,
                 ingress_bytes=250*2**20, resident_bytes=512*2**20,
                 metadata_bytes=256*2**20, api_requests=150000, export_bytes=2*GIB),
    'Team': dict(price=129, retention_days=90, support_minutes=5, logins=100,
                 misc_requests=5000, monthly_events=50000, monthly_batches=50000,
                 ingress_bytes=GIB, resident_bytes=3*GIB,
                 metadata_bytes=2*GIB, api_requests=750000, export_bytes=10*GIB),
}


def estimate(name, plan_name, *, exports=4, billed_seconds=1, support_minutes=None,
             paying_workspaces=25, refund_fraction=0, auth_multiplier=1,
             extra_attempts=0, attempt_phase='duplicate', retention_days=None,
             workload_scale=1):
    """30 ingestion days, steady retained horizon, full-horizon exports.

    Scaling is an extrapolation of aggregate counters, NOT a throughput test.
    Extra attempts use measured duplicate/conflict/hash/failure coefficients.
    Costs above proposed caps are counterfactual, not automatically clipped.
    """
    p = PLANS[plan_name]
    profile = BASELINE['reports'][name]
    assert profile['network_calls'] == 0
    retention = retention_days if retention_days is not None else p['retention_days']
    factors = [(v, 30*workload_scale) for k, v in profile['phases'].items() if k != 'export']
    factors += [(profile['phases']['export'], retention*exports*workload_scale)]
    factors += [(profile['phases'][attempt_phase], extra_attempts)]
    def total(key):
        return sum(v.get(key, 0)*n for v, n in factors)
    def commands(key):
        return sum(v.get('s3_commands', {}).get(key, 0)*n for v, n in factors)
    requests = total('http_requests') + p['misc_requests']
    # Explicit unmeasured workspace/auth/UI overhead: 2x old RRU/WRU/metadata.
    # Misc UI requests assume 6 RRU + 4 WRU each, not a source-enforced bound.
    rru = 2*total('estimated_rrus') + 6*p['misc_requests']
    wru = 2*total('estimated_wrus') + 4*p['misc_requests']
    payload = profile['measured']['payload_bytes']*retention*workload_scale
    metadata = 2*profile['measured']['metadata_storage_proxy_bytes']*retention*workload_scale
    response = total('response_body_bytes') + 4096*p['misc_requests']
    # Operation-equivalent cost is NOT current provisioned marginal billing.
    equivalent = rru*RATES['dynamodb_rru_per_million']/1e6 + wru*RATES['dynamodb_wru_per_million']/1e6
    costs = {
        'metadata_capacity_planning_allowance': max(10/paying_workspaces, equivalent),
        'metadata_storage_proxy': metadata/GIB*RATES['dynamodb_gb_month'],
        'objects_storage': payload/GIB*RATES['s3_gb_month'],
        's3_put_attempts': commands('PutObjectCommand')*RATES['s3_put_per_1000']/1000,
        's3_gets': commands('GetObjectCommand')*RATES['s3_get_per_1000']/1000,
        'lambda': requests*(RATES['lambda_requests_per_million']/1e6 + .25*billed_seconds*RATES['lambda_gb_second']),
        'edge_requests': requests*(RATES['cloudfront_https_per_10000']/10000 + RATES['cloudfront_functions_per_million']/1e6),
        'viewer_egress': response/GIB*RATES['cloudfront_viewer_gb'],
        'origin_ingress': total('request_body_bytes')/GIB*RATES['cloudfront_origin_upload_gb'],
        'logs': requests/GIB*(1024*RATES['logs_ingested_gb']+512*RATES['logs_stored_gb_month']*7/30),
        'secrets_reads': requests*2*RATES['secret_reads_per_10000']/10000,
        'shared_non_metadata_allowance': 20/paying_workspaces,
        'authentication_allowance': p['logins']*.005*auth_multiplier,
        'support': p['support_minutes'] if support_minutes is None else support_minutes,
        'payment_and_billing': p['price']*(RATES['stripe_domestic_fraction']+RATES['stripe_billing_fraction'])+RATES['stripe_domestic_fixed'],
    }
    # Support loaded at assumed $60/h => $1/minute. Fees retained on refunds.
    revenue = p['price']*(1-refund_fraction)
    contribution = revenue-sum(costs.values())
    usage = dict(events=profile['measured']['archive_events']*30*workload_scale,
                 batches=profile['measured']['objects']*30*workload_scale,
                 api_requests=requests, ingress_bytes=total('request_body_bytes'),
                 resident_bytes=payload, metadata_bytes=metadata,
                 export_bytes=profile['phases']['export']['response_body_bytes']*retention*exports*workload_scale)
    limits = dict(events=p['monthly_events'], batches=p['monthly_batches'],
                  api_requests=p['api_requests'], ingress_bytes=p['ingress_bytes'],
                  resident_bytes=p['resident_bytes'], metadata_bytes=p['metadata_bytes'],
                  export_bytes=p['export_bytes'])
    return dict(profile=name, plan=plan_name, exports_per_month=exports,
                assumed_billed_seconds=billed_seconds, usage=usage,
                exceeded_proposed_limits=[k for k in usage if usage[k] > limits[k]],
                costs=costs, realized_revenue=revenue, contribution=contribution,
                margin_percent=100*contribution/p['price'],
                margin_denominator='gross posted monthly price; refunds are a cost sensitivity')


def conditional_envelope(plan_name):
    """Stress budget if ALL proposed counters AND unproved per-request bounds hold.

    NOT an actual maximum bill: 16s includes assumed INIT, DB work is assumed,
    edge rejects and independent services are outside admission counters.
    """
    p = PLANS[plan_name]
    n = p['api_requests']
    costs = {
        'lambda_16s_assumption': n*(.25*16*RATES['lambda_gb_second']+RATES['lambda_requests_per_million']/1e6),
        'edge_and_logs': n*(1.1/1e6 + (1024*.50+512*.03*7/30)/GIB),
        'metadata_64wru_32rru_assumption': max(.4, n*(64*.625+32*.125)/1e6),
        'metadata_storage': p['metadata_bytes']/GIB*.25,
        'objects_storage': p['resident_bytes']/GIB*.023,
        'puts_twice_batch_cap_assumption': 2*p['monthly_batches']*.005/1000,
        'gets_at_most_api_cap_assumption': n*.0004/1000,
        'ingress': p['ingress_bytes']/GIB*.020,
        'export_egress': p['export_bytes']/GIB*.085,
        'secrets_two_reads_per_request_assumption': n*2*.05/10000,
        'other_shared_and_auth': .8+p['logins']*.005,
        'support_budget_assumption': p['support_minutes'],
        'payment': p['price']*.036+.30,
    }
    return dict(costs=costs, conditional_cost=sum(costs.values()),
                contribution=p['price']-sum(costs.values()),
                actual_company_maximum_usd=None, guaranteed_bound=False)


def free_envelope():
    n = 5000
    # All coefficients here are conditional assumptions, not enforced bounds.
    cost = (n*(.25*16*RATES['lambda_gb_second']+.2/1e6+1.1/1e6
               +(1024*.5+512*.03*7/30)/GIB+44/1e6+2*.05/10000)
            +10/1024*(.25+.023)+2000*.005/1000+5000*.0004/1000
            +100/1024*.085+10/1024*.02+.05)
    return dict(conditional_cost_per_trial=cost, five_new_trials=5*cost,
                fifty_new_trials=50*cost, guaranteed_bound=False,
                actual_company_maximum_usd=None)


def build():
    matrix = [estimate(w, p) for p in PLANS for w in ('light', 'typical', 'large')]
    sensitivity = {}
    for p in PLANS:
        sensitivity[p] = {
            'base': estimate('typical', p),
            'daily_full_exports': estimate('typical', p, exports=30),
            'ten_full_exports_per_day': estimate('typical', p, exports=300),
            'sixteen_second_compute': estimate('typical', p, billed_seconds=16),
            'ten_support_minutes': estimate('typical', p, support_minutes=10),
            'thirty_support_minutes': estimate('typical', p, support_minutes=30),
            'one_paying_workspace': estimate('typical', p, paying_workspaces=1),
            'five_paying_workspaces': estimate('typical', p, paying_workspaces=5),
            'two_percent_refunds': estimate('typical', p, refund_fraction=.02),
            'full_refund': estimate('typical', p, refund_fraction=1),
            'tenfold_auth_cost': estimate('typical', p, auth_multiplier=10),
            'one_hundred_thousand_duplicates': estimate('typical', p, extra_attempts=100000),
            'one_hundred_thousand_conflicts': estimate('typical', p, extra_attempts=100000, attempt_phase='conflict'),
            'one_hundred_thousand_failed_puts': estimate('typical', p, extra_attempts=100000, attempt_phase='failed_upload'),
            'one_year_retention': estimate('typical', p, retention_days=365),
            'monthly_event_cap_extrapolation': estimate('large', p, workload_scale=PLANS[p]['monthly_events']/(801*30)),
        }
    # One trial lifecycle including recovery and one export; no fictitious reset.
    return dict(as_of='2026-11-08', fixture_kind='synthetic',
                measured_baseline_date=BASELINE['as_of'], rate_date='2026-11-04',
                recommended_not_approved=True, network_calls=0, plans=PLANS,
                assumptions=dict(days_per_month=30, full_horizon_exports=4,
                                 support_usd_per_hour=60, paying_workspaces=25,
                                 shared_non_metadata_usd_per_month=20,
                                 provisioned_metadata_floor_usd_per_month=10,
                                 full_auth_usd_per_login=.005,
                                 metadata_old_to_current_multiplier=2,
                                 secret_reads_per_api_request=2,
                                 log_ingest_bytes_per_request=1024,
                                 log_stored_bytes_per_request=512, log_retention_days=7),
                matrix=matrix, sensitivity=sensitivity, free_trial_envelope=free_envelope(),
                conditional_envelopes={p:conditional_envelope(p) for p in PLANS})


if __name__ == '__main__':
    print(json.dumps(build(), indent=2, sort_keys=True, allow_nan=False))
