//! The `/oauth` routes: the authorisation steps, the token endpoint, revocation and the
//! browser's management of connected installations (`routes.ts:100-171`).

use super::{APPROVAL_LIMIT, BrowserIdentity};
use crate::state::RouteState;
use bson::oid::ObjectId;
use bson::{Bson, DateTime, Document, doc};
use dima_model::oauth_grants;
use dima_model::oauth_sessions;
use dima_model::users::AccountType;
use dima_platform::oauth::{Input, OAuthError};
use dima_store::mongo::WriteContext;
use dima_store::mongo::update::UpdateOptions;
use dima_web::{Error, Flow, Req, Response};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::time::Duration;

/// Deadline of each MongoDB call these routes make themselves (the service has its own).
const STORE_DEADLINE: Duration = Duration::from_secs(5);
/// Most connections listed (the reference had no bound; a user has a handful).
const MAX_CONNECTIONS: i64 = 1000;

fn unavailable<E>(_: E) -> OAuthError {
    OAuthError::UNAVAILABLE
}

async fn bounded<T, E>(
    work: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, OAuthError> {
    tokio::time::timeout(STORE_DEADLINE, work)
        .await
        .map_err(unavailable)?
        .map_err(unavailable)
}

/// `body(req)` (`routes.ts:37`): an object whose values are all strings or booleans (a repeated
/// form field is an array and is refused rather than guessed), else `invalid_request`. The
/// service reads each field it needs by name and type.
fn form<S>(req: &Req<S>) -> Result<Input, OAuthError> {
    // raw body: checked here field by field, and only handed to the OAuth service's parsers.
    let Value::Object(input) = req.body() else {
        return Err(OAuthError::INVALID_REQUEST);
    };
    if input
        .values()
        .any(|value| !matches!(value, Value::String(_) | Value::Bool(_)))
    {
        return Err(OAuthError::INVALID_REQUEST);
    }
    Ok(input.clone())
}

/// `Types.ObjectId.isValid(String(id))`: 24 hexadecimal digits.
fn object_id(text: &str) -> Result<ObjectId, OAuthError> {
    if text.len() != 24 {
        return Err(OAuthError::INVALID_REQUEST);
    }
    ObjectId::parse_str(text).map_err(|_| OAuthError::INVALID_REQUEST)
}

/// `GET /oauth/authorize`: checks and stores the request, then sends the browser to the
/// website's approval page.
pub(super) async fn authorize<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let oauth = &state.core().oauth;
    let query = req.query().as_object().cloned().unwrap_or_default();
    let request = oauth.start_authorization(&query).await?;
    let mut url = url_join(oauth.config().website(), "/oauth/authorize");
    url.push_str("?request=");
    url.push_str(&request);
    Ok(Response::redirect_with(302, url))
}

/// `new URL(path, origin).href` for an origin without a path.
fn url_join(origin: &str, path: &str) -> String {
    format!("{}{path}", origin.trim_end_matches('/'))
}

/// `GET /oauth/requests/:request`.
pub(super) async fn request<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let oauth = &state.core().oauth;
    let id = req.param("request").unwrap_or_default().to_owned();
    let request = oauth.get_authorization(&id).await?;
    let client = oauth
        .get_client(Some(&Value::String(request.client_id.clone())))
        .await?;
    Ok(Response::new().json(&json!({
        "client_id": client.client_id,
        "client_name": client.name,
        "device_name": request.device_name,
        "scopes": request.scopes,
        "redirect_uri": request.redirect_uri,
    })))
}

/// The decision, read before the browser proof as the reference does.
#[derive(Clone, Copy, Debug)]
struct Decision {
    approve: bool,
}

/// `POST /oauth/requests/:request/decision`, first step: the body.
pub(super) async fn decision_input<S: RouteState>(req: &mut Req<S>) -> Result<Flow, Error> {
    let input = form(req)?;
    let Some(Value::Bool(approve)) = input.get("approve") else {
        return Err(OAuthError::INVALID_REQUEST.into());
    };
    let approve = *approve;
    req.extensions_mut().insert(Decision { approve });
    Ok(Flow::Next)
}

/// `POST /oauth/requests/:request/decision`, after the browser proof.
pub(super) async fn decide<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let oauth = &state.core().oauth;
    let approve = req
        .extensions()
        .get::<Decision>()
        .map(|decision| decision.approve)
        .ok_or_else(|| Error::new(500, "decision input missing"))?;
    let twitch_id = BrowserIdentity::of(req)?.user().twitch_id.clone();
    oauth
        .rate_limit(&format!("approval:{twitch_id}"), APPROVAL_LIMIT)
        .await?;
    let id = req.param("request").unwrap_or_default().to_owned();
    let redirect_uri = oauth
        .approve_authorization(&id, &twitch_id, approve)
        .await?;
    Ok(Response::new().json(&json!({ "redirect_uri": redirect_uri })))
}

/// `POST /oauth/token`.
pub(super) async fn token<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let oauth = &state.core().oauth;
    let input = form(req)?;
    let authorization = req
        .header("authorization")
        .is_some_and(|value| !value.is_empty());
    if input.contains_key("client_secret") || authorization {
        return Err(OAuthError::INVALID_CLIENT.into());
    }
    let tokens = match input.get("grant_type") {
        Some(Value::String(kind)) if kind == "authorization_code" => {
            oauth.exchange_code(&input).await?
        }
        Some(Value::String(kind)) if kind == "refresh_token" => {
            oauth.refresh_access(&input).await?
        }
        _ => return Err(OAuthError::UNSUPPORTED_GRANT_TYPE.into()),
    };
    Ok(Response::new().json(&tokens.body()))
}

/// `POST /oauth/revoke`.
pub(super) async fn revoke<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let input = form(req)?;
    state.core().oauth.revoke_token(&input).await?;
    Ok(Response::new().json(&json!({})))
}

/// `GET /oauth/browser-session`.
pub(super) async fn session<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let browser = BrowserIdentity::of(req)?.user();
    let account = browser.user.accounts.iter().find(|account| {
        account.kind == AccountType::Twitch && account.id.as_deref() == Some(&browser.twitch_id)
    });
    // `account?.name || user.name`.
    let name = account
        .and_then(|account| account.name.clone())
        .filter(|name| !name.is_empty())
        .or_else(|| browser.user.name.clone());
    let mut body = json!({
        "user_id": browser.user.id.to_hex(),
        "channel_id": browser.twitch_id,
    });
    if let (Some(name), Some(object)) = (name, body.as_object_mut()) {
        object.insert("name".to_owned(), Value::String(name));
    }
    Ok(Response::new().json(&body))
}

/// `GET /oauth/connections`: the user's live installations.
pub(super) async fn connections<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let core = state.core();
    let user_id = BrowserIdentity::of(req)?.user().user.id;
    let now = Bson::DateTime(DateTime::from_millis(core.clock.now_ms()));
    let filter = doc! {
        "user_id": user_id,
        "revoked_at": Bson::Null,
        "expires_at": { "$gt": now.clone() },
        "idle_expires_at": { "$gt": now },
    };
    let projection = doc! {
        "_id": 1, "client_id": 1, "grant_id": 1, "device_name": 1, "scopes": 1,
        "last_used_at": 1, "expires_at": 1, "createdAt": 1,
    };
    let sessions: Vec<Document> = bounded(async {
        core.mongo
            .documents(oauth_sessions::COLLECTION)
            .find(filter)
            .projection(projection)
            .limit(MAX_CONNECTIONS)
            .await?
            .try_collect::<Vec<Document>>()
            .await
    })
    .await?;
    let sessions: Vec<Value> = sessions
        .iter()
        .map(dima_store::mongo::json::to_json_value)
        .collect();
    Ok(Response::new().json(&json!({ "sessions": sessions })))
}

/// `DELETE /oauth/connections/:session`.
pub(super) async fn drop_connection<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let core = state.core();
    let user_id = BrowserIdentity::of(req)?.user().user.id;
    let session = object_id(req.param("session").unwrap_or_default())?;
    let found = bounded(
        core.mongo
            .documents(oauth_sessions::COLLECTION)
            .find_one(doc! { "_id": session, "user_id": user_id })
            .projection(doc! { "_id": 1 })
            .into_future(),
    )
    .await?;
    if found.is_none() {
        return Err(OAuthError::NOT_FOUND.into());
    }
    core.oauth.revoke_session(&session, "user_revoked").await?;
    Ok(Response::new().json(&json!({ "revoked": true })))
}

/// `DELETE /oauth/grants/:grant`: the grant and every installation made under it, so that
/// approving the application again cannot bring them back.
pub(super) async fn drop_grant<S: RouteState>(req: &mut Req<S>) -> Result<Response, Error> {
    let state = req.state_arc();
    let core = state.core();
    let user_id = BrowserIdentity::of(req)?.user().user.id;
    let grant = object_id(req.param("grant").unwrap_or_default())?;
    let found = bounded(
        core.mongo
            .documents(oauth_grants::COLLECTION)
            .find_one(doc! { "_id": grant, "user_id": user_id })
            .projection(doc! { "_id": 1 })
            .into_future(),
    )
    .await?;
    if found.is_none() {
        return Err(OAuthError::NOT_FOUND.into());
    }
    let now = core.clock.now_ms();
    let sessions = oauth_sessions::INFO
        .prepare_update(
            &doc! { "grant_id": grant },
            doc! { "$set": {
                "revoked_at": DateTime::from_millis(now),
                "revoke_reason": "grant_revoked",
            } },
            UpdateOptions::default(),
            &mut WriteContext::new(now),
        )
        .map_err(unavailable)?;
    let mut writes = core.mongo.writes(oauth_sessions::COLLECTION);
    bounded(writes.update_many(&sessions)).await?;
    let now = core.clock.now_ms();
    let grants = oauth_grants::INFO
        .prepare_update(
            &doc! { "_id": grant },
            doc! { "$set": { "revoked_at": DateTime::from_millis(now) } },
            UpdateOptions::default(),
            &mut WriteContext::new(now),
        )
        .map_err(unavailable)?;
    let mut writes = core.mongo.writes(oauth_grants::COLLECTION);
    bounded(writes.update_one(&grants)).await?;
    Ok(Response::new().json(&json!({ "revoked": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_ids() {
        assert!(object_id("507f1f77bcf86cd799439011").is_ok());
        assert!(object_id("507F1F77BCF86CD799439011").is_ok());
        assert!(object_id("aaaaaaaaaaaa").is_err());
        assert!(object_id("zzzzzzzzzzzzzzzzzzzzzzzz").is_err());
        assert_eq!(
            url_join("https://domdimabot.com", "/oauth/authorize"),
            "https://domdimabot.com/oauth/authorize"
        );
    }
}
