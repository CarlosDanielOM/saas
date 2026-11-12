#![allow(clippy::expect_used)]
//! Backend-service boundaries, with a scripted in-process transport and local Twitch mock.
mod support;
use anyhow::Result;
use dima_http::guard::BoxFuture;
use dima_twitch::functions::{chats::speech::*, triggers::*};
use serde_json::{Value, json};
use std::sync::Mutex;
use support::*;
#[derive(Default)]
struct Api {
    requests: Mutex<Vec<BackendRequest>>,
    response: Mutex<Option<(u16, Option<Value>)>>,
}
impl Api {
    fn reply(&self, status: u16, body: Option<Value>) {
        *self.response.lock().expect("reply") = Some((status, body));
    }
}
impl BackendApi for Api {
    fn request(
        &self,
        request: BackendRequest,
    ) -> BoxFuture<'_, Result<BackendReply, BackendError>> {
        self.requests.lock().expect("requests").push(request);
        let reply = self.response.lock().expect("reply").clone();
        Box::pin(async move {
            reply
                .map(|(status, body)| BackendReply { status, body })
                .ok_or(BackendError)
        })
    }
}
#[tokio::test]
async fn speech_payload_and_error_branches() {
    let api = Api::default();
    for (status, body, message) in [
        (
            200,
            Some(json!({"data":{"id":"audio"}})),
            "Speech sent successfully",
        ),
        (200, None, "Invalid response from speech service"),
        (500, None, "Error al enviar mensaje"),
        (403, Some(json!({"message":"denied"})), "denied"),
        (
            200,
            Some(json!({"error":true,"message":"no","status":409})),
            "no",
        ),
    ] {
        api.reply(status, body);
        let result = speach(&api, "message-id", "Á🙂אב", "123").await;
        assert_eq!(result.message.as_deref(), Some(message));
        let requests = api.requests.lock().expect("requests");
        let r = requests.last().expect("request");
        assert_eq!(r.method, dima_http::Method::POST);
        assert_eq!(r.path, "/speech/123");
        assert!(r.owner.is_none());
        assert_eq!(
            r.body,
            Some(
                json!({"mode":"speak","text":"Á🙂אב","meta":{"source":"chat-command","originalText":"message-id"}})
            )
        );
        assert_eq!(r.timeout.as_secs(), 60);
    }
    *api.response.lock().expect("reply") = None;
    assert_eq!(
        speach(&api, "id", "text", "123").await.message.as_deref(),
        Some("Internal server error")
    );
}
#[tokio::test]
async fn owner_controls_status_and_trigger() -> Result<()> {
    with_stores(|stores|async move {
        insert_user(&stores,user_document("123","owner","owner-access","refresh",Some(NOW_MS/1000+3600))).await?;
        let server=twitch_mock(Default::default(),helix_ok).await?;
        let process=process(&stores,&server,fast_timings())?;process.twitch.load_streamers().await?;
        let api=Api::default();let t=&process.twitch;
        assert_eq!(control_tts(t,&api,"missing",TtsControlAction::Skip).await.message.as_deref(),Some("Reconnect the channel owner’s account in the dashboard"));
        for action in [TtsControlAction::Skip,TtsControlAction::Clear,TtsControlAction::Refresh] {
            api.reply(200,Some(json!({"message":"ok"})));
            assert!(!control_tts(t,&api,"123",action).await.error);
            let requests=api.requests.lock().expect("requests");let r=requests.last().expect("request");assert_eq!(r.path,"/speech/123/control");assert_eq!(r.method,dima_http::Method::POST);assert!(r.owner.is_some());assert_eq!(r.timeout.as_secs(),10);assert_eq!(r.body,Some(json!({"action":action})));
        }
        for(status,body,message) in [(401,Some(json!({"message":"denied"})),"denied"),(503,Some(json!({})),"TTS control failed"),(200,None,"TTS controls are temporarily unavailable")] {
            api.reply(status,body);assert_eq!(control_tts(t,&api,"123",TtsControlAction::Clear).await.message.as_deref(),Some(message));
        }
        api.reply(200,Some(json!({"data":{"connected":true,"playing":false,"preparing":false,"queueLength":2}})));
        let result=get_tts_status(t,&api,"123").await;assert!(!result.error);assert_eq!(result.data.expect("data").queue_length,2);assert!(result.message.is_none());
        {
            let requests=api.requests.lock().expect("requests");let r=requests.last().expect("request");assert_eq!(r.path,"/speech/123/status");assert_eq!(r.method,dima_http::Method::GET);assert!(r.body.is_none());assert!(r.owner.is_some());assert!(r.no_store);assert_eq!(r.timeout.as_secs(),10);
        }
        for body in [json!({}),json!({"data":{"connected":true,"playing":false,"preparing":false,"queueLength":-1}}),json!({"data":{"connected":true,"playing":false,"preparing":false,"queueLength":9007199254740992_u64}})] {
            api.reply(200,Some(body));assert_eq!(get_tts_status(t,&api,"123").await.message.as_deref(),Some("Unable to read TTS status"));
        }
        let trigger=||TriggerData{trigger_id:None,name:Some("Á🙂אב".into()),url:"https://media.example/clip".into(),media_type:"video".into(),volume:0.5};
        api.reply(204,None);assert!(!send_trigger(t,&api,"123",trigger(),true).await.error);
        {
            let requests=api.requests.lock().expect("requests");let r=requests.last().expect("request");assert_eq!(r.path,"/triggers/123/send");assert_eq!(r.method,dima_http::Method::POST);assert!(r.owner.is_some());assert_eq!(r.body,Some(json!({"name":"Á🙂אב","url":"https://media.example/clip","mediaType":"video","volume":0.5,"queue":true})));
        }
        for(status,body,message) in [(400,Some(json!({"message":"denied"})),"denied"),(503,Some(json!({})),"Error sending trigger"),(500,None,"Internal server error")] {
            api.reply(status,body);assert_eq!(send_trigger(t,&api,"123",trigger(),false).await.message.as_deref(),Some(message));
        }
        assert_eq!(send_trigger(t,&api,"missing",trigger(),false).await.message.as_deref(),Some("I don't have the permissions to perform this action. Please reauthenticate in the dashboard."));
        t.shutdown().await;Ok(())
    }).await
}

#[test]
fn tts_reaches_api_from_production_workers_without_legacy_environment_settings() {
    assert_eq!(
        BackendConfig::from_values(None, Some("production"), None).speech_base,
        "http://dima-server:3000"
    );
    assert_eq!(
        BackendConfig::from_values(None, Some("production"), Some("production")).speech_base,
        "http://dima-server:3000"
    );
    assert_eq!(
        BackendConfig::from_values(
            Some("http://custom-api:3100"),
            Some("production"),
            Some("production")
        )
        .speech_base,
        "http://custom-api:3100"
    );
    assert_eq!(
        BackendConfig::from_values(None, Some("development"), None).speech_base,
        "http://localhost:3000"
    );
    assert_eq!(
        BackendConfig::from_values(None, Some("development"), Some("production")).speech_base,
        "https://api.domdimabot.com"
    );
}
