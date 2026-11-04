# Overlay Studio shared renderer — routing observation

On 2026-11-04, GPT-6.1 Sol at high implemented the shared editor/OBS renderer and led integration, GPT-6.1 Terra at high authored an independent browser parity check, and GPT-6 Luna at high drafted source-backed documentation. The existing OBS composition is now the canonical visual implementation for both surfaces.

The independent check exposed a Chromium grid-fieldset layout issue, which the implementation fixed with a block fieldset and grid content wrapper. Integration review also tightened cache warming, stale-request cancellation, and animation input stability. Existing fixture assumptions were corrected for the shared scene DOM, current Studio preview API, and original OBS whole-event reservation policy.

The final candidate `site-246dc6ae4350` passed TypeScript no-emit, 11 playback/cache unit tests, widget contract sync, and all 31 scoped browser checks before deployment. The parity check covers dark/light themes at three viewport widths, sampled animation frames, geometry, text/fonts/images, stable selection/resize, TTS, placement expiry, and queue reservation. See the [release record](../migration-notes/overlay-shared-renderer.md) for production verification and limitations.

This is task-specific collaboration evidence. It does not establish a broad model quality ranking or runtime performance comparison.
