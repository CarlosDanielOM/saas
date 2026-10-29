# 2026-10-29 — Twitch emotes and normalizer retirement

**Task:** Stateful opt-in Rust utility integration plus a TypeScript source
retirement; source-backed parity, concrete Redis/token/HTTP dependencies,
archive resolver changes, and capped native checks. The task explicitly
excluded caller cutover and production deployment.

**Routing and outcome:** GPT-6.1 Terra at xhigh authored the actual TypeScript
oracle and an incomplete first native pass. GPT-6.1 Sol at xhigh implemented
the concrete Redis and `TwitchTokenStorage` integration, app-token
acquisition/header construction, single-attempt Helix behavior, channel/global
cache composition, and lossless DTO/wire behavior. Terra at xhigh completed
the bounded test follow-up; lead Sol review/integration and Luna documentation
reconciled final evidence. Candidate `compiler-fixtures-1793248206114963870`
passed formatting, feature-profile checks and strict Clippy, 244 ordinary
executions, and 11 explicit source/adapter fixture executions. The 65-case
emote corpus had 57 direct source replays; separate concrete checks covered
Redis command faults, auth/header handling, fetch connection close,
concurrency/cancellation, and timeout boundaries. Connection acquisition
remains outside the constructor boundary, and source Promise identity was not
asserted directly. Singleflight map cleanup was covered by a native module
test and future-clock retry. All 21 archive resolver checks passed. This is a
successful single-task outcome, not a comparative model benchmark.

**Evidence:** [Twitch emote migration record](../migration-notes/twitch-emotes-2026-10-29.md),
[normalizer retirement](../migration-notes/tts-normalizer-retirement-2026-10-29.md),
and the [combined evidence index](../migration-notes/evidence/2026-10-29-emotes-normalizer-retirement/README.md).

**Routing implication:** For this one stateful integration, Sol's follow-up
closed concrete dependency gaps left by Terra's first pass; Terra's bounded
test follow-up passed in the final candidate. Keep this as one task-specific
observation with low confidence. It does not rank Terra and Sol broadly or
reorder the user's model tier. Validation timings and resource limits describe
build/fixture execution, not model latency or generated-code runtime
performance. No new paired benchmark was run.
