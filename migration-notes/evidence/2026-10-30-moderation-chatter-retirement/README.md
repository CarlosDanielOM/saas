# Moderation chatter schema retirement evidence

This package records the post-retirement source-resolution, semantic comparison and selected native verification epoch for commit `a2a0b3ab9d5398fee8ee9551a34fa4e7d6022f02`. `source-bindings-committed.json` binds 1,507 inputs (1,497 Git plus ten reused SDK) to tree SHA-256 `6d3e0f96d8cab8e6b261462c6644573a453f679d4ac79daf79a43169cc804d3c`; all input hashes were independently verified. The Chatter source is SHA-256 `71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e`. The archive adds it as entry 50; the previous 49 manifest entries are unchanged. Shared source pin count moved 17→18 with the previous 17 in their original order.

The package includes eight regenerated oracle/reference corpora, the source report and prepared Spam benchmark input, source maps/bindings, semantic comparison and diff inventory, cache maintenance, production readback, and the complete DeepSeek final thread response. Eight corpora are behavior-identical; only enumerated source path, archive provenance, resolver and script hash metadata differs. All 37 source Spam claims compared unchanged. The 160 prepared benchmark inputs are byte-identical at SHA-256 `9f54153d86b2f91417733343c744d4f8e17d0a1a6bf744df1779ea3bcad6086b`; the Node check validated them without timing.

| Phase | Receipt | Result |
|---|---:|---|
| Formatting | `1793382552323881451` | Passed |
| Node | `1793382649824905659` | Passed |
| Capped compiler-fixtures | `1793382865007741746` | Passed 37 selected checks |

The compiler checks included all seven Chatter tests, 25 actual-Mongoose cases, real-Mongo CRUD and atomic first-seen behavior, 1,636 Spam pure records, six affected schema oracle/replay suites, ordinary regressions, formatting, scoped Clippy, minimal and all-feature strict checks. The native full asynchronous Spam claim suite was not rerun. The compiler ran 98.536 seconds overall / 85.336 seconds for its compiler step, with 12,663,513,088 bytes minimum available and 8,550,195,200 bytes peak private cache, under 6 CPU, 4 GiB no-swap, 256 PID and two Cargo job limits. Production readback found 18 containers unchanged and zero task-owned resources.

The package contains no performance timing. Its TypeScript source consumers were not migrated or cut over; a remaining `spam.ts` model import may be broken after the permitted source deletion. The broad Spam feature is still incomplete.

`index.json` inventories each stored payload's absolute origin, raw/stored SHA-256, byte sizes, and encoding. Large JSON and all logs/receipts are losslessly gzip-compressed. The raw DeepSeek final-thread JSON and exact inert reproduction scripts are retained. No binary, mutable source snapshot or cache is included. This index is for evidence payloads; it is not a replacement for the recorded source binding.
