//! Custom widget bundles: format validation, files, media copy, history, sessions and state.
//! Package **P4-FEAT-ASSETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `custom_widgets/format.ts` (472 lines): `CUSTOM_WIDGET_LIMITS`, `CUSTOM_WIDGET_PLAN_LIMITS`,
//!   `PACKAGE_FILES`, `PackageFormatError`, `STATE_NAMES`, `checkOverrides`, `inferManifest`,
//!   `outsideCode`, `readPackage`
//! - `custom_widgets/files.ts` (47 lines): `deleteKeys`, `describeFiles`, `putFiles`, `readFile`
//! - `custom_widgets/goal-source.ts` (9 lines): `layerGoalSource`
//! - `custom_widgets/history.ts` (24 lines): `HISTORY_BYTES`, `HISTORY_REVISIONS`, `keptRevisions`
//! - `custom_widgets/state.ts` (39 lines): `channelGoals`, `publicGoals`
//! - `custom_widgets/session.ts` (208 lines): `alertFromEventsub`, `sessionFor`
//! - `custom_widgets/media.ts` (127 lines): `copyMedia`, `planMediaCopy`
//!
//! The custom widget store and its live side (`custom_widgets/store.ts`, `widget-store.ts`) are
//! `dima-realtime::overlay_live` (P4-RT-OVERLAY-LIVE).
