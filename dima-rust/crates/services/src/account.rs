//! Account deletion across every collection, media cleanup and the files it removes. Package
//! **P4-SVC-ACCOUNT** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/account_deletion.ts` (219 lines): `deleteAccountPermanently`
//! - `utils/media_cleanup.ts` (102 lines): `cleanupChannelMediaOwnership`
//! - `utils/fs.ts` (13 lines): `readFile`
