# Orchestrator model notes

Use this file to keep concise, evidence-based observations that help choose models for future work. Read it before substantive delegation. Update it after a meaningful verified outcome or useful user feedback. These notes support the live orchestrator capability catalog; they do not replace it. Always check that catalog for current providers, exact model identifiers, effort options, and delegation support. Do not treat any identifier or option recorded here as permanent truth.

## Starting preferences

The user's current ascending capability coding tier is a user-provided starting preference:

1. GPT-6 Luna
2. MiniMax M3.1 Flash
3. DeepSeek V4.1 Flash
4. Grok 4.7
5. GPT-6.1 Sol
6. GPT-6 Astra

On 2026-10-20, the user expanded the original five-model baseline by inserting Grok 4.7 between DeepSeek V4.1 Flash and GPT-6.1 Sol. Based on their experience, the user prefers Grok as a stronger reasoning option than V4.1 Flash for more demanding/deeper exploration; this is a routing preference, not a verified benchmark. Use Grok 4.7 at high or xhigh when the live catalog advertises those effort levels. Grok is available through Cursor and Grok CLI/provider, and may also be used for scoped implementation under the same delegation and verification rules.

This is not a mandatory sequential escalation ladder. Choose the best available model for the task up front. Verified outcomes or user feedback may justify revising the working tier as well as routing by task category without another approval request. Keep the user-provided baseline above, and record the date, reason, and supporting evidence for each adjustment.

For GPT-led UI/UX and design tasks, start with DeepSeek V4.1 Flash or GPT-6.1 Sol using the existing effort preferences. The user may manually ask Claude to refine the work later. This preference applies only to GPT-led sessions; it does not set a default for Claude-led sessions.

On 2026-10-20, the user set a runtime preference for delegated work: default to full access for non-Claude delegates when the live catalog advertises it and the parent/platform permits it; use MiniMax `bypassPermissions` for full-access work when advertised. Do not use full access or bypassed permissions for Claude as Unix root (UID 0). Honor live catalog and parent limits, and use an authorized supported alternative if a mode is unavailable or refused. This preference does not change the model-tier baseline above.

## Routing observations

Keep observations brief and tied to a task category, scope, and concrete evidence. Consider exploration, single-file or function work, multi-file integration and consistency, optimization, and UI/UX design separately. Confidence should reflect how much evidence exists and how well it transfers to similar tasks. One result can inform a hypothesis; repeated, comparable results support a stronger routing change.

Separate implementation performance (correctness, consistency, rework, and time to a verified result) from generated-code runtime performance (for example, latency, throughput, or resource use). Claim runtime optimization only when measurements support it. A good build or review is not evidence of a runtime speedup.

Do not record secrets, credentials, private user data, or raw logs. Prefer short summaries and references to commits, task records, or check results.

First verified coding-performance observation: [2026-10-20 shared chat origin handling](2026-10-20-shared-chat.md). The current tier includes the user's Grok insertion above; no empirical tier reordering has been established.

2026-10-20 — Scoped Rust MongoDB connection utility: DeepSeek V4.1 Flash at high via OpenCode implemented the utility; GPT-6.1 Sol led review and integration of runtime-lifetime documentation corrections and stronger checks. Verified with four default unit tests and eight isolated authenticated MongoDB fixture cases. Evidence: `dima-rust/src/utils/mongo.rs`, `dima-rust/tests/mongo_connection.rs`. Confidence: single task. This supports the existing scoped-implementation routing; it does not change the model-tier baseline. No runtime performance claim.

2026-10-20 — Scoped Rust Redis/Dragonfly connection utility: DeepSeek V4.1 Flash at high via OpenCode implemented the utility; GPT-6.1 Sol led review, integration, and disposable Dragonfly runtime checks. Verification covered 15 unit tests, two doctests, formatting, check, clippy, build, and 13 isolated runtime cases for configuration rejection, shared-client behavior, Lua/TTL, failed-init retry, handshake timeout/retry, reconnect after a dropped socket, and blocking-command behavior with a subsequent `PING`. During fixture review, GPT-6.1 corrected the Lua fixture key TTL to 60 seconds to match its comment, and the success-case recheck passed. Confidence: single task. This supports the existing scoped-implementation routing; it does not change the model-tier baseline. No runtime performance claim.

## Blank observation template

Copy this block for each meaningful outcome:

```text
Date:
Provider / model / version + effort:
Task category / scope / constraints:
Concrete result and verification evidence (commit, task, or check references):
Rework / failures:
Latency / cost (only when actually measured):
User feedback:
Confidence:
Routing implication:
```
