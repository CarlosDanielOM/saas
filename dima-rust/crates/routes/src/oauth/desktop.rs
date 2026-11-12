//! The `/v1` routes of the desktop app, behind an OAuth access token (`routes.ts:180-260`).
//!
//! | route | scope | answer |
//! |---|---|---|
//! | `GET /me` | `profile:read` | the user and the channel's Twitch account |
//! | `GET /me/ai/capabilities` | `profile:read` | the AI features and the granted scopes |
//! | `POST /me/ai/turns` | any | [`DesktopTurns::submit`], 202 |
//! | `GET /me/ai/turns/by-request/:requestId`, `GET /me/ai/turns/:turnId` | any | [`DesktopTurns::get`] |
//! | `POST /me/ai/turns/:turnId/cancel` | any, after the body is checked empty | [`DesktopTurns::cancel`] |
//! | `POST /me/ai/turns/:turnId/speech/cancel`, `.../speech/events` | any | [`DesktopTurns::cancel_speech`], [`DesktopTurns::speech_event`] |
//! | `GET /me/ai/turns/:turnId/speech/audio` | any | the file of [`DesktopTurns::claim_audio`] (`X-Dima-Audio-Ticket`) |
//! | `GET /me/credits` | `credits:read` | [`DesktopCredits::credits`] |
//! | `GET /me/pet`, `GET /me/pet/runtime` | `pet:read` | [`PetControl::configuration`] without `profiles` and `voices`, [`PetControl::runtime`] |
//! | `PUT /me/pet/playback` | `pet:playback:select` | [`PetControl::select_playback`] |
//! | `POST /me/pet/requests/:requestId/cancel` | `pet:control` | the configuration (plan check), then a body of `commandId` only, then [`PetControl::cancel_request`] |
//! | `GET /desktop/session`, `DELETE /desktop/session` | `desktop:connect`, any | the session; its revocation (`signed_out`) |
//!
//! The account and channel always come from the token's session, never from the request.

use super::areas::{AreaError, DesktopCredits, DesktopTurns, PetControl};
use super::{OAuthAccess, access};
use crate::state::{RouteState, service};
use bson::oid::ObjectId;
use bson::{Bson, Document, doc};
use dima_model::{oauth_sessions, users};
use dima_platform::oauth::OAuthError;
use dima_store::mongo::json::bson_to_json_value;
use dima_web::{Error, Flow, Req, Response, Router};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

/// `TURN_STATUS_FEATURE` (`desktop_ai/updates.ts:5`).
pub const TURN_STATUS_FEATURE: &str = "turn-status-v1";

/// Deadline of each MongoDB read these routes make themselves.
const STORE_DEADLINE: Duration = Duration::from_secs(5);

pub(super) fn routes<S: RouteState>(router: &mut Router<S>) {
    router.get("/me", (access(Some("profile:read")), me::<S>));
    router.get(
        "/me/ai/capabilities",
        (access(Some("profile:read")), capabilities::<S>),
    );
    router.post("/me/ai/turns", (access(None), submit_turn::<S>));
    router.get(
        "/me/ai/turns/by-request/:requestId",
        (access(None), turn_by_request::<S>),
    );
    router.get("/me/ai/turns/:turnId", (access(None), turn::<S>));
    router.post(
        "/me/ai/turns/:turnId/cancel",
        (empty_body::<S>, access(None), cancel_turn::<S>),
    );
    router.post(
        "/me/ai/turns/:turnId/speech/cancel",
        (access(None), cancel_speech::<S>),
    );
    router.post(
        "/me/ai/turns/:turnId/speech/events",
        (access(None), speech_event::<S>),
    );
    router.get(
        "/me/ai/turns/:turnId/speech/audio",
        (access(None), speech_audio::<S>),
    );
    router.get("/me/credits", (access(Some("credits:read")), credits::<S>));
    router.get("/me/pet", (access(Some("pet:read")), pet::<S>));
    router.get(
        "/me/pet/runtime",
        (access(Some("pet:read")), pet_runtime::<S>),
    );
    router.put(
        "/me/pet/playback",
        (access(Some("pet:playback:select")), pet_playback::<S>),
    );
    router.post(
        "/me/pet/requests/:requestId/cancel",
        (access(Some("pet:control")), pet_cancel::<S>),
    );
    router.get(
        "/desktop/session",
        (access(Some("desktop:connect")), desktop_session::<S>),
    );
    router.delete("/desktop/session", (access(None), sign_out::<S>));
}

fn unavailable<E>(_: E) -> OAuthError {
    OAuthError::UNAVAILABLE
}

async fn find_one<S: RouteState>(
    req: &Req<S>,
    collection: &str,
    id: &str,
    projection: Document,
) -> Result<Option<Document>, OAuthError> {
    let id = ObjectId::parse_str(id).map_err(unavailable)?;
    let state = req.state_arc();
    let documents = state.core().mongo.documents(collection);
    let read = documents
        .find_one(doc! { "_id": id })
        .projection(projection);
    tokio::time::timeout(STORE_DEADLINE, read.into_future())
        .await
        .map_err(unavailable)?
        .map_err(unavailable)
}

/// The value at `key` as `res.json` would write it (`None`: the key is left out).
fn lean(document: &Document, key: &str) -> Option<Value> {
    document.get(key).and_then(bson_to_json_value)
}

fn insert(object: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        object.insert(key.to_owned(), value);
    }
}

fn param<S>(req: &Req<S>, name: &str) -> String {
    req.param(name).unwrap_or_default().to_owned()
}

/// The body as the client sent it, for the services that validate it themselves.
fn sent_body<S>(req: &Req<S>) -> Value {
    // raw body: handed to an area service whose own parser checks it (see `areas`).
    req.body().clone()
}

/// `GET /v1/me`.
async fn me<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let who = OAuthAccess::of(req)?.identity().clone();
    let user = find_one(
        req,
        users::COLLECTION,
        &who.user_id,
        doc! { "name": 1, "accounts.type": 1, "accounts.id": 1, "accounts.name": 1 },
    )
    .await?;
    let account = user.as_ref().and_then(|user| {
        user.get_array("accounts").ok()?.iter().find_map(|account| {
            let account = account.as_document()?;
            let twitch = account.get("type") == Some(&Bson::String("twitch".to_owned()));
            let same = account.get("id") == Some(&Bson::String(who.channel_id.clone()));
            (twitch && same).then_some(account)
        })
    });
    let (Some(user), Some(account)) = (user.as_ref(), account) else {
        return Err(OAuthError::INVALID_TOKEN.into());
    };
    let mut body = Map::new();
    body.insert("user_id".to_owned(), Value::String(who.user_id.clone()));
    insert(&mut body, "name", lean(user, "name"));
    let mut channel = Map::new();
    channel.insert("platform".to_owned(), Value::String("twitch".to_owned()));
    insert(&mut channel, "id", lean(account, "id"));
    insert(&mut channel, "name", lean(account, "name"));
    body.insert("channel".to_owned(), Value::Object(channel));
    Ok(Response::new().json(&body))
}

/// `GET /v1/me/ai/capabilities`.
async fn capabilities<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let who = OAuthAccess::of(req)?;
    Ok(Response::new().json(&json!({
        "version": 1,
        "permission_profile_version": 2,
        "available": true,
        "features": [TURN_STATUS_FEATURE],
        "supported_scopes": ["ai:interact", "pet:interact"],
        "required_scopes": { "bot": ["ai:interact"], "pet": ["pet:interact"] },
        "granted_scopes": who.identity().scopes,
    })))
}

/// `POST /v1/me/ai/turns`.
async fn submit_turn<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let turns: Arc<dyn DesktopTurns> = service(req)?;
    let who = OAuthAccess::of(req)?.clone();
    let input = sent_body(req);
    let answer = turns.submit(&who, &input).await?;
    Ok(Response::status(202).json(&answer))
}

async fn get_turn<S: RouteState>(
    req: &mut Req<S>,
    param_name: &str,
    by_request: bool,
) -> Result<Response, Error> {
    let turns: Arc<dyn DesktopTurns> = service(req)?;
    let who = OAuthAccess::of(req)?.clone();
    let id = param(req, param_name);
    Ok(Response::new().json(&turns.get(&who, &id, by_request).await?))
}

/// `GET /v1/me/ai/turns/by-request/:requestId`.
async fn turn_by_request<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    get_turn(req, "requestId", true).await
}

/// `GET /v1/me/ai/turns/:turnId`.
async fn turn<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    get_turn(req, "turnId", false).await
}

/// `POST /v1/me/ai/turns/:turnId/cancel`, first step: an empty object body, checked before
/// the token as the reference does.
async fn empty_body<S: RouteState>(req: &mut Req<S>) -> Result<Flow, Error> {
    // raw body: only its emptiness is read.
    match req.body() {
        Value::Object(object) if object.is_empty() => Ok(Flow::Next),
        _ => Err(OAuthError::INVALID_REQUEST.into()),
    }
}

/// `POST /v1/me/ai/turns/:turnId/cancel`.
async fn cancel_turn<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let turns: Arc<dyn DesktopTurns> = service(req)?;
    let who = OAuthAccess::of(req)?.clone();
    let turn = param(req, "turnId");
    Ok(Response::new().json(&turns.cancel(&who, &turn).await?))
}

/// `POST /v1/me/ai/turns/:turnId/speech/cancel`.
async fn cancel_speech<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let turns: Arc<dyn DesktopTurns> = service(req)?;
    let who = OAuthAccess::of(req)?.clone();
    let turn = param(req, "turnId");
    let input = sent_body(req);
    Ok(Response::new().json(&turns.cancel_speech(&who, &turn, &input).await?))
}

/// `POST /v1/me/ai/turns/:turnId/speech/events`.
async fn speech_event<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let turns: Arc<dyn DesktopTurns> = service(req)?;
    let who = OAuthAccess::of(req)?.clone();
    let turn = param(req, "turnId");
    let input = sent_body(req);
    Ok(Response::new().json(&turns.speech_event(&who, &turn, &input).await?))
}

/// `GET /v1/me/ai/turns/:turnId/speech/audio`.
async fn speech_audio<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let turns: Arc<dyn DesktopTurns> = service(req)?;
    let who = OAuthAccess::of(req)?.clone();
    let turn = param(req, "turnId");
    let ticket = req
        .header("x-dima-audio-ticket")
        .map(|value| value.into_owned());
    let audio = turns.claim_audio(&who, &turn, ticket.as_deref()).await?;
    Ok(Response::new()
        .set("Content-Type", audio.mime_type)
        .send_file(audio.path))
}

/// `GET /v1/me/credits`.
async fn credits<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let credits: Arc<dyn DesktopCredits> = service(req)?;
    let who = OAuthAccess::of(req)?.identity().clone();
    match credits.credits(&who.user_id, &who.channel_id).await? {
        Some(body) => Ok(Response::new().json(&body)),
        None => Err(OAuthError::INVALID_TOKEN.into()),
    }
}

/// `GET /v1/me/pet`: the configuration without the catalogues of profiles and voices.
async fn pet<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let pets: Arc<dyn PetControl> = service(req)?;
    let who = OAuthAccess::of(req)?.identity().clone();
    let mut configuration = pets.configuration(&who.user_id, &who.channel_id).await?;
    configuration.remove("profiles");
    configuration.remove("voices");
    Ok(Response::new().json(&configuration))
}

/// `GET /v1/me/pet/runtime`.
async fn pet_runtime<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let pets: Arc<dyn PetControl> = service(req)?;
    let who = OAuthAccess::of(req)?.identity().clone();
    Ok(Response::new().json(&pets.runtime(&who.user_id, &who.channel_id).await?))
}

/// `PUT /v1/me/pet/playback`.
async fn pet_playback<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let pets: Arc<dyn PetControl> = service(req)?;
    let who = OAuthAccess::of(req)?.clone();
    let input = sent_body(req);
    Ok(Response::new().json(&pets.select_playback(&who, &input).await?))
}

/// `POST /v1/me/pet/requests/:requestId/cancel`.
async fn pet_cancel<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let pets: Arc<dyn PetControl> = service(req)?;
    let who = OAuthAccess::of(req)?.identity().clone();
    pets.configuration(&who.user_id, &who.channel_id).await?;
    // raw body: only the `commandId` key is allowed, and passed to the pet service's check.
    let command_id = match req.body() {
        Value::Object(object) if object.keys().all(|key| key == "commandId") => {
            object.get("commandId").cloned()
        }
        // `Object.keys([])` is empty too.
        Value::Array(items) if items.is_empty() => None,
        _ => return Err(AreaError::new("invalid_command").into()),
    };
    let request = param(req, "requestId");
    let answer = pets
        .cancel_request(&who.user_id, &request, command_id.as_ref())
        .await?;
    Ok(Response::new().json(&answer))
}

/// `GET /v1/desktop/session`.
async fn desktop_session<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let who = OAuthAccess::of(req)?.identity().clone();
    let session = find_one(
        req,
        oauth_sessions::COLLECTION,
        &who.session_id,
        doc! { "device_name": 1, "expires_at": 1 },
    )
    .await?;
    let mut body = match serde_json::to_value(&who) {
        Ok(Value::Object(object)) => object,
        _ => return Err(OAuthError::UNAVAILABLE.into()),
    };
    if let Some(session) = &session {
        insert(&mut body, "device_name", lean(session, "device_name"));
        insert(&mut body, "expires_at", lean(session, "expires_at"));
    }
    body.insert("protocol_version".to_owned(), json!(1));
    body.insert(
        "pet_available".to_owned(),
        Value::Bool(who.scopes.iter().any(|scope| scope == "pet:receive")),
    );
    body.insert(
        "socket_io".to_owned(),
        json!({ "path": "/socket.io/", "namespace": "/desktop", "protocol_version": 1 }),
    );
    Ok(Response::new().json(&body))
}

/// `DELETE /v1/desktop/session`.
async fn sign_out<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let who = OAuthAccess::of(req)?.identity().clone();
    let session = ObjectId::parse_str(&who.session_id).map_err(unavailable)?;
    state
        .core()
        .oauth
        .revoke_session(&session, "signed_out")
        .await?;
    Ok(Response::new().json(&json!({ "revoked": true })))
}
