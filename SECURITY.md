# Security policy

Report suspected vulnerabilities to **security@supatrace.dev**. Do not open a public issue for a vulnerability or include secrets in a report.

Include affected versions or commit IDs, reproduction steps with synthetic data, the security impact, and a way to contact you. Send the minimum information needed to reproduce the problem. Do not send real trace payloads, access keys, passwords, or customer data.

Slancha, Inc. aims to acknowledge reports within five business days and provide an initial assessment within ten business days. These are targets, not guarantees. Updates depend on severity and a reproducible report. Coordinate disclosure with the maintainers while a fix is assessed.

The project is in alpha. Security fixes target the current main branch; older revisions have no promised support window. Source changes may precede deployment to the hosted service. A local development server uses synthetic identity and in-memory storage and must remain on loopback.

Trace content can contain secrets. Review payloads before sending them. Optional redacted-copy previews mask selected fields and exact text; they do not guarantee anonymity. See [roles and security](docs/roles-and-security.md) for the data and access boundaries.
