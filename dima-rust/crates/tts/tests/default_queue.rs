#![allow(clippy::unwrap_used)]
use dima_model::channel_tts_settings::ChannelTtsSettings;
use dima_tts::default_queue::*;
use serde_json::{Value, json};
struct Fixture {
    enabled: bool,
    provider: &'static str,
}
impl Settings for Fixture {
    async fn get(&self, _: &str) -> Result<ChannelTtsSettings, Rejected> {
        Ok(serde_json::from_value(json!({"_id":"aaaaaaaaaaaaaaaaaaaaaaaa","channelID":"1","enabled":self.enabled,"provider":self.provider})).unwrap())
    }
}
impl EmoteNames for Fixture {
    async fn names(&self, _: &str) -> Vec<String> {
        vec!["Kappa".into()]
    }
}
impl SpeechQueue for Fixture {
    async fn request(&self, channel: &str, payload: Value) -> Result<Value, Rejected> {
        assert_eq!(channel, "1");
        Ok(payload)
    }
}
fn input() -> Input {
    Input {
        channel_id: "1".into(),
        raw_message: " Kappa [happy] Hello https://example.com ".into(),
        source: "chat-command".into(),
        preferred_mode: None,
        clone_name: None,
        language: Some("en".into()),
        user_id: Some("2".into()),
        user_login: Some("viewer".into()),
        user_name: Some(" Viewer ".into()),
        user_level: Some(1.0),
        emote_names: None,
        emote_ranges: None,
    }
}
#[tokio::test]
async fn default_queue_resolves_modes_filters_and_attribution() {
    for provider in ["fish", "piper", "kokoro"] {
        let fixture = Fixture {
            enabled: true,
            provider,
        };
        let i = input();
        let result = queue(&i, &fixture, &fixture, &fixture).await.unwrap();
        assert_eq!(result["provider"], provider);
        assert_eq!(
            result["mode"],
            if provider == "fish" { "clone" } else { "speak" }
        );
        assert_eq!(
            result["text"],
            if provider == "fish" {
                "Viewer say: [happy] Hello [link]"
            } else {
                "Viewer say: Hello [link]"
            }
        );
        assert_eq!(
            result["requestedBy"],
            json!({"userID":"2","userLogin":"viewer","userName":"Viewer","userLevel":1.0})
        );
        let mut i = i;
        i.source = "ast".into();
        i.preferred_mode = Some("kokoro".into());
        i.clone_name = Some("af_heart".into());
        let result = queue(&i, &fixture, &fixture, &fixture).await.unwrap();
        assert_eq!(result["text"], "Hello [link]");
        assert_eq!(result["voice"], "af_heart");
        assert!(result.get("cloneName").is_none());
    }
}
#[tokio::test]
async fn default_queue_rejects_empty_disabled_and_filtered_empty() {
    let fixture = Fixture {
        enabled: false,
        provider: "piper",
    };
    let mut i = input();
    assert_eq!(
        queue(&i, &fixture, &fixture, &fixture)
            .await
            .unwrap_err()
            .status,
        403
    );
    i.raw_message = " ".into();
    assert_eq!(
        queue(&i, &fixture, &fixture, &fixture)
            .await
            .unwrap_err()
            .message,
        "No message provided"
    );
    i.raw_message = "Kappa".into();
    let fixture = Fixture {
        enabled: true,
        provider: "piper",
    };
    assert_eq!(
        queue(&i, &fixture, &fixture, &fixture)
            .await
            .unwrap_err()
            .message,
        "No speakable text remained after filtering"
    );
}
