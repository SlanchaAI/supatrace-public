"""Offline arithmetic/provenance checks; no credentials, network or runtime policy."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pricing', ROOT/'scripts/pricing_recommendation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PricingTests(unittest.TestCase):
    def test_retained_output_is_reproducible(self):
        self.assertEqual(json.loads((ROOT/'tests/fixtures/economics/pricing.json').read_text()), m.build())

    def test_recovery_probe_is_counted(self):
        for name, expected in [('light',2430),('typical',12030),('large',24030)]:
            self.assertEqual(m.estimate(name,'Core')['usage']['events'],expected)

    def test_exports_read_entire_retained_horizon(self):
        a,b=m.estimate('typical','Core',exports=0),m.estimate('typical','Core',exports=1)
        self.assertEqual(b['usage']['api_requests']-a['usage']['api_requests'],403*30)
        c,d=m.estimate('typical','Team',exports=0),m.estimate('typical','Team',exports=1)
        self.assertEqual(d['usage']['api_requests']-c['usage']['api_requests'],403*90)

    def test_storage_uses_retention_not_export_count(self):
        a,b=m.estimate('typical','Team',exports=0),m.estimate('typical','Team',exports=300)
        self.assertEqual(a['usage']['resident_bytes'],703287*90)
        self.assertEqual(a['usage']['resident_bytes'],b['usage']['resident_bytes'])
        self.assertEqual(a['usage']['metadata_bytes'],2*663741*90)

    def test_provisioned_floor_and_unit_proxy_are_not_added(self):
        a=m.estimate('light','Core')
        self.assertEqual(a['costs']['metadata_capacity_planning_allowance'],.4)
        b=m.estimate('large','Team')
        self.assertGreater(b['costs']['metadata_capacity_planning_allowance'],.4)

    def test_refund_keeps_original_fee_and_cost(self):
        a,b=m.estimate('typical','Core'),m.estimate('typical','Core',refund_fraction=1)
        self.assertEqual(a['costs'],b['costs'])
        self.assertAlmostEqual(a['contribution']-b['contribution'],39)
        self.assertLess(b['contribution'],0)

    def test_support_is_dollar_per_minute(self):
        a,b=m.estimate('typical','Core'),m.estimate('typical','Core',support_minutes=30)
        self.assertAlmostEqual(a['contribution']-b['contribution'],28)

    def test_duplicate_has_no_new_storage_or_put(self):
        a,b=m.estimate('typical','Core'),m.estimate('typical','Core',extra_attempts=100000)
        for key in ('objects_storage','metadata_storage_proxy','s3_put_attempts'):
            self.assertEqual(a['costs'][key],b['costs'][key])
        self.assertEqual(b['usage']['api_requests']-a['usage']['api_requests'],100000)

    def test_failed_put_attempts_conservatively_charged(self):
        a,b=m.estimate('typical','Core'),m.estimate('typical','Core',extra_attempts=100000,attempt_phase='failed_upload')
        self.assertAlmostEqual(b['costs']['s3_put_attempts']-a['costs']['s3_put_attempts'],.5)

    def test_no_silent_clipping_of_abuse(self):
        a=m.estimate('typical','Core',exports=300)
        self.assertIn('api_requests',a['exceeded_proposed_limits'])
        self.assertIn('export_bytes',a['exceeded_proposed_limits'])
        self.assertLess(a['contribution'],0)

    def test_event_cap_scenarios_meet_normal_target(self):
        for plan in m.PLANS:
            a=m.estimate('large',plan,workload_scale=m.PLANS[plan]['monthly_events']/(801*30))
            self.assertGreater(a['margin_percent'],80)
            self.assertEqual(a['exceeded_proposed_limits'],[])

    def test_model_does_not_assert_a_total_bill_bound(self):
        for plan in m.PLANS:
            e=m.conditional_envelope(plan)
            self.assertIsNone(e['actual_company_maximum_usd'])
            self.assertFalse(e['guaranteed_bound'])
        self.assertTrue(m.build()['recommended_not_approved'])
        self.assertEqual(m.build()['network_calls'],0)


if __name__=='__main__':
    unittest.main()
