//! Moderator lists and their rebuilt cache families (JSON, IDs, logins, mapping; TTL 7200).
use crate::functions::polls::{FunctionError, cached, key};
use crate::{Auth, HelixError, HelixRequest, Twitch};
use dima_http::Path;
use dima_store::dragonfly::SetOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
/// Moderator identity returned by Twitch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Moderator {
    /// ID.
    pub user_id: String,
    /// Login.
    pub user_login: String,
    /// Display name.
    pub user_name: String,
}
/// The reference moderator result and JSON cache shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Moderators {
    /// Always false on success.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Moderator rows.
    pub data: Vec<Moderator>,
    /// IDs in Twitch order.
    pub ids: Vec<String>,
    /// Logins in Twitch order.
    pub logins: Vec<String>,
    /// Display names in Twitch order.
    #[serde(rename = "displayNames")]
    pub display_names: Vec<String>,
}
/// Fetch the first page only, optionally reading/writing the full-channel cache even with filters.
pub async fn get_channel_moderators(
    twitch: &Twitch,
    channel: &str,
    users: &[String],
    cache: bool,
) -> Result<Moderators, FunctionError> {
    let cache_key = key(twitch, channel, "moderators");
    if cache && let Some(mut result) = cached::<Moderators>(twitch, &cache_key).await? {
        result.message = "Success (from cache)".into();
        return Ok(result);
    }
    let mut request = HelixRequest::get(
        Path::fixed("/moderation/moderators"),
        Auth::Streamer(channel.into()),
    )
    .query("broadcaster_id", channel);
    for user in users {
        request = request.query("user_id", user);
    }
    let response = twitch.helix(request).await.map_err(|e| match e {
        HelixError::Credential { error, .. } => {
            FunctionError::new(error.message(), Some(403), None)
        }
        HelixError::Http(_) => FunctionError::internal(false),
    })?;
    let body: Value = response
        .into_response()
        .json()
        .await
        .map_err(|_| FunctionError::internal(false))?;
    if body
        .get("error")
        .is_some_and(|e| e == true || e.as_str().is_some_and(|s| !s.is_empty()))
    {
        return Err(FunctionError::new(
            body["message"].as_str().unwrap_or_default(),
            body["status"].as_u64().and_then(|n| u16::try_from(n).ok()),
            None,
        ));
    }
    let rows: Vec<Moderator> =
        serde_json::from_value(body["data"].clone()).map_err(|_| FunctionError::internal(false))?;
    let result = Moderators {
        error: false,
        message: "Success".into(),
        ids: rows.iter().map(|r| r.user_id.clone()).collect(),
        logins: rows.iter().map(|r| r.user_login.clone()).collect(),
        display_names: rows.iter().map(|r| r.user_name.clone()).collect(),
        data: rows,
    };
    if cache {
        let bytes = serde_json::to_vec(&result).map_err(|_| FunctionError::internal(false))?;
        twitch
            .inner
            .dragonfly
            .set(&cache_key, &bytes, SetOptions::ex(7200))
            .await
            .map_err(|_| FunctionError::internal(false))?;
        let ids = key(twitch, channel, "moderators:ids");
        let logins = key(twitch, channel, "moderators:logins");
        let mapping = key(twitch, channel, "moderators:mapping");
        twitch
            .inner
            .dragonfly
            .del(&[&ids, &logins, &mapping])
            .await
            .map_err(|_| FunctionError::internal(false))?;
        if !result.ids.is_empty() {
            let mut pipeline = redis::pipe();
            pipeline
                .cmd("SADD")
                .arg(&ids)
                .arg(&result.ids)
                .ignore()
                .cmd("EXPIRE")
                .arg(&ids)
                .arg(7200)
                .ignore();
            pipeline
                .cmd("SADD")
                .arg(&logins)
                .arg(&result.logins)
                .ignore()
                .cmd("EXPIRE")
                .arg(&logins)
                .arg(7200)
                .ignore();
            pipeline.cmd("HSET").arg(&mapping);
            for row in &result.data {
                pipeline.arg(&row.user_login).arg(&row.user_id);
            }
            pipeline
                .ignore()
                .cmd("EXPIRE")
                .arg(&mapping)
                .arg(7200)
                .ignore();
            twitch
                .inner
                .dragonfly
                .query_pipeline::<()>(&pipeline)
                .await
                .map_err(|_| FunctionError::internal(false))?;
        }
    }
    Ok(result)
}
/// ID lookup response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModeratorIds {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// IDs.
    pub ids: Vec<String>,
}
/// Prefer a nonempty cached ID set, then refresh through getChannelModerators.
pub async fn get_twitch_moderators_ids(
    twitch: &Twitch,
    channel: &str,
    skip_cache: bool,
) -> Result<ModeratorIds, FunctionError> {
    if !skip_cache {
        let ids: Vec<String> = twitch
            .inner
            .dragonfly
            .query(redis::cmd("SMEMBERS").arg(key(twitch, channel, "moderators:ids")))
            .await
            .map_err(|_| FunctionError::internal(false))?;
        if !ids.is_empty() {
            return Ok(ModeratorIds {
                error: false,
                message: "Success (from cache)".into(),
                ids,
            });
        }
    }
    let result = get_channel_moderators(twitch, channel, &[], true)
        .await
        .map_err(|mut e| {
            e.status = None;
            e.kind = None;
            e
        })?;
    Ok(ModeratorIds {
        error: false,
        message: "Success".into(),
        ids: result.ids,
    })
}
/// Moderator membership success response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IsModerator {
    /// Always false.
    pub error: bool,
    /// Membership.
    #[serde(rename = "isModerator")]
    pub is_moderator: bool,
    /// User-visible message.
    pub message: String,
}
async fn member(
    twitch: &Twitch,
    channel: &str,
    user: &str,
    skip: bool,
    login: bool,
) -> Result<IsModerator, FunctionError> {
    let found = if !skip {
        let key = key(
            twitch,
            channel,
            if login {
                "moderators:logins"
            } else {
                "moderators:ids"
            },
        );
        let present: bool = twitch
            .inner
            .dragonfly
            .query(redis::cmd("SISMEMBER").arg(&key).arg(user))
            .await
            .map_err(|_| FunctionError::internal(false))?;
        if present {
            Some(true)
        } else if twitch
            .inner
            .dragonfly
            .exists(&[&key])
            .await
            .map_err(|_| FunctionError::internal(false))?
            == 1
        {
            Some(false)
        } else {
            None
        }
    } else {
        None
    };
    let found = match found {
        Some(found) => found,
        None => {
            let result = get_channel_moderators(twitch, channel, &[], true)
                .await
                .map_err(|mut e| {
                    e.status = None;
                    e.kind = None;
                    e
                })?;
            if login {
                result.logins.iter().any(|s| s == user)
            } else {
                result.ids.iter().any(|s| s == user)
            }
        }
    };
    Ok(IsModerator {
        error: false,
        is_moderator: found,
        message: if found {
            "User is a moderator"
        } else {
            "User is not a moderator"
        }
        .into(),
    })
}
/// Check by ID, retaining negative cached membership.
pub async fn is_twitch_moderator_by_id(
    twitch: &Twitch,
    channel: &str,
    user: &str,
    skip_cache: bool,
) -> Result<IsModerator, FunctionError> {
    member(twitch, channel, user, skip_cache, false).await
}
/// Check by exact login; reference does not lowercase it.
pub async fn is_twitch_moderator_by_login(
    twitch: &Twitch,
    channel: &str,
    user: &str,
    skip_cache: bool,
) -> Result<IsModerator, FunctionError> {
    member(twitch, channel, user, skip_cache, true).await
}
