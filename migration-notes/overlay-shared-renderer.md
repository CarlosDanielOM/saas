# Overlay Studio shared visual renderer

**Date:** 2026-11-04
**Scope:** DimaSite Overlay Studio editor and OBS browser renderer.

## Change

The editor and OBS path now mount the same `OverlaySceneRendererComponent` for static design layers, state widgets, clips, alert layouts, event media, TTS captions, and alert sounds. The editor supplies draft/sample data and its timeline transport; the runtime supplies the live snapshot, prepared event jobs, and the viewport measured by the component. The renderer owns visual composition and applies one scene scale to the design canvas. Existing editor controls remain separate overlays.

`overlay-playback.ts` contains shared render-job types and helpers for scene scale, placement deadlines, and alert placement selection. It is data and timing support only: the runtime still owns socket delivery, its event queue, acknowledgement, and exclusive TTS audio ownership. The editor still owns its local test queue and controls. Each alert placement has its own visual deadline. Event delivery is serialized per alert box, with all boxes targeted by an event reserved until the whole event completes, matching the original OBS policy. Prepared asset bytes/URLs are reused through the existing `OverlayAssetCache` path. Idle design examples use playback epoch `0`; live and simulated events use their event playback key so editing or selection does not restart unrelated motion. Active event jobs retain their prepared layout snapshot and assets.

The runtime filters placements as individual pending IDs complete, allowing completed placements to leave the DOM while other placements in the event continue. The first audible TTS placement remains the audio owner; captions are rendered from `event.text` separately from media title/label UI.

## Reuse and boundaries

The existing OBS visual composition is the canonical rendering implementation. The editor adapts draft scene and sample state into that renderer, avoiding a second visual path. Existing specialized alert, TTS, and clip delivery semantics remain in the runtime, as documented in [`OVERLAY_WIDGET_MODULES.md`](../dimabot/OVERLAY_WIDGET_MODULES.md). No API, database schema, or socket contract change is part of this work.

## Verification and delivery

Candidate `site-246dc6ae4350` passed the isolated `saas-ops` build and exact-candidate browser verification, then was deployed on 2026-11-04. Only the site bundle was published; no backend, worker, schema, or service configuration changed. The existing wide-editor mock from the current production baseline is preserved.

- DimaSite TypeScript no-emit passed without warnings. The playback and asset-cache unit suites passed all 11 tests; the widget contract sync check passed.
- All 31 scoped browser checks passed against the exact candidate. Coverage includes editor/history/draft recovery, controls and queueing, trigger filters/placement, stacking, assets and codecs, clips, TTS, widget modules, alert keyframes/presets/timeline/sounds, image/AST/event-text readiness, and the prior cross-tab regression. The existing history suite covers English/Spanish, both themes, mobile/tablet/desktop, and accessibility checks.
- The new [renderer parity check](../ops/checks/overlay-renderer-parity-browser.mjs) passed in dark/light themes at 320, 390, and 1280 pixels. It compares animation definitions and computed frames at six playhead positions, normalized geometry, fonts/text, image readiness, selection/resize stability, TTS caption/audio ownership, per-placement expiry, and whole-event box reservation. Mobile dark and desktop light screenshots were visually reviewed.
- The initially discovered zero-size editor canvas was a Chromium layout interaction with an absolute custom-element child inside a native grid fieldset. Keeping the fieldset as a block and moving the grid to its content wrapper fixed it while retaining disabled semantics.
- Integration review added asset-cache warming, stale-request cancellation guards, and stable animation input equality. Old browser fixtures were adapted to separate selection controls from scene art and to preserve the existing OBS queue policy; obsolete clip-test producers were replaced with the current Studio preview API mock.

Source digest: `f67140022056f80df08e6ff86e4994aa4169003273580669c4db55aa86116095`.
Artifact digest: `68eb1dd40a0450b8b167a696621eef3e5b078fc4619509220bcec256e6d2c98c`.

The same parity check also passed against `https://domdimabot.com` with all API/socket/media calls mocked. Direct origin checks confirmed both editor and OBS routes serve the published CSR entrypoint and all 13 referenced JavaScript/CSS assets match the published files byte for byte. A plain Python request to the public edge returned HTTP 403; the real-browser production check succeeded. The site container retained its identity, and no backend/worker deployment occurred. The isolated preview was stopped, its loopback port was released, and helper cleanup removed temporary resources while retaining receipts and rollback artifacts. Rollback remains available through `scripts/saas-ops rollback site-246dc6ae4350`.

Existing browser tabs keep their loaded code. Reload the editor and refresh the OBS browser source to use the shared renderer. No desktop OBS application acceptance result is recorded here; the browser runtime route is covered by browser checks.

## Source references

- `dimasite/src/app/features/overlays/overlay-playback.ts`
- `dimasite/src/app/features/overlays/overlay-scene-renderer.component.ts`
- `dimasite/src/app/features/overlays/overlay-editor.component.{ts,html,css}`
- `dimasite/src/app/features/overlays/overlay-runtime.component.ts`
- `dimasite/src/app/features/overlays/overlay-layer.component.ts`
- `dimasite/src/app/features/overlays/overlay-sound.component.ts`
- `ops/checks/overlay-renderer-parity-browser.mjs`
