# Moderation semantic verification evidence

Final code commit: `1375d89066b3a135268584fb9f6ac5beadd22a3b`. Frozen source tree SHA-256: `181f1e43ed91244e637428d10be65f34e709bef74f46486d5ef5a981cb72c282` (1421 Git inputs and 10 reused SDK inputs).
The final replay visited all 1071 pure and 65 evaluator records; fixture-4 SHA-256 is `8980dda8ebd881b38fe85da52bf4ac92a5771f510bc768290099171e1260dfc8`. It reports 3 explicit pure boundary records and 10 evaluator seam adaptations; these are not unrestricted JavaScript parity.

All four oracle JSON artifacts are retained as gzip files with raw and stored hashes in `artifacts/reference-hashes.json`.

## Verification

Accepted final-source runs: `node-1793342383176037556, compiler-1793342466130881764`. The compiler phase took 138.56 s (149.384 s total), minimum available memory was 8993722368 bytes and peak cache was 7639011328 bytes.
All scoped, minimal, Mongo/Redis and all-feature strict checks passed. The run also passed seven semantic ordinary tests, eight spam unit tests, and 1,636 spam source regression records.
Accepted exact-source and strict-check runs are listed in `verification-summary.json`; all earlier attempts in the retained numeric interval remain indexed, including failures.
The feature uses ordinary JSON/native adapters with the declared spam category enum. Source-only JavaScript shapes and other adapters remain identified in the migration note.
No benchmark was required or run for this bounded helper. No performance claim is made.

Production readback: unchanged=True across 18 records; task-owned resources remaining={'containers': [], 'networks': [], 'volumes': []}.
Caller adoption, TypeScript retirement, deployment, and push are separate and are not authorized or implied by this evidence.

See [the migration note](../../moderation-semantic.md), [native handoff](../../moderation-semantic-native-handoff.md), and [oracle handoff](../../moderation-semantic-oracle-handoff.md).
