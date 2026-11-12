# PostgreSQL rig package report — 2026-11-12

Only Part 1 is implemented. Parts 2–6 remain open; no service code was changed, deployed or pushed.
The checkout fast-forwarded to `9d0ccc48` on `rust-v2`, a descendant of required `2e8f6409`.

## Authoring and formats

Use target format 2, `postgres: true` and `{postgres_uri}`. Scenario format 3 adds
`seed.postgres: [SQL, ...]` and `sql: SELECT ...` steps. Capture format 5 records PostgreSQL
catalogue/rows and SQL replies. Target 1, scenarios 1–2 and captures 2–4 remain readable.
PostgreSQL absence versus an observed database fails comparison. Non-SQL captures need no migration.
The PostgreSQL adapter reuses the workspace tokio-postgres dependency; serde_json arbitrary precision
prevents large numeric cells from rounding into a false match. Catalogue SQL compares exactly;
typed timestamp columns normalize PostgreSQL's variable fractional-zero formatting at ms precision.

Each side has a fresh database, recreated between scenarios and dropped on success, errors and
interrupts. Shared-process PostgreSQL targets are refused. GC recovers databases after a dead process.
The first analytics recording exposed a transient startup/reset/cleanup failure; its orphan was
recovered with rig GC. Lifecycle tests subsequently exercised success, SQL errors and SIGINT with
no abandoned databases. Full database recreation replaces the earlier schema-only reset.

## Analytics recording and verification

Access and routes passed the default two-reference stability recording. Ingestion required explicit
`record --once`: the reference's 10-second/minute/hour bucket boundaries differ across recording
runs under the existing run-relative clock normalization. No allowances were added to hide this.
All three captures are committed. Candidate verification reports differences below; verdict belongs
to the lead. Step indices are zero-based; PostgreSQL paths refer to final state after the last step.

### access (11 differences)

| Path | Difference |
|---|---|
| `steps[0].headers.etag` | header missing in candidate |
| `steps[1].headers.etag` | header missing in candidate |
| `steps[2].headers.etag` | header missing in candidate |
| `steps[3].headers.etag` | header missing in candidate |
| `steps[4].headers.etag` | header missing in candidate |
| `steps[5].headers.etag` | header missing in candidate |
| `steps[6].headers.etag` | header missing in candidate |
| `steps[7].headers.etag` | header missing in candidate |
| `steps[8].headers.etag` | header missing in candidate |
| `steps[9].headers.etag` | header missing in candidate |
| `steps[10].headers.etag` | header missing in candidate |

### ingestion (18 differences)

| Path | Difference |
|---|---|
| `postgres["public.analytics_metrics"].rows[0].at` | run-relative times differ by 3.2s (tolerance 2.0s) |
| `postgres["public.analytics_metrics"].rows[1].at` | run-relative times differ by -6.8s (tolerance 2.0s) |
| `postgres["public.analytics_metrics"].rows[2].at` | run-relative times differ by -6.8s (tolerance 2.0s) |
| `postgres["public.analytics_metrics_20261112"].rows[0].at` | run-relative times differ by 3.2s (tolerance 2.0s) |
| `postgres["public.analytics_metrics_20261112"].rows[1].at` | run-relative times differ by -6.8s (tolerance 2.0s) |
| `postgres["public.analytics_metrics_20261112"].rows[2].at` | run-relative times differ by -6.8s (tolerance 2.0s) |
| `steps[2].headers.etag` | header missing in candidate |
| `steps[2].body.lastAt` | run-relative times differ by 3.2s (tolerance 2.0s) |
| `steps[2].body.timeline[0].at` | run-relative times differ by -6.8s (tolerance 2.0s) |
| `steps[2].body.groups[0].lastAt` | run-relative times differ by 3.2s (tolerance 2.0s) |
| `steps[3].headers.etag` | header missing in candidate |
| `steps[4].headers.etag` | header missing in candidate |
| `steps[5].headers.etag` | header missing in candidate |
| `steps[8].headers.etag` | header missing in candidate |
| `steps[8].body.lastAt` | run-relative times differ by 3.2s (tolerance 2.0s) |
| `steps[8].body.timeline[0].at` | run-relative times differ by -6.8s (tolerance 2.0s) |
| `steps[8].body.groups[0].lastAt` | run-relative times differ by 3.2s (tolerance 2.0s) |
| `steps[12].headers.etag` | header missing in candidate |

### routes (33 differences)

| Path | Difference |
|---|---|
| `steps[0].headers.etag` | header missing in candidate |
| `steps[1].headers.etag` | header missing in candidate |
| `steps[2].headers.etag` | header missing in candidate |
| `steps[3].headers.etag` | header missing in candidate |
| `steps[4].headers.etag` | header missing in candidate |
| `steps[5].headers.etag` | header missing in candidate |
| `steps[6].headers.etag` | header missing in candidate |
| `steps[7].headers.etag` | header missing in candidate |
| `steps[8].headers.etag` | header missing in candidate |
| `steps[9].headers.etag` | header missing in candidate |
| `steps[10].headers.etag` | header missing in candidate |
| `steps[11].headers.etag` | header missing in candidate |
| `steps[12].headers.etag` | header missing in candidate |
| `steps[13].headers.etag` | header missing in candidate |
| `steps[14].headers.etag` | header missing in candidate |
| `steps[15].headers.etag` | header missing in candidate |
| `steps[16].headers.etag` | header missing in candidate |
| `steps[17].headers.etag` | header missing in candidate |
| `steps[18].headers.etag` | header missing in candidate |
| `steps[19].headers.etag` | header missing in candidate |
| `steps[20].headers.etag` | header missing in candidate |
| `steps[21].headers.etag` | header missing in candidate |
| `steps[22].headers.etag` | header missing in candidate |
| `steps[23].headers.etag` | header missing in candidate |
| `steps[24].headers.etag` | header missing in candidate |
| `steps[25].headers.etag` | header missing in candidate |
| `steps[26].headers.etag` | header missing in candidate |
| `steps[27].headers.etag` | header missing in candidate |
| `steps[28].headers.etag` | header missing in candidate |
| `steps[29].headers.etag` | header missing in candidate |
| `steps[30].headers.etag` | header missing in candidate |
| `steps[31].headers.etag` | header missing in candidate |
| `steps[32].headers.etag` | header missing in candidate |

Non-failing notes: [{"path": "steps[9].body.channelNames", "what": "object key order differs", "reference": "2, 3, allowed", "candidate": "allowed, 3, 2"}]

## Scope and remaining work

The analytics scenarios access.json, ingestion.json and routes.json only changed their descriptions
to describe rig-owned PostgreSQL. No scenarios from other packages changed. The dimadb and hoststats
targets now launch their references from the installed, read-only `/home/dom/Projects/saas` checkout.
No captures outside analytics were changed.

Part 2: the underlying run/step clock drift remains unresolved. A loaded-machine pass alone does
not establish a fix. Part 3: cursor-following is not implemented; the dimadb scan scenario still
intermittently reports page-boundary differences. Part 4: startup deduplication and startup-call
capture are not implemented; capture sizes have no before/after reduction. Part 5: Qdrant contents
remain unobserved. Part 6: raw WebSocket and SSE steps remain unavailable.

SQL observation excludes roles, grants, triggers, functions, user-defined type definitions and sequence counters. Timestamp
comparison uses the rig's millisecond precision/tolerances; arbitrary-precision SQL numeric values
are exact (numeric tolerance allowances do not apply). Integer identity values remain exact;
generated UUIDs are mapped consistently with SQL replies and other observations.

The PostgreSQL integration self-test seeds changed rows, missing rows, changed column types, missing
indexes and a decimal differing only beyond f64 precision. Every defect must produce its named
PostgreSQL path. It also checks generated UUID consistency, SQL readback, SQL-error and SIGINT cleanup.

## Final validation

- `tools/check dima-rig`: passed (format, clippy with warnings denied, 109 tests, no skips).
- Final PostgreSQL integration test passed, including all five defects and cleanup paths.
- Candidate verification: dimadb 22/22, hoststats 2/2, dimafx-server 8/8 matched.
- Analytics: all three compared and differed, with all 62 differences enumerated above.
- `check dimabot-api`: 3 checked; `check dimabot-bot`: 1 checked.
- `check dimabot-cron` refuses because that target has no committed scenarios.
- The earlier dimadb scan run differed at `steps[7].body.data.cursor` and missing keys at
  `steps[8].body.data.keys[0..3]`; the latest run matched. No scan fix is claimed.
- `git diff --check` passed. The PostgreSQL integration test checked that no completed rig
  process retained a database. Failed-test scratch data was removed. Successful commands logged
  their store/process cleanup.
- Final `dima-rig gc`: `dropped 0 database(s)` (no abandoned resources found).
- Final gate tail: `Doc-tests dima_rig`; `running 0 tests`;
  `test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s`.

Open decisions for the lead: adjudicate the analytics ETags and choose the correct normalization
for aggregate bucket timestamps. No service changes or ignore allowances were made to force a pass.
