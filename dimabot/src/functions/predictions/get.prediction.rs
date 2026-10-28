use crate::functions::{TwitchFunctions, internal, polls::InteractionKind};
use serde_json::Value;
impl TwitchFunctions {
    pub async fn get_prediction(
        &self,
        channel: &str,
        prediction_id: Option<&str>,
        cache: bool,
    ) -> Value {
        let result = self
            .get_interaction(channel, prediction_id, cache, InteractionKind::Prediction)
            .await;
        self.finish(
            "getPrediction",
            channel,
            result,
            internal(false),
            Some("permission_error"),
        )
        .await
    }
}
