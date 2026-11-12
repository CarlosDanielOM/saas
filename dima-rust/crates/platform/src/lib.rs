//! Outside platform adapters. No SDKs or environment access.
#![forbid(unsafe_code)]
pub mod access;
pub mod auth;
pub mod clips;
pub mod extension_fulfilment;
pub mod media_library;
pub mod oauth;
pub mod process;
pub mod s3;
pub mod tts_usage;
