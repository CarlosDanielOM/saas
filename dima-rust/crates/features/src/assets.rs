//! The asset library: uploads with their probes and quotas, consumers, serving. Package
//! **P4-FEAT-ASSETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `assets/library.ts` (156 lines): `AssetError`, `MAX_ASSET_BYTES`, `assetQuota`, `deleteAsset`,
//!   `findAsset`, `listAssets`, `registerAssetConsumer`, `requireMoodAssetPlan`, `uploadAsset`,
//!   `withAssetLibrary`
//! - `assets/http.ts` (34 lines): `serveAsset`
