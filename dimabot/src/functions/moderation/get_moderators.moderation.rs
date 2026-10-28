use crate::{
    functions::{
        CacheCommand, FunctionFailure, TwitchFunctions, copy_fields, internal, query, truthy,
    },
    utils::twitch::TwitchAuth,
};
use reqwest::Method;
use serde_json::{Value, json};

impl TwitchFunctions {
    pub async fn get_channel_moderators(
        &self,
        channel: &str,
        user_ids: &[String],
        cache: bool,
    ) -> Value {
        let result = self.load_channel_moderators(channel, user_ids, cache).await;
        self.finish(
            "getChannelModerators",
            channel,
            result,
            internal(false),
            None,
        )
        .await
    }
    pub(crate) async fn load_channel_moderators(
        &self,
        channel: &str,
        user_ids: &[String],
        cache: bool,
    ) -> Result<Value, FunctionFailure> {
        self.cache.execute(CacheCommand::Acquire).await?;
        let key = format!("twitch:{channel}:moderators");
        if cache && let Some(cached) = self.cached(&key).await? {
            let mut result = copy_fields(
                &cached,
                &[
                    ("data", "data"),
                    ("ids", "ids"),
                    ("logins", "logins"),
                    ("displayNames", "displayNames"),
                ],
            );
            result.insert("error".into(), false.into());
            result.insert("message".into(), "Success (from cache)".into());
            return Ok(Value::Object(result));
        }
        let params = query(
            std::iter::once(("broadcaster_id".into(), channel.into()))
                .chain(user_ids.iter().cloned().map(|id| ("user_id".into(), id))),
        );
        let response = self
            .request(
                TwitchAuth::Streamer(channel.into()),
                Method::GET,
                "moderation/moderators",
                Some(&params),
                None,
                None,
            )
            .await?;
        let data: Value = response
            .json()
            .await
            .map_err(|_| FunctionFailure::Internal)?;
        if data.get("error").is_some_and(truthy) {
            let mut result = copy_fields(&data, &[("message", "message"), ("status", "status")]);
            result.insert("error".into(), true.into());
            return Ok(Value::Object(result));
        }
        let moderators = data
            .get("data")
            .and_then(Value::as_array)
            .ok_or(FunctionFailure::Internal)?;
        let mut ids = Vec::with_capacity(moderators.len());
        let mut logins = Vec::with_capacity(moderators.len());
        let mut names = Vec::with_capacity(moderators.len());
        let mut mapping = std::collections::BTreeMap::new();
        for moderator in moderators {
            let id = moderator
                .get("user_id")
                .and_then(Value::as_str)
                .ok_or(FunctionFailure::Internal)?;
            let login = moderator
                .get("user_login")
                .and_then(Value::as_str)
                .ok_or(FunctionFailure::Internal)?;
            let name = moderator
                .get("user_name")
                .and_then(Value::as_str)
                .ok_or(FunctionFailure::Internal)?;
            ids.push(id.to_owned());
            logins.push(login.to_owned());
            names.push(name.to_owned());
            mapping.insert(login.to_owned(), id.to_owned());
        }
        let result = json!({"error":false,"message":"Success","data":moderators,"ids":ids,"logins":logins,"displayNames":names});
        if cache {
            self.cache_value(key, &result, Some(7200)).await?;
            let id_key = format!("twitch:{channel}:moderators:ids");
            let login_key = format!("twitch:{channel}:moderators:logins");
            let mapping_key = format!("twitch:{channel}:moderators:mapping");
            for key in [&id_key, &login_key, &mapping_key] {
                self.cache
                    .execute(CacheCommand::Delete(key.clone()))
                    .await?;
            }
            for (key, values) in [(id_key, ids), (login_key, logins)] {
                if !values.is_empty() {
                    self.cache
                        .execute(CacheCommand::AddMembers {
                            key: key.clone(),
                            values,
                        })
                        .await?;
                    self.cache
                        .execute(CacheCommand::Expire { key, seconds: 7200 })
                        .await?;
                }
            }
            if !mapping.is_empty() {
                self.cache
                    .execute(CacheCommand::Hash {
                        key: mapping_key.clone(),
                        entries: mapping.into_iter().collect(),
                    })
                    .await?;
                self.cache
                    .execute(CacheCommand::Expire {
                        key: mapping_key,
                        seconds: 7200,
                    })
                    .await?;
            }
        }
        Ok(result)
    }
}
