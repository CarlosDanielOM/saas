use super::{InteractionKind, first_item, map_interaction};
use crate::{
    functions::{FunctionFailure, TwitchFunctions, internal, remote_error},
    utils::twitch::TwitchAuth,
};
use reqwest::Method;
use serde_json::{Value, json};

impl TwitchFunctions {
    pub async fn end_poll(&self, channel: &str, poll_id: &str, status: &str) -> Value {
        if !matches!(status, "TERMINATED" | "ARCHIVED") {
            return json!({"error":true,"message":"Invalid status","status":400,"type":"invalid_status"});
        }
        let result = self
            .end_interaction(channel, poll_id, status, None, InteractionKind::Poll)
            .await;
        self.finish(
            "endPoll",
            channel,
            result,
            internal(true),
            Some("permission_error"),
        )
        .await
    }
    pub(crate) async fn end_interaction(
        &self,
        channel: &str,
        id: &str,
        status: &str,
        winner: Option<&str>,
        kind: InteractionKind,
    ) -> Result<Value, FunctionFailure> {
        let mut body = json!({"broadcaster_id":channel,"id":id,"status":status});
        if kind == InteractionKind::Prediction
            && status == "RESOLVED"
            && let Some(winner) = winner.filter(|winner| !winner.is_empty())
        {
            body["winning_outcome_id"] = winner.into();
        }
        let response = self
            .request(
                TwitchAuth::Streamer(channel.into()),
                Method::PATCH,
                kind.endpoint(),
                None,
                Some(&body),
                None,
            )
            .await?;
        let status = response.status().as_u16();
        let data: Value = response
            .json()
            .await
            .map_err(|_| FunctionFailure::Internal)?;
        if let Some(error) = remote_error(&data, status) {
            return Ok(error);
        }
        let mapped = map_interaction(kind, first_item(&data)?, false)?;
        self.cleanup_cache_later(
            format!("twitch:{channel}:{}", kind.endpoint()),
            if kind == InteractionKind::Poll {
                "endPoll.cacheCleanup"
            } else {
                "endPrediction.cacheCleanup"
            },
            channel.into(),
        );
        Ok(
            json!({"error":false,"message":format!("{} ended successfully",kind.noun()),"data":mapped}),
        )
    }
}
