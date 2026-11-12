//! Reward-cost orchestration. The reference PATCHes the internal rewards API, not Helix.
//! The API owns reward writes; these functions only read `redemptionrewards`.
//! VIP creation/expiration cannot be ported here until dima-model holds VipSchema (`vips`).
use crate::functions::polls::FunctionError;
use crate::{AccessToken, Twitch};
use bson::{RawDocumentBuf, doc};
use dima_model::redemption_rewards::{COLLECTION, RedemptionReward};
use futures_util::{TryStreamExt, future::BoxFuture};
use serde::{Deserialize, Serialize};
/// The reference's internal PATCH body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RewardUpdate {
    /// Stored title.
    pub title: String,
    /// Stored prompt.
    pub prompt: String,
    /// New price.
    pub cost: f64,
}
/// A transport/body failure from the internal reward API. Never includes credentials.
#[derive(Debug, thiserror::Error)]
#[error("Internal rewards API unavailable")]
pub struct RewardApiError;
/// Adapter supplied by the rewards API package. Send exactly one PATCH to
/// `/rewards/{channel}/{reward}` with bearer authorization and a JSON RewardUpdate.
/// Return the parsed response's `error` flag, or RewardApiError on transport/malformed JSON.
pub trait RewardApi: Send + Sync {
    /// No retries after timeout or 5xx; use a bounded deadline (60s when the reference has none).
    fn update<'a>(
        &'a self,
        channel: &'a str,
        reward: &'a str,
        token: &'a AccessToken,
        body: RewardUpdate,
    ) -> BoxFuture<'a, Result<bool, RewardApiError>>;
}
/// Reference reward operation success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RewardSuccess {
    /// Always false.
    pub error: bool,
    /// User-visible message.
    pub message: String,
    /// Present for custom redemption, absent for reset.
    #[serde(rename = "rewardMessage", skip_serializing_if = "Option::is_none")]
    pub reward_message: Option<String>,
}
async fn update(
    twitch: &Twitch,
    api: &impl RewardApi,
    channel: &str,
    reward: &RedemptionReward,
    cost: f64,
) -> Result<(), FunctionError> {
    let token = twitch
        .streamer_token(channel, None, "redemption")
        .await
        .map_err(|_| {
            FunctionError::new(
                "Failed to authenticate",
                Some(403),
                Some("authentication_error"),
            )
        })?;
    if api
        .update(
            channel,
            reward.reward_id.as_deref().unwrap_or_default(),
            &token,
            RewardUpdate {
                title: reward.title.clone().unwrap_or_default(),
                prompt: reward.prompt.clone().unwrap_or_default(),
                cost,
            },
        )
        .await
        .map_err(|_| FunctionError::internal(true))?
    {
        return Err(FunctionError::new(
            "Error updating reward",
            Some(500),
            Some("error_updating_reward"),
        ));
    }
    Ok(())
}
/// Custom redemption: increment positive configured costChange; return the stored message.
pub async fn custom_redemption_reward(
    twitch: &Twitch,
    api: &impl RewardApi,
    channel: &str,
    reward_id: &str,
) -> Result<RewardSuccess, FunctionError> {
    let raw = twitch
        .inner
        .mongo
        .database()
        .collection::<RawDocumentBuf>(COLLECTION)
        .find_one(doc! {"channelID":channel,"rewardID":reward_id})
        .await
        .map_err(|_| FunctionError::internal(true))?
        .ok_or_else(|| {
            FunctionError::new("Reward not found", Some(404), Some("reward_not_found"))
        })?;
    let reward: RedemptionReward =
        dima_model::decode(&raw).map_err(|_| FunctionError::internal(true))?;
    if reward.cost_change_number() > 0.0 {
        update(
            twitch,
            api,
            channel,
            &reward,
            (reward.cost_number() + reward.cost_change_number()).max(1.0),
        )
        .await?;
    }
    Ok(RewardSuccess {
        error: false,
        message: "Reward updated".into(),
        reward_message: Some(reward.message_text().to_owned()),
    })
}
/// Reset all opted-in rewards for a non-free streamer. Stop on the first failed update.
pub async fn reset_redemption_cost(
    twitch: &Twitch,
    api: &impl RewardApi,
    channel: &str,
) -> Result<RewardSuccess, FunctionError> {
    let account = twitch.streamer(channel).await;
    if account
        .as_ref()
        .is_none_or(|a| a.plan_tier() == Some("free"))
    {
        return Err(FunctionError::new(
            "Channel not premium",
            Some(400),
            Some("channel_not_premium"),
        ));
    }
    let mut cursor = twitch
        .inner
        .mongo
        .database()
        .collection::<RawDocumentBuf>(COLLECTION)
        .find(doc! {"channelID":channel,"returnToOriginalCost":true})
        .await
        .map_err(|_| FunctionError::internal(true))?;
    let Some(first) = cursor
        .try_next()
        .await
        .map_err(|_| FunctionError::internal(true))?
    else {
        return Err(FunctionError::new(
            "No rewards found",
            Some(404),
            Some("no_rewards_found"),
        ));
    };
    let token = twitch
        .streamer_token(channel, None, "resetRedemptionCost")
        .await
        .map_err(|_| {
            FunctionError::new(
                "Failed to authenticate",
                Some(403),
                Some("authentication_error"),
            )
        })?;
    let mut next = Some(first);
    while let Some(raw) = next {
        let reward: RedemptionReward =
            dima_model::decode(&raw).map_err(|_| FunctionError::internal(true))?;
        if api
            .update(
                channel,
                reward.reward_id.as_deref().unwrap_or_default(),
                &token,
                RewardUpdate {
                    title: reward.title.clone().unwrap_or_default(),
                    prompt: reward.prompt.clone().unwrap_or_default(),
                    cost: reward.original_cost_number(),
                },
            )
            .await
            .map_err(|_| FunctionError::internal(true))?
        {
            return Err(FunctionError::new(
                "Error updating reward",
                Some(500),
                Some("error_updating_reward"),
            ));
        }
        next = cursor
            .try_next()
            .await
            .map_err(|_| FunctionError::internal(true))?;
    }
    Ok(RewardSuccess {
        error: false,
        message: "Costs reset".into(),
        reward_message: None,
    })
}
