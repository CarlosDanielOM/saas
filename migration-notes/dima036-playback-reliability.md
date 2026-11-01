# DIMA-036 — Pet playback reliability evidence

Status as of 2026-11-01: desktop source fixes are committed and the browser source fix is implemented, but delivery and platform acceptance are still in progress. This work concerns pet speech on the Windows desktop app and OBS browser source. It does not concern normal Speech Overlay TTS.

## Browser source change

The browser pet runtime now treats a lost or transiently rejected lease-renewal acknowledgement as uncertain until the last server-confirmed local deadline. It retries using a bounded delay, preserves the independent expiry stop, and fences callbacks by connection and lease identity. Lease acquisition retries after transient acknowledgement loss, and safe `retryAfterMs` values are bounded to valid timer delays. Progress telemetry timeout, `rate_limited`, or `temporarily_unavailable` no longer revokes otherwise authorized playback; lifecycle acknowledgements and definitive lease rejection remain strict. Reacquiring ownership never replays a prior speech request.

Implementation and focused regression coverage are in [`pet-runtime.component.ts`](../dimasite/src/app/features/pet/pet-runtime.component.ts), [`pet-runtime.component.spec.ts`](../dimasite/src/app/features/pet/pet-runtime.component.spec.ts), and the exact-bundle browser fixture [`pet-lease-recovery.mjs`](../ops/checks/pet-lease-recovery.mjs). The fixture mocks the WebSocket server and HTTP audio endpoint, then exercises actual Chromium HTML audio with generated WAV samples. It covers lost acquisition ACK, renewal and progress ACK loss while speech continues, loading through a rate limit, stop at unchanged expiry, no replay after reacquisition, and immediate stop after definitive rejection.

Browser source commit: `18a1d1f0` (`fix(DIMA-036): retain valid browser pet audio through transient ACK loss`).

## Verification and limits

- Final browser component/follow-clock focused suite: 23 passed, including two malformed-ACK regressions reproduced RED then fixed; final scoped-pet TypeScript check passed.
- The full all-spec TypeScript check remains blocked by pre-existing roulette `node:test` type errors; this is not evidence of a DIMA-036 regression.
- The development preview's five-case actual-WAV Chromium fixture passed, then the preview was cleaned up. A final direct string-code guard correction followed that preview; the 23 focused tests and scoped TypeScript check were rerun after the correction. The final production candidate must include and verify this latest source. Font/HMR harness corrections affected only the preview harness. Production candidate build, final exact-candidate verification, and deployment are **pending**.
- Desktop integration suite: `bash scripts/cargo-limited.sh test --bin dima_app -j 1` passed 258 tests; seven opt-in tests were ignored. Commits `3a20da5` and `dd798b9` contain the desktop audio/discovery and pet lifecycle/telemetry changes. Windows hardware and OBS acceptance have not been verified.
- Linux/headless and mocked browser evidence do not establish Windows device behavior, real OBS playback, or production acceptance. Historical `player_unavailable` events remain unexplained; reproduced client defects do not prove the cause of those reports.

## Pending delivery record

Manager: fill in the browser candidate/build/verification/deployment receipt, cleanup status, and final production status here when available. Keep DIMA-036 in progress until required delivery and acceptance evidence is complete.

## Routing observation

The browser implementation was assigned to GPT-6.1 Sol at high through native Codex; this note was reconciled by GPT-6 Luna at high through Codex. This records bounded task routing only. It does not establish model superiority or a code/runtime performance result.
