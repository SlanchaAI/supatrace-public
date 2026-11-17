# Default-off commercial selection, fulfillment and admission controls

This source is not an activated offer or a hosted payment result. No commercial policy, price, live credential, binding, provider adapter or account enrollment was configured. Tests use synthetic data and injected live-shaped callbacks; they are not genuine Stripe acceptance.

## Explicit policy and plan selection

The actual AWS API environment can compose an approved sandbox projection from the default-empty, nonsecret BILLING_COMMERCIAL_POLICY_CONFIG; this loader rejects live mode, raw verifier functions, fulfillment actions and mismatched runtime identity. Invalid policy hides the selector and blocks Checkout bypass without breaking authentication or trace access. The server requires a full policy and matching canonical hash: version and monotonic revision, exact merchant/environment/mode, own-domain terms URL, USD monthly plans and immutable Stripe price IDs, integer amounts, explicit storage reservation limits, one explicit free plan, cumulative accounting, non-active/risk behavior, invoice eligibility and a short reconciliation lease. There are no default commercial prices, terms, grace periods or quota assignments. Unsupported currencies or terms fail closed. The implementation currently supports blocking new uploads for non-active/risk states and either full-price-paid or explicitly approved paid-invoice eligibility; other business policies require implementation and approval.

Authenticated Usage and GET /api/billing/plans expose only the safe projection. The actual Usage selector sends plan ID, policy version and stable request ID; the server resolves the exact price from the pinned policy. The sandbox catalog must bind its revision to that policy hash and match every price/currency/interval/amount. Plan promises above the operational ceiling are unavailable. Sandbox success never changes account quota or grants paid access. Unknown Checkout outcomes retain the request ID; policy changes or reload reconciliation conflicts block another attempt rather than create duplicates. Recovery after a lost result/reload can still require the operator; this is not one-click recovery.

## Explicit account enrollment

Global source configuration does not silently migrate alpha accounts. POST /api/billing/controls/enroll requires the authenticated account, Origin/project gates, current policy version, enabled live fulfillment composition and a separate commercial.controls.enroll authorization. It changes no usage counters or trace data. It installs the commercial namespace/hash/revision and a zero legacy-limit sentinel, so disabled or older quota code fails closed instead of restoring alpha capacity. The effective approved limit is held in billing state and bounded by the unchanged operational ceiling. Unenrolled alpha accounts remain unchanged. No enrollment was performed outside the in-memory tests.

Enrollment policy revisions cannot roll backward or change hash at the same revision. Existing reservations can finish/replay without a new charge even after suspension; new reservations require the current commercial state. No monthly counter reset, retention cleanup or data deletion is implied by subscription renewal.

## Fulfillment boundary and exact remaining bridge

POST /api/billing/reconcile accepts an empty body only. It cannot accept customer IDs, snapshots or claimed payment results. A server-only registered verifier must be supplied; arbitrary JSON/functions do not qualify. It snapshots binding/policy/watermark before awaiting authorization, checks the exact live merchant/Customer/Subscription/Price/invoice/current period and an explicit fresh risk result, and issues an opaque in-process decision. The adapter contract pins the reviewed Stripe API version. Sandbox objects and test receipts are rejected.


A decision atomically records a versioned effective entitlement with tenant enrollment and both directions of the live binding checked. Stale observations, policy rollback, binding changes and replay conflicts fail closed. A short lease expires into blocked admission when reconciliation is unavailable. The worker never updates Metadata quota counters; only explicit API enrollment changes its compatibility marker. A separate genuine live read/risk bridge and any new persistent access need exact action-time authorization.

## Upload reservation enforcement

Exact batch replay remains first. New reservations read the effective ledger then include entitlement revision/status/policy/expiry and forward/reverse binding checks in the existing batch + account counter + global counter transaction. An explicit free fallback includes an atomic absence check. Concurrent revocation, suspension, binding/merchant/environment changes and free-to-managed races abort without counters or a premature receipt. Downgrades below reserved usage block new uploads, preserving existing data and cumulative counters.

The current operational per-account/global ceilings remain upper bounds. A larger paid promise cannot be activated without separately approved operational changes. The sandbox worker proposal is narrowed to its STRIPETEST/TENANT billing keys and cannot read/write future COMMERCIAL entitlement rows. No IAM policy or AWS resource was applied.

## User-facing and release limits

Sandbox selection and read-only Portal remain explicitly labelled. Verified live control status, when supplied by a genuine future bridge, is distinguished from an unconfigured live Portal; no live Portal transport is implemented. No genuine hosted commercial journey, Stripe charge, webhook delivery, commercial Dynamo transaction or related IAM acceptance is established. Synthetic rendered UI coverage is separate from that commercial acceptance.

Current billing gates remain separate: approved event ingress/security/cost scope, secure scoped credentials, owner-approved pricing/terms/tax/limits/lifecycle, genuine live transport/risk/webhook/binding implementation and real commercial acceptance. Tax registrations must be active before enabling automatic tax. Use [local development](local-development.md) for synthetic billing checks. Original trace/account exports support streaming Save File where available. Standard browser downloads retain their documented memory limits; complete saved-content validation remains unverified.


Deployment preflight must account for Lambda's aggregate 4 KiB environment-variable limit, including existing authentication settings and the sandbox catalog. The policy loader's local parsing bound is not a guarantee that a fully populated AWS environment fits. Measure the exact resolved environment before any change set execution; if it does not fit, a reviewed bundled or external configuration mechanism is required. No policy/configuration was installed, and no template validation against actual account parameters occurred. Source: https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html .

## Deny-only signed risk ledger

The source now verifies the three documented refund/dispute/early-fraud snapshot event types using the official Stripe SDK raw signature verifier, a supplied endpoint secret, strict live own-account endpoint scope and the pinned API version. It stores only a minimal event/hash and an unresolved merchant/environment hold in one transaction. Duplicates are idempotent and conflicting event IDs fail closed. It does not infer a tenant from metadata, does not fetch provider objects and exposes no endpoint or secret loader.

Until a real object-graph resolution and explicit risk-clear/coverage policy exist, an unresolved risk event conservatively blocks every managed paid entitlement in that merchant/environment, not unrelated alpha/free accounts. The hold is checked atomically in active fulfillment and new paid batch reservation, so event arrival cannot race a stale lease into another admission. There is deliberately no clear/delete/automatic resolution operation. No absence of events is treated as proof of risk clearance. This deny-only capture is not a complete lifecycle or risk pipeline and cannot enable live billing by itself. A reviewed operator decision is still required for how resolved disputes, refunds, fraud warnings and delivery/backfill coverage can safely release a hold; do not activate this incomplete path as a commercial offer.
