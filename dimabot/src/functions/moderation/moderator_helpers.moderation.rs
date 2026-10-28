use super::string_array;
use crate::functions::{CacheCommand, CacheValue, FunctionFailure, TwitchFunctions, internal};
use serde_json::{Value, json};

impl TwitchFunctions {
    pub async fn get_twitch_moderators_ids(&self, channel: &str, skip_cache: bool) -> Value {
        let result=async {
            if !skip_cache {
                let CacheValue::Strings(ids)=self.cache.execute(CacheCommand::Members(format!("twitch:{channel}:moderators:ids"))).await? else{return Err(FunctionFailure::Internal);};
                if !ids.is_empty(){return Ok(json!({"error":false,"message":"Success (from cache)","ids":ids}));}
            }
            let result=self.get_channel_moderators(channel,&[],true).await;
            if result["error"]==true {return Ok(json!({"error":true,"message":result["message"]}));}
            Ok(json!({"error":false,"message":"Success","ids":result.get("ids").filter(|value|!value.is_null()).cloned().unwrap_or_else(||json!([]))}))
        }.await;
        self.finish(
            "getTwitchModeratorsIds",
            channel,
            result,
            internal(false),
            None,
        )
        .await
    }
    pub async fn is_twitch_moderator_by_id(
        &self,
        channel: &str,
        user: &str,
        skip_cache: bool,
    ) -> Value {
        self.is_twitch_moderator(channel, user, skip_cache, false)
            .await
    }
    pub async fn is_twitch_moderator_by_login(
        &self,
        channel: &str,
        login: &str,
        skip_cache: bool,
    ) -> Value {
        self.is_twitch_moderator(channel, login, skip_cache, true)
            .await
    }
    async fn is_twitch_moderator(
        &self,
        channel: &str,
        user: &str,
        skip_cache: bool,
        by_login: bool,
    ) -> Value {
        let found = |is_moderator| json!({"error":false,"isModerator":is_moderator,"message":if is_moderator{"User is a moderator"}else{"User is not a moderator"}});
        let result = async {
            if !skip_cache {
                let key = format!(
                    "twitch:{channel}:moderators:{}",
                    if by_login { "logins" } else { "ids" }
                );
                let CacheValue::Flag(member) = self
                    .cache
                    .execute(CacheCommand::IsMember {
                        key: key.clone(),
                        value: user.into(),
                    })
                    .await?
                else {
                    return Err(FunctionFailure::Internal);
                };
                if member {
                    return Ok(found(true));
                }
                let CacheValue::Flag(exists) =
                    self.cache.execute(CacheCommand::Exists(key)).await?
                else {
                    return Err(FunctionFailure::Internal);
                };
                if exists {
                    return Ok(found(false));
                }
            }
            let response = self.get_channel_moderators(channel, &[], true).await;
            if response["error"] == true {
                return Ok(json!({"error":true,"isModerator":false,"message":response["message"]}));
            }
            let members = string_array(&response, if by_login { "logins" } else { "ids" })?;
            Ok(found(members.iter().any(|value| value == user)))
        }
        .await;
        self.finish(
            if by_login {
                "isTwitchModeratorByLogin"
            } else {
                "isTwitchModeratorById"
            },
            channel,
            result,
            json!({"error":true,"isModerator":false,"message":"Internal server error"}),
            None,
        )
        .await
    }
}
