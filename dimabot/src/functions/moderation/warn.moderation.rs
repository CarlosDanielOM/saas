use super::moderation_failure;
use crate::{
    functions::{TwitchFunctions, prefix_utf16, query},
    utils::twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
};
use reqwest::Method;
use serde_json::{Value, json};

impl TwitchFunctions {
    pub async fn warn_user(&self, channel: &str, user: &str, reason: &str) -> Value {
        let result = async {
            let params = query([
                ("broadcaster_id".into(), channel.into()),
                ("moderator_id".into(), TWITCH_BOT_ACCOUNT_ID.into()),
            ]);
            let body = json!({"data":{"user_id":user,"reason":prefix_utf16(reason,500)}});
            let response = self
                .request(
                    TwitchAuth::Bot,
                    Method::POST,
                    "moderation/warnings",
                    Some(&params),
                    Some(&body),
                    None,
                )
                .await?;
            let status = response.status();
            let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
            Ok(
                moderation_failure(&data, status, "Twitch warn request failed").unwrap_or_else(
                    || json!({"error":false,"message":"Warning issued","status":status.as_u16()}),
                ),
            )
        }
        .await;
        self.finish(
            "warnUser",
            channel,
            result,
            json!({"error":true,"message":"Internal server error","status":500,"type":"error"}),
            Some("permission_error"),
        )
        .await
    }
}
