# TTS pricing and emote bootstrap — 2026-10-29

This scoped Rust task consolidates the existing TTS usage pricing calculation
behind a shared module and adds a lazy concrete Redis bootstrap runtime for
Twitch emote lookup. Pricing logic already existed in `credit_policy.rs`; the
change exposes the same implementation to TTS utilities and extends its
source-oracle/benchmark coverage. It does not retire a TypeScript source file.
The emote runtime adds bounded lazy Redis manager initialization and retryable
successful-only caching, while application callers still need to supply the
existing token storage and integrate bootstrap, logging, and telemetry.

Final source `64984e28f5d64d8b61e99aacc24d868a14c841fa35e0e245d93c1caa7908ad92`
passed the scoped compiler suite, feature checks, Node source oracle, and final
manual production readback. The final same-input six-workload benchmark kept
Kokoro slower than TypeScript by 18.27%; Piper/Fish/unknown results were
near-parity/noise, with overlapping ranges. The Rust Kokoro median improved
against baseline but the regression remains. The 19 production records were
unchanged and task-owned resources were removed; there was no deployment or
push. See the [migration record](../migration-notes/tts-pricing-emote-bootstrap-2026-10-29.md)
and [verification summary](../migration-notes/evidence/2026-10-29-pricing-emote-bootstrap/verification-summary.json).

This is a single task-specific routing observation with low confidence. The
assignment history reported by the parent was GPT-6.1 Terra at xhigh for
pricing implementation/hardening and cache work, with the parent integrating
the additional global connection-failure oracle case. This observation does
not support model attribution, a general capability ranking, or any change to
the user-provided model tier order.
