//! Overlay Studio without sockets: the model and store, revisions and publishing, alert events and
//! interactions, ad schedule and hype train, assets, readiness, test playback, and overlay tokens.
//! Package **P4-FEAT-OVERLAYS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `overlays/ad-schedule.ts` (53 lines): `adSchedule`, `refreshAdSchedule`, `updateAdSchedules`
//! - `overlays/alert-events.ts` (24 lines): `ALERT_DOMAIN_TYPES`, `AlertEventFilter`
//! - `overlays/assets.ts` (25 lines): `snapshotAssets`, `validateAssets`
//! - `overlays/ast.ts` (47 lines): `renderLayout`, `renderTemplate`, `sampleEvent`
//! - `overlays/bridge.ts` (38 lines): `controlStudioTts`, `endStudioReadTts`, `publishStudioMedia`,
//!   `publishStudioReadTts`, `publishStudioTrigger`, `publishWidgetEvent`, `registerStudioBridge`,
//!   `reloadCustomWidget`, `studioHasLiveSource`, `studioHasSource`, `studioQueueChannels`,
//!   `studioTtsStatus`, `widgetsUse`
//! - `overlays/controls.ts` (10 lines): `OVERLAY_ACTIONS`, `OVERLAY_PLATFORMS`,
//!   `initialQueueState`, `platformMatches`
//! - `overlays/delivery-store.ts` (39 lines): `DELIVERY_TTL_MS`, `LEASE_MS`, `MAX_CHANNEL_BYTES`,
//!   `MAX_PENDING`, `deliveries`, `leases`, `readFileStream`, `releaseFile`, `retainFile`,
//!   `sweepFiles`
//! - `overlays/interaction-model.ts` (79 lines): `INTERACTION_EVENT_TYPES`,
//!   `INTERACTION_SUBSCRIPTIONS`, `parseInteraction`
//! - `overlays/interaction-subscriptions.ts` (79 lines): `activateInteraction`,
//!   `interactionReadiness`
//! - `overlays/interactions.ts` (137 lines): `LiveState`, `applyInteractionEvent`,
//!   `resyncHypeTrain`, `resyncInteractions`, `saveLive`
//! - `overlays/keyframes.ts` (36 lines)
//! - `overlays/live-events-model.ts` (146 lines): `AD_BREAK_EVENT_TYPES`, `HYPE_TRAIN_EVENT_TYPES`,
//!   `LIVE_EVENT_DOMAIN_TYPES`, `hypeTrainOverdue`, `parseAdBreak`, `parseHypeTrain`, `publicAds`,
//!   `publicHypeTrain`
//! - `overlays/model.ts` (91 lines): `ALERT_EVENTS`, `EVENT_KINDS`, `matchesTrigger`,
//!   `selectAlertLayout`
//! - `overlays/publish.ts` (46 lines): `PublishBlocked`, `buildPublished`, `liveStatus`
//! - `overlays/readiness-cache.ts` (21 lines)
//! - `overlays/recover.ts` (27 lines): `recoverCopies`
//! - `overlays/store.ts` (178 lines): `OverlayError`, `Studio`, `change`, `load`, `object`,
//!   `publicState`, `requireOverlayAccount`, `string`, `token`, `validateState`
//! - `overlays/test-playback.ts` (76 lines): `prepareTest`, `previewMedia`, `testFile`,
//!   `withTestLock`
//! - `overlays/widget-contract.ts` (91 lines): `getWidgetDefinition`, `validWidgetModuleConfig`
//! - `overlays/widget-state-providers.ts` (21 lines): `legacyInteractions`, `widgetStateRegistry`
//! - `overlays/widget-state.ts` (75 lines)
//! - `utils/overlay-token.ts` (53 lines): `manageOverlayToken`, `overlayTokenHash`,
//!   `readOverlayToken`, `rememberOverlayToken`, `storedOverlayToken`
//!
//! Overlay text is rendered with `dima-engine` and no host (plan section 2.3). The live loop
//! (`overlays/live.ts`) is `dima-realtime::overlay_live` (P4-RT-OVERLAY-LIVE).
