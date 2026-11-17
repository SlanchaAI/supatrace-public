# Issue contracts

Each file here is the acceptance contract for one backlog issue. It fails on the base commit and
passes only when the issue's change exists. It is not in `npm test`, so CI stays green until the
change lands. The issue's `Proof:` line pins the file's sha256, so editing a contract to make it
pass fails the proof.

Contracts run with no server, browser, Docker or network. Tests that need listening sockets use the loopback harness.

| File | Issue |
|---|---|
| `langfuse-local-source.contract.mjs` | #67 local Langfuse source (`SUPATRACE_LOCAL_LANGFUSE_URL`) |
| `acceptance-j3.contract.mjs` | #68 J3 step from the import receipt |
| `pairing-link.contract.mjs` | #58 one-tap approve link (setup start returns `#agents?code=`) |
| `key-labels.contract.mjs` | #66 J1: API key list shows created time and marks the newest key |
| `supabase-parity-1113.contract.mjs` | #85 Supabase-parity comparison (source-only): scores 21 surfaces, mixed presence/absence probes cover specific wiring and startup behavior; other rows require manual source review. Scores and issue links distinguish source capabilities, unresolved gaps, and withdrawn allegations. See `tests/fixtures/contracts/surfaces.md`. |
