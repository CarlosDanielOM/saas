# Receipt parser benchmark baseline

This verified baseline preserves four native time regressions and two gains. It is not a performance acceptance or total Rust migration completion. The [comparison](artifacts/initial-benchmark-comparison.json) retains every trial and range; the [summary](verification-summary.json) records source, runs and limits. Both runtimes validate 192 source wires over six prepared pools before timing, with matching warmups and seven trials. The scope is parsing, ordered wire encoding and a UTF-8 byte checksum; no database, queue, I/O, CPU, RSS or production-latency gain is claimed.

The [source binding](source-binding.json) maps 1,275 frozen inputs to commit 0389561e6004d3a8f7bc10ca73b3bc49a9016e5e and ten unchanged SDK references. The [earlier lint binding](pre-lint-source-binding.json) retains the benchmark file before its constant-assert lint correction; business logic, prepared inputs and source wires did not change. Raw run receipts/logs, including the lint failure, are preserved. Compressed files retain raw hashes and sizes.

The native stage diagnostic uses one ASCII prepared input and the exact release rlib hash/fingerprint. Twenty named lookups took roughly 57 microseconds per pass versus roughly one microsecond for validation/indexing. These are separate diagnostic stages, not additive production latency or a TypeScript comparison. Source and read-only compile commands are retained; the regenerable executable is excluded with its hash. A lookup optimization is separate ongoing work.

Readback confirms 19 unchanged production records and no task-owned containers, networks or volumes. No TypeScript source retirement, application adoption, deployment or push occurred.
