# Moderation Chatter schema verification evidence

This immutable package backs the [2026-10-30 verification note](../../moderation-chatter-schema-2026-10-30.md). `artifact-index.json` inventories all payloads with source origin, raw and stored SHA-256, raw and stored byte counts, and compression encoding. Gzip payloads are lossless.

The package contains the initial failed source map and its 16 overrides, the final source map and all-input binding, the 25-case actual-Mongoose oracle, final production readback, static snapshot metadata, all formatter/Node/compiler-fixture receipts and full logs, and the five inert reproduction/validation scripts. The failed Node attempt remains explicitly represented as a failure. It does not include mutable workspace snapshots, copied source trees, compiler caches or target directories, toolchain binaries, or generated application binaries.

The run artifacts originate in `/root/.local/state/rust-full-migration-20261028-chatter-tt5gnptj/`; the scripts originate in `/tmp/dimabot-full-migration-tools/`. The scripts are evidence references only and do not authorize replay against a historical production run.
