//! Argument readers and untrusted-text helpers shared by the tools. Package **P4-SA-TOOLS-A** fills
//! this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `site_agent/tools/util.ts` (64 lines): `asObject`, `bool`, `int`, `oneOf`, `stableJson`,
//!   `str`, `untrusted`
