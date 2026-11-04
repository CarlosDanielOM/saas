# DIMA-046 — Pet moods (API/site release, 2026-11-04)

## Status

The DIMA-046 source is frozen at feature commit `c3df6fe310c52483a9db2a3f916de15b0865e007`. Mood support is deployed to the SaaS API and public site. This record covers the API/site release and read-only production checks; it does not claim real desktop VTS/OBS acceptance. No published `dimadocs` content was changed.

## Reused paths

- `src/utils/tts/expressive_tts_tags.util.ts` is the existing catalog and alias normalizer for expressive emotion and sound tags. Mood selection reads raw request text before provider filtering; it does not create another tag catalog or alter TTS filtering.
- `src/pets/runtime.ts`, `state.ts`, and `read_tts.ts` remain the existing request and playback paths. Pet requests carry an optional mood on `RequestView`. Read-TTS Path A uses that request; overlay Path B has no `PetRequest` and adds an optional mood to the existing `pet:follow` event.
- `src/server/services/pet_settings.service.ts` remains the configuration boundary. Mood image uploads/references extend the private Asset Library with a separate `pet-mood` purpose; they reuse its ownership, image inspection, private serving, and deletion guards.
- DIMA-046 source additions include `src/pets/moods.ts`, schema normalization, mood-aware request admission and runtime, asset routes, and the existing site Pet settings/browser rendering surfaces. Desktop VTS mappings remain local to each model and are not SaaS configuration.

## Contract decisions

Owner-approved, 2026-11-03:

- Eight configurable moods: happy, excited, sad, angry, surprised, scared, embarrassed, thinking; neutral is the fallback. Moods are optional, default disabled, and have a default 2,000 ms hold (integer 0–10,000 ms).
- Owner-approved clarification: if all eight emotion lists are empty, omit the impossible AI leading-tag instruction and resolve the reply to neutral.
- Standing owner-approved Pet resilience rule: mood/configuration/image/extraction/instruction errors are decorative failures only. They must not fail, wait on, cancel, disconnect, or otherwise interfere with the parent Pet request/speech, billing, Read-TTS, desktop session, settings page, or browser playback. Preserve strict core-field validation and keep all mood fields additive in protocol v1.
- Existing expressive emotion and sound tags can be assigned to one mood each. Resolve the first known tag from raw text after aliases, skip delivery/effect tags, and use neutral for an unlisted tag or no tag. The mood is fixed per reply.
- Mood data is available to Premium and Pro only. The existing Free pet-wide gate remains (`GET /v1/me/pet` and pet settings still return `403 plan_required`); the helper's unavailable shape is minimal for any future Free-tier support.
- Premium activates the first eight configured image slots; Pro activates up to sixteen. Slot order is mood order (happy, excited, sad, angry, surprised, scared, embarrassed, thinking), idle before talking. A downgrade retains settings and all images while excess slots are inactive; re-upgrade restores them.
- Editing/rearranging saved slots remains allowed over allowance. New uploads stop at the stored-image allowance, including pending upload reservations. Pet-mood bytes are excluded from ordinary media quota; existing per-file and ownership checks remain.
- Site owns server mood settings/images. Desktop keeps a read-only synced copy and per-model VTS expression/hotkey mappings locally. Browser mood images fall back to ordinary idle/talking images. A terminal playback keeps the last shown mood for the configured hold; a new playing request switches directly.
- Overlay Read-TTS Path B adds only optional `pet:follow.mood`; it creates no Pet request. Path A continues to use `RequestView.mood`.

## Wire shapes

- `RequestView.mood?: 'neutral' | 'happy' | 'excited' | 'sad' | 'angry' | 'surprised' | 'scared' | 'embarrassed' | 'thinking'`, emitted only when entitled and enabled.
- Snapshot config: `{available:true,enabled,holdMs,emotions}`; unavailable: `{available:false,enabled:false}` only.
- Browser snapshot/public assets may include mood names mapped to `{idleUrl:string|null,talkingUrl:string|null}`. Only active enabled slots receive private URLs; this browser asset map omits IDs. Authenticated pet settings retain the configured mood image asset IDs.
- Existing overlay `pet:follow` gains optional `mood` under the same entitlement/enable condition. No new Socket.IO event is added.

## Self-healing source changes

The deployed source isolates mood handling from parent Pet work. Malformed mood-only submitted settings default to the disabled defaults with a bounded warning; invalid stored mood data also falls back to disabled defaults. Extraction failure resolves to neutral, instruction failure omits the instruction, and malformed snapshot decorations are dropped/defaulted. The `ask` cue-settings lookup is prefetched without awaiting or retrying; if a Fish cue lookup is still pending or fails, the existing text is used. Warnings are bounded and omit raw private message text, mood payloads, asset IDs, and provider/error details.

Mood image changes are sanitized separately from core settings: invalid/new foreign references are removed or restored to the prior slot, over-quota edits preserve the prior image mapping, and unchanged missing references do not prevent core settings from saving. Browser mood images stay decorative: ordinary PNG images remain visible during preload and after mood-image failure; failure does not revoke readiness, and the image is retried once on the next request with no idle retry timer. Invalid mood hold input in the editor also defaults the mood section off and does not block a valid core save. Release verification follows below.

## Release and verification

The API was deployed first with `api-0529a1e65dd2`, image `sha256:792b26fea1d82d28b1bda0c19aca93fa2e05d61594ae6824476008cd254e679c`, started `2026-11-04T00:15:41.949Z`. Rollback restores the prior image `sha256:f1bc6cdab87ef9664b5bd6b0ceda9fcbca0993e99259bd6c0ee187d88ac0dded`. The site was published with `site-72222126e72b` at about 00:16:39 UTC; bundle digest `5da390c7acf98de12def84b5dcf8f5fe886c3f7bd2ce340a55bd74904aea92c3`, entry `main-H2Z2SPPT.js`. The prior site bundle digest `d5f12f8658a654653dddcc604fdf01b94b783799b3cc25d01a065a70041561a9` remains available for rollback.

**Exact-candidate checks:**

- The promoted API candidate passed its TypeScript build, 400 compiled regressions across 43 serial files, full Pet runtime normal checks, and desktop AI normal checks (19 groups). Extraction and instruction fault injection also passed; speech played and completed, then the next valid request worked. Desktop AI fault checks passed all 19 groups. Production probe fixtures covered legacy, corrupt, and valid stored mood configuration.
- Site focused Pet Vitest passed 82 tests across five files; the scoped five-file Pet spec typecheck and both app builds passed. Node 24 development preview (4 CPUs, 3 GiB JS heap) built in 30.845 seconds, and mood plus configuration checks passed, including the development owner-switch race. The isolated production bundle built in 45.833 seconds with the existing 2.04 MB initial-bundle and CommonJS warnings.
- All five exact-site browser suites passed: mood editor, mood-image failure/playback, pet configuration, pet runtime, and lease recovery. Checks covered 320/390/1280 px in dark and light, Spanish, Axe with zero findings, image 404 fallback/retry, mood hold/switch/reset, three natural WAV completions without renderer unready/error/replay, settings sanitization, and configuration behavior. No browser readiness or audio state depended on mood images.
- `pet-lease-recovery.mjs` passed lost-ACK, renewal, progress, rate-limit, expiry, reacquisition, and rejection cases. The full-repository spec typecheck still has unrelated baseline errors: roulette `card-highlight.spec.ts` lacks `node:test`/`node:assert` types, and adding Node types exposes the existing `Timeout`/`number` conflict in `overlay-asset-cache.ts`. Do not represent the full-repository spec typecheck as passing.

**Read-only production checks:** production probe scripts `ops/checks/pet-moods-production*.mjs` were added in commit `d4d405e4cedc393c33e47660141b52f5411c17e4`. Read-only configuration probes of three saved paid accounts confirmed valid mood configuration, legacy defaults, and plan limits; alias/free-helper checks and unauthenticated HTTP behavior also passed (`401`), as did internal and public API readiness (`200`). Public HTTPS `curl` GETs confirmed both HTML entrypoints and 19 script/style assets match the tested bundle, including mood chunks `chunk-JKO2GKHS.js`, `chunk-DLMYK7KS.js`, and `chunk-CQVJ2UI7.js`. An initial Python urllib request received an edge `403`; curl verification succeeded. No edge/configuration change or rollback was needed.

The 19-container comparison found only the API container changed; the other 18, including the site container, were unchanged. API startup had zero restarts and no startup-error signatures. No active Pet request or desktop speech was in progress at cutover. These verification and production checks made no paid provider calls or credit spend. No real VTS expression/hotkey, reconnect, OBS, or hardware checks were performed.

**Cleanup:** the lead confirmed `saas-ops` cleanup completed for the deployment receipts. API and site receipts are `deployed` with `resources: []`; task source directories, temporary Node 24/fixture directories, test containers, and networks were removed. The deployed and rollback images and prior site bundle remain retained by the helper. Root logs and screenshots remain in `/tmp`.

**Historical candidate evidence:** pre-hardening `api-5a09f12f198b` and `site-b221ac373c4d`, and hardened pre-deployment `api-836798d7077c` and `site-ae93b4fff1bc`, were superseded by the release above. Their checks and the earlier shared-memory resource-routing interruption are historical only; the deployed run's exact-candidate checks and outcomes above are the release evidence.
