use super::{first_item, map_poll};
use crate::{
    functions::{CacheCommand, FunctionFailure, TwitchFunctions, internal, remote_error},
    utils::{json_number, twitch::TwitchAuth},
};
use reqwest::Method;
use serde_json::{Value, json};

impl TwitchFunctions {
    pub async fn create_poll(
        &self,
        channel: &str,
        title: &str,
        choices: &Value,
        duration: &Value,
        cache: bool,
        channel_points_per_vote: f64,
    ) -> Value {
        let result=async {
            if !channel_points_per_vote.is_finite()||channel_points_per_vote.fract()!=0.0||!(0.0..=1_000_000.0).contains(&channel_points_per_vote){return Ok(json!({"error":true,"message":"Channel Points per vote must be a whole number from 0 to 1000000","status":400,"type":"validation_error"}));}
            // Source acquisition is unconditional here, including cache=false.
            self.cache.execute(CacheCommand::Acquire).await?;
            let mut body=json!({"broadcaster_id":channel,"title":title,"choices":choices,"duration":json_number::to_number(duration)});
            if channel_points_per_vote>0.0{body["channel_points_voting_enabled"]=true.into();body["channel_points_per_vote"]=json!(channel_points_per_vote);}
            let response=self.request(TwitchAuth::Streamer(channel.into()),Method::POST,"polls",None,Some(&body),None).await?;
            let status=response.status().as_u16();let data:Value=response.json().await.map_err(|_|FunctionFailure::Internal)?;
            if let Some(error)=remote_error(&data,status){return Ok(error);}
            let mapped=map_poll(first_item(&data)?,false)?;
            if cache{self.cache_value(format!("twitch:{channel}:polls"),&mapped,None).await?;}
            // createPoll returns the object itself, unlike get/end wrappers.
            Ok(mapped)
        }.await;
        self.finish(
            "createPoll",
            channel,
            result,
            internal(true),
            Some("permission_error"),
        )
        .await
    }
}
