//! The widget feed: chat, event and bot-event messages for widgets, badges, signals, replay and
//! session refresh. Package **P4-FEAT-WIDGETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `widget_feed/badges.ts` (64 lines)
//! - `widget_feed/bot-events.ts` (20 lines): `duelWidgetEvent`, `petWidgetEvent`
//! - `widget_feed/chat-normalize.ts` (83 lines)
//! - `widget_feed/chat-replay.ts` (25 lines): `replayChat`
//! - `widget_feed/publisher.ts` (65 lines): `publishWidgetChatEvent`
//! - `widget_feed/session-refresh.ts` (19 lines): `flushWidgetPublishes`, `publishToWidgets`,
//!   `requestWidgetSessionRefresh`
//! - `widget_feed/signals.ts` (82 lines): `buildSignal`, `signalError`, `skippedSignals`,
//!   `widgetSignals`
//! - `widget_feed/subscriptions.ts` (101 lines): `ensureChatModerationEvents`
//! - `widget_feed/types.ts` (47 lines): `WIDGET_FEED_CHANNEL`, `widgetFeedDemandKey`
//!
//! The `widget-feed` channel reports a gap instead of dropping (F-STORE-DF-b).
