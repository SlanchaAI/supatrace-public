# Management API and personal access tokens

Read what the workspace shows from a script: workspaces, projects, write keys, usage and traces. This first version is read-only.

## Create a personal access token

Open **Settings** in the workspace, name a token and choose when it expires (1 to 365 days, 30 by default). The browser makes the token (`stpat_…`) and sends only its SHA-256, so it is shown once and cannot be recovered.

- **Read-only.** A token can call the `GET` endpoints below. It cannot upload, create or revoke keys, change billing or manage tokens.
- **Account-scoped.** A token sees what the account can open, with the account's current role in each workspace. Removing the account from a workspace removes the token's access to it.
- **Revocable.** Revoke a token in Settings. It stops working at once.
- Up to 20 tokens per account.

## Call the API

```sh
curl -H "Authorization: Bearer $TOKEN" "$ORIGIN/api/v1/projects"
```

The hosted edge replaces the `Authorization` header before it reaches the API, and already forwards `X-Supatrace-Key`. On https://supatrace.dev send the same token there:

```sh
curl -H "X-Supatrace-Key: $TOKEN" https://supatrace.dev/api/v1/projects
```

Errors are JSON of the form `{"error": "code"}`. A missing, expired or revoked token is `401`. A workspace the account cannot open, or keys requested with a viewer role, is `403`. Each token may make 120 requests a minute; `429` carries `Retry-After`.

| Request | Returns |
| --- | --- |
| `GET /api/v1/me` | The account and the token making the request |
| `GET /api/v1/workspaces` | Workspaces the account can open, with its role |
| `GET /api/v1/projects` | Accessible projects, including multiple projects within a workspace |
| `GET /api/v1/keys` | Keys of a workspace environment: id, type, expiry, revoked. Needs a role that may manage keys (owner, admin or developer). Key values are never returned. Up to 100 a page; follow `next` with `after` |
| `GET /api/v1/usage` | Stored bytes, limit and plan state of a workspace |
| `GET /api/v1/logs` | Recorded upload attempts of a workspace environment, newest first. `stream` (`issues` or `accepted`), `route`, `reason`, `from`, `to`, `limit`, `after`. See [Logs](logs.md) |
| `GET /api/v1/traces` | Traces, newest first. `limit`, `offset`, `sort`, `dir`, `q`, `from`, `to` |
| `GET /api/v1/traces/{trace_id}/events` | The events of one trace, one stored batch per page. Follow `next` with `after` |

Workspace endpoints take `workspace` (defaults to the account's own) and, except usage, `environment` (defaults to `default`). A parameter that is not listed for an endpoint is refused with `400`.

## OpenAPI document

`GET /api/v1/openapi.json` serves the OpenAPI 3.1 description. It needs no token. `tests/management-api.test.mjs` calls every operation in it against the handler and checks each response against its schema.

## Not available yet

- Write operations: creating or revoking keys, changing workspaces, billing.
- Token scopes narrower than the whole account, and OAuth apps.
- Rate limits that vary by plan.
- Rendered reference pages for each endpoint. The public guide is https://supatrace.dev/docs/management-api/.

## Secret keys

A secret key (`st_sec_…`, created under **API keys**) is also accepted on `GET /api/v1/traces` and `GET /api/v1/traces/{id}/events`, as a bearer credential or in `X-Supatrace-Key`. It reads only the workspace and environment it belongs to: a `workspace` or `environment` parameter naming another one, and every other `/api/v1` endpoint in the table (usage included, because usage covers every environment), returns `403 key_scope_denied`. `GET /api/v1/openapi.json` needs no credential. Ingest keys (`st_pub_…`) and setup-code keys cannot read.
