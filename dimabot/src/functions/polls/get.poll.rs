use super::{InteractionKind, map_interaction};
use crate::{
    functions::{FunctionFailure, TwitchFunctions, internal, query, remote_error},
    utils::twitch::TwitchAuth,
};
use reqwest::Method;
use serde_json::{Value, json};

impl TwitchFunctions {
    pub async fn get_poll(&self, channel: &str, poll_id: Option<&str>, cache: bool) -> Value {
        let result = self
            .get_interaction(channel, poll_id, cache, InteractionKind::Poll)
            .await;
        self.finish(
            "getPoll",
            channel,
            result,
            internal(false),
            Some("permission_error"),
        )
        .await
    }
    pub(crate) async fn get_interaction(
        &self,
        channel: &str,
        id: Option<&str>,
        cache: bool,
        kind: InteractionKind,
    ) -> Result<Value, FunctionFailure> {
        let key = format!("twitch:{channel}:{}", kind.endpoint());
        if cache && let Some(data) = self.cached(&key).await? {
            return Ok(json!({"error":false,"message":"Success (from cache)","data":data}));
        }
        let mut pairs = vec![("broadcaster_id".into(), channel.into())];
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            pairs.push(("id".into(), id.into()));
        }
        let params = query(pairs);
        let response = self
            .request(
                TwitchAuth::Streamer(channel.into()),
                Method::GET,
                kind.endpoint(),
                Some(&params),
                None,
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
        let items = data
            .get("data")
            .and_then(Value::as_array)
            .ok_or(FunctionFailure::Internal)?;
        if items.is_empty() || status == 404 {
            return Ok(
                json!({"error":true,"message":format!("{} not found",kind.noun()),"status":status,"type":data.get("error").filter(|value|!value.is_null()).cloned().unwrap_or(json!("not_found"))}),
            );
        }
        let selected = if id.is_some_and(|id| !id.is_empty()) {
            &items[0]
        } else {
            items
                .iter()
                .find(|item| kind.active(item.get("status").and_then(Value::as_str)))
                .unwrap_or(&items[0])
        };
        let mapped = map_interaction(kind, selected, true)?;
        if cache {
            self.cache_value(key, &mapped, None).await?;
        }
        Ok(json!({"error":false,"message":"Success","data":mapped}))
    }
}
