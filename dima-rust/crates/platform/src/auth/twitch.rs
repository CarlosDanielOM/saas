//! The two Twitch calls the authentication layer makes with a *user's* own token, Twitch's token
//! validation and the Helix user lookup: [`dima_twitch::Twitch::validate_user_token`] and
//! [`dima_twitch::Twitch::user_by_token`] (they replaced the seam this module held before they
//! existed, P4-API-APP).
//!
//! [`TwitchUserApi`] is what [`crate::auth::Authenticator`] and the OAuth server's browser
//! proof ([`crate::oauth::OAuthService::browser_user`]) call; [`dima_twitch::Twitch`] implements
//! it, and a test can wrap it (to hold an answer, for instance). The decisions (what is a
//! refusal, which message the client sees) are the callers'.
//!
//! The token travels in a sensitive header only; no error, log line or `Debug` output holds it.

use dima_core::SecretString;
use futures_util::future::BoxFuture;
use std::fmt;

pub use dima_twitch::functions::users::TwitchUser;
pub use dima_twitch::{UserTokenError, ValidatedToken};

/// The two calls.
pub trait TwitchUserApi: Send + Sync + fmt::Debug {
    /// `GET id.twitch.tv/oauth2/validate` with the user's token.
    fn validate<'a>(
        &'a self,
        token: &'a SecretString,
    ) -> BoxFuture<'a, Result<ValidatedToken, UserTokenError>>;

    /// `GET api.twitch.tv/helix/users` with the user's token (and the application's
    /// `Client-Id`).
    fn user<'a>(
        &'a self,
        token: &'a SecretString,
    ) -> BoxFuture<'a, Result<TwitchUser, UserTokenError>>;
}

impl TwitchUserApi for dima_twitch::Twitch {
    fn validate<'a>(
        &'a self,
        token: &'a SecretString,
    ) -> BoxFuture<'a, Result<ValidatedToken, UserTokenError>> {
        Box::pin(self.validate_user_token(token))
    }

    fn user<'a>(
        &'a self,
        token: &'a SecretString,
    ) -> BoxFuture<'a, Result<TwitchUser, UserTokenError>> {
        Box::pin(self.user_by_token(token))
    }
}
