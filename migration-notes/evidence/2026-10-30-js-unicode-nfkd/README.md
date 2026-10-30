# JavaScript Unicode NFKD verification evidence — 2026-10-30

This package documents the verified shared Unicode 17 NFKD utility capability. It does not claim that the separate Fish favorites consumer draft is compiled or accepted. `artifact-index.json` records every payload with origin, raw/stored SHA-256, and byte sizes. Logs and large fixture JSON files are losslessly gzipped. No mutable snapshot, Node binary, or SDK binary is included.

## Source binding and scope

The immutable source binding is commit `9d6da9bb808a14f48e23cbc96ff45a17dbe5b154`, source-tree SHA-256 `d2eb9798d43a5b2688b5c19fa57174fb17a45acb30aeb515229b46c0ba64c4f0`, 1,497 inputs total (1,487 Git, ten reused SDK), with all hashes verified. The tested delta is limited to `dimabot/src/utils/js_unicode.rs`, `dimabot/tests/js_unicode_nfkd.rs`, and `dimabot/tests/fixtures/js_unicode_nfkd_reference.cjs`.

`snapshot-isolation.json.gz` records that the three unverified Fish draft files were excluded, working drafts were preserved, and only the Cargo/schema module files were restored from the accepted frozen baseline. This is evidence for the shared Unicode capability only.

## Fixtures and run history

Attempt 1 and attempt 2 NFKD fixtures are preserved separately and have identical raw SHA-256 `aad332503d1767eb7fb6e2810af5e0a9b52f97446a082bac9e644eb858c2975e` (46,860 bytes). Each covers 1,112,064 Unicode scalar values in 272 chunks plus 14 mixed UTF-16 cases. The attempt 2 NFC fixture preserves the existing corpus: 1,114,112 code points including surrogate code units and 4,116 mixed cases.

Formatting passed (`1793371244657916413`). The first Node wrapper (`1793371579661256848`) generated and checked the NFKD fixture before failing because it omitted the required NFC fixture SHA pin. The NFKD implementation and fixture were unchanged. Node attempt 2 (`1793371718262175099`) added the expected NFC pin and passed with the same NFKD bytes. The compiler/quality run (`1793371761919072282`) passed ordinary lower/fold, NFC and NFKD tests, exhaustive release NFKD and NFC oracle replays, and scoped/minimal/all-feature strict checks. It completed in 110.574 seconds total / 100.886 seconds build step, with 13,009,149,952 bytes minimum available and 8,171,270,144 bytes peak cache.

Release replay durations (0.37 seconds NFKD and 0.46 seconds NFC) are test times, not benchmark measurements. The package makes no speed, allocation-count, or RSS claim. Final production readback found 18 records unchanged and zero task-owned resources.

`reproduction-tools/` preserves both Node wrappers, both quality scripts, and the validation/readback scripts as inert evidence. They were not executed during documentation work. See [the capability note](../../js-unicode-nfkd.md) for API behavior and migration scope.
