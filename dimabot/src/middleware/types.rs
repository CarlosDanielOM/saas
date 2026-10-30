//! Native equivalents of the exported TypeScript types in
//! `dimabot/src/middleware/types.ts`.
//!
//! `types.ts` is type-only apart from static interfaces, so no runtime behavior
//! is migrated here. Express `Request` inheritance becomes [`AuthRequest`], a
//! small native carrier for the authenticated identity that the Axum middleware
//! also stores in request extensions. See `auth.middleware.rs` for the working
//! middleware that produces these values.

use axum::http::Extensions;
use serde::{Deserialize, Serialize};

/// Value of the `type` field for a missing `Authorization` header.
pub const ERROR_TYPE_NO_TOKEN: &str = "no_token";
/// Value of the `type` field for an unvalidated or invalid token.
pub const ERROR_TYPE_INVALID_TOKEN: &str = "invalid_token";
/// Value of the `type` field when the Twitch user lookup fails.
pub const ERROR_TYPE_USER_FETCH_FAILED: &str = "user_fetch_failed";
/// Value of the `type` field for the outer unexpected-failure branch.
pub const ERROR_TYPE_INTERNAL_ERROR: &str = "internal_error";

/// The identity attached to an authenticated request.
///
/// Mirrors `AuthenticatedUser`. `profile_image_url` stays optional because both
/// an absent hash field and a nullable upstream field are supported by the
/// TypeScript interface.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthenticatedUser {
    pub id: String,
    pub login: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image_url: Option<String>,
}

/// Native equivalent of `AuthRequest` (`Request & { user?: AuthenticatedUser }`).
///
/// Axum handlers read the identity from request extensions; this carrier is the
/// typed view of the same state and is what the middleware inserts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<AuthenticatedUser>,
}

impl AuthRequest {
    /// Reads the authenticated identity previously inserted by the middleware.
    pub fn from_extensions(extensions: &Extensions) -> Self {
        Self {
            user: extensions.get::<AuthenticatedUser>().cloned(),
        }
    }

    /// Attaches the identity so later Axum layers and handlers can read it.
    pub fn insert(&self, extensions: &mut Extensions) {
        match &self.user {
            Some(user) => {
                extensions.insert(user.clone());
            }
            None => {
                extensions.remove::<AuthenticatedUser>();
            }
        }
    }
}

impl From<AuthenticatedUser> for AuthRequest {
    fn from(user: AuthenticatedUser) -> Self {
        Self { user: Some(user) }
    }
}

/// Declared shape of a successful Twitch token validation response.
///
/// Fields are required, so a malformed validation body is rejected as a failed
/// validation instead of being used with absent fields.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TwitchTokenValidation {
    pub client_id: String,
    pub login: String,
    pub scopes: Vec<String>,
    pub user_id: String,
    pub expires_in: f64,
}

/// One Twitch Helix user entry. Field names match the upstream JSON exactly.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TwitchUser {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub profile_image_url: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub broadcaster_type: String,
    pub created_at: String,
}

/// Declared shape of `GET /helix/users`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TwitchUsersResponse {
    pub data: Vec<TwitchUser>,
}

/// Declared cache value shape.
///
/// The middleware's Redis protocol is the flat hash described by
/// `CachedTokenData`'s inherited user fields; `cached_at` is a type-level field
/// only and is never written by the source cache helpers, so this port keeps it
/// out of the Redis protocol as well.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CachedTokenData {
    #[serde(flatten)]
    pub user: AuthenticatedUser,
    pub cached_at: f64,
}

impl CachedTokenData {
    /// Combines a cached identity with a caller-supplied age. No I/O.
    pub fn new(user: AuthenticatedUser, cached_at: f64) -> Self {
        Self { user, cached_at }
    }

    /// Returns the identity, dropping the type-only age field.
    pub fn into_user(self) -> AuthenticatedUser {
        self.user
    }
}

/// The middleware's JSON error body: `{ error, message, status, type }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: bool,
    pub message: String,
    pub status: u16,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl ErrorResponse {
    fn new(message: impl Into<String>, status: u16, kind: &str) -> Self {
        Self {
            error: true,
            message: message.into(),
            status,
            r#type: kind.into(),
        }
    }

    /// Exact body for a missing or empty token.
    pub fn no_token() -> Self {
        Self::new("No token provided", 401, ERROR_TYPE_NO_TOKEN)
    }

    /// Body for a token Twitch did not validate.
    pub fn invalid_token(message: impl Into<String>) -> Self {
        Self::new(message, 401, ERROR_TYPE_INVALID_TOKEN)
    }

    /// Body for a failed user lookup after successful validation.
    pub fn user_fetch_failed(message: impl Into<String>) -> Self {
        Self::new(message, 401, ERROR_TYPE_USER_FETCH_FAILED)
    }

    /// Body for the outer unexpected-failure branch.
    pub fn internal_error() -> Self {
        Self::new("Internal server error", 500, ERROR_TYPE_INTERNAL_ERROR)
    }
}
