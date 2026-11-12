//! Frozen `vip.redemption.ts`, including its failed timed-role write before the grant.
use super::{RewardApi, RewardSuccess, update};
use crate::{
    Twitch,
    functions::{channels::add_channel_vip, polls::FunctionError},
};
use bson::{RawDocumentBuf, doc};
use dima_model::{
    redemption_rewards::{COLLECTION, RedemptionReward},
    vips,
};
use dima_store::mongo::WriteContext;

/// Identity fields used by the reference redemption (reward metadata comes from storage).
#[derive(Clone, Debug)]
pub struct VipRedemptionEvent<'a> {
    /// Broadcaster ID.
    pub channel_id: &'a str,
    /// Broadcaster login.
    pub channel: &'a str,
    /// Viewer ID.
    pub user_id: &'a str,
    /// Viewer login.
    pub username: &'a str,
}
/// Increment cost, attempt the timed-role save, then grant VIP with the broadcaster token.
/// Chat and refunds belong to the caller: neither is invoked by this reference function.
pub async fn vip_redemption(
    twitch: &Twitch,
    api: &impl RewardApi,
    event: &VipRedemptionEvent<'_>,
    reward_id: &str,
) -> Result<RewardSuccess, FunctionError> {
    let raw = twitch
        .inner
        .mongo
        .database()
        .collection::<RawDocumentBuf>(COLLECTION)
        .find_one(doc! {"channelID": event.channel_id, "rewardID": reward_id, "type": "vip"})
        .await
        .map_err(|_| FunctionError::internal(true))?
        .ok_or_else(|| {
            FunctionError::new("Reward not found", Some(404), Some("reward_not_found"))
        })?;
    let reward: RedemptionReward =
        dima_model::decode(&raw).map_err(|_| FunctionError::internal(true))?;
    if reward.cost_change_number() > 0.0 {
        // Unlike custom redemption the reference does not clamp the new cost to 1.
        update(
            twitch,
            api,
            event.channel_id,
            &reward,
            reward.cost_number() + reward.cost_change_number(),
        )
        .await?;
    }
    if reward.duration_number() > 0.0 {
        let now = twitch.inner.clock.now_ms();
        let today = dima_text::utc_fields(now).ok_or_else(|| FunctionError::internal(true))?;
        let expires = dima_text::date_utc(
            today.year,
            i64::from(today.month),
            (f64::from(today.day) + reward.duration_number()).trunc() as i64,
            0,
            0,
            0,
            0,
        )
        .and_then(dima_text::utc_fields)
        .ok_or_else(|| FunctionError::internal(true))?;
        // QUIRK: Mongoose save validates expireTimestamp, which this reference omits.
        // Use INFO rather than NewVip: its required timestamp would silently repair the bug.
        // Validation fails before insert AND before add_channel_vip. Never invent a timestamp.
        let prepared = vips::INFO.prepare_create(&doc! {
            "username":event.username, "userID":event.user_id,
            "channel":event.channel, "channelID":event.channel_id,
            "vip":true, "duration":reward.duration_number(),
            "expireDate":{"day":expires.day as i32,"month":expires.month as i32,"year":expires.year}
        }, &mut WriteContext::new(now)).map_err(|_| FunctionError::internal(true))?;
        twitch
            .inner
            .mongo
            .writes(vips::COLLECTION)
            .insert_one(&prepared)
            .await
            .map_err(|_| FunctionError::internal(true))?;
    }
    add_channel_vip(twitch, event.channel_id, event.user_id)
        .await
        .map_err(|_| FunctionError::new("Error adding VIP", Some(500), Some("error_adding_vip")))?;
    Ok(RewardSuccess {
        error: false,
        message: "VIP added".into(),
        reward_message: Some(reward.message_text().into()),
    })
}
