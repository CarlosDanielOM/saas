//! Poll wrappers. Reference: `functions/polls/{create,end,get}.poll.ts`.
//! No retries, including 401; the default Helix deadline bounds otherwise unbounded fetches.
//! Poll caches are rebuilt after cutover and have no TTL, matching the reference.
use crate::{Auth, HelixError, HelixRequest, Twitch};
use dima_http::Path;
use dima_store::dragonfly::SetOptions;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Reference failure envelope. Missing status/type remain absent, not null.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FunctionError {
    /// Always true.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Reference HTTP status, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Reference error category.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}
impl std::fmt::Display for FunctionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for FunctionError {}
impl FunctionError {
    pub(crate) fn new(message: impl Into<String>, status: Option<u16>, kind: Option<&str>) -> Self {
        Self {
            error: true,
            message: message.into(),
            status,
            kind: kind.map(str::to_owned),
        }
    }
    pub(crate) fn internal(typed: bool) -> Self {
        Self::new("Internal server error", None, typed.then_some("error"))
    }
}
/// Successful get/end envelope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Answer<T> {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Transformed Twitch data.
    pub data: T,
}
impl<T> Answer<T> {
    pub(crate) fn new(message: &str, data: T) -> Self {
        Self {
            error: false,
            message: message.into(),
            data,
        }
    }
}
/// A choice; channel-points votes are returned only by getPoll.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PollChoice {
    /// Twitch ID.
    pub id: String,
    /// Choice title.
    pub title: String,
    /// Votes, absent in a partial Twitch response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub votes: Option<f64>,
    /// Included by getPoll, defaulting to zero.
    #[serde(rename = "channelPointsVotes", skip_serializing_if = "Option::is_none")]
    pub channel_points_votes: Option<f64>,
}
/// The reference's transformed poll.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Poll {
    /// Twitch ID.
    pub id: String,
    /// Title.
    pub title: String,
    /// Choices.
    pub choices: Vec<PollChoice>,
    /// Broadcaster ID.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Broadcaster login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Returned only by getPoll.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}
#[derive(Deserialize)]
struct WireChoice {
    id: String,
    title: String,
    votes: Option<f64>,
    channel_points_votes: Option<f64>,
}
#[derive(Deserialize)]
struct WirePoll {
    id: String,
    title: String,
    choices: Vec<WireChoice>,
    broadcaster_id: Option<String>,
    broadcaster_login: Option<String>,
    status: Option<String>,
}
fn poll(value: Value, get: bool) -> Result<Poll, FunctionError> {
    let p: WirePoll = serde_json::from_value(value).map_err(|_| FunctionError::internal(!get))?;
    Ok(Poll {
        id: p.id,
        title: p.title,
        choices: p
            .choices
            .into_iter()
            .map(|c| PollChoice {
                id: c.id,
                title: c.title,
                votes: c.votes,
                channel_points_votes: get.then_some(c.channel_points_votes.unwrap_or(0.0)),
            })
            .collect(),
        channel_id: p.broadcaster_id,
        channel: p.broadcaster_login,
        status: if get { p.status } else { None },
    })
}
pub(crate) fn key(twitch: &Twitch, channel: &str, family: &str) -> String {
    format!(
        "{}twitch:{channel}:{family}",
        twitch.inner.config.keys.prefix()
    )
}
pub(crate) async fn cached<T: serde::de::DeserializeOwned>(
    twitch: &Twitch,
    key: &str,
) -> Result<Option<T>, FunctionError> {
    let bytes = twitch
        .inner
        .dragonfly
        .get(key)
        .await
        .map_err(|_| FunctionError::internal(false))?;
    bytes
        .map(|b| serde_json::from_slice(&b).map_err(|_| FunctionError::internal(false)))
        .transpose()
}
pub(crate) async fn save<T: Serialize>(
    twitch: &Twitch,
    key: &str,
    data: &T,
    typed: bool,
) -> Result<(), FunctionError> {
    let bytes = serde_json::to_vec(data).map_err(|_| FunctionError::internal(typed))?;
    twitch
        .inner
        .dragonfly
        .set(key, &bytes, SetOptions::default())
        .await
        .map_err(|_| FunctionError::internal(typed))?;
    Ok(())
}
pub(crate) fn cleanup(twitch: &Twitch, key: String) {
    let cache = twitch.inner.dragonfly.clone();
    // Owned by Twitch; shutdown joins the cleanup. Never delays or fails an already committed mutation.
    twitch.inner.tracker.spawn(async move {
        let _ = cache.del(&[&key]).await;
    });
}
pub(crate) async fn call(
    twitch: &Twitch,
    request: HelixRequest,
    typed: bool,
) -> Result<(u16, Value), FunctionError> {
    let response = twitch.helix(request).await.map_err(|e| match e {
        HelixError::Credential { error, .. } => {
            FunctionError::new(error.message(), Some(403), Some("permission_error"))
        }
        HelixError::Http(_) => FunctionError::internal(typed),
    })?;
    let status = response.status().as_u16();
    let body: Value = response
        .into_response()
        .json()
        .await
        .map_err(|_| FunctionError::internal(typed))?;
    if body
        .get("error")
        .is_some_and(|e| e.as_str().is_some_and(|s| !s.is_empty()) || e == true)
    {
        return Err(FunctionError::new(
            body["message"].as_str().unwrap_or_default(),
            Some(status),
            body["error"].as_str(),
        ));
    }
    Ok((status, body))
}
pub(crate) fn select(
    body: &Value,
    status: u16,
    id: Option<&str>,
    prediction: bool,
    get: bool,
) -> Result<Value, FunctionError> {
    let list = body["data"]
        .as_array()
        .ok_or_else(|| FunctionError::internal(!get))?;
    if get && (list.is_empty() || status == 404) {
        return Err(FunctionError::new(
            if prediction {
                "Prediction not found"
            } else {
                "Poll not found"
            },
            Some(status),
            Some("not_found"),
        ));
    }
    let active = if get && id.filter(|s| !s.is_empty()).is_none() {
        list.iter()
            .find(|p| p["status"] == "ACTIVE" || prediction && p["status"] == "LOCKED")
    } else {
        None
    };
    active
        .or_else(|| list.first())
        .cloned()
        .ok_or_else(|| FunctionError::internal(!get))
}
/// Create a poll. Twitch owns title/choice limits; the reference passes them unchanged.
pub async fn create_poll(
    twitch: &Twitch,
    channel: &str,
    title: &str,
    choices: &[String],
    duration: f64,
    cache: bool,
    channel_points_per_vote: f64,
) -> Result<Poll, FunctionError> {
    if !channel_points_per_vote.is_finite()
        || channel_points_per_vote.fract() != 0.0
        || !(0.0..=1_000_000.0).contains(&channel_points_per_vote)
    {
        return Err(FunctionError::new(
            "Channel Points per vote must be a whole number from 0 to 1000000",
            Some(400),
            Some("validation_error"),
        ));
    }
    let mut body = json!({"broadcaster_id":channel,"title":title,"choices":choices.iter().map(|title| json!({"title":title})).collect::<Vec<_>>(),"duration":duration});
    if channel_points_per_vote > 0.0 {
        body["channel_points_voting_enabled"] = json!(true);
        body["channel_points_per_vote"] = json!(channel_points_per_vote);
    }
    let (status, data) = call(
        twitch,
        HelixRequest::post(Path::fixed("/polls"), Auth::Streamer(channel.into())).json(body),
        true,
    )
    .await?;
    let result = poll(select(&data, status, None, false, false)?, false)?;
    if cache {
        save(twitch, &key(twitch, channel, "polls"), &result, true).await?;
    }
    Ok(result)
}
/// Lookup a poll; prefer ACTIVE when no ID was requested.
pub async fn get_poll(
    twitch: &Twitch,
    channel: &str,
    id: Option<&str>,
    cache: bool,
) -> Result<Answer<Poll>, FunctionError> {
    let key = key(twitch, channel, "polls");
    if cache && let Some(poll) = cached(twitch, &key).await? {
        return Ok(Answer::new("Success (from cache)", poll));
    }
    let mut request = HelixRequest::get(Path::fixed("/polls"), Auth::Streamer(channel.into()))
        .query("broadcaster_id", channel);
    if let Some(id) = id.filter(|s| !s.is_empty()) {
        request = request.query("id", id);
    }
    let (status, data) = call(twitch, request, false).await?;
    let result = poll(select(&data, status, id, false, true)?, true)?;
    if cache {
        save(twitch, &key, &result, false).await?;
    }
    Ok(Answer::new("Success", result))
}
/// End a poll; invalid status fails before any request.
pub async fn end_poll(
    twitch: &Twitch,
    channel: &str,
    id: &str,
    status: &str,
) -> Result<Answer<Poll>, FunctionError> {
    if !matches!(status, "TERMINATED" | "ARCHIVED") {
        return Err(FunctionError::new(
            "Invalid status",
            Some(400),
            Some("invalid_status"),
        ));
    }
    let (code, data) = call(
        twitch,
        HelixRequest::patch(Path::fixed("/polls"), Auth::Streamer(channel.into()))
            .json(json!({"broadcaster_id":channel,"id":id,"status":status})),
        true,
    )
    .await?;
    let result = poll(select(&data, code, Some(id), false, false)?, false)?;
    cleanup(twitch, key(twitch, channel, "polls"));
    Ok(Answer::new("Poll ended successfully", result))
}
