//! Channel action wrappers from `functions/channels`.
//! These mutations are single-send, with no 401, transport or status retry.
use super::polls::FunctionError;
use crate::{Auth, HelixError, HelixRequest, Twitch};
use dima_http::Path;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Reference action success envelope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActionSuccess {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Some references omit successful status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}
/// Only the fields accepted by setChannelInformation.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ChannelInformation {
    /// New title, passed to Twitch unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// New category ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
    /// New broadcast language.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broadcaster_language: Option<String>,
}
async fn action(
    twitch: &Twitch,
    request: HelixRequest,
    message: &str,
    unraid: bool,
) -> Result<ActionSuccess, FunctionError> {
    let response = twitch.helix(request).await.map_err(|e| match e {
        HelixError::Credential { error, .. } => {
            FunctionError::new(error.message(), Some(403), Some("permission_error"))
        }
        HelixError::Http(_) => FunctionError::internal(true),
    })?;
    if response.status() == 204 {
        return Ok(ActionSuccess {
            error: false,
            message: message.into(),
            status: if unraid { None } else { Some(200) },
        });
    }
    let body: Value = response
        .into_response()
        .json()
        .await
        .map_err(|_| FunctionError::internal(true))?;
    Err(FunctionError::new(
        body["message"].as_str().unwrap_or_default(),
        if unraid {
            None
        } else {
            body["status"].as_u64().and_then(|n| u16::try_from(n).ok())
        },
        if unraid { None } else { body["error"].as_str() },
    ))
}
/// Add a VIP using the target broadcaster's token.
pub async fn add_channel_vip(
    twitch: &Twitch,
    channel: &str,
    user: &str,
) -> Result<ActionSuccess, FunctionError> {
    action(
        twitch,
        HelixRequest::post(
            Path::fixed("/channels/vips"),
            Auth::Streamer(channel.into()),
        )
        .query("user_id", user)
        .query("broadcaster_id", channel),
        "Success",
        false,
    )
    .await
}
/// Remove a VIP using the target broadcaster's token.
pub async fn remove_channel_vip(
    twitch: &Twitch,
    channel: &str,
    user: &str,
) -> Result<ActionSuccess, FunctionError> {
    action(
        twitch,
        HelixRequest::delete(
            Path::fixed("/channels/vips"),
            Auth::Streamer(channel.into()),
        )
        .query("user_id", user)
        .query("broadcaster_id", channel),
        "Success",
        false,
    )
    .await
}
/// Modify only the supplied channel fields.
pub async fn set_channel_information(
    twitch: &Twitch,
    channel: &str,
    information: ChannelInformation,
) -> Result<ActionSuccess, FunctionError> {
    let body = serde_json::to_value(information).map_err(|_| FunctionError::internal(true))?;
    action(
        twitch,
        HelixRequest::patch(Path::fixed("/channels"), Auth::Streamer(channel.into()))
            .query("broadcaster_id", channel)
            .json(body),
        "Channel information modified",
        false,
    )
    .await
}
/// Cancel a raid. The successful envelope intentionally omits status.
pub async fn unraid(twitch: &Twitch, channel: &str) -> Result<ActionSuccess, FunctionError> {
    action(
        twitch,
        HelixRequest::delete(Path::fixed("/raids"), Auth::Streamer(channel.into()))
            .query("broadcaster_id", channel),
        "Successfully unraided channel!",
        true,
    )
    .await
}
/// Start a raid; preserve the Twitch JSON response, as the reference does.
pub async fn raid(twitch: &Twitch, channel: &str, target: &str) -> Result<Value, FunctionError> {
    let response = twitch
        .helix(
            HelixRequest::post(Path::fixed("/raids"), Auth::Streamer(channel.into()))
                .query("from_broadcaster_id", channel)
                .query("to_broadcaster_id", target),
        )
        .await
        .map_err(|e| match e {
            HelixError::Credential { error, .. } => {
                FunctionError::new(error.message(), Some(403), Some("permission_error"))
            }
            HelixError::Http(_) => FunctionError::internal(true),
        })?;
    let data = response
        .into_response()
        .json()
        .await
        .map_err(|_| FunctionError::internal(true))?;
    Ok(data)
}
/// A Helix editor normalized by the reference.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Editor {
    /// User ID.
    pub user_id: String,
    /// Derived from display name (not the supplied login).
    #[serde(default)]
    pub user_login: String,
    /// Display name.
    pub user_name: String,
}
/// Reference `normalizeEditors`; exactly one result for each input entry.
pub fn normalize_editors(editors: Vec<Editor>) -> Vec<Editor> {
    editors
        .into_iter()
        .map(|mut editor| {
            editor.user_login = editor.user_name.to_lowercase();
            editor
        })
        .collect()
}
/// Followers response; the reference ignores its userId argument and never paginates.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Followers {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Helix follower rows (the reference declares any[]).
    pub data: Vec<Value>,
    /// Total count, default zero.
    pub total: f64,
}
/// Fetch the first page; userId is deliberately unused, matching the frozen reference.
pub async fn get_twitch_followers(
    twitch: &Twitch,
    channel: &str,
    _user: Option<&str>,
) -> Result<Followers, FunctionError> {
    let response = twitch
        .helix(
            HelixRequest::get(
                Path::fixed("/channels/followers"),
                Auth::Streamer(channel.into()),
            )
            .query("broadcaster_id", channel),
        )
        .await
        .map_err(|e| match e {
            HelixError::Credential { error, .. } => {
                FunctionError::new(error.message(), Some(403), Some("permission_error"))
            }
            HelixError::Http(_) => FunctionError::internal(true),
        })?;
    let body: Value = response
        .into_response()
        .json()
        .await
        .map_err(|_| FunctionError::internal(true))?;
    if body
        .get("error")
        .is_some_and(|e| e == true || e.as_str().is_some_and(|s| !s.is_empty()))
    {
        return Err(FunctionError::new(
            body["message"].as_str().unwrap_or_default(),
            body["status"].as_u64().and_then(|n| u16::try_from(n).ok()),
            body["error"].as_str(),
        ));
    }
    Ok(Followers {
        error: false,
        message: "Successfully fetched followers".into(),
        data: body["data"].as_array().cloned().unwrap_or_default(),
        total: body["total"].as_f64().unwrap_or(0.0),
    })
}
/// App-token live lookup. Empty/non-array data becomes an empty list.
pub async fn is_live(twitch: &Twitch, channel: &str) -> Result<Vec<Value>, FunctionError> {
    let (_, body) = super::polls::call(
        twitch,
        HelixRequest::get(Path::fixed("/streams"), Auth::App).query("user_id", channel),
        false,
    )
    .await
    .map_err(|mut e| {
        if e.message == "Internal server error" || e.kind.as_deref() == Some("permission_error") {
            e = FunctionError::new("Failed to check live status", None, None);
        } else {
            e.status = None;
            e.kind = None;
        }
        e
    })?;
    Ok(body["data"].as_array().cloned().unwrap_or_default())
}
/// App-token live lookup in batches of at most 100 directory IDs.
pub async fn live_channels(twitch: &Twitch) -> Result<Vec<Value>, FunctionError> {
    let ids = twitch.streamer_ids().await;
    twitch
        .app_credential()
        .await
        .map_err(|_| FunctionError::internal(true))?;
    let mut result = Vec::new();
    for batch in ids.chunks(100) {
        let mut request =
            HelixRequest::get(Path::fixed("/streams"), Auth::App).query("type", "live");
        for id in batch {
            request = request.query("user_id", id);
        }
        let (_, body) = super::polls::call(twitch, request, true).await?;
        if let Some(rows) = body["data"].as_array() {
            result.extend(rows.iter().cloned());
        }
    }
    Ok(result)
}

/// Channel-information lookup envelope (empty Helix lists omit data).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChannelData {
    /// Always false.
    pub error: bool,
    /// First Helix row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}
/// Always consult the existing cache, even when save_to_cache is false.
pub async fn get_channel_information(
    twitch: &Twitch,
    channel: &str,
    save_to_cache: bool,
) -> Result<ChannelData, FunctionError> {
    let key = format!(
        "{}channel:data:{channel}",
        twitch.inner.config.keys.prefix()
    );
    if let Some(data) = super::polls::cached(twitch, &key).await? {
        return Ok(ChannelData {
            error: false,
            data: Some(data),
        });
    }
    let body = read_channel(
        twitch,
        HelixRequest::get(Path::fixed("/channels"), Auth::App).query("broadcaster_id", channel),
        false,
    )
    .await?;
    let rows = body["data"]
        .as_array()
        .ok_or_else(|| FunctionError::internal(false))?;
    let data = rows.first().cloned();
    if save_to_cache && let Some(data) = &data {
        let bytes = serde_json::to_vec(data).map_err(|_| FunctionError::internal(false))?;
        twitch
            .inner
            .dragonfly
            .set(&key, &bytes, dima_store::dragonfly::SetOptions::ex(10800))
            .await
            .map_err(|_| FunctionError::internal(false))?;
    }
    Ok(ChannelData { error: false, data })
}
async fn read_channel(
    twitch: &Twitch,
    request: HelixRequest,
    typed: bool,
) -> Result<Value, FunctionError> {
    let response = twitch.helix(request).await.map_err(|e| match e {
        HelixError::Credential { error, .. } => {
            if typed {
                FunctionError::new(error.message(), Some(403), Some("permission_error"))
            } else {
                FunctionError::internal(false)
            }
        }
        HelixError::Http(_) => FunctionError::internal(typed),
    })?;
    let body: Value = response
        .into_response()
        .json()
        .await
        .map_err(|_| FunctionError::internal(typed))?;
    if body
        .get("error")
        .is_some_and(|e| e == true || e.as_str().is_some_and(|s| !s.is_empty()))
    {
        return Err(FunctionError::new(
            body["message"].as_str().unwrap_or_default(),
            body["status"].as_u64().and_then(|n| u16::try_from(n).ok()),
            if typed { body["error"].as_str() } else { None },
        ));
    }
    Ok(body)
}
/// Subscription lookup response. Missing fields stay absent, without follower defaults.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Subscriptions {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Subscription rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<Value>>,
    /// Total subscriptions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    /// Subscription points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<f64>,
}
/// Fetch the first subscription page with the broadcaster's credential.
pub async fn get_channel_subscriptions(
    twitch: &Twitch,
    channel: &str,
) -> Result<Subscriptions, FunctionError> {
    let body = read_channel(
        twitch,
        HelixRequest::get(
            Path::fixed("/subscriptions"),
            Auth::Streamer(channel.into()),
        )
        .query("broadcaster_id", channel),
        true,
    )
    .await?;
    Ok(Subscriptions {
        error: false,
        message: "Successfully fetched subscriptions".into(),
        data: body["data"].as_array().cloned(),
        total: body["total"].as_f64(),
        points: body["points"].as_f64(),
    })
}
/// Successful editor list (the reference omits a success message).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Editors {
    /// Always false.
    pub error: bool,
    /// Normalized editors.
    pub editors: Vec<Editor>,
}
/// Lookup editors with the reference's 10-second timeout and 401 refresh wrapper.
pub async fn get_channel_editors(
    twitch: &Twitch,
    channel: &str,
    cache: bool,
) -> Result<Editors, FunctionError> {
    let response = twitch
        .helix(
            HelixRequest::get(
                Path::fixed("/channels/editors"),
                Auth::Streamer(channel.into()),
            )
            .query("broadcaster_id", channel)
            .timeout(std::time::Duration::from_secs(10))
            .retry_on_401()
            .operation("get_channel_editors"),
        )
        .await
        .map_err(|e| match e {
            HelixError::Credential { error, status } => {
                FunctionError::new(error.message(), Some(status), Some("transient"))
            }
            HelixError::Http(_) => {
                FunctionError::new("Internal server error", None, Some("transient"))
            }
        })?;
    if response.refresh_unavailable() {
        return Err(FunctionError::new(
            "Unable to refresh Twitch streamer token",
            Some(503),
            Some("transient"),
        ));
    }
    let code = response.status();
    let status = code.as_u16();
    let body: Value = response
        .into_response()
        .json()
        .await
        .map_err(|_| FunctionError::new("Internal server error", None, Some("transient")))?;
    if !code.is_success()
        || body
            .get("error")
            .is_some_and(|e| e == true || e.as_str().is_some_and(|s| !s.is_empty()))
    {
        return Err(FunctionError::new(
            body["message"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Twitch editor lookup failed ({status})")),
            Some(status),
            Some(if status == 401 || status == 403 {
                "auth_required"
            } else {
                "transient"
            }),
        ));
    }
    let rows: Vec<Editor> = serde_json::from_value(body["data"].clone())
        .map_err(|_| FunctionError::new("Internal server error", None, Some("transient")))?;
    let editors = normalize_editors(rows);
    if cache {
        let logins = super::polls::key(twitch, channel, "editors");
        let ids = super::polls::key(twitch, channel, "editors:ids");
        let legacy = format!(
            "{}{channel}:channel:editors",
            twitch.inner.config.keys.prefix()
        );
        let mut pipeline = redis::pipe();
        pipeline
            .cmd("DEL")
            .arg(&logins)
            .arg(&ids)
            .arg(legacy)
            .ignore();
        for editor in &editors {
            if !editor.user_login.is_empty() {
                pipeline
                    .cmd("SADD")
                    .arg(&logins)
                    .arg(&editor.user_login)
                    .ignore();
            }
            if !editor.user_id.is_empty() {
                pipeline.cmd("SADD").arg(&ids).arg(&editor.user_id).ignore();
            }
        }
        pipeline
            .cmd("EXPIRE")
            .arg(logins)
            .arg(86400)
            .ignore()
            .cmd("EXPIRE")
            .arg(ids)
            .arg(86400)
            .ignore();
        twitch
            .inner
            .dragonfly
            .query_pipeline::<()>(&pipeline)
            .await
            .map_err(|_| FunctionError::new("Internal server error", None, Some("transient")))?;
    }
    Ok(Editors {
        error: false,
        editors,
    })
}

/// Successful moderator removal, including the reference's `type` field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModeratorRemoved {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Reference success status.
    pub status: u16,
    /// Always success.
    #[serde(rename = "type")]
    pub kind: String,
}
/// Remove a moderator once, then maintain only existing cache entries.
/// Cancellation before/during the request drops its future; no transport retry occurs.
pub async fn remove_channel_moderator(
    twitch: &Twitch,
    channel: &str,
    user: &str,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<ModeratorRemoved, FunctionError> {
    let request = HelixRequest::delete(
        Path::fixed("/moderation/moderators"),
        Auth::Streamer(channel.into()),
    )
    .query("broadcaster_id", channel)
    .query("user_id", user);
    tokio::select! {biased;()=cancel.cancelled()=>return Err(FunctionError::internal(true)),result=action(twitch,request,"Moderator removed",false)=>{result?;}}
    let key = super::polls::key(twitch, channel, "moderators");
    let ids = format!("{key}:ids");
    let logins = format!("{key}:logins");
    let mapping = format!("{key}:mapping");
    let mut pipeline = redis::pipe();
    if let Some(mut cached) =
        super::polls::cached::<crate::functions::moderation::moderators::Moderators>(twitch, &key)
            .await
            .map_err(|_| FunctionError::internal(true))?
    {
        if let Some(index) = cached.data.iter().position(|m| m.user_id == user) {
            let removed = cached.data.remove(index);
            // Preserve splice(-1,1) when an inconsistent cached ID list lacks the user.
            if !cached.ids.is_empty() {
                let index = cached
                    .ids
                    .iter()
                    .position(|id| id == user)
                    .unwrap_or(cached.ids.len() - 1);
                cached.ids.remove(index);
            }
            if let Some(index) = cached
                .logins
                .iter()
                .position(|login| login == &removed.user_login)
            {
                cached.logins.remove(index);
                if index < cached.display_names.len() {
                    cached.display_names.remove(index);
                }
            }
            let bytes = serde_json::to_vec(&cached).map_err(|_| FunctionError::internal(true))?;
            twitch
                .inner
                .dragonfly
                .set(&key, &bytes, dima_store::dragonfly::SetOptions::ex(7200))
                .await
                .map_err(|_| FunctionError::internal(true))?;
            pipeline.cmd("SREM").arg(&ids).arg(user).ignore();
            if !removed.user_login.is_empty() {
                pipeline
                    .cmd("SREM")
                    .arg(&logins)
                    .arg(&removed.user_login)
                    .ignore()
                    .cmd("HDEL")
                    .arg(&mapping)
                    .arg(removed.user_login)
                    .ignore();
            }
        }
    } else {
        pipeline.cmd("SREM").arg(&ids).arg(user).ignore();
        let fields = twitch
            .inner
            .dragonfly
            .hgetall(&mapping)
            .await
            .map_err(|_| FunctionError::internal(true))?;
        if let Some((login, _)) = fields.into_iter().find(|(_, id)| id == user) {
            pipeline
                .cmd("SREM")
                .arg(logins)
                .arg(&login)
                .ignore()
                .cmd("HDEL")
                .arg(mapping)
                .arg(login)
                .ignore();
        }
    }
    twitch
        .inner
        .dragonfly
        .query_pipeline::<()>(&pipeline)
        .await
        .map_err(|_| FunctionError::internal(true))?;
    Ok(ModeratorRemoved {
        error: false,
        message: "Moderator removed".into(),
        status: 200,
        kind: "success".into(),
    })
}

/// User lookup supplied by the sibling users wrapper package; failure means no cache update.
pub trait ModeratorUserLookup: Send + Sync {
    /// Return the Twitch ID/login/display name after a moderator grant.
    fn lookup<'a>(
        &'a self,
        twitch: &'a Twitch,
        user: &'a str,
    ) -> futures_util::future::BoxFuture<
        'a,
        Option<crate::functions::moderation::moderators::Moderator>,
    >;
}
/// Successful addModerator response deliberately has no error boolean.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModeratorAdded {
    /// Always 200.
    pub status: u16,
    /// Always Success.
    pub message: String,
}
/// addModerator uses a string error instead of the other channel wrappers' boolean.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AddModeratorFailure {
    /// Reference status.
    pub status: u16,
    /// User-visible message.
    pub message: String,
    /// Error name, absent when Twitch omits it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Always error.
    #[serde(rename = "type")]
    pub kind: String,
}
impl std::fmt::Display for AddModeratorFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for AddModeratorFailure {}
/// Add a moderator (default user is the bot), then extend an already populated cache.
pub async fn add_moderator(
    twitch: &Twitch,
    channel: &str,
    user: Option<&str>,
    lookup: &impl ModeratorUserLookup,
) -> Result<ModeratorAdded, AddModeratorFailure> {
    let user = user.unwrap_or(crate::TWITCH_BOT_ACCOUNT_ID);
    let internal = || AddModeratorFailure {
        status: 500,
        message: "Internal server error".into(),
        error: Some("Internal server error".into()),
        kind: "error".into(),
    };
    let response = twitch
        .helix(
            HelixRequest::post(
                Path::fixed("/moderation/moderators"),
                Auth::Streamer(channel.into()),
            )
            .query("broadcaster_id", channel)
            .query("user_id", user),
        )
        .await
        .map_err(|e| match e {
            HelixError::Credential { error, .. } => AddModeratorFailure {
                status: 403,
                message: error.message(),
                error: Some("permission_error".into()),
                kind: "error".into(),
            },
            HelixError::Http(_) => internal(),
        })?;
    let status = response.status().as_u16();
    if status != 204 {
        let body: Value = response
            .into_response()
            .json()
            .await
            .map_err(|_| internal())?;
        return Err(AddModeratorFailure {
            status,
            message: body["message"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("Failed to add moderator")
                .into(),
            error: body["error"].as_str().map(str::to_owned),
            kind: "error".into(),
        });
    }
    if let Some(info) = lookup.lookup(twitch, user).await {
        let key = super::polls::key(twitch, channel, "moderators");
        if let Some(mut cached) = super::polls::cached::<
            crate::functions::moderation::moderators::Moderators,
        >(twitch, &key)
        .await
        .map_err(|_| internal())?
        {
            cached.ids.push(info.user_id.clone());
            cached.logins.push(info.user_login.clone());
            cached.display_names.push(info.user_name.clone());
            cached.data.push(info.clone());
            let bytes = serde_json::to_vec(&cached).map_err(|_| internal())?;
            twitch
                .inner
                .dragonfly
                .set(&key, &bytes, dima_store::dragonfly::SetOptions::ex(7200))
                .await
                .map_err(|_| internal())?;
            let ids = format!("{key}:ids");
            let logins = format!("{key}:logins");
            let mapping = format!("{key}:mapping");
            let mut pipeline = redis::pipe();
            pipeline
                .cmd("SADD")
                .arg(&ids)
                .arg(info.user_id.clone())
                .ignore()
                .cmd("EXPIRE")
                .arg(ids)
                .arg(7200)
                .ignore();
            pipeline
                .cmd("SADD")
                .arg(&logins)
                .arg(&info.user_login)
                .ignore()
                .cmd("EXPIRE")
                .arg(logins)
                .arg(7200)
                .ignore();
            pipeline
                .cmd("HSET")
                .arg(&mapping)
                .arg(info.user_login)
                .arg(info.user_id)
                .ignore()
                .cmd("EXPIRE")
                .arg(mapping)
                .arg(7200)
                .ignore();
            twitch
                .inner
                .dragonfly
                .query_pipeline::<()>(&pipeline)
                .await
                .map_err(|_| internal())?;
        }
    }
    Ok(ModeratorAdded {
        status: 200,
        message: "Success".into(),
    })
}
