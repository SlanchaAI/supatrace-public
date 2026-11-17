import {alphaProject} from './alpha-projects.mjs';

// Versioned commercial reference, not an activated offer or a billing adapter.
// Source: official Supabase inventory verified 2026-10-21; decimal GB units.
const reference = {
  version: 'supatrace-reference-2026-10-21.1', verified_on: '2026-10-21',
  source_url: 'https://supabase.com/pricing', currency: 'USD', billing_scope: 'organization', interval: 'month',
  status: 'reference_only', paid_activation_enabled: false,
  target_allowance_basis: 'object_storage_reference_not_current_reserved_byte_meter',
  tiers: [
    { id: 'free', name: 'Free', monthly_base_usd: 0, price_kind: 'fixed', target_object_storage_bytes: 1000000000, purchasable: false },
    { id: 'pro', name: 'Pro', monthly_base_usd: 25, price_kind: 'from', target_object_storage_bytes: 100000000000, purchasable: false },
    { id: 'team', name: 'Team', monthly_base_usd: 599, price_kind: 'from', target_object_storage_bytes: 100000000000, purchasable: false },
    { id: 'enterprise', name: 'Enterprise', monthly_base_usd: null, price_kind: 'custom', target_object_storage_bytes: null, purchasable: false }
  ]
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const PLAN_CATALOG = freeze(reference);

// SupaTrace plan catalog.
// Enterprise uses custom pricing with no self-serve checkout.
// See docs/plan-catalog.md for limits and features.
// This table is the single source of truth: src/plan-limits.mjs derives the enforced allowances from it,
// src/entitlements.mjs derives every count limit and feature flag from it, and the public /pricing page is
// generated from it (scripts/site-pages.mjs) and contract-tested against it.
// null on a count means unlimited (no plan uses it yet: member, environment and key lists are single pages, so
// Enterprise has the largest counts those pages hold). `features` lists the feature flags the plan unlocks (see FEATURES).
// `checkout` says whether the plan is bought through Stripe Checkout; Enterprise is assigned by an operator.
export const FEATURES = freeze({
  email_support: {label: 'Email support'},
  usage_alerts: {label: 'Usage alert emails at 80% and 100%'},
  spend_cap: {label: 'Spend cap control (run past the allowance)'},
  trace_drains: {label: 'Data export to your systems (trace drains)'},
  audit_log: {label: 'Audit log'},
  rbac_roles: {label: 'Developer and read-only roles, environment limits'},
  priority_support: {label: 'Priority support'},
  sso_saml: {label: 'SAML single sign-on'},
  scim: {label: 'SCIM provisioning'},
  audit_log_export: {label: 'Audit log export'},
  custom_roles: {label: 'Custom roles'},
  enforce_mfa: {label: 'Require two-factor authentication'},
  custom_retention: {label: 'Custom retention'},
  sla: {label: 'Uptime SLA (terms by contract)'}
});
const BASE_FEATURES = ['email_support', 'usage_alerts'];
const PRO_FEATURES = [...BASE_FEATURES, 'spend_cap', 'trace_drains', 'audit_log', 'rbac_roles', 'priority_support'];
const ENTERPRISE_FEATURES = [...PRO_FEATURES, 'sso_saml', 'scim', 'audit_log_export', 'custom_roles', 'enforce_mfa', 'custom_retention', 'sla'];
export const PLANS = freeze({
  version: 'supatrace-plans-2026-11-16.1', approved_on: '2026-11-16',
  approval_note: "Plan limits and features",
  source_url: 'https://github.com/SlanchaAI/supatrace/issues/107', status: 'approved',
  currency: 'USD', billing_scope: 'organization', interval: 'month',
  plans: [
    { id: 'free', name: 'Free', price_kind: 'fixed', monthly_base_usd: 0, card_required: false, checkout: false,
      included_spans_per_month: 50000, overage_usd_per_million_spans: null, at_allowance: 'hard_stop',
      storage_gb: 1, retention_days: 7, workspaces: 1, projects: 2, environments: 2, seats: 2, api_keys: 2, spend_cap: null, features: [] },
    { id: 'base', name: 'Base', price_kind: 'fixed', monthly_base_usd: 9.99, card_required: true, checkout: true,
      included_spans_per_month: 1000000, overage_usd_per_million_spans: null, at_allowance: 'hard_stop',
      storage_gb: 10, retention_days: 30, workspaces: 3, projects: 3, environments: 3, seats: 5, api_keys: 10, spend_cap: null, features: BASE_FEATURES },
    { id: 'pro', name: 'Pro', price_kind: 'fixed', monthly_base_usd: 25.99, card_required: true, checkout: true,
      included_spans_per_month: 5000000, overage_usd_per_million_spans: 5, at_allowance: 'metered_overage',
      storage_gb: 50, retention_days: 90, workspaces: 5, projects: 10, environments: 10, seats: 10, api_keys: 25, spend_cap: 'on_by_default', features: PRO_FEATURES },
    { id: 'enterprise', name: 'Enterprise', price_kind: 'custom', monthly_base_usd: null, card_required: null, checkout: false,
      included_spans_per_month: 50000000, overage_usd_per_million_spans: null, at_allowance: 'hard_stop',
      storage_gb: 500, retention_days: 365, workspaces: 10, projects: 20, environments: 20, seats: 20, api_keys: 100, spend_cap: 'on_by_default', features: ENTERPRISE_FEATURES }
  ]
});

export function accountPlanConfiguration(catalog = PLAN_CATALOG, tenantId) {
  // This release supports exactly this reviewed reference configuration. Arbitrary
  // server config, metadata, query fields or mock events cannot enable purchases.
  if (JSON.stringify(catalog) !== JSON.stringify(PLAN_CATALOG)) {
    const error = new Error('plan_not_configured'); error.status = 503; error.code = 'plan_not_configured'; throw error;
  }
  return {
    account_plan: {
      id: 'alpha_unbilled', name: 'Unbilled alpha account', scope: alphaProject(tenantId).accounting_scope,
      organization_id: null, commercial_plan_assignment: 'not_migrated',
      billing_status: 'not_configured', paid_active: false, paid_activation_enabled: false
    },
    plan_configuration: {
      version: PLAN_CATALOG.version, status: 'reference_configured_not_assigned',
      target_allowances_active: false, organization_project_migration_required: true,
      verified_billing_required: true
    }
  };
}
