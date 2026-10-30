# Moderation variation jobs source-oracle handoff

The source oracle is `dimabot/tests/fixtures/moderation_variation_jobs_reference.cjs`. It transpiles the pinned actual `variation_jobs.ts` with TypeScript 5.9.3 and executes the actual variation, normalization, advanced moderation, crypto, and Node RE2 path through the reused `moderation_variations_source.cjs` loader. Mongo models, Dragonfly, time, abort timeout, and `fetch` are scripted; the Muse helper executes against a mock fetch and inert fixture key. No live provider request is made.

The generated reference contains 38 named, ordered source scenarios and has SHA-256 `4bc9a8afee384bd554514eea3cf26ca9ea120c739348818e3a5d6ee7e9587e1b`. The Rust test rejects omissions, duplicate names, stale source/dependency pins, and a wrong reference checksum. It checks source-visible public outcomes and call contracts including model query/update filters, provider request bodies and timeout bounds, schema-defaulted inserts, Redis Lua arguments, cache/usage persistence, credit accounting, and job transitions. This scripted source oracle captures the actual Lua string; only the separate isolated native fixture executes that script against Redis.

## Pinned source and SDK inputs

The output provenance pins the module, reader, loader, imported source dependencies, TypeScript runtime, and Node RE2 files. `prepare_variation_jobs_provenance.py` copied the 24 pinned source/runtime/SDK files into the attempt's read-only provenance tree and wrote `source-provenance-manifest.json`; the accepted independent check rehashed the pins. The reader SHA required by the oracle is `da35f50e960708ad112664c680b30692e8f44e3b35fb3e905e6de9884a97c32a`; the reused loader pin is `a90b6a9bf8e6c9a859c2454c76b0222d99d1c8b6d3e0c930ce4ee1f072a28653`.

The final evidence package preserves every oracle/reference/provenance artifact under `attempt1/`, not only the JSON reference, and links the earlier verified source-freeze chain for `variations.ts`, the loader, and reused Node/RE2 pins. The Rust verification source snapshot is independently bound to the final code commit; the 24 imported oracle provenance files are not a substitute for that complete snapshot binding.

## Native fixture limits and adaptations

The native replay uses task-owned private MongoDB and Redis, native drivers, and the concrete Muse provider with a loopback responder. It covers the entire ordered 38-case source matrix. Targeted tests additionally exercise concurrent requests, quotas and TTL, plan/provider failures, retry, expiry, reservation/claim races, one-job backlog progress, deadline and batch bounds, usage retention, model casts, Redis partial mutation and response loss, unknown BSON/Mixed fields, and application bootstrap. These results support the bounded serialized/BSON boundary in the migration note; they do not imply arbitrary JavaScript object-identity parity.

Three source-fixture adaptations are explicit:

1. Request scripts return `_id: 'fixture-job'` for a lookup by hash. A real Mongo row cannot do that. The fixture independently checks the source hash query, then maps that scripted ID to its real namespaced native lookup ID before comparing public values and updates.
2. The source `process-timeout-before` script fabricates an expired result from a future-deadline query. The native fixture claims just before the corresponding translated logical deadline and advances its explicit clock before owner/cache processing. The expired public outcome is compared; truly overdue claim predicates are separately exercised.
3. Source scripts throw ORM errors with arbitrary English messages. The native fixture injects equivalent failures at the semantic operation and compares generic error categories where driver wording differs, while checking source domain status/messages and failure codes separately.

The logical clock translates January 2026 source dates by one common delta into January 2100, preserving durations and preventing the live TTL monitor from expiring test documents. Redis TTL remains measured by Redis's real clock. The checks establish configured expiry values and application deadline maintenance, not the passage of a real 180-day interval.

The source `variationJobView` can preserve an own `symbolVersion` property with value `undefined`, while the accepted JSON helper boundary omits that property during JSON serialization. One first replay failed on an over-broad own-property assertion; the corrected test adapts only at that documented serialized boundary. Exact own-property identity is not claimed. Other excluded boundaries include arbitrary prototypes/getters, sparse arrays, and unusual BSON-to-Node value identity. The native BSON bridge remains the authority for stored unknown values; the test compiler projection is a narrower comparison representation.

For the private fixture, use a fresh uniquely namespaced database and Redis keyspace, task-owned dependencies, the fixture guard variables described by `moderation-variation-jobs-handoff.md`, and an independent outer cleanup path. The fixtures' own guards do not prove Docker ownership or production isolation. The accepted verification must retain before/after production identity and task-resource readbacks. No production resource was used for the passing phase.


Final readback: `node-1793337869257910513` checked the unchanged 38-case reference against source tree `f4d756d6b406385cc6e32f89f9971c9ce12cc03e907f2d8dee7fdcdfa43dca16`; the reference SHA remained `4bc9a8afee384bd554514eea3cf26ca9ea120c739348818e3a5d6ee7e9587e1b`. The matching native combined runtime/quality phase was `compiler-fixtures-1793337683444735110`. Receipts, gzip-only logs, reference/provenance files, and final production/resource readback are indexed in [the evidence bundle](evidence/2026-10-30-variation-jobs/README.md).
