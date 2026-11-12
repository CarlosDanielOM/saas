//! The services the desktop API calls that other packages port: the desktop AI turns
//! (`desktop_ai/service.ts`, P4-RT-DESKTOP), the pet (`pets/state.ts`, `pets/runtime.ts`,
//! `pets/selection.ts`, `server/services/pet_settings.service.ts`; P4-FEAT-PETS, P4-RT-PETS)
//! and the AI credits (`utils/billing.ts`, `utils/ai_credit_display.ts`; P2-BILLING). Each is a
//! seam registered in [`crate::state::Services`] by the binary; until it is, its routes answer
//! `503 {"error":"temporarily_unavailable"}` (the reference's answer for an unexpected failure)
//! and the missing registration is logged.
//!
//! The inputs these routes pass on are the body as the client sent it, because the reference's
//! services validate it themselves (`submitTurn`, `cancelSpeech`, `speechEvent`,
//! `selectOwnPetPlayback`): an implementation parses it into its own typed input before any
//! use and answers [`AreaError`] (`invalid_request`, `invalid_command`) when it does not fit.

use super::OAuthAccess;
use crate::state::ServiceKey;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::borrow::Cow;

/// An error of one of these services with the code and status the client sees, as the
/// reference's `PetError`, `PetSettingsError` and the desktop AI's `OAuthError` carry them:
/// `{"error": code}`, `WWW-Authenticate` on 401, `Retry-After: 60` on 429.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct AreaError {
    /// The code.
    pub code: Cow<'static, str>,
    /// The HTTP status.
    pub status: u16,
}

impl AreaError {
    /// `new PetError(code)`: status 400.
    pub fn new(code: impl Into<Cow<'static, str>>) -> Self {
        Self::with_status(code, 400)
    }

    /// An error with its status.
    pub fn with_status(code: impl Into<Cow<'static, str>>, status: u16) -> Self {
        Self {
            code: code.into(),
            status,
        }
    }
}

/// What these services answer.
pub type AreaResult<T> = Result<T, AreaError>;

/// An audio file a turn produced (`claimAudio`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnAudio {
    /// `Content-Type` to send.
    pub mime_type: String,
    /// Absolute path of the file.
    pub path: String,
}

/// `desktop_ai/service.ts` as the desktop API calls it.
pub trait DesktopTurns: Send + Sync {
    /// `submitTurn(identity, body)`: the answer of `POST /v1/me/ai/turns` (sent with 202).
    fn submit<'a>(
        &'a self,
        who: &'a OAuthAccess,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>>;
    /// `getTurn(identity, id, byRequest)`.
    fn get<'a>(
        &'a self,
        who: &'a OAuthAccess,
        id: &'a str,
        by_request: bool,
    ) -> BoxFuture<'a, AreaResult<Value>>;
    /// `cancelTurn(identity, turnId)`.
    fn cancel<'a>(
        &'a self,
        who: &'a OAuthAccess,
        turn: &'a str,
    ) -> BoxFuture<'a, AreaResult<Value>>;
    /// `cancelSpeech(identity, turnId, body)`.
    fn cancel_speech<'a>(
        &'a self,
        who: &'a OAuthAccess,
        turn: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>>;
    /// `speechEvent(identity, turnId, body)`.
    fn speech_event<'a>(
        &'a self,
        who: &'a OAuthAccess,
        turn: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>>;
    /// `claimAudio(identity, turnId, ticket)`.
    fn claim_audio<'a>(
        &'a self,
        who: &'a OAuthAccess,
        turn: &'a str,
        ticket: Option<&'a str>,
    ) -> BoxFuture<'a, AreaResult<TurnAudio>>;
}

/// The pet services as the desktop API calls them.
pub trait PetControl: Send + Sync {
    /// `getPetConfiguration(userId, channelId)` (the route drops `profiles` and `voices`).
    fn configuration<'a>(
        &'a self,
        user_id: &'a str,
        channel_id: &'a str,
    ) -> BoxFuture<'a, AreaResult<Map<String, Value>>>;
    /// `getPetRuntime(userId, channelId)`.
    fn runtime<'a>(
        &'a self,
        user_id: &'a str,
        channel_id: &'a str,
    ) -> BoxFuture<'a, AreaResult<Value>>;
    /// `selectOwnPetPlayback(identity, body)`.
    fn select_playback<'a>(
        &'a self,
        who: &'a OAuthAccess,
        input: &'a Value,
    ) -> BoxFuture<'a, AreaResult<Value>>;
    /// `cancelPetRequest(userId, requestId, commandId)` (`commandId` as the body holds it).
    fn cancel_request<'a>(
        &'a self,
        user_id: &'a str,
        request_id: &'a str,
        command_id: Option<&'a Value>,
    ) -> BoxFuture<'a, AreaResult<Value>>;
}

/// `GET /v1/me/credits`: `getAiCredits(user, channelId)` with `getFreeAiCreditDisplay` merged
/// in as the reference does (`{...credits, display?}`); `None` when the user does not exist.
pub trait DesktopCredits: Send + Sync {
    /// The answer's body.
    fn credits<'a>(
        &'a self,
        user_id: &'a str,
        channel_id: &'a str,
    ) -> BoxFuture<'a, AreaResult<Option<Value>>>;
}

/// What the binary registers for the OAuth routes.
pub const SERVICES: &[ServiceKey] = &[
    ServiceKey::of::<dyn DesktopTurns>(),
    ServiceKey::of::<dyn PetControl>(),
    ServiceKey::of::<dyn DesktopCredits>(),
];
