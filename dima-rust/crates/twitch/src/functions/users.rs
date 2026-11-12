//! `functions/users`: app-authenticated lookups, without caching or retries.
use super::{Envelope, has_error, payload};
use crate::{Auth, HelixError, HelixRequest, Twitch};
use dima_http::Path;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Public user fields returned by the reference.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TwitchUser {
    /// Twitch id.
    pub id: String,
    /// Login name.
    pub login: String,
    /// Display name.
    pub display_name: String,
    /// User type.
    #[serde(rename = "type")]
    pub kind: String,
    /// Broadcaster type.
    pub broadcaster_type: String,
    /// Biography.
    pub description: String,
    /// Profile image.
    pub profile_image_url: String,
    /// Offline image.
    pub offline_image_url: String,
    /// Legacy view count.
    pub view_count: u64,
    /// Creation time as returned by Twitch.
    pub created_at: String,
    /// Additional Twitch fields consumed by downstream callers.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}
async fn lookup(twitch: &Twitch, key: &str, value: &str) -> Envelope<TwitchUser> {
    let Some(body) = payload(
        twitch,
        HelixRequest::get(Path::fixed("/users"), Auth::App).query(key, value),
    )
    .await
    else {
        return Envelope::failure("Internal server error");
    };
    if has_error(&body) {
        return Envelope::payload_error(&body);
    }
    let Some(first) = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    else {
        return Envelope::failure("User not found");
    };
    match serde_json::from_value(first.clone()) {
        Ok(user) => Envelope::success("Success", Some(user)),
        Err(_) => Envelope::failure("Internal server error"),
    }
}
/// `getTwitchUserById`.
pub async fn get_twitch_user_by_id(twitch: &Twitch, id: &str) -> Envelope<TwitchUser> {
    lookup(twitch, "id", id).await
}
/// `getTwitchUserByLogin`; `skipCache` is unused in the reference.
pub async fn get_twitch_user_by_login(
    twitch: &Twitch,
    login: &str,
    _skip_cache: bool,
) -> Envelope<TwitchUser> {
    lookup(twitch, "login", login).await
}
/// `getScopes`. Data is the unmodified grant list; Twitch may add scopes.
pub async fn get_scopes(twitch: &Twitch, id: &str) -> Envelope<Value> {
    let response = twitch
        .helix(
            HelixRequest::get(Path::fixed("/authorization/users"), Auth::App).query("user_id", id),
        )
        .await;
    let response = match response {
        Ok(response) => response,
        Err(HelixError::Credential { .. }) => {
            return Envelope::failure("Failed to get app access token").status(500);
        }
        Err(_) => return Envelope::failure("Internal server error"),
    };
    let Ok(body) = response.into_response().json::<Value>().await else {
        return Envelope::failure("Internal server error");
    };
    if has_error(&body) {
        let mut result = Envelope::payload_error(&body);
        result.data = Some(body);
        return result;
    }
    Envelope::success("Scopes fetched successfully", body.get("data").cloned()).status(200)
}
