//! Media and private asset helpers ported from `assets/library.ts`, `assets/http.ts`,
//! `server/services/media_library.service.ts` and the two media routes. Private
//! GridFS assets and S3 media are separate stores; no I/O occurs at module load.

#[cfg(feature = "media-assets")]
pub mod asset_library_route;
#[cfg(feature = "media-assets")]
pub mod http;
#[cfg(feature = "media-assets")]
pub mod library;
#[cfg(feature = "media-assets")]
pub mod library_service;
#[cfg(feature = "media-assets")]
pub mod media_route;
