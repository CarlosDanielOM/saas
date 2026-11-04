# DIMA-052 — Two-value pet mouth: opening and smile

Status: deployed 2026-11-04. API run `api-2d03e52cacfe` and site artifact `site-3d80a1a87d57` passed candidate verification and scoped production checks. All three helper cleanups passed with `resources: []`; the isolated preview copy was removed. Real VTS/OBS/Windows acceptance remains separate and unverified.

Implementation commit: `821f7263dcd1d8a7285d455142a76f5a7a5843bb` (GPT-6.1 Sol via Codex/T3, effort high). GPT-6 Luna via Codex/T3, high, drafted this release record and the runtime contract; the lead reconciled final evidence and wording.

## Contract and reuse

The existing Read-TTS adapter owns normal-queue speech observation and `pet:follow`; the browser player already owns audio fetch/decode lifecycle, and the socket layer already owns desktop feature negotiation, elected VTS routing, and `pet:mouth`. DIMA-052 extends those paths rather than adding a second speech path or event. The API reuses the existing audio file and ticket flow; no new synthesis, billing, usage, or audio-delivery path is introduced.

The new `dima-mouth-v1` curve computes opening from loudness and smile from voiced-band brightness. It bins decoded clips at `ceil(sampleRate / 30)` frames, computes loudness from every channel sample, and filters the average mono mix into 250–700, 700–1300, and 2000–3500 Hz bands. It emits a normalized opening curve and a smoothed smile curve with neutral 0.5 fallback. The browser fetches and decodes once, then precomputes both curves without blocking playback; PNG speech skips browser analysis and keeps playing/waiting image state, while silent follow keeps its envelope clock. Sample selection is `floor(positionMs * sampleRate / (1000 * binFrames))`; an exact 700 ms fixture case exposed a floating-point error with the prior arithmetic order, so both server and browser implementations use this expression and have a regression test.

The `/desktop` hello advertises `mouth-smile`; desktops declare any subset of known features, while unknown names are ignored. The declaration is per socket, retained through reauth, and repeated after reconnect. `pet:mouth.smile` is optional finite 0..1 data: malformed smile is dropped alone, while invalid opening remains an error. The API forwards smile only to the elected VTS controller when that socket declared support.

The desktop confirmed the contract in commit `c2cb716`; the original specification is commit `bff70a5`. No contract question remains open.

Read-TTS remains on `pet:follow` v1. Supporting desktop controllers receive native-rate envelopes with fractional `stepMs = 1000 * binFrames / sampleRate`, values rounded to four decimals, step 20..100 ms, up to 1800 entries, and at most `60000 + stepMs` milliseconds of coverage for a partial last bin. Smile is optional, same-length, and bounded 0..1. Legacy desktop and PNG/browser followers retain the exact old 40 ms, at-most-1500-entry envelope without smile; PNG samples the new opening curve at 40 ms. Only the initial follow carries the envelope. The PNG image threshold is any positive opening value: on the fixture, the legacy 0.08 gate marks 72.51% of bins as talking, the new curve with 0.08 marks 54.98%, and the chosen `> 0` threshold marks 66.82%. The existing `pet:follow-end` shape is unchanged.

## Source and fixture evidence

The source implementation is in `dimabot/src/pets/{socket,peers,read_tts,tts_envelope,mouth_curves,mouth_analysis,mouth_curves.worker}.ts` and `dimasite/src/app/features/pet/{pet-browser-player,mouth-curves,pet-follow-clock}.ts`. The same mock-reply fixture is copied byte-for-byte in both projects. Compared with the desktop reference, the measured maximum absolute errors are 0.0000498435 for opening and 0.0000729903 for smile, each within the 0.001 tolerance.

The initial API candidate `api-02258bfcf901` passed 274 compiled tests with zero skips, including the actual ffmpeg fixture. Its synchronous curve calculation took 333 ms for the maximum 60-second 48 kHz stereo clip, prompting bounded on-demand Node worker analysis: two active, eight queued, maximum 64 MiB PCM, a five-second worker deadline, and abort/termination cleanup. Final API candidate `api-2d03e52cacfe` passed 280 compiled tests across all 19 suites with zero failures or skips, including the actual ffmpeg and compiled-worker fixture; the six focused worker tests passed separately. The full `ops/checks/pet-runtime.mjs` check passed real OAuth, mouth relay, and browser behavior. All directly affected legacy follow source tests are included in the compiled suite.

Site candidate `site-3d80a1a87d57` passed the exact bundle check, all 57 source specs, and `ops/checks/dima032-site-follow.mjs`: real-WAV mouth/smile parity, one fetch/decode, PNG threshold, 10 Hz reporting, desktop/mobile at 320/390/1280 px in dark/light themes, and axe. The preview initially exceeded 4 GiB; it passed after rerunning with 2 CPUs and 6 GiB, pinned to CPUs 0–1 within this SaaS host's allocation. Peak memory was 4,454,805,504 bytes.

The dedicated `ops/checks/dima052-follow.mjs` check passed PNG, modern-desktop, and legacy-desktop paths on both the initial API candidate `api-02258bfcf901` and final candidate `api-2d03e52cacfe`. The broader `dima032-api` fixture failed twice on its existing 30-second Studio expectation: after skip, the prior speech slot remained reserved behind a genuine 80-second silence fence because actual silence was not proven. Experimental edits to that fixture were restored to HEAD. The overlap guard is unchanged, and the broader forced-stop regression remains a known timing limitation, not a passed test or a production safety change. Directly affected follow/mouth cases passed in the compiled suite and the dedicated real check. Affected runtime sources match candidate snapshots byte-for-byte. The desktop reference at `/root/projects/dima_app/tracking/notes/DIMA-052-mouth-smile.md` was read-only and was not edited.

## Reproduction commands

These are the historical exact-candidate verification commands; helper verification is no longer available for the deployed, cleaned runs. A rebuild produces new run IDs. Staged fixtures are expected at the paths shown.

```sh
scripts/saas-ops verify api-2d03e52cacfe --dependency mongo --dependency redis \
  --test-env ops/checks/dima032-fixtures/api-env.json --fixtures /tmp/dima052-follow-fixtures \
  --check ops/checks/dima032-compiled.mjs
scripts/saas-ops verify api-2d03e52cacfe --dependency mongo --dependency redis \
  --test-env ops/checks/pet-runtime-fixtures/test-env.json --fixtures /tmp/dima052-runtime-fixtures \
  --check ops/checks/pet-runtime.mjs
scripts/saas-ops verify api-2d03e52cacfe --dependency mongo --dependency redis \
  --test-env ops/checks/dima052-fixtures/api-env.json --fixtures /tmp/dima052-follow-fixtures \
  --check ops/checks/dima052-follow.mjs
scripts/saas-ops verify site-3d80a1a87d57 --check ops/checks/dima032-site-follow.mjs
```

Production verification on API image `sha256:6102ed4ec1841376e16c98d2e7ab4e9866f4ea98d23ab02fbc6fa5991e072c39` confirmed the ffmpeg/worker mouth fixture at 253 native and 211 legacy bins (maximum open error 0; smile error about 0.0001), unauthorized access returned 401, and the worker queue was 0 active / 0 queued. The API started at `2026-11-04T20:55:16.659868287Z` with zero restarts. The deployed site artifact SHA-256 is `424b82288f21e069f15e7be080d7f75faacfd6c96435f1690115064ee5e5e2df`; public root, CSR pet route, and `chunk-EYTEEOB6.js` matched candidate bytes. The chunk SHA-256 is `657ec50260822f3bf0ff17e3d575a8edf7694db78daac5cd85263e301743b9ba`, `index.html` is `9b4aabeecaf10c154faf4bb59278bbe84284eb3b398bc8a060f8c484f017b24c`, and `index.csr.html` is `c46c1366409f736d16fcc5ce010aad9dda64aeb180e5ccdc0a058756db297b52`. Nineteen Compose containers were checked; only the API container changed, while the site container retained its identity and the bundle files were published. The recent API log had 42 lines and no fatal/uncaught/unhandled/module/error matches. One urllib request returned an edge 403; curl returned 200 and verified byte identity. No production account, paid speech, or database mutation was used. All three helper cleanups passed with `resources: []`; the isolated preview copy was removed. Private per-run evidence is retained in each final run's `dima052-evidence/` directory.

No rollback was performed. If required, roll back the site first with `scripts/saas-ops rollback site-3d80a1a87d57`, then API with `scripts/saas-ops rollback api-2d03e52cacfe`; the API's prior image was `sha256:043d4f054de2b5ad5a2628ff5eb02227b271d391641ad72448a70cb3b640a1ce`. Reload open browser tabs after rollback to the pre-smile API parser.

## Verification limits and handoff

The API and site releases are deployed, passed the scoped production checks above, and were cleaned up. The broader `dima032-api` forced-stop regression remains a known timing limitation, not a passed check; desktop tolerance/mood bias/VTS parameter injection and real VTS/OBS/Windows behavior remain separate unverified acceptance items.
