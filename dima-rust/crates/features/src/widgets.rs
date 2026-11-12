//! Widgets: the catalog, the event model and adapters, the widget service and its 1 s settle body.
//! Package **P4-FEAT-WIDGETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `widgets/catalog.ts` (10 lines): `catalog`
//! - `widgets/event-adapters.ts` (10 lines)
//! - `widgets/event-model.ts` (134 lines)
//! - `widgets/events.ts` (52 lines): `WIDGET_EVENT_MAX_AGE_MS`, `applyWidgetDomainEvent`
//! - `widgets/model.ts` (226 lines)
//! - `widgets/service.ts` (206 lines): `WidgetChannel`, `authorizeOverlay`, `execute`,
//!   `hasPremium`, `overlayTokenState`, `requirePremium`, `settleDue`, `snapshot`,
//!   `updateOverlayToken`, `widgetEventSettings`
