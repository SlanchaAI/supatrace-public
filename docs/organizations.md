# Organizations

An organization owns its members, plan, billing, usage, keys, environments and traces. An account can belong to several organizations and switches between them with the **Organization** selector at the top of the dashboard rail.

## Two kinds

| | Personal organization | Created organization |
| --- | --- | --- |
| ID | The account ID (`github-…`, `google-…`, …) | `org-` and 32 hexadecimal characters |
| Owner | The account itself | A member with the `owner` role |
| Exists | For every account, with nothing written | After `POST /api/orgs` |
| Transfer ownership | No | Yes, to a current member; the previous owner becomes an admin |
| Leave | No | Members yes; the owner must transfer first |
| Limit | One | Highest actively owned plan: Free 1 / Base 3 / Pro 5 / Enterprise 10 |

## Migration

There is no migration step and no data movement. Before this change every account already had one partition (`TENANT#<account id>`) holding its traces, keys, quota, plan and, when sharing was on, its members. That partition is the account's personal organization. `GET /api/orgs` reads it; it writes nothing. The test `migration: every existing account-owned workspace is already a personal organization` compares every stored item before and after.

A created organization is one more partition of the same shape, keyed by its `org-` ID. It is not a second tenancy model: the same handlers, quota counters, plan table, key model and audit log run against it. Its ID is random and has no sign-in provider, so nobody can sign in as an organization.

## What each organization has of its own

- A default project (ID derived from the organization ID) and additional isolated projects: Free 2 / Base 3 / Pro 10 / Enterprise 20 total. Environments are per project; the active-key allowance is shared by the organization.
- Traces and stored bytes. Nothing is shared between organizations.
- Plan, monthly allowance and usage counters, read by `GET /api/usage?workspace=<org id>`.
- Billing. The billing endpoints accept `?workspace=<org id>` from that organization's owner and from nobody else. Checkout and the portal remain whatever the stack has configured (sandbox on trunk).
- Members and invitations, on the Members page.
- An audit log, including `org.create`, `org.rename`, `org.transfer_ownership` and `member.leave`.

A new organization starts on the Free plan. The service allows 1,000 created organizations in total; they do not use the alpha account cap.

## API

All routes need a signed-in browser session. Personal access tokens cannot call them.

- `GET /api/orgs` → `{organizations: [{id, name, role, personal, shared, project_id}], limit}`
- `POST /api/orgs` `{name}` → the new organization
- `POST /api/orgs/rename` `{organization_id, name}` (owner). Naming a personal organization for the first time is the existing enable-sharing write.
- `POST /api/orgs/transfer` `{organization_id, user_id, version}` (owner of a created organization; `version` is the member's version from the member list)
- `POST /api/orgs/leave` `{organization_id}` (a member of a created organization)

## Compatibility

Nothing was renamed. `?workspace=<id>` selects the organization on every existing route, `GET /api/workspaces` and `GET /api/projects` list created organizations beside the personal one, and `/api/v1` is unchanged. Import jobs remain limited to the personal organization.

## Related controls

Projects have isolated keys, environments and traces while sharing organization billing and quotas; see [Projects](projects.md). Account closure removes the personal organization and requires transferring or deleting owned organizations first. Project, organization and account deletion queue physical erasure through the scheduled worker; see [Retention](retention.md).

## Deleting an organization

The owner of a created organization deletes it from Members (`POST /api/orgs/delete {organization_id, confirm}`; `confirm` repeats the organization's name). It takes effect at once and cannot be undone:

- nobody can open it again, the owner included: every route answers `workspace_unavailable`;
- its keys stop uploading, and its SCIM token and SSO sign-in stop;
- the email domains it had verified for SSO are released;
- the owner's count of created organizations goes down by one;
- an audit event `org.delete` is written.

It is refused for a personal organization, and for an organization with any billing state (`billing_bound_organization`): a Stripe customer (created the first time Checkout is started, whether or not anything was paid), commercial enrolment, or a binding from the older billing sandbox. A Stripe customer can hold a subscription or an open Checkout that is paid later, and this request cannot wind that down; such an organization is closed by an operator after its billing is closed.

Also on deletion: every member's and the owner's joined-workspace slot and the service-wide organization count are released, invitations to the organization stop working, and no Stripe customer can be attached to it afterwards. Stored traces and rows are not erased synchronously by the request; they are unreachable immediately. The scheduled worker physically erases payload versions and metadata after a ten-minute in-flight grace period, retrying bounded work as needed. Recovery backups expire within 35 days; see [Retention](retention.md).
