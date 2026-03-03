# Triggers Phase 2 Follow-Up Plan

## Goal
Finish full triggers module parity after the MVP foundation by adding richer UX, stronger validation, and overlay reliability checks.

## Current MVP Baseline (Done)
- Dedicated triggers page in `dimasite` with route and service wiring.
- Trigger CRUD, media upload/delete, and test-send flow connected to backend APIs.
- Basic inline editing and trigger/media management UI.

## Tomorrow Plan

### 1) UX parity improvements
- Add better media preview support (image, video, audio) directly in media list cards.
- Add trigger creation helper UX (preselect last used media, create-from-media shortcut).
- Add richer per-trigger status chips (file linked, last edited, validation warnings).

### 2) Trigger editing enhancements
- Add explicit dirty-state badges per trigger with discard/reset actions.
- Improve field-level validation feedback (name/cost/cooldown/volume) before submit.
- Add optional inline toggle path for trigger enabled/disabled via reward bridge (if backend supports this safely).

### 3) Media management quality
- Add MIME grouping/filter tabs (image/video/audio).
- Add duplicate-name UX guard before upload with clear recovery actions.
- Add safer delete UX for files referenced by triggers (show blocking trigger names before delete).

### 4) Overlay/test workflow improvements
- Add guided test flow with expected overlay URL and connection checklist.
- Add optional cooldown/progress feedback after test send.
- Validate overlay path behavior end-to-end in local/dev and document expected route contract.

### 5) Backend reliability polish
- Normalize trigger/media response envelopes where needed for stricter frontend typing.
- Add/extend route-level validations and clearer 4xx messages for bad payloads.
- Add focused tests for trigger upload uniqueness, trigger update payloads, and file-in-use delete guard.

### 6) Final verification
- Run `npm run build` in `dimasite` and `dimabot`.
- Manual smoke run:
  - upload media
  - create trigger
  - edit + save trigger
  - test trigger emit
  - delete trigger
  - delete media

## Suggested execution order
1. UX parity improvements
2. Trigger editing enhancements
3. Media management quality
4. Overlay/test workflow improvements
5. Backend reliability polish
6. Final verification and cleanup
