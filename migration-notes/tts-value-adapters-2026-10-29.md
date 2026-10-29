# TTS value adapters — 2026-10-29

## Scope and status

This follow-up adds public JSON-value adapters for expressive-tag normalization and Kokoro voice resolution in `dimabot/src/utils/tts/mod.rs`. The existing serde and string APIs remain compatible. The settings path already consumed ordered lossless `JsonValue`; it now reuses the shared normalization policy directly, preserves source-ordered JSON output, and uses the shared Kokoro voice resolver without an intermediate map.

The normalizer borrows inline and wrapping references once per call, matching the TypeScript configuration lookup order. Each tag uses the existing generic nullish-before-boolean policy. The source-selected test calls the public production APIs directly; it no longer relies on a test-only configuration projection or manual voice handling. Ordinary JSON data is supported; executable JavaScript getters, prototypes, and inherited hooks are outside this value adapter's contract.

The source oracle added 301 normalization cases to the prior expressive TTS source coverage and passed all 1,932 cases: 1,229 filter, 185 reinforcement, 314 normalization, and 204 voice cases. The expanded normalization corpus contains four cases for each of 75 tags, plus unknown/lone-key and duplicate-key coverage. It checks malformed string masks, nullish legacy `longPause`, explicit `false`, root primitives, and a Kelvin-sign voice ID (`af_Kore`) resolving to `af_kore`.

## Compatibility and remaining boundary

The native normalizer returns `BTreeMap<String, bool>` while the source contract is a closed 75-tag union and a complete boolean record. The catalog and string map carry the runtime values, but exact exported type/alias parity still needs a source/export audit before any TypeScript retirement. Both TypeScript utility modules remain import-free and active; no TypeScript source count changed, and the 17-file archive is unchanged. Native application caller adoption is separate from these local adapters.

The [typed expressive-tag follow-up](tts-tag-types-2026-10-29.md) adds the closed native tag and fixed-size settings record, including source-catalog ordering for typed JSON serialization. It closes the local type/record/wire/runtime-metadata gap described above; the broader source-retirement audit and application caller inventory remain open.

The native settings and persistence implementation was already present. This change closes the value-conversion gap in that path, not application bootstrap or module-layout selection. Queue behavior, preview, billing/usage, emote behavior, routes, and broader application wiring remain open. No whole-migration completion or deployment claim follows from this slice.

## Verification state

The capped formatter receipt `1793238951378442405` passed and applied formatting to two files. Node source oracle `1793239069194106370` passed its source write/check and prior settings/credit fixture provenance checks; source hash `4cc5a9dac720136211179a3835a64b5b9f7e10308d9f8a75cec0567e8cdcfc19`; script duration 2.502 seconds and total duration 3.789 seconds. Compiler candidate `1793239113115650059` passed in 135.859 seconds (144.161 seconds total) against the same source hash. It reported 75 ordinary test executions: 56 library, seven settings normalization, one schema, five expressive-lossless, one JavaScript-string, two credit, and three TTS utility executions; plus four explicit fixture executions (expressive, channel-settings pure, schema metadata, credit). The 1,932 source cases and the prior 308 pure settings, 11 schema metadata, and 276 credit cases were replayed fresh. The existing JavaScript goldens were source-hash/provenance checked and not regenerated. Provenance covered 12 and 10 entries in two fixture files; these are 22 entries, not 22 unique fixtures.

Final quality checks passed: strict formatting, TTS utilities all-target check and Clippy, channel-tts-settings check and Clippy, all-features check and Clippy, and no-default-features check. The task stayed within six CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs; peak build cache was 7,596,826,624 bytes and minimum available memory was 10,362,929,152 bytes. Production was unchanged. No feature/runtime profile, manifest, lockfile, or dependency changed. The implementation was committed as `14c8d171a7542e3327ede9e0aee5146514e76392`.

The acceptance reused existing settings and credit JavaScript goldens after source-hash provenance checks; it did not regenerate them. No Mongo transport/restart or operations test was run or needed because the write plan, repository, and DB adapters did not change. No provider-operation test was run or needed because provider HTTP code did not change. Pure behavior and schema metadata checks remained in scope because the shared normalization policy changed. No deployment, provider/Twitch call, or production-resource test was performed. The [cleanup receipt](evidence/2026-10-29-tts-value-adapters/cleanup.json) confirms all 19 inspected production records were unchanged and zero task-owned containers, networks, or volumes remain. Artifact hashes are listed in [sha256.json](evidence/2026-10-29-tts-value-adapters/sha256.json).

No comparative benchmark is part of this follow-up: the value adapters and cached configuration view are thin, while the filter/reinforcement algorithms and benchmark harness are unchanged. Preserve the three final expressive-TTS regressions and five initial regressions in [the preceding note](expressive-tts-2026-10-29.md); those measurements belong to their recorded sources and workloads and are not new performance evidence for these adapters.

## Evidence

See the companion [evidence index](evidence/2026-10-29-tts-value-adapters/README.md) for receipts, fixtures, cleanup evidence, and artifact hashes.
