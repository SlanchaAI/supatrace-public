# Explicit upload recovery (ACC-02)

The manual uploader now distinguishes known server responses instead of recommending the same retry for every failure. This corrects the contradiction between the setup guide's first-upload paragraph and its capacity/key recovery instructions. It changes no quota, reservation, retention, plan, server endpoint or automatic retry behavior.

`upload_pending_result(...)` returns only an accepted flag, a fixed recovery category and an optional bounded integer Retry-After value. The existing `upload_pending(...)` remains a boolean interface. Automated private imports and Claude hook uploads keep their existing stricter attempt journals and reconciliation fences; their boolean calls do not start reading error-response bodies outside their bounded transport wrapper.

| Verified response | Manual action described |
|---|---|
| 429 `rate_limit` | Retain the exact file; wait before an explicit retry. Show an integer retry window only when valid and bounded. |
| 429 `storage_capacity` | Inspect Usage; repeated attempts do not add capacity. |
| 429 `monthly_span_allowance_exceeded` | The plan's monthly span allowance is used up. The body names the plan, limit, used count, `resets_at` and `upgrade_url`. Wait for the reset; retries before then do not add allowance. Paid plans are not available yet. |
| 429 `spend_cap_reached` | The plan has metered overage but the spend cap is on, so uploads stop at the included spans. The body names `resets_at` and `cost_control_url`. The workspace owner can turn the cap off under Billing, or wait for the reset. |
| 429 `stored_bytes_allowance_exceeded` | The plan's stored-data allowance is used up. It does not reset monthly. Check Usage. Paid plans are not available yet. |
| 429 `storage_capacity_or_unknown_tenant` | Review capacity **or account state**, rather than asserting that the user's quota is definitely full. |
| 401 missing/invalid write key | Check the approved connection and key state before another attempt. No automatic pairing or new key. |
| 403 unavailable project | Check the project-bound configuration. No project or origin substitution. |
| 403 commercial upload block | Review account state. Do not promise that payment or an upgrade resolves it. |
| 409 idempotency conflict | Preserve the unchanged original and reconcile identity/content. Never change its ID to force a retry. |
| Unknown/mismatched status/code, malformed/oversized/duplicate-key response, redirect, 5xx, transport failure or wrong ACK | Outcome is unconfirmed. Preserve the local copy and verify batch/hash/project before another explicit attempt. |
| Matching ACK but failed local cleanup | Say the server acknowledged the exact batch but local cleanup failed. Keep the file and reconcile before cleanup or another attempt. |

A rejection is **not proof of no server-side data or quota use**. In the current API, a storage/account-state error can occur after reservation and object storage. The messages explicitly retain this uncertainty. Account quota includes accepted and pending reservations, is cumulative, does not reset monthly, and has no automatic cleanup. No retention/reclamation policy is invented.

Responses are read once with an 8,193-byte sentinel bound; bodies over 8,192 bytes are not accepted. Only allowlisted status/code combinations become recovery categories. Raw response bodies, headers, exception strings, request URLs, tokens and local paths are not printed by these outcome messages. Unknown Retry-After formats are omitted rather than echoed. The uploader makes one transport attempt, refuses redirects and removes a pending file only after the exact successful batch ID/hash/project ACK; an uncertain response never removes it.

Source tests cover returned responses and urllib HTTPError, error/status mismatch, malformed/oversized/non-object/duplicate JSON, bounded retry headers, no extra attempts, unchanged pending bytes, exact ACK/cleanup, sanitized CLI output and compatibility with both automated callers. This is local source acceptance, not a hosted quota test. ACC-02 remains open for the original dashboard/API/uploader/plan-transition acceptance, retention/reclamation and commercial policy, and applicable hosted evidence.
