# OpenRouter application-attribution retirement handoff

**Status: verified local source retirement.** Source commit `aa8e5079de37933273c106591c1e7bedbec90ce9` binds 1,510 inputs (1,500 Git and ten reused PostHog SDK files) to tree SHA-256 `0e29c964bf60d6427c296b3be75ae42cd9d6d70082fc2a6b9aabb0b6617d6117`. The 368-byte TypeScript module was archived byte-exactly at SHA-256 `0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c`, as archive entry 51; all prior 50 entries/order are unchanged.

## Local constant mapping

The module has one runtime export and no imports: `OPENROUTER_APP_HEADERS` declared `as const`. The assertion affects compile-time typing only. The native `pub const OPENROUTER_APP_HEADERS: &[(&str, &str)]` already existed in `dimabot/src/utils/ai/openrouter/app_attribution.util.rs` and remains re-exported from `utils::openrouter_attribution` behind the existing features. No application/runtime Rust source, Cargo feature, dependency or HTTP client changed.

| Order | Header | Value |
|---:|---|---|
| 1 | `HTTP-Referer` | `https://domdimabot.com` |
| 2 | `X-OpenRouter-Title` | `DomDimaBot` |
| 3 | `X-OpenRouter-Description` | `DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.` |
| 4 | `X-OpenRouter-Categories` | `general-chat, roleplay` |

This is a data-only constant mapping. It does not claim JavaScript object identity, prototype, descriptors, freezing or mutation behavior. Native Fish TTS, Kokoro TTS, variation-provider and semantic-provider code already share the constant. The TypeScript embeddings consumer remains unported; other TypeScript imports were not adopted or cut over. Removing the helper may leave those TypeScript imports unresolved, which the migration checkout explicitly permits. This single local helper has no missing application-specific adapter dependency, but does not complete its consumers or total migration.

## Source readers and preserved oracles

One allowlisted source reader resolves the exact source path from either the live tree or the canonical archive and rejects wrong pins, missing/ambiguous or symlinked files, bad manifests, duplicate/missing/mismatched entries, shadowing and tampered bytes. Actual-source oracle and native replay keep the original logical/virtual paths and hash the archive/resolver bindings. A focused native fallback was added to the existing moderation leaf reader, and the jobs/semantic guards now resolve the archive provenance without weakening pin checks.

The run wrote and checked 19 oracles, passed 18 resolver rejection cases, and compared 19 reports to their accepted outputs. Nine reports were byte-identical; 34 leaf paths changed provenance/hash metadata only. All comparisons report behavior unchanged. The 160 prepared variation benchmark items remain byte-identical (input SHA-256 `07b8192f942ef9c3246720aa75926939260f3e07250d83b7973197ca6ac65d2e`). The source was checked but not timed; no new benchmark or performance claim is made.

RE2 is an existing reproducibility dependency for the affected moderation source readers. The existing Node 24 addon evidence is linked from the [RE2 string handoff](re2-string-handoff.md) and [prerequisite artifact package](evidence/2026-10-30-advanced-moderation-prerequisites/artifacts/re2-node24/independent-readback.json): binary SHA-256 `94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb`, source-manifest SHA-256 `e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664`, build-provenance SHA-256 `4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c`. The addon binary is reused by reference and is not copied into this package.

## Verification and failure history

| Phase | Receipt | Result |
|---|---:|---|
| Formatting | `1793386270045423031` | Passed |
| Node oracle/corpus checks | `1793386585532493945` | Passed |
| Compiler, initial reader pins | `1793386806395824008` | Failed: native decisions reader lacked exact archived Chatter/attribution pins; parent added pins in the existing leaf reader |
| Compiler, final source tree | `1793386956258970693` | Failed after 25 selected tests passed: parent fixture setup omitted three explicit jobs provenance fields outside its loader-pin list |
| Compiler, same final source tree | `1793387023855299505` | Passed the remaining six selected tests and strict phases |

Thus 31 selected native tests passed across the final-source second and third compiler runs; no single successful receipt reports all 31. The standalone formatter receipt ran on preceding tree `b12e61cb68f053e0632eb9033c9807f0b76786d327fa2e4b40232c5a065712a8`; Node and the first compiler attempt used `990fe98ce53641ed19f2f623cf123d7e4f958fb9166aad4de9246d545bb3251a`. The accepted final tree is `0e29c964bf60d6427c296b3be75ae42cd9d6d70082fc2a6b9aabb0b6617d6117`, and its successful compiler phase also passed formatting. Source did not change between those two phases. The Node fixtures were unchanged by the final native-only reader correction. Across the accepted final phases, jobs replay covered all 38 cases with private services, five TTS source replays passed, and formatting, scoped Clippy with warnings denied, minimal all-target check and all-feature all-target Clippy with warnings denied passed. The third compiler phase took 101.029 seconds overall / 88.499 seconds in the compiler step, with 12,771,377,152 bytes minimum available and 8,053,932,032 bytes peak private cache. Limits were 6 CPU, 4 GiB no swap, 256 PIDs, two Cargo jobs, a 5 GiB startup reserve and 4 GiB in-flight floor.

All 18 production records remained unchanged and zero task-owned resources remained. There was no application-runtime or Cargo/lock change, push, deployment or caller cutover. Total migration remains incomplete; the detailed [dated verification note](openrouter-attribution-retirement-2026-10-30.md) and [indexed evidence](evidence/2026-10-30-openrouter-attribution-retirement/README.md) distinguish the phases and limits.
