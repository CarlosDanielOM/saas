# Overlay Studio: full-screen studio layout

**Date:** 2026-11-04
**Scope:** DimaSite Overlay Studio editor (`/:streamer/modules/overlays`). Layout and interaction only: no API, socket, schema or OBS renderer change.

## Why

The streamer approved the `/mocks/dev/overlay-studio` proposal, which combines StreamElements' editor layout with the Live First studio. The previous page capped the editor at 80rem, so on a 1920px screen the canvas was only about 670px wide.

## What changed

- **Full screen.** Once the studio is loaded, `LayoutFocusService` hides the site navbar. Loading, error and permission screens keep it. The studio top bar holds back, the overlay name and switcher, the OBS status, the publish chip, the studio menu, and Save draft / Publish live. The menu has Back to modules, theme, language, the signed-in account and keyboard shortcuts.
- **Desktop (≥960px).** Three columns:
  - **Left:** Add (grouped palette, collapsible), Layers (drag rows to reorder; eye/lock) and Alert designs.
  - **Centre:** the canvas at true size with zoom/fit, plus a floating tool bar: Test, undo/redo, zoom, fit, snap and side panels.
  - **Right:** tabs for the *Selected layer* (settings in collapsible groups) and the *Overlay* (live controls, polls & predictions, canvas size, link/reload/delete).
- **Test drawer.** Try it is a drawer under the canvas: the canvas shrinks to make room instead of being covered. It has two columns when the centre is at least 50rem wide.
- **Alert design mode.** Event tabs sit above the canvas. The timeline, sound and length are a dock under it, Bits looks and variants are in the left panel, and design settings are in the right tab.
- **Phones.** The canvas and tool bar stay pinned on top. Bottom tabs are Layers (with alert designs), Add, Edit, Test and Overlay (or Design). Save draft / Publish live sit above the tabs. Tapping a source, a layer row or a palette item opens Edit. Opening a design opens Edit, which leads with variants and ends with the timeline. Scroll padding keeps focused fields clear of the pinned canvas and bottom bars.
- **New editing behaviour:**
  - Snap guides to canvas edges/centre and other layers.
  - Delete/Backspace remove the selection, and focus stays in the studio so Ctrl+Z undoes it.
  - `+`/`-`/`0` and Ctrl+scroll zoom.
  - Clicking empty canvas clears the selection.

### Where the old sections went

| Before | Now |
|---|---|
| Header chips (OBS, live/unpublished, Alpha) | Top bar chips; OBS chip opens the link panel |
| Overlay tabs | Overlay switcher (name ▾), `.scene-tab[data-id]` inside it |
| OBS setup strip + connection diagnostics | OBS link panel (always mounted, so status keeps updating) |
| Polls & predictions setup, Live overlay controls | Right panel → Overlay tab |
| Overlay/design settings (`details.publish-settings`) | Right panel → Overlay/Design tab ("Canvas and more", open by default) |
| Try it (tests, OBS test, queue order) | Test drawer (desktop) / Test tab (phones) |
| Alert designs card | Left panel (desktop) / Layers tab (phones) |
| Save bar | Top right (desktop) / above the tabs (phones) |

## Checks

- `ops/checks/overlay-studio-ui-helpers.mjs`: shared helpers that open the Test drawer, the Overlay tab, the switcher, the OBS panel and the studio menu on either layout.
- `overlay-studio-redesign-browser.mjs` now covers the new layout:
  - status chip and amber OBS panel, switcher, move pad and grouped undo, toggles and save states;
  - zoom/fit, side panels, the drawer never covering the canvas, the snap guide, layer drag order, keyboard delete/undo/zoom, the studio menu, the navbar restored on leave;
  - phone tabs and pinned canvas, EN/ES, both themes and axe.
- Existing editor checks were adapted to open the panel they use. Their assertions are unchanged except old-layout ones (phone section order, the one-row layer strip, the navbar language switch).
- `overlay-studio-suite.mjs` now runs five bounded batches (motion, editor, reliability, renderer, samples: 32 checks) for `saas-ops verify`.

## Verification and delivery

Candidate `site-78ef5b17701d` was built from `c46bb274` plus only this change, in an isolated worktree. A parallel commands feature (`54e925e5`, random viewer exclusions) had uncommitted and then committed site changes whose API was not deployed yet, so they were left out.

- During development, every editor check ran against a loopback dev server, with layout and accessibility screenshots reviewed at 1920/1280/390 in dark and light.
- `saas-ops verify` on the exact candidate passed all five batches: motion 7, editor 7, reliability 7, renderer 6 and samples 5 (32 checks, including runtime/OBS checks). `overlay-studio-wide.mjs` (the mock) also passed. Only the old warnings remain: the initial bundle budget and CommonJS modules.
- Deployed on 2026-11-04. Rollback: `scripts/saas-ops rollback site-78ef5b17701d`.

### Known limits

- The studio hides the site navbar. Theme, language and Back to modules are in the studio menu (the avatar button), and the site's permission banners don't show inside the studio.
- Tablets between 960 and 1279px get the desktop layout with narrower side panels; the Side panels button gives the canvas the full width.
