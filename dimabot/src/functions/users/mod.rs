//! User-related Twitch function adapters.
//!
//! `crate::functions` does not declare this module. Adding `pub mod users;`
//! in `dimabot/src/functions/mod.rs` is the lead-owned central integration
//! patch. This file only exposes the scopes adapter.

#[path = "get_scopes.users.rs"]
pub mod get_scopes;
