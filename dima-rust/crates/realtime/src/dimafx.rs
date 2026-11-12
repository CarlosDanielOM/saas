//! The DimaFX queue: playback leases (5 s renewal), redelivery over sockets, the DimaFX service,
//! and purchase recovery. Package **P4-RT-CLIP-FX** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `handlers/dimafx_queue.handler.ts` (320 lines): `dimafxQueueHandler`
//! - `server/services/dimafx.service.ts` (177 lines): `dimafxItemUsesViewerInput`,
//!   `getAllowedDimafxBitPrices`, `getDimafxSkuForBitsPrice`, `hasDimafxPermission`,
//!   `normalizeDimafxPurchaseAction`, `normalizeDimafxTtsConfig`, `normalizeDimafxViewerConfig`,
//!   `sanitizeDimafxViewerTtsText`, `selectRedeemCandidate`
//! - `schemas/dimafx_playback.schema.ts` (32 lines)
//! - `utils/dimafx_data.ts` (32 lines): `deleteChannelDimafxData`
//!
//! `recoverDimafxPurchases` moves here from `dimafx.route.ts` (the helper that made
//! `dimafx-overlay.service.ts` import the route; plan section 2.1). DimaFX items are paid with
//! Bits: delivered once.
