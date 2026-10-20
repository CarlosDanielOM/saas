//! Lazy, process-wide access to the native MongoDB driver.
//!
//! [`get_mongo_client`] reads `MONGO_URI` from the process environment during
//! initialization attempts. It does not load `.env` files, select a database, or
//! configure URI options beyond what the driver already supports.
//!
//! The client is stored in a static [`OnceCell`]. Use it within the
//! application's long-lived Tokio runtime and share it across tasks and
//! threads. Static storage does not keep the driver's originating runtime
//! alive; do not reuse the cached client after that runtime or the client has
//! been shut down. Clone the client when an owned handle is needed; clones
//! share the underlying connection pool.

use std::env;

use mongodb::{
    Client,
    bson::doc,
    error::{Error, Result},
    options::ClientOptions,
};
use tokio::sync::OnceCell;

const MISSING_URI_MESSAGE: &str =
    "MONGO_URI is not set; set it to a MongoDB connection string before calling get_mongo_client";
const NON_UNICODE_URI_MESSAGE: &str =
    "MONGO_URI is not valid UTF-8; set it to a UTF-8 MongoDB connection string";
const BLANK_URI_MESSAGE: &str =
    "MONGO_URI is blank; set it to a non-empty MongoDB connection string";
const INVALID_URI_MESSAGE: &str = concat!(
    "MONGO_URI is not a usable MongoDB connection string; check its scheme, hosts, and ",
    "percent-encoded credentials. The raw value is omitted from this error"
);
const INVALID_OPTIONS_MESSAGE: &str = concat!(
    "MONGO_URI produced invalid MongoDB client options; check its query options. ",
    "The raw value is omitted from this error"
);

static CLIENT: OnceCell<Client> = OnceCell::const_new();

/// Returns the process-wide MongoDB client, creating and verifying it on first
/// success.
///
/// Initialization reads `MONGO_URI`, parses the connection string, creates a
/// native driver [`Client`], and pings the `admin` database before storing it.
/// Use the cached client within the application's long-lived Tokio runtime and
/// share it across tasks and threads. Static storage does not keep the driver's
/// originating runtime alive; do not reuse the client after that runtime or the
/// client has been shut down. Clone it for an owned handle, which shares the
/// same connection pool.
///
/// Missing, non-UTF-8, blank, or invalid `MONGO_URI` values fail with static
/// actionable errors that do not repeat the raw URI. Network and authentication
/// failures keep the driver's error. A failed or cancelled initialization does
/// not poison the cell: a later call retries with the current environment.
/// The environment is read only while initializing, so changing `MONGO_URI`
/// after the first success has no effect.
pub async fn get_mongo_client() -> Result<&'static Client> {
    CLIENT
        .get_or_try_init(|| async {
            let uri = read_mongo_uri()?;

            // Parse separately so malformed connection strings (including
            // malformed credentials) can be sanitized before they reach callers.
            let options = ClientOptions::parse(&uri)
                .await
                .map_err(|_| config_error(INVALID_URI_MESSAGE))?;
            let client =
                Client::with_options(options).map_err(|_| config_error(INVALID_OPTIONS_MESSAGE))?;

            // A client is created lazily and does not prove that the deployment
            // is reachable or that the credentials work.
            client
                .database("admin")
                .run_command(doc! { "ping": 1 })
                .await?;

            Ok(client)
        })
        .await
}

fn read_mongo_uri() -> Result<String> {
    validate_mongo_uri(env::var("MONGO_URI"))
}

fn validate_mongo_uri(raw: std::result::Result<String, env::VarError>) -> Result<String> {
    match raw {
        Ok(uri) if uri.trim().is_empty() => Err(config_error(BLANK_URI_MESSAGE)),
        Ok(uri) => Ok(uri),
        Err(env::VarError::NotPresent) => Err(config_error(MISSING_URI_MESSAGE)),
        Err(env::VarError::NotUnicode(_)) => Err(config_error(NON_UNICODE_URI_MESSAGE)),
    }
}

fn config_error(message: &'static str) -> Error {
    // The driver only renders custom error payloads that are `String`s.
    Error::custom(message.to_owned())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn missing_uri_is_rejected_with_a_static_message() {
        let error = validate_mongo_uri(Err(env::VarError::NotPresent))
            .expect_err("a missing MONGO_URI must be rejected");

        assert!(error.to_string().contains(MISSING_URI_MESSAGE));
    }

    #[test]
    fn non_unicode_uri_is_rejected_with_a_static_message() {
        let error = validate_mongo_uri(Err(env::VarError::NotUnicode(OsString::from(
            "mongodb://example.invalid",
        ))))
        .expect_err("a non-UTF-8 MONGO_URI must be rejected");

        assert!(error.to_string().contains(NON_UNICODE_URI_MESSAGE));
    }

    #[test]
    fn blank_uri_is_rejected_with_a_static_message() {
        let error = validate_mongo_uri(Ok(" \t\n".to_owned()))
            .expect_err("a blank MONGO_URI must be rejected");

        assert!(error.to_string().contains(BLANK_URI_MESSAGE));
    }

    #[test]
    fn non_blank_uri_is_preserved() {
        let uri = "mongodb://user:pass@localhost:27017/app?retryWrites=true";

        assert_eq!(
            validate_mongo_uri(Ok(uri.to_owned())).expect("a non-blank URI must be accepted"),
            uri
        );
    }
}
