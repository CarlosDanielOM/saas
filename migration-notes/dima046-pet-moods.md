# DIMA-046 — Pet moods (source candidate, 2026-11-03)

## Status

The SaaS source candidate implements pet moods across the existing Pet runtime, Read-TTS handoff, settings, private Asset Library, and website editor/browser pet. Candidate verification and task resource cleanup are complete. This note records the candidate contract; it does not claim deployment, acceptance, or production behavior. No published `dimadocs` content was changed.

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

The current source candidate isolates mood handling from parent Pet work. Malformed mood-only submitted settings default to the disabled defaults with a bounded warning; invalid stored mood data also falls back to disabled defaults. Extraction failure resolves to neutral, instruction failure omits the instruction, and malformed snapshot decorations are dropped/defaulted. The `ask` cue-settings lookup is prefetched without awaiting or retrying; if a Fish cue lookup is still pending or fails, the existing text is used. Warnings are bounded and omit raw private message text, mood payloads, asset IDs, and provider/error details.

Mood image changes are sanitized separately from core settings: invalid/new foreign references are removed or restored to the prior slot, over-quota edits preserve the prior image mapping, and unchanged missing references do not prevent core settings from saving. Browser mood images stay decorative: ordinary PNG images remain visible during preload and after mood-image failure; failure does not revoke readiness, and the image is retried once on the next request with no idle retry timer. Invalid mood hold input in the editor also defaults the mood section off and does not block a valid core save. Current candidate checks and remaining evidence follow below.

## Verification status

- Before resilience hardening, source backend/site TypeScript checks passed and site focused Vitest passed 40 actual tests across three files, including the PNG readiness red-green regression and generation-change cancel/hold red-green regression. These checks do not establish the newer self-healing guarantees.
- Earlier pre-hardening API candidate `api-5a09f12f198b` passed 389 compiled tests, the Pet runtime check, and 19 desktop groups. Earlier pre-hardening site candidate `site-b221ac373c4d` passed its build and moods mock. These runs do not verify the newer Pet self-healing changes.
- Hardened API candidate `api-836798d7077c` passed its TypeScript build and compiled regressions (400 tests across 43 serial files). Its full Pet runtime check passed normally, and the desktop AI suite passed all 19 groups. A full Pet runtime variant that threw on the first mood extraction and first mood instruction also passed: speech played and completed, and the next valid request extracted and built its instruction successfully.
- After the earlier pre-hardening results, hardened site focused Pet Vitest passed all 82 tests across five files. Site candidate `site-ae93b4fff1bc` built successfully under Node 24, 4 CPUs, and 3 GiB JS heap in 45.159 seconds. It retained the existing 2.04 MB initial-bundle warning and CommonJS warnings. Site mood mock verification passed, including corrupt mood settings and invalid hold input while a valid core-settings save succeeded.
- The site candidate passed mobile/browser checks at 320, 390, and 1280 px in dark and light themes, Spanish strings, and Axe with zero findings. The Chromium mood-image check confirmed a held 404 leaves the ordinary image visible, the same URL is retried on the next request after repair, mood hold/switch/reset works, and three natural WAV completions produce no renderer unready/error/replay. Existing `pet-runtime-browser` passed. `pet-configuration-browser` passed after its `/speech/favorites` fixture was corrected to return `[]`; one owner-switch race assertion was intentionally skipped in the production bundle because it is dev-only.
- The API desktop fault-injection suite passed all 19 groups. `pet-lease-recovery.mjs` passed lost-ACK, renewal, progress, rate-limit, expiry, reacquisition, and rejection cases. The focused five-file Pet spec typecheck passed using a temporary `tsconfig.spec.json` extension limited to `features/pet/**/*.spec.ts` and the Pet mood model/warning specs; the temporary config was removed. Both app builds passed.
- A full-repository spec typecheck does not pass cleanly for unrelated baseline issues: `roulette/card-highlight.spec.ts` lacks `node:test` and `node:assert` types; adding Node types exposes the existing `Timeout`/`number` conflict in `overlay-asset-cache.ts`. The successful scoped Pet typecheck and app builds do not establish a clean full-repository spec typecheck.
- The existing UI configuration check initially failed while locating the Custom Fish voice. Diagnosis found its `/speech/favorites` mock returned `{}` although the caller uses `.filter`; the fixture now returns `[]`, and the rerun passed.
- The final API normal Pet runtime rerun passed with the new ordinary-instruction assertion. The extraction/instruction fault-injection variant also passed and recovered on the next valid request.
- The development preview compiled, but HTML requests stalled. A Node 26 site helper run `site-92dafbe6d866` failed during prerender. The Node 24 retry `site-d0aad12f8ffd` was interrupted at the manager request; it did not establish Node-version causality.
- Resource diagnostics found esbuild threads blocked in `mem_cgroup_handle_over_high` while extra scopes and desktop Cargo shared `dima-dev.slice`. The lead identified this as a resource-routing mistake, not a model or Node failure. The manager returned the lane; current SaaS builds use the SaaS-owned `saas-ops` path and limits outside the desktop slice.
- Production deployment and smoke verification: **not requested for this task**.
- No production changes were made. Real desktop VTS expression/hotkey and OBS/hardware acceptance remain desktop-owned and **not checked**. The browser behavior was verified as above.
- Helper cleanup completed through `saas-ops` for API runs `api-dd4428a3d826`, `api-d4a6f0593180`, `api-9f7f3f187502`, `api-5a09f12f198b`, and `api-836798d7077c`, plus site runs `site-b221ac373c4d` and `site-ae93b4fff1bc`. The API cleanup receipt reports zero resources and the site receipt is verified with zero resources; the helper retains verified bundle/receipt artifacts by design. No task test containers or networks remain. Temporary Node 24 and fixture directories were removed; root logs/screenshots remain in `/tmp`.
