# DimaFX identity routing observation — 2026-11-04

Complexity: cross-layer identity classification, API routing/recovery guards, and panel/mobile UX with English/Spanish copy. GPT-6.1 Sol at high via Codex led; native GPT-6.1 Terra at high implemented the dimabot identity classification, route, and recovery guard with four service tests; native Sol at high implemented the DimaFX identity prompt and free/Bits/credits/callback guards.

Lead review caught a stale `refreshMe` `/me` response race. Sol added authorization-generation guards to `loadStore` and `refreshMe`, with mocked regression coverage.

Evidence: API candidate `api-7137aa70c37d` passed `ops/checks/dimafx-queue.mjs` with disposable Mongo/Redis and mocked providers, including anonymous custom/legacy/paid rejection without receipt or queue, pending recovery denial, shared TTS, normal/fixed success, and existing queue/ack/restart/idempotency cases. Verification-only EBS candidate `dimafx-server-61211a374218` passed `ops/checks/dimafx-server.mjs`, including body-identity spoof rejection; EBS code was unchanged and no EBS deployment was needed. The lead's full client rerun passed against an isolated copy at 318/320/390px in dark/light, including axe, overflow, direct method/callback defenses, identity opt-in/revocation, and stale-auth responses.

`api-7137aa70c37d` was deployed and validated: `panel.js`, `panel.html`, and `mobile.html` were published; served byte equality and the complete mocked panel/mobile suite passed against the production nginx URL. Production API classification and unauthenticated internal API 401 protection passed, startup logs were healthy, and only `dima-server` was recreated; EBS, bot, cron, and nginx were unchanged. Both helper runs cleaned up and retained rollback. No active custom-TTS production item exists, so actual rejection/fulfillment was tested only with disposable fixtures; live Twitch payments were mocked.

Confidence: one cross-layer task and accepted release. Supports task-specific Terra routing for bounded backend identity integration and Sol routing for DimaFX UI/security guards plus review correction. No broad tier reorder or speed/performance claim.
