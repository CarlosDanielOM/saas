//! The Overlay Studio live loop: socket sessions (twelve events), widget RPC acknowledgements,
//! delivery leases, the 1 s loop and the 15 s GridFS sweep, and the custom widget store. Package
//! **P4-RT-OVERLAY-LIVE** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `overlays/live.ts` (854 lines): `bitsRuleFor`, `controlStudio`, `ensureWidgetModeration`,
//!   `eventFor`, `feedSignal`, `feedTestAlert`, `feedTestEvent`, `fileFor`, `publicWidgetStateFor`,
//!   `publishStudioAlert`, `publishTest`, `queueStatus`, `registerStudio`, `studioConnections`,
//!   `studioHasSource`
//! - `custom_widgets/store.ts` (362 lines): `CustomWidgetError`, `CustomWidgets`, `channelInfo`,
//!   `checkCustomLayers`, `createWidget`, `deleteWidget`, `listWidgets`, `mediaUrls`,
//!   `overlaysLive`, `pruneRevisions`, `publishedBundle`, `publishedCopy`, `publishedLayers`,
//!   `publishedMediaAsset`, `renameWidget`, `replaceFiles`, `widgetBundle`, `widgetFile`,
//!   `widgetMediaAsset`
//! - `custom_widgets/widget-store.ts` (59 lines): `commandCount`, `storeGet`
