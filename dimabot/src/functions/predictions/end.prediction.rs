use crate::functions::{TwitchFunctions, internal, polls::InteractionKind};
use serde_json::{Value, json};
impl TwitchFunctions {
    pub async fn end_prediction(
        &self,
        channel: &str,
        prediction_id: &str,
        status: &str,
        winner_id: Option<&str>,
    ) -> Value {
        if !matches!(status, "RESOLVED" | "CANCELED" | "LOCKED") {
            return json!({"error":true,"message":"Invalid status","status":400,"type":"invalid_status"});
        }
        let result = self
            .end_interaction(
                channel,
                prediction_id,
                status,
                winner_id,
                InteractionKind::Prediction,
            )
            .await;
        self.finish(
            "endPrediction",
            channel,
            result,
            internal(true),
            Some("permission_error"),
        )
        .await
    }
}
