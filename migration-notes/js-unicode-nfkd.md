# JavaScript-compatible Unicode 17 NFKD capability — 2026-10-30

**Status: verified shared Rust capability.** The implementation adds `normalize_nfkd(&JsString) -> Cow<'_, JsString>` to the existing `js-unicode17` utility. It is source-bound to commit `9d6da9bb808a14f48e23cbc96ff45a17dbe5b154`, tree SHA-256 `d2eb9798d43a5b2688b5c19fa57174fb17a45acb30aeb515229b46c0ba64c4f0`, across 1,497 verified inputs (1,487 Git inputs and ten reused SDK inputs).

The implementation uses the existing `unicode-normalization` crate (0.1.26) for decomposition within assigned Unicode 17 runs. The repository's Unicode 17 assignment ranges fence each run: Unicode 17-unassigned code points and unpaired UTF-16 surrogates are copied as barriers, preventing newer crate tables from normalizing across characters JavaScript Unicode 17 treats as unassigned. ASCII and unchanged values are borrowed; transformed values are returned as owned `JsString`s. The API accepts/returns the repository's UTF-16-preserving string type, so lone surrogates remain representable.

The existing NFC fast paths are unchanged. NFKD reuses the private UTF-16 flush helper while selecting compatibility decomposition. No dependency, Cargo feature, profile, TypeScript retirement, or caller-adoption change is part of this capability.

## Verification

Node v24.22.1 / V8 13.6.233.17-node.58 / ICU 78.3 / Unicode 17.0 was pinned by executable SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`. The NFKD oracle covers all 1,112,064 Unicode scalar values (surrogate code points excluded) in 272 chunks of 4,096 code points, plus 14 mixed UTF-16 cases covering compatibility mappings, canonical ordering, Unicode 17-unassigned barriers, valid surrogate pairs, and lone surrogates. Its SHA-256 is `aad332503d1767eb7fb6e2810af5e0a9b52f97446a082bac9e644eb858c2975e`. Attempt 1 and attempt 2 NFKD fixtures are byte-identical.

The same gate replayed the existing NFC oracle: all 1,114,112 code points, including all 2,048 surrogate code units, and 4,116 mixed contexts passed. NFKD release replay took 0.37 seconds and NFC replay 0.46 seconds; these are test execution times, not benchmark or speed claims. Ordinary checks passed three shared lower/fold tests, two NFC tests, and one NFKD test. Formatting, scoped/minimal/all-feature strict checks, and the remaining quality run passed. The compiler run completed in 110.574 seconds total / 100.886 seconds build step, with 13,009,149,952 bytes minimum available and 8,171,270,144 bytes peak cache, under six CPUs, 4 GiB memory/no swap, two Cargo jobs, and a 256 PID cap.

The first Node wrapper attempt generated and checked its NFKD fixture, then failed because it omitted the required existing NFC fixture pin. It did not indicate an NFKD mismatch. The unchanged fixture was checked again on attempt 2 after adding the required `449e3f81f3b01c0e37a3c5ebdb2e547ca8c0d29a6770356aa18da119a4493ed5` pin; both NFKD fixture bytes matched. The attempt 1 NFC output directory was empty and is recorded in the evidence package.

## Scope and limits

The frozen source explicitly excluded three unverified Fish favorite schema/consumer draft files. It restored only `dimabot/Cargo.toml` and `dimabot/src/schemas/mod.rs` from the frozen baseline while preserving those working drafts. The verified result is the shared Unicode utility capability; it does not verify the Fish consumer, its Mongo/schema policy, or caller integration.

Final readback found all 18 production records unchanged and zero task-owned resources. No deployment or caller adoption occurred. This utility change does not retire TypeScript and does not complete total migration; total migration remains incomplete. Full source bindings, fixtures, run receipts/logs, reproduction scripts, and readback are in the [indexed evidence package](evidence/2026-10-30-js-unicode-nfkd/README.md).
