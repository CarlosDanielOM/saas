# OpenRouter app-attribution retirement — 2026-10-30

## Local feature and archive

`src/utils/ai/openrouter/app_attribution.util.ts` was archived byte-exactly at its original 368 bytes/SHA-256 `0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c`. The final source epoch is commit `aa8e5079de37933273c106591c1e7bedbec90ce9`, tree SHA-256 `0e29c964bf60d6427c296b3be75ae42cd9d6d70082fc2a6b9aabb0b6617d6117`, with all 1,510 inputs independently bound (1,500 Git plus ten reused PostHog SDK files). Archive count grew 50→51; all earlier entries and ordering are unchanged.

The TypeScript module has one runtime constant, no imports, and an `as const` assertion that supplies a literal type at compile time. Its ordered four pairs map to the existing native string-slice constant with no new feature, dependency, HTTP client or application runtime code. The helper is a complete local data mapping without a missing application adapter. It does not reproduce JavaScript object mutability, prototype, identity or property descriptors.

Native Fish TTS, Kokoro TTS, moderation variation-provider and moderation semantic-provider already consume the shared native constant. The TypeScript embeddings consumer remains unported. The other TypeScript callsites were not adopted or cut over and may now have unresolved imports. This source deletion does not complete those callers or total migration.

## Source resolution and semantic comparisons

A single allowlisted reader handles live/archive resolution and validates exact source pins, regular-file and manifest shape, unique entry, no shadowing, no ambiguous live/archive pair and content hashes. Existing source readers preserve actual-source compilation and their logical IDs; native guards allow archived fallback only for the exact pins and only when the live file is absent. This avoids substituting native data for source evidence.

Nineteen oracle outputs were written and checked; the resolver negative matrix passed 18 rejection cases. Nineteen golden comparisons found nine byte-identical reports and 34 provenance-only changed paths; behavior remained unchanged across all 19. Source-only metadata changed as intended; no cases, wires, claims, constants or prepared workloads changed. The prepared 160-item variation benchmark input is byte-identical at SHA-256 `07b8192f942ef9c3246720aa75926939260f3e07250d83b7973197ca6ac65d2e`; Node write/check validated it without timing. There is no benchmark/performance claim.

Affected reader groups include the actual attribution oracle/resolver, moderation variations and jobs, semantic and decisions readers, Fish/Kokoro/runtime TTS oracles, and the native leaf/jobs/semantic provenance guards. Existing RE2 SDK evidence remains an external prerequisite, not a copied binary: [RE2 string handoff](re2-string-handoff.md), [source manifest](evidence/2026-10-30-advanced-moderation-prerequisites/artifacts/re2-node24/source-manifest.json), [build provenance](evidence/2026-10-30-advanced-moderation-prerequisites/artifacts/re2-node24/build-provenance.json), and [independent readback](evidence/2026-10-30-advanced-moderation-prerequisites/artifacts/re2-node24/independent-readback.json). Its existing pins are binary `94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb`, source manifest `e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664`, and build provenance `4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c`.

## Capped verification epochs

Formatting `1793386270045423031` and Node `1793386585532493945` passed. Compiler-fixtures `1793386806395824008` failed because the native decisions reader lacked archived Chatter/attribution paths; parent added the exact pins in the existing native reader. That earlier compiler epoch used tree `990fe98ce53641ed19f2f623cf123d7e4f958fb9166aad4de9246d545bb3251a` and is not the final source tree.

Compiler-fixtures `1793386956258970693` used final tree `0e29c964bf60d6427c296b3be75ae42cd9d6d70082fc2a6b9aabb0b6617d6117`, passed 25 selected tests, then failed because parent fixture setup omitted three required jobs provenance fields outside the loader-pin list. No further source changed. The final native-only reader correction did not change the Node fixtures or their output. Compiler-fixtures `1793387023855299505` ran on that same tree and passed the remaining six selected tests, all 38 jobs cases through private services, five TTS source replays, formatting, scoped Clippy, minimal and all-feature strict phases. The final-source total is 31 selected tests across compiler phases 2 and 3; it is not a single all-31 passing receipt. The standalone formatter receipt ran on preceding tree `b12e61cb68f053e0632eb9033c9807f0b76786d327fa2e4b40232c5a065712a8`; Node and the first compiler attempt used `990fe98ce53641ed19f2f623cf123d7e4f958fb9166aad4de9246d545bb3251a`. The accepted final tree is `0e29c964bf60d6427c296b3be75ae42cd9d6d70082fc2a6b9aabb0b6617d6117`, and its successful compiler phase also passed formatting.

The three native phases reused a private compiler cache under 6 CPU / 4 GiB no swap / 256 PID / two-job limits with 5 GiB startup reserve and 4 GiB floor. The final compiler phase took 101.029 s overall and 88.499 s for the compiler step; minimum available memory was 12,771,377,152 bytes and peak private cache was 8,053,932,032 bytes. Production readback found 18 records unchanged and zero task-owned resources. The verifier reused the existing Node 24 RE2 addon evidence and made no SDK changes.

## Limits

No application runtime or Cargo/lock changes occurred. The TypeScript consumers remain unadopted; embeddings remains unmigrated. No deployment, push, benchmark timing, RSS or whole-application claim is made. The overall dependency migration is incomplete and total completion remains `null`.

See the [verified handoff](openrouter-attribution-retirement-handoff.md) and [indexed evidence package](evidence/2026-10-30-openrouter-attribution-retirement/README.md).
