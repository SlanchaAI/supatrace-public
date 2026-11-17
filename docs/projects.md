# Projects

A project holds isolated traces, keys and environments. Projects inside an organization share its membership, plan, monthly spans, stored bytes and active-key allowance.

Settings → Projects lists accessible projects. Owners and unrestricted admins can create, rename and delete additional projects. The Project selector switches the selected organization to a project and its Default environment. Operations that would navigate are refused while another operation is busy.

| Action | Route |
| --- | --- |
| List accessible projects | `GET /api/projects` |
| Create inside selected organization | `POST /api/projects?workspace=<id>` with `{name}` |
| Rename default or additional project | `POST /api/projects/rename?workspace=<id>` with `{id,name}` |
| Delete additional project | `POST /api/projects/delete?workspace=<id>` with `{id,confirm}`; confirm repeats id |
| Open | `/app/?workspace=<id>&project=<project id>&environment=default` |

Approved project limits are Free 2, Base 3, Pro 10 and Enterprise 20. The server enforces admission transactionally, including concurrent requests. Downgrading prevents new projects over the lower limit; existing projects remain readable. An additional project does not create an organization or a second subscription.

Each project's environments may use the same IDs without sharing traces or keys. Keys are bound to both project and environment. Ingest logs and pagination cursors use that same scope. Legacy project IDs and data retain their existing namespace. Account and organization erasure inventories every project's payloads, including retired environments.

Deleting an additional project ends access immediately and frees its project slot. The existing five-minute erasure worker removes all payload versions, traces and keys after a ten-minute request drain. Failed storage operations retry; storage capacity is released exactly once, while monthly accepted-span billing history remains. The project ID stays retired. Default cannot be deleted separately. Recovery backups expire within 35 days. Account closure inventories retired projects too.
