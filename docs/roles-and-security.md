# Roles, environment limits and required two-factor authentication

## Roles

| Role | Stored as | Traces, usage, exports | Keys | Environments, drains | Members, billing, audit log, security |
| --- | --- | --- | --- | --- | --- |
| Owner | account (personal organization) or `owner` member (created organization) | yes | yes | yes | yes |
| Admin | `admin` | yes | yes | yes | no |
| Developer | `developer` | yes | yes | no | no |
| Read-only | `viewer` | yes | no | no | no |

One table, `src/roles.mjs`, maps every signed-in route to the capability it needs. The request handler and the workspace routes both call it; nothing else decides a role. A route that is not in the table belongs to the owner, so a new route is closed to members until someone lists it. `tests/roles.test.mjs` calls every row of the table as every role, and fails when the handler serves a route the table does not know.

Keys issued by a member work only while that member still has a role that may issue keys and the same membership version. Changing a member's role or limit ends the keys they issued.

## Environment limits

An organization can contain multiple [projects](projects.md). Each project has its own environments and keys. A member can be limited to listed environments, on the invitation (`environments: ["dev"]`) or later (`POST /api/workspaces/member` with `environments`, or `null` to lift the limit).

For a limited member:

- trace, event, key and key-approval routes answer only in the listed environments (`environment_unavailable` elsewhere);
- the environment list shows only those environments;
- routes that act on the whole organization (create an environment, drains) are refused, whatever the role;
- organization usage stays readable.

The dashboard sets the environment limit on the invitation; changing it for an existing member is API-only for now.

## Require two-factor authentication

The owner can require two-factor authentication for everyone in an organization: Members page, Security, or `POST /api/orgs/security {organization_id, require_mfa}`.

- It is checked on every request that uses the organization's data, with a session or a personal access token, not only at sign-in. A member without two-factor authentication gets `403 mfa_enrollment_required` on every organization route and is sent to Settings in the dashboard to turn it on. Their own account and personal organization stay open so they can.
- Upload keys keep working. The rule is about people opening the organization, not agents sending traces.
- The owner must have two-factor authentication before turning the rule on, and is held to it too.

**Dependency.** This works only where two-factor authentication is enabled on the deployment: the stack parameter `MfaEnabled` must be `true` (see [sign-in](sign-in.md)). While it is `false`, nobody can enroll, so the rule cannot be turned on (`409 mfa_unavailable`) and a stored rule is not applied. Setting `MfaEnabled` is the operator action; nothing else is needed.

Both changes are recorded in the audit log (`member.role_change`, `member.scope_change`, `settings.require_mfa_changed`).

## Environments

Owners and admins of the whole organization create, rename and delete environments (Settings). Each environment has its own keys and its own traces; quota and billing are shared. The number of environments follows the plan and counts Default ([plan-catalog.md](plan-catalog.md)).

- **Rename** (`POST /api/environments/rename {id, name}`) changes the display name. The id, the keys and the data stay.
- **Delete** (`POST /api/environments/delete {id, confirm}`; `confirm` repeats the id) ends access at once: reads, uploads and keys of that environment are refused, and its keys are revoked. The id is retired and cannot be created again, so old traces cannot reappear under a new environment. After a ten-minute request drain, the existing five-minute erasure worker removes payload versions, trace metadata and keys, then releases stored-data capacity. Failed operations retry; sibling environments and monthly billing usage remain. Recovery backups expire within 35 days. Default cannot be renamed or deleted.

Feature and count limits by plan are enforced on these and the other routes in this document: Developer and Read-only roles and environment limits on a member need Pro, the two-factor rule needs Enterprise, and the seat count follows the plan.
