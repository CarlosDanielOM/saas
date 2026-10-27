//! Lazy, process-wide Qdrant client, mirroring
//! `dimabot/src/utils/databases/qdrant.database.ts`.
//!
//! The TypeScript client uses Qdrant's REST API on `QDRANT_PORT` (6333 in
//! production). The official Rust client speaks gRPC only, so this utility
//! reads the same `QDRANT_HOST` and `QDRANT_API_KEY`, plus `QDRANT_GRPC_PORT`
//! (default 6334, the production server's gRPC port). Like the TypeScript
//! code it connects over plain `http://` inside the private Docker network.
//!
//! Initialization lists collections, as `getCollections()` does in
//! TypeScript, before caching the client. A failed attempt is not cached and
//! a later call retries. The crate's own client/server version check is
//! skipped; the dependency is pinned to the production server's minor version.
//!
//! [`QdrantUtilities`] ports all eleven sources under the TypeScript Qdrant
//! folder, with child modules for collection startup, chat, memory, and pure
//! parity helpers. Construction is I/O-free: callers explicitly connect using
//! this existing connector and inject embedding, language, queue, and telemetry
//! adapters. Unported AI prompt assembly and authoritative memory policy remain
//! caller responsibilities. This API stays behind the opt-in `qdrant` feature;
//! it does not register workers or change deployed/default feature profiles.

// Returns the client crate's own `QdrantError`, like every Qdrant API call,
// so callers can use `?` across setup and queries.
#![allow(clippy::result_large_err)]

use std::env;

use qdrant_client::{Qdrant, QdrantError};
use tokio::sync::OnceCell;

#[path = "../qdrant/backend.rs"]
mod backend;
#[path = "../qdrant/chat.rs"]
mod chat;
#[path = "../qdrant/collections.rs"]
mod collections;
#[path = "../qdrant/memory.rs"]
mod memory;
#[path = "../qdrant/parity.rs"]
mod parity;
#[path = "../qdrant/types.rs"]
mod types;

pub use backend::*;
pub use chat::*;
pub use collections::*;
pub use memory::*;
pub use parity::*;
pub use types::*;

/// Default gRPC port of the production Qdrant service.
pub const DEFAULT_GRPC_PORT: u16 = 6334;

const MISSING_MESSAGE: &str =
    "QDRANT_HOST or QDRANT_API_KEY is not set; set both before calling get_qdrant_client";
const INVALID_PORT_MESSAGE: &str =
    "QDRANT_GRPC_PORT is not a usable TCP port; set it to an integer from 1 to 65535";

static CLIENT: OnceCell<Qdrant> = OnceCell::const_new();

/// Connection settings read from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QdrantSettings {
    pub host: String,
    pub grpc_port: u16,
    pub api_key: String,
}

impl QdrantSettings {
    /// Reads `QDRANT_HOST`, `QDRANT_API_KEY`, and optional `QDRANT_GRPC_PORT`.
    pub fn from_env() -> Result<Self, QdrantError> {
        Self::from_values(
            env::var("QDRANT_HOST").ok(),
            env::var("QDRANT_API_KEY").ok(),
            env::var("QDRANT_GRPC_PORT").ok(),
        )
    }

    fn from_values(
        host: Option<String>,
        api_key: Option<String>,
        grpc_port: Option<String>,
    ) -> Result<Self, QdrantError> {
        let host = host.filter(|value| !value.trim().is_empty());
        let api_key = api_key.filter(|value| !value.trim().is_empty());
        let (Some(host), Some(api_key)) = (host, api_key) else {
            return Err(config_error(MISSING_MESSAGE));
        };
        let grpc_port = match grpc_port.filter(|value| !value.trim().is_empty()) {
            None => DEFAULT_GRPC_PORT,
            Some(value) => match value.trim().parse::<u16>() {
                Ok(port) if port > 0 => port,
                _ => return Err(config_error(INVALID_PORT_MESSAGE)),
            },
        };
        Ok(Self {
            host: host.trim().to_owned(),
            grpc_port,
            api_key,
        })
    }

    /// The gRPC endpoint URL.
    pub fn url(&self) -> String {
        format!("http://{}:{}", self.host, self.grpc_port)
    }
}

/// Returns the process-wide Qdrant client, verifying it on first success.
pub async fn get_qdrant_client() -> Result<&'static Qdrant, QdrantError> {
    CLIENT
        .get_or_try_init(|| async { connect(&QdrantSettings::from_env()?).await })
        .await
}

/// Builds a client for explicit settings and lists collections to verify it.
pub async fn connect(settings: &QdrantSettings) -> Result<Qdrant, QdrantError> {
    let client = Qdrant::from_url(&settings.url())
        .api_key(settings.api_key.clone())
        .skip_compatibility_check()
        .build()?;
    client.list_collections().await?;
    Ok(client)
}

fn config_error(message: &str) -> QdrantError {
    QdrantError::ConversionError(message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(
        host: Option<&str>,
        key: Option<&str>,
        port: Option<&str>,
    ) -> Result<QdrantSettings, QdrantError> {
        QdrantSettings::from_values(
            host.map(str::to_owned),
            key.map(str::to_owned),
            port.map(str::to_owned),
        )
    }

    #[test]
    fn defaults_to_the_grpc_port() {
        let parsed = settings(Some("qdrant"), Some("secret"), None).unwrap();
        assert_eq!(parsed.url(), "http://qdrant:6334");
        assert_eq!(parsed.api_key, "secret");
    }

    #[test]
    fn honors_an_explicit_grpc_port() {
        let parsed = settings(Some("qdrant"), Some("secret"), Some("7334")).unwrap();
        assert_eq!(parsed.url(), "http://qdrant:7334");
    }

    #[test]
    fn requires_host_and_key_without_echoing_values() {
        for (host, key) in [
            (None, Some("secret")),
            (Some("qdrant"), None),
            (Some(" "), Some("secret")),
        ] {
            let error = settings(host, key, None).unwrap_err().to_string();
            assert!(error.contains(MISSING_MESSAGE), "{error}");
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn rejects_bad_ports() {
        for port in ["0", "65536", "abc", "-1"] {
            let error = settings(Some("qdrant"), Some("secret"), Some(port))
                .unwrap_err()
                .to_string();
            assert!(error.contains(INVALID_PORT_MESSAGE), "{port}: {error}");
        }
    }
}
