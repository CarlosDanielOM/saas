# Pet Fish favorites UI routing — 2026-10-31

- **Scope:** Bounded dimasite pet settings UI to expose saved Fish voices, retaining custom/current IDs and linking to TTS management.
- **Routing:** GPT-6.1 Sol at high via Codex implemented through a native agent; Sol at high led review, browser checks, and release; GPT-6 Luna at high documented.
- **Implementation:** Reuses `TtsSettingsApiService.getFavorites(channelID)` and `/speech/favorites/:channelID`; deduplicates named favorites against default voices and preserves saved/custom Fish IDs across loading, failure, removal, reply-language changes, and retry. Switching providers still selects a voice valid for that provider.
- **Reliability:** Timeout, disposal, and channel-owner guards protect refresh state. Lead review only required a test-only Angular DOM-settling wait; no material application changes followed.
- **Verification:** TypeScript no-emit and Angular compiler checks passed. Preview on `127.0.0.1:4217` and exact candidate `site-b4e310abf3e0` passed [`pet-fish-favorites-browser.mjs`](../ops/checks/pet-fish-favorites-browser.mjs): save/reload, dedup/names, provider/language changes, loading/error/retry draft preservation, custom/removed IDs, EN/ES, dark/light at 320/390/1280, and axe.
- **Release:** Site deployed and helper cleanup completed. Production CSR route, emitted chunk, and EN/ES assets matched the tested bundle; all 18 container IDs were unchanged and no backend was deployed. No paid voice/audio production test.
- **Evidence:** [pet page](../dimasite/src/app/features/pet/pet-page.component.ts), [behavior check](../ops/checks/pet-fish-favorites-browser.mjs), candidate `site-b4e310abf3e0`.
- **Confidence / routing:** Low, single UI task. Supports Sol's existing GPT-led UI route only; no tier change, quality ranking, or performance claim.
