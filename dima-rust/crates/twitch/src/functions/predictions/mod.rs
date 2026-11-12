//! Prediction wrappers. Reference: `functions/predictions/*.ts`.
//! No mutation is retried. Cache cleanup belongs to the Twitch task tracker.
use super::polls::{Answer, FunctionError, cached, call, cleanup, key, save, select};
use crate::{Auth, HelixRequest, Twitch};
use dima_http::Path;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Top predictor, as supplied by Helix.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TopPredictor {
    /// Twitch user ID.
    pub user_id: String,
    /// Display name.
    pub user_name: String,
    /// Login.
    pub user_login: String,
    /// Null before resolution.
    pub channel_points_won: Option<f64>,
    /// Points spent.
    pub channel_points_used: f64,
}
/// Prediction outcome.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Outcome {
    /// Outcome ID.
    pub id: String,
    /// Title.
    pub title: String,
    /// Participants.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub users: Option<f64>,
    /// Points spent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_points: Option<f64>,
    /// Leading participants (null is preserved).
    #[serde(
        default,
        deserialize_with = "top_predictors",
        skip_serializing_if = "Option::is_none"
    )]
    pub top_predictors: Option<Option<Vec<TopPredictor>>>,
    /// Twitch color.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
fn top_predictors<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<Vec<TopPredictor>>>, D::Error> {
    Option::<Vec<TopPredictor>>::deserialize(deserializer).map(Some)
}
/// Transformed prediction data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Prediction {
    /// ID.
    pub id: String,
    /// Title.
    pub title: String,
    /// Outcomes.
    pub outcomes: Vec<Outcome>,
    /// Broadcaster ID.
    #[serde(rename = "channelID", skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Status under the reference name.
    #[serde(rename = "predictionStatus", skip_serializing_if = "Option::is_none")]
    pub prediction_status: Option<String>,
    /// Additional alias included only by getPrediction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Winning outcome ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winning_outcome_id: Option<String>,
    /// Matching outcome, absent if Twitch did not include it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winning_outcome: Option<Outcome>,
}
/// Create response has flattened prediction data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CreatedPrediction {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Flattened fields (unlike get/end).
    #[serde(flatten)]
    pub prediction: Prediction,
}
#[derive(Deserialize)]
struct WirePrediction {
    id: String,
    title: String,
    outcomes: Vec<Outcome>,
    broadcaster_id: Option<String>,
    broadcaster_login: Option<String>,
    status: Option<String>,
    winning_outcome_id: Option<String>,
}
fn prediction(value: Value, get: bool) -> Result<Prediction, FunctionError> {
    let p: WirePrediction =
        serde_json::from_value(value).map_err(|_| FunctionError::internal(!get))?;
    let winner = p.winning_outcome_id.filter(|s| !s.is_empty());
    let winning_outcome = winner
        .as_ref()
        .and_then(|id| p.outcomes.iter().find(|o| &o.id == id))
        .cloned();
    Ok(Prediction {
        id: p.id,
        title: p.title,
        outcomes: p.outcomes,
        channel_id: p.broadcaster_id,
        channel: p.broadcaster_login,
        status: if get { p.status.clone() } else { None },
        prediction_status: p.status,
        winning_outcome_id: winner,
        winning_outcome,
    })
}
/// Create a prediction. Duration is the result of the caller's shared Number conversion.
pub async fn create_prediction(
    twitch: &Twitch,
    channel: &str,
    title: &str,
    outcomes: &[String],
    duration: f64,
    cache: bool,
) -> Result<CreatedPrediction, FunctionError> {
    let (status, data) = call(twitch, HelixRequest::post(Path::fixed("/predictions"), Auth::Streamer(channel.into())).json(json!({"broadcaster_id":channel,"title":title,"outcomes":outcomes.iter().map(|title| json!({"title":title})).collect::<Vec<_>>(),"prediction_window":duration})),true).await?;
    let result = prediction(select(&data, status, None, true, false)?, false)?;
    if cache {
        save(twitch, &key(twitch, channel, "predictions"), &result, true).await?;
    }
    Ok(CreatedPrediction {
        error: false,
        message: "Prediction created successfully".into(),
        prediction: result,
    })
}
/// Prefer ACTIVE or LOCKED without a specific ID; otherwise return the first result.
pub async fn get_prediction(
    twitch: &Twitch,
    channel: &str,
    id: Option<&str>,
    cache: bool,
) -> Result<Answer<Prediction>, FunctionError> {
    let key = key(twitch, channel, "predictions");
    if cache && let Some(result) = cached(twitch, &key).await? {
        return Ok(Answer::new("Success (from cache)", result));
    }
    let mut request =
        HelixRequest::get(Path::fixed("/predictions"), Auth::Streamer(channel.into()))
            .query("broadcaster_id", channel);
    if let Some(id) = id.filter(|s| !s.is_empty()) {
        request = request.query("id", id);
    }
    let (status, data) = call(twitch, request, false).await?;
    let result = prediction(select(&data, status, id, true, true)?, true)?;
    if cache {
        save(twitch, &key, &result, false).await?;
    }
    Ok(Answer::new("Success", result))
}
/// Lock, cancel or resolve a prediction. Only RESOLVED forwards a nonempty winner ID.
pub async fn end_prediction(
    twitch: &Twitch,
    channel: &str,
    id: &str,
    status: &str,
    winner: Option<&str>,
) -> Result<Answer<Prediction>, FunctionError> {
    if !matches!(status, "RESOLVED" | "CANCELED" | "LOCKED") {
        return Err(FunctionError::new(
            "Invalid status",
            Some(400),
            Some("invalid_status"),
        ));
    }
    let mut body = json!({"broadcaster_id":channel,"id":id,"status":status});
    if status == "RESOLVED"
        && let Some(winner) = winner.filter(|s| !s.is_empty())
    {
        body["winning_outcome_id"] = json!(winner);
    }
    let (code, data) = call(
        twitch,
        HelixRequest::patch(Path::fixed("/predictions"), Auth::Streamer(channel.into())).json(body),
        true,
    )
    .await?;
    let result = prediction(select(&data, code, Some(id), true, false)?, false)?;
    cleanup(twitch, key(twitch, channel, "predictions"));
    Ok(Answer::new("Prediction ended successfully", result))
}
