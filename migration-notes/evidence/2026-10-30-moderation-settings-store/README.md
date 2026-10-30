# Moderation settings store verification evidence

This evidence directory accompanies [`../../moderation-settings-store.md`](../../moderation-settings-store.md). The immutable feature source was commit `23e7916db0a2ed8e0e497e79a16ddb0756704fc4`, source-tree SHA-256 `06fdce358d609287739c40f9fe96b89c3e3133ff026fded611c8c06bd2d1c133`. `source-bindings.json` records 1,464 Git files and ten previously captured `posthog-rs` inputs; `source-final.json.gz` is the complete 1,474-path hash manifest. The ten-file SDK proof is preserved separately, without copying the SDK source tree.

## Reproduction inputs

- `reproduction-tools/settings_store_node5.sh` is the exact final Node oracle runner. It writes and checks the committed source fixture under the fixed channel `keyword-fixture-fca01b6f57a8:settings-store-20261030-😀-é`.
- `reproduction-tools/settings_store_runtime5.sh` is the exact final Rust test and quality runner. It performs normal and serial ignored fixture tests, formatting, feature-scoped Clippy, all-target check, and all-feature strict Clippy.
- `reproduction-tools/validate_variation_jobs.py` is the standard isolated-resource validator used by the runner workflow.
- `moderation-settings-store-reference.json` contains all 22 source-derived cases; SHA-256 `069d08939f4676c2e9e814b1327f584884959444abcc6aae33dde0b39005e3d9`.
- `tested-delta-paths.json` records the six tested feature source paths. The feature source itself is bound by the commit and manifest rather than copied as a second full source snapshot.

The final Node run was `1793360095403551702`; it used Node `v24.22.1`, wrote and checked the same 22-case fixture hash, and completed its runner step in 2.502 seconds. The final capped compiler run was `1793360144874064512`; its compiler step passed in 91.917 seconds and the phase completed in 103.795 seconds. Final formatter receipt `1793360483014850688` records the post-freeze format check. The final compiler limits were 6 CPUs, 4 GiB memory with memory-swap equal to the same cap, 256 PIDs, and two Cargo jobs; private cache peak was 8,338,165,760 bytes and minimum available host memory was 8,777,846,784 bytes. The Rust toolchain image was `sha256:557a94c82b485a14b569120e00867267108c734efe33f10cc31ca0cd5dd1eca9`; the Node image was `sha256:a001f865dc47694124ef59a1f71cdf80e6214f64613f4e5b4d891088f71dca82`.

## Attempt trail

Each `runs/` receipt and log is gzip-compressed. Decompress with `gzip -dc`; `payload-index.json` records both stored and uncompressed sizes and SHA-256 hashes. This preserves terminal whitespace and exact raw bytes.

| Attempt | Node run | Rust run | Result |
|---|---:|---:|---|
| 1 | `1793359321498694713` | `1793359389359555355` | The ordinary and pure fixture tests passed; one cache TTL assertion exposed that a losing SET-NX race preserves the corrupt key TTL, and the default 500 ms Redis response timeout preempted the two-second app deadline. Both fixture/config assumptions were corrected. |
| 2 | `1793359564992521786` | `1793359573645255892` | All 22 source cases and the pure test passed; the response-loss proxy left the client socket open, producing a deadline instead of the expected Redis error. Both proxy socket sides now close. |
| 3 | `1793359692348967922` | `1793359732450464197` | Functional checks passed; strict Clippy reported five `possible_missing_else`/`collapsible_if` findings. Style was corrected without behavior changes. |
| 4 | `1793359851055651397` | `1793359910058882352` | Functional checks passed; strict test Clippy reported one collapsible event-handler conditional. Style was corrected without behavior changes. |
| 5 | `1793360095403551702` | `1793360144874064512` | Final Node source replay and all Rust feature, fixture, and quality checks passed. |

Formatting passes `1793359269014425573`, `1793359494827369660`, `1793359664962336073`, and `1793359806584564143` are retained for the intermediate snapshots. The final frozen snapshot’s formatting check is part of the final runtime runner `1793360144874064512`. An earlier compiler-only pass `1793359321498412836` is included as context. Raw output includes exact passing and failing assertions and Clippy diagnostics.

## Fixture and production readback

`production-before.json` and `production-after-final.json` record the read-only topology comparison. Final summary reports 18 production records unchanged and zero remaining task-owned resources. The user-acknowledged Piper removal remains part of the recorded baseline, not a change from this feature. No Rust deployment or production mutation occurred.
