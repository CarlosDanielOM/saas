# Overlay Studio cross-tab request storm

**Date:** 2026-11-04

**Scope:** DimaSite authenticated shell and Overlay Studio interaction readiness API.

## Incident and cause

Production observation reached 76 channel requests in one second. Reproduction with two authenticated tabs open to different channels generated about 587 readiness/queue requests and 588 connection calls in two seconds. The tabs repeatedly wrote their channel preference to shared local storage. The authenticated layout's preference effect tracked `lastViewedStreamer`, so a preference update from one tab caused the other tab to reassert its own channel. The session storage listener also rebuilt the session for preference-only events. The auth interceptor read the session snapshot reactively, allowing request effects to depend on that session metadata and restart on each update.

## Changes

- The authenticated layout now writes the last-viewed channel without tracking the preference signal that triggered the effect.
- Storage synchronization updates the session only for session-key changes; channel preference changes update only the preference signal.
- The auth interceptor reads a credential snapshot untracked, so unrelated session metadata cannot retrigger callers' request effects.
- The API reuses `getEventsubs(channel)`'s optional channel filter and caches readiness per channel for 15 seconds after success and 10 seconds after failure, with a 500-entry bound. In-flight reads coalesce; explicit activation invalidates the cached value before and after activation. Existing remote subscription adoption and permission checks remain in the interaction path.
- English and Spanish status copy now says “All changes published” / “Todos los cambios publicados”; it does not claim an OBS connection state.

## Verification and release

The native Sol-high frontend reproduction measured approximately 587 readiness/queue requests and 588 connection calls in two seconds before the fixes; after the fix the second-tab window produced only the normal queue poll. Preview browser checks passed at mobile and desktop sizes in dark and light themes, in English and Spanish, with axe and runtime diagnostics.

API candidate `api-a58e7a9d2271` passed `ops/checks/overlay-interactions.mjs` against disposable MongoDB/Redis and provider fixtures: 26 unit tests plus authenticated routes, concurrent readiness reads, failure cooldown, activation, projection, and socket checks passed. It deployed at 2026-11-04 21:09 UTC. Startup and public unauthenticated `401` checks passed; natural authenticated Twitch-events traffic recovered from `502` to `200`. Rollback: `scripts/saas-ops rollback api-a58e7a9d2271`. No database migration, bot deployment, or cron deployment was needed.

Site candidate `site-6b40d57afea6` passed both `overlay-cross-tab-browser.mjs` and `overlay-connections-browser.mjs` against the exact production bundle, including real cross-tab events, failed reads, token renewal, logout/storage clearing, bounded polling, disposal, honest published status, connection recovery, native playback, EN/ES, both themes, 320–1440px viewports and axe. It was deployed on 2026-11-04. The cross-tab regression also passed against the live-served site with every API and socket mocked; public entrypoints and the new English status asset were checked separately. Rollback: `scripts/saas-ops rollback site-6b40d57afea6`.

The development preview and its temporary source copy were removed. Both release runs were cleaned through `saas-ops`, retaining receipts and rollback artifacts. Existing loaded tabs still require a refresh; the live-site browser check verifies the newly served code, not replacement of already running JavaScript in user tabs.

Users need to reload **all open DomDimaBot tabs** to replace the old JavaScript bundle; a stale tab can continue the cross-tab preference loop.

## Source references

- `dimasite/src/app/features/layout/authenticated-layout.component.ts`
- `dimasite/src/app/services/session-auth.service.ts`
- `dimasite/src/app/interceptors/auth-header.interceptor.ts`
- `dimasite/src/assets/i18n/{en,es}.json`
- `dimabot/src/overlays/interaction-subscriptions.ts`
- `dimabot/src/overlays/readiness-cache.ts`
- `dimabot/src/utils/eventsub.ts`
- `ops/checks/overlay-interactions.mjs`
- `ops/checks/overlay-cross-tab-browser.mjs`
