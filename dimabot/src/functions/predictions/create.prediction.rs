use crate::{
    functions::{
        CacheCommand, FunctionFailure, TwitchFunctions, internal,
        polls::{first_item, map_prediction},
        remote_error,
    },
    utils::{json_number, twitch::TwitchAuth},
};
use reqwest::Method;
use serde_json::{Value, json};
impl TwitchFunctions {
    pub async fn create_prediction(
        &self,
        channel: &str,
        title: &str,
        outcomes: &Value,
        duration: &Value,
        cache: bool,
    ) -> Value {
        let result=async {
            self.cache.execute(CacheCommand::Acquire).await?;
            let body=json!({"broadcaster_id":channel,"title":title,"outcomes":outcomes,"prediction_window":json_number::to_number(duration)});
            let response=self.request(TwitchAuth::Streamer(channel.into()),Method::POST,"predictions",None,Some(&body),None).await?;
            let status=response.status().as_u16();let data:Value=response.json().await.map_err(|_|FunctionFailure::Internal)?;
            if let Some(error)=remote_error(&data,status){return Ok(error);}
            let mapped=map_prediction(first_item(&data)?,false)?;
            if cache{self.cache_value(format!("twitch:{channel}:predictions"),&mapped,None).await?;}
            let mut result=mapped;result["error"]=false.into();result["message"]="Prediction created successfully".into();Ok(result)
        }.await;
        self.finish(
            "createPrediction",
            channel,
            result,
            internal(true),
            Some("permission_error"),
        )
        .await
    }
}
