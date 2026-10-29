# TTS runtime factory routing observation — 2026-10-29

## Task and routing

This was a multi-file Rust integration and source-parity task around the application-owned TTS runtime factory, its source-compatible configuration read points, and runtime wiring tests. Scope was constrained to existing `tts-services`: no crate/package or lockfile additions, default-feature changes, worker graph changes, source retirement, caller adoption, or production release. Documentation was reconciled separately after source and exact-candidate evidence stabilized.

GPT-6.1 Sol at xhigh reviewed an early GPT-6.1 Terra xhigh asynchronous implementation draft and closed concrete coverage gaps around Fish's shared client/catalog cache and environment read timing. Sol also added the optional environment hooks while retaining explicit config APIs. GPT-6.1 Terra at xhigh implemented native runtime wiring/configuration tests and the dynamic TypeScript source oracle/replay. GPT-6.1 Sol at xhigh led final source controls, verification, and the independent OS environment-byte probe. GPT-6 Luna at high reconciled the documentation against source and final evidence.

An initial 90-second asynchronous Terra attempt produced a runtime core but missed Fish/shared-pool coverage. The subsequent review and test work closed those specific gaps; the initial attempt is iteration history, not final verification. The final run identities, source hashes, suite totals, and cleanup record are in the [TTS runtime migration note](../migration-notes/tts-runtime-2026-10-29.md) and [evidence index](../migration-notes/evidence/2026-10-29-tts-runtime/README.md).

## Evidence and implication

The final Node oracle and compiler candidate passed against source commit `bc48e32f3de0f864c8f8eaa7211ca6f35931698a` and source SHA-256 `80846b66199103deea86f9225a69796516c6243930fede9b5da3a7f6b805c6a8`. The oracle covers source-selected configuration cases, actual TypeScript modules in an isolated VM, ordinary environment-read traces, and provider/catalog behavior replay. Native tests passed bounded HTTP and CLI fixtures, including reuse of one TCP connection across eight same-origin requests and the environment adapter's lossy invalid-OS-byte conversion in an isolated child. These are behavioral/source-parity checks; no provider was called and no benchmark or runtime performance comparison was run.

This is one scoped multi-model integration result. Sol's review found specific omissions and closed them; Terra delivered the bounded wiring and oracle scope after that correction; Luna handled source-backed documentation. It supports the existing task-specific Sol integration/review and Luna documentation routes, and the provisional Terra route for bounded coding/oracle work. It does not establish a model capability ranking, TPS/cost difference, or a broad tier reorder. Retain the user-provided baseline.
