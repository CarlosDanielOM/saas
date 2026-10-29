# TTS utility retirement evidence — 2026-10-29

Source commit `797479aa92cc6965ec3979cadcfe3dca1fbcf989` retires the two byte-exact expressive-tag and Kokoro snapshots, exposes the existing named native tag groups, and updates fixture readers. The [migration note](../../tts-utility-retirement-2026-10-29.md) maps the local behavior and remaining application obligations. No release or push was performed.

- [Verification summary](verification-summary.json): 127 ordinary Rust tests and nine explicit fixture replays passed. Formatting, standalone TTS and all-features all-target checks/strict Clippy, and the no-default-features check passed.
- [Source binding](source-binding.json): all 17 retained files changed by the implementation commit match the validated snapshot. The two live TypeScript paths are absent. All 19 archive hashes match and the original 17 entries are unchanged.
- [Node receipt](node-1793243808422442823-receipt.json) and [compiler receipt](compiler-1793244158042369061-receipt.json): both bind source tree `ad8bf05c0fc6f95b324de6f63e859d6cc5d008a5ef17d15758a9f2ab79aafb2e`. The formatter applied no changes.
- [Compressed fixture inventory](compressed-fixtures.json): twelve JSON artifacts include the source replays, nine provenance reports and eight exact semantic comparisons with prior fixtures. Only private artifact-directory strings are normalized by the recorded comparison script. Expected fixture bytes stayed unchanged during Rust replay.
- [Compressed log inventory](compressed-logs.json): exact uncompressed hashes and lengths for the three logs. `gzip -dc` recovers each log or fixture; its decompressed bytes are independently hashed.
- [Cleanup readback](cleanup.json): all 19 production container records match the user-acknowledged API baseline, fingerprint `50903c6a12f924a8fa842db591bb68472fe98c522309d790a03743714add3536`. No task-owned containers, networks or volumes remain. The private compiler cache is retained for ongoing migration.

Node oracle execution took 19.508 seconds (20.837 seconds including setup/cleanup). Compiler execution took 223.198 seconds (233.124 seconds total). These are validation durations, not runtime benchmarks. Compiler limits were six CPUs, 4 GiB memory with no swap, 256 PIDs and two Cargo jobs. Peak private cache was 7,958,134,784 bytes; minimum available host memory was 8,967,917,568 bytes. Exact commands and isolation policy are preserved under `recorded-verifier/`.

The benchmark script ran only to verify archive-reader tooling. Its fresh Node timings under `fixtures/benchmark-tooling-smoke/` are not a new paired performance result. The nine-workload input remains `95bbc229a92de5f1b8d12c36e69ab2af3ed06cee160ec31dfe1d24c812a6b195`. Earlier paired results and three remaining regressions stay in the [expressive utility evidence](../2026-10-29-expressive-tts/README.md).

Provider source fixtures use controlled transport/filesystem/process boundaries; ordinary native provider tests exercise disposable loopback and CLI fixtures. No real provider or Twitch request was made. The distinct unchanged Fish SDK replay and Mongo persistence fixture were not rerun in this source-retirement wave. Existing accepted adapter evidence is linked from the migration note.

This pack proves the bounded utility retirement. Application callers, pet runtime, queues, billing and the wider migration remain open. The separately captured accepted `pet.talk` source delta remains an open obligation beyond the frozen 806-file baseline. The [SHA-256 inventory](sha256.json) covers every file in this pack except itself.
