# DIMA-036 — Pet playback reliability evidence

Status as of 2026-11-01: browser pet playback fixes are deployed and verified in production. Desktop source fixes are committed, while desktop release and Windows/OBS hardware acceptance remain in progress. This work concerns pet speech on the Windows desktop app and OBS browser source. It does not concern normal Speech Overlay TTS.

## Browser source change

The browser pet runtime now treats a lost or transiently rejected lease-renewal acknowledgement as uncertain until the last server-confirmed local deadline. It retries using a bounded delay, preserves the independent expiry stop, and fences callbacks by connection and lease identity. Lease acquisition retries after transient acknowledgement loss, and safe `retryAfterMs` values are bounded to valid timer delays. Progress telemetry timeout, `rate_limited`, or `temporarily_unavailable` no longer revokes otherwise authorized playback; lifecycle acknowledgements and definitive lease rejection remain strict. Reacquiring ownership never replays a prior speech request.

Implementation and focused regression coverage are in [`pet-runtime.component.ts`](../dimasite/src/app/features/pet/pet-runtime.component.ts), [`pet-runtime.component.spec.ts`](../dimasite/src/app/features/pet/pet-runtime.component.spec.ts), and the exact-bundle browser fixture [`pet-lease-recovery.mjs`](../ops/checks/pet-lease-recovery.mjs). The fixture mocks the WebSocket server and HTTP audio endpoint, then exercises actual Chromium HTML audio with generated WAV samples. It covers lost acquisition ACK, renewal and progress ACK loss while speech continues, loading through a rate limit, stop at unchanged expiry, no replay after reacquisition, and immediate stop after definitive rejection.

Browser source commit: `18a1d1f0` (`fix(DIMA-036): retain valid browser pet audio through transient ACK loss`).

The final browser source snapshot (`c17f339d…`) matched the frozen candidate source. That snapshot includes the final direct string-code guard correction.

## Verification and limits

- Final browser component/follow-clock focused suite: 23 passed, including two malformed-ACK regressions reproduced RED then fixed; final scoped-pet TypeScript check passed.
- The full all-spec TypeScript check remains blocked by pre-existing roulette `node:test` type errors; this is not evidence of a DIMA-036 regression.
- The development preview's five-case actual-WAV Chromium fixture passed and the preview was cleaned up. After the final guard correction, the 23 focused tests and scoped TypeScript check passed again. Font/HMR harness corrections affected only the preview harness. The final exact-candidate browser check below covers the corrected source.
- Desktop integration suite: `bash scripts/cargo-limited.sh test --bin dima_app -j 1` passed 258 tests; seven opt-in tests were ignored. Desktop `fmt` and Clippy passed. Commits `3a20da5` and `dd798b9` contain the desktop audio/discovery and pet lifecycle/telemetry changes. The Windows GNU check was blocked because `x86_64-w64-mingw32-gcc` is unavailable. No Windows installer was released; physical Windows and OBS acceptance remain unverified. A managed desktop update is still running and is not recorded as delivered.
- Linux/headless and mocked browser evidence do not establish Windows device behavior or physical OBS playback. Historical `player_unavailable` events remain unexplained; reproduced client defects do not prove the cause of those reports.

## Browser production delivery

Candidate `site-052c28e5cc26` was built with four Angular workers under the verified eight-CPU, 6 GB pressure, 8 GB hard-cap, no-swap build scope. Artifact digest: `7ae9e3080ae13f492bc497052c325af0d33aa87883c1c297766e3ccb1eef211b`; frozen source digest: `7abe63e51172824188f84bd50f758e802b70ec4d8c379ea8629a0646d985a6ac`. The exact candidate passed `ops/checks/pet-lease-recovery.mjs` with all five actual Chromium/WAV cases, was deployed successfully, and helper cleanup completed with receipts and rollback retained.

Public production checks at `2026-11-01T03:14:19Z` returned HTTP 200 for the synthetic-capability pet route and its `chunk-JHH2EAZY.js` bundle. Both byte hashes matched the exact candidate: HTML `69b081819707ab6d0935d6f79880f675b0976d6bf99789e2ef5a315dfa2b0d8b`; pet chunk `f1eb63a207c3533d125f8501ee6ed8556107703b06b6a3e7d92e8e6189d810d7`. The public check receipt is in the ignored local artifact `target/dima036-public-check.json` under `/root/projects/dima_app`.

Existing OBS browser sources need a reload to pick up the updated bundle. No API, bot, or cron services were deployed, no production settings changed, and no paid requests were made. Browser delivery is complete; keep DIMA-036 in progress for the desktop release and Windows/physical OBS acceptance follow-up.

## Routing observation

The browser implementation was assigned to GPT-6.1 Sol at high through native Codex; this note was reconciled by GPT-6 Luna at high through Codex. This records bounded task routing only. It does not establish model superiority or a code/runtime performance result.
