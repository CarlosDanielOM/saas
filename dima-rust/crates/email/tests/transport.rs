use dima_email::*;
use dima_http::{
    HttpClient,
    testing::{MockResponse, MockServer},
};
use std::time::Duration;
fn payload() -> RenderedEmailPayload {
    RenderedEmailPayload {
        from: "Sender <from@example.invalid>".into(),
        to: vec!["private@example.invalid".into()],
        subject: "subject".into(),
        html: "<p>hi</p>".into(),
        text: "hi".into(),
    }
}
#[allow(clippy::unwrap_used)] // Test fixture setup only.
async fn service(server: &MockServer) -> EmailService {
    let config = Config {
        api_key: "secret-api-key".into(),
        ..Config::default()
    };
    let provider = server
        .provider(provider(&config).timeout(Duration::from_millis(500)))
        .unwrap();
    EmailService::new(HttpClient::builder().build().unwrap(), provider, config, ())
}
#[tokio::test]
async fn requests_for_every_email() {
    let server = MockServer::start().await.unwrap();
    let service = service(&server).await;
    let corpus: serde_json::Value = serde_json::from_str(include_str!("golden.json")).unwrap();
    for kind in [
        "welcome",
        "activation-reminder",
        "stream-summary",
        "vod-clip-analysis-finished",
    ] {
        let c = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["kind"] == kind)
            .unwrap();
        let p = c["input"].clone();
        let email = match kind {
            "welcome" => welcome(&serde_json::from_value(p).unwrap()),
            "activation-reminder" => activation_reminder(&serde_json::from_value(p).unwrap()),
            "stream-summary" => stream_summary(&serde_json::from_value(p).unwrap()),
            _ => clip_analysis_finished(&serde_json::from_value(p).unwrap()),
        }
        .unwrap();
        let payload = service.render_email("private@example.invalid".into(), email, None);
        server.push(MockResponse::json(200, r#"{"id":"message-id"}"#));
        assert_eq!(
            service
                .send_rendered_email(&payload, Some("stable-id"))
                .await
                .unwrap()
                .id,
            "message-id"
        );
        let requests = server.requests();
        let r = requests.last().unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path(), "/emails");
        assert_eq!(
            r.header("authorization").unwrap().split_whitespace().next(),
            Some("Bearer")
        );
        assert_eq!(r.header("user-agent"), Some("resend-node:6.20.0"));
        assert_eq!(r.header("content-type"), Some("application/json"));
        assert_eq!(r.header("idempotency-key"), Some("stable-id"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&r.body).unwrap(),
            serde_json::json!({
                "from": "DomDimaBot <noreply@notifications.domdimabot.com>",
                "to": ["private@example.invalid"],
                "subject": c["subject"], "html": c["html"], "text": c["text"]
            })
        );
    }
}
#[tokio::test]
async fn failures_are_private_and_never_retry() {
    let server = MockServer::start().await.unwrap();
    let service = service(&server).await;
    for status in [401, 422, 429, 500] {
        server.push(MockResponse::json(
            status,
            r#"{"message":"secret-api-key private@example.invalid"}"#,
        ));
        let e = service
            .send_rendered_email(&payload(), None)
            .await
            .unwrap_err();
        assert_eq!(e, Error::Rejected(status));
        assert!(!format!("{e:?} {e}").contains("private@example"));
        assert!(!format!("{e:?} {e}").contains("secret-api"));
    }
    server.push(MockResponse::json(200, "bad"));
    assert_eq!(
        service
            .send_rendered_email(&payload(), None)
            .await
            .unwrap_err(),
        Error::Malformed
    );
    server.push(MockResponse::json(200, r#"{"id":"late"}"#).delay(Duration::from_millis(1500)));
    assert_eq!(
        service
            .send_rendered_email(&payload(), None)
            .await
            .unwrap_err(),
        Error::Transport
    );
    assert_eq!(server.requests().len(), 6);
}
#[tokio::test]
async fn disabled_and_missing_recipient() {
    let server = MockServer::start().await.unwrap();
    let config = Config::default();
    let s = EmailService::new(
        HttpClient::builder().build().unwrap(),
        server.provider(provider(&config)).unwrap(),
        config,
        (),
    );
    assert_eq!(
        s.send_rendered_email(&payload(), None).await.unwrap_err(),
        Error::NotConfigured
    );
    let s = service(&server).await;
    for to in [vec![], vec![String::new()]] {
        let p = RenderedEmailPayload { to, ..payload() };
        assert_eq!(
            s.send_rendered_email(&p, None).await.unwrap_err(),
            Error::NoRecipient
        );
    }
    assert!(server.requests().is_empty());
}
