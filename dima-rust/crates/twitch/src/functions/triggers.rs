//! Trigger delivery through the existing backend owner-token API boundary.
use super::{
    Envelope,
    chats::speech::{BackendApi, BackendRequest},
};
use crate::Twitch;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Trigger playback fields.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerData {
    /// Optional stored trigger id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_id: Option<String>,
    /// Optional display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Media URL (the downstream API applies its SSRF policy).
    pub url: String,
    /// Media type.
    pub media_type: String,
    /// Playback volume.
    pub volume: f64,
}
/// `sendTrigger`, preserving revoked-versus-transient token messages.
pub async fn send_trigger(
    twitch: &Twitch,
    api: &dyn BackendApi,
    channel: &str,
    data: TriggerData,
    queue: bool,
) -> Envelope<()> {
    let token = match twitch.streamer_token(channel, None, "sendTrigger").await {
        Ok(t) => t,
        Err(_) => {
            let revoked = twitch
                .streamer(channel)
                .await
                .is_none_or(|s| !s.has_permissions());
            return Envelope::failure(if revoked {
                "I don't have the permissions to perform this action. Please reauthenticate in the dashboard."
            } else {
                "Failed to renew permissions. Please try again later."
            });
        }
    };
    let Ok(mut body) = serde_json::to_value(data) else {
        return Envelope::failure("Internal server error");
    };
    body["queue"] = queue.into();
    let Ok(reply) = api
        .request(BackendRequest {
            method: dima_http::Method::POST,
            path: format!(
                "/triggers/{}/send",
                dima_text::encode_uri_component(channel)
            ),
            owner: Some(token),
            body: Some(body),
            timeout: Duration::from_secs(60),
            no_store: false,
        })
        .await
    else {
        return Envelope::failure("Internal server error");
    };
    if !(200..300).contains(&reply.status) {
        let Some(body) = reply.body else {
            return Envelope::failure("Internal server error");
        };
        return Envelope::failure(
            body["message"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("Error sending trigger"),
        );
    }
    Envelope::success("Trigger sent", None)
}
