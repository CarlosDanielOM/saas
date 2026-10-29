//! Compatibility path for provider consumers of the shared lossless JSON type.
pub(crate) use crate::utils::lossless_json::parse_with_depth_error;
pub use crate::utils::lossless_json::{JsonValue, parse_json};
