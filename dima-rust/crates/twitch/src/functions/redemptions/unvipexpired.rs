//! Frozen `unvipexpired.redemption.ts`; distinct from the temporary-roles worker.
use crate::{
    Twitch,
    functions::{channels::remove_channel_vip, polls::FunctionError},
};
use bson::doc;
use dima_store::mongo::number::JsNumber;
use futures_util::TryStreamExt;
use serde::Deserialize;

// A projection intentionally accepts legacy records without expireTimestamp: the reference
// reads expireDate, unlike the model's strict whole-document read type.
#[derive(Deserialize)]
struct ExpiringVip {
    #[serde(rename = "userID")]
    user_id: String,
    #[serde(rename = "expireDate", default)]
    date: Option<Calendar>,
}
#[derive(Deserialize)]
struct Calendar {
    #[serde(default, deserialize_with = "calendar_part")]
    year: Option<Option<JsNumber>>,
    #[serde(default, deserialize_with = "calendar_part")]
    month: Option<Option<JsNumber>>,
    #[serde(default, deserialize_with = "calendar_part")]
    day: Option<Option<JsNumber>>,
}
fn calendar_part<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<JsNumber>>, D::Error> {
    Option::<JsNumber>::deserialize(deserializer).map(Some)
}
/// Scan active VIPs for this channel, remove expired roles once, then delete one matching row.
/// Reference has no total batch limit or sleep; stream Mongo batches of 100 to bound memory.
/// Equality at midnight is not expired. Any removal failure retains the row and stops this pass,
/// including "not a VIP" (only the separate worker discards that error).
/// Successful completion is `None`, matching JavaScript undefined.
pub async fn unvip_expired_user(
    twitch: &Twitch,
    channel: &str,
) -> Result<Option<()>, FunctionError> {
    expire(twitch, channel).await.map_err(|e| {
        if e.message == "Internal server error" {
            FunctionError::new(e.message, Some(500), Some("error"))
        } else {
            e
        }
    })
}
async fn expire(twitch: &Twitch, channel: &str) -> Result<Option<()>, FunctionError> {
    let collection = twitch
        .inner
        .mongo
        .database()
        .collection::<ExpiringVip>(dima_model::vips::COLLECTION);
    let mut cursor = collection
        .find(doc! {"channelID":channel,"vip":true})
        .projection(doc! {"userID":1,"expireDate":1})
        .batch_size(100)
        .await
        .map_err(|_| FunctionError::internal(true))?;
    let mut next = cursor
        .try_next()
        .await
        .map_err(|_| FunctionError::internal(true))?;
    if next.is_none() {
        return Err(FunctionError::new(
            "No VIPs found",
            None,
            Some("no_vips_found"),
        ));
    }
    let now = twitch.inner.clock.now_ms();
    while let Some(vip) = next {
        // Missing or nonfinite calendar parts produce Invalid Date in the reference,
        // whose comparison is false; keep the record without contacting Twitch.
        let expiration = vip.date.and_then(|date| {
            // Date constructor: explicit null is zero; missing is NaN.
            let number = |part| match part {
                None => None,
                Some(None) => Some(0.0),
                Some(Some(JsNumber(n))) => Some(n),
            };
            let (year, month, day) = (number(date.year)?, number(date.month)?, number(date.day)?);
            if !year.is_finite() || !month.is_finite() || !day.is_finite() {
                return None;
            }
            dima_text::date_utc(year as i64, month as i64, day as i64, 0, 0, 0, 0)
        });
        if expiration.is_some_and(|deadline| now > deadline) {
            remove_channel_vip(twitch, channel, &vip.user_id)
                .await
                .map_err(|_| {
                    FunctionError::new("Error removing VIP", Some(500), Some("error_removing_vip"))
                })?;
            // Delete has no schema transformation; preserve reference's user/channel filter,
            // deliberately not _id (duplicate records can cause a different row to be deleted).
            twitch
                .inner
                .mongo
                .documents(dima_model::vips::COLLECTION)
                .delete_one(doc! {"userID": &vip.user_id,"channelID":channel})
                .await
                .map_err(|_| FunctionError::internal(true))?;
        }
        next = cursor
            .try_next()
            .await
            .map_err(|_| FunctionError::internal(true))?;
    }
    Ok(None)
}
