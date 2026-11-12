//! Roulettes: the model, revisions, the overlay snapshot and token, and the due winner actions.
//! Package **P4-FEAT-GAMES** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `roulette/model.ts` (236 lines): `RouletteError`, `configure`, `create`, `emptyState`, `fail`,
//!   `find`, `importItems`, `integer`, `object`, `text`, `updateItem`
//! - `roulette/service.ts` (173 lines): `RouletteChannel`, `authorizeOverlay`, `execute`,
//!   `overlaySnapshot`, `overlayTokenState`, `snapshot`, `updateOverlayToken`
//! - `roulette/actions.ts` (50 lines): `runDueActions`
//!
//! Winner actions render and post through `dima_twitch::chat::ChatOut::deliver`
//! (`roulette/actions.ts:28-34`); actions are validated with `dima-engine`'s parser.
