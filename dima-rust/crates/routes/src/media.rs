//! Files, media, the asset library, clips and speech. Package **P4-API-MEDIA** fills this module;
//! its routers are empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/routes/file.route.ts` (67 lines): `fileRoute`
//! - `server/routes/media.route.ts` (51 lines): `mediaRoute`
//! - `server/routes/asset-library.route.ts` (97 lines): `assetLibraryRoute`
//! - `server/routes/clip.route.ts` (94 lines): `clipRoute`
//! - `server/routes/speech.route.ts` (471 lines): `speechRoute`
//!
//! `POST /speech/:channelID` is open in the reference and spends the channel's AI credits; whether
//! it takes a service credential the bot sends waits for the owner (plan question 1). Its place in
//! the mount table is the `Undecided` guard.

use crate::state::RouteState;
use dima_web::Router;

/// `fileRoute`, mounted at `/video`.
pub fn file_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `mediaRoute`, mounted at `/media`.
pub fn media_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `clipRoute`, mounted at `/clip`.
pub fn clip_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `speechRoute`, mounted at `/speech`.
pub fn speech_router<S: RouteState>() -> Router<S> {
    Router::new()
}

/// `assetLibraryRoute`, mounted at `/asset-library`.
pub fn asset_library_router<S: RouteState>() -> Router<S> {
    Router::new()
}
