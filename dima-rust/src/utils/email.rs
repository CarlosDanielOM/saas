//! Resend email delivery, mirroring `dimabot/src/utils/email/email.service.ts`.
//!
//! [`get_resend_client`] reads `RESEND_API_KEY` once. Like the TypeScript
//! service, a missing or blank key leaves email unconfigured instead of failing
//! at startup; [`send_rendered_email`] then returns [`EmailError::NotConfigured`].
//! [`email_from`] applies the same `EMAIL_FROM` default.
//!
//! This module only sends already-rendered HTML and text. The TypeScript React
//! Email templates have no Rust equivalent yet, so rendering stays in
//! TypeScript until those templates are ported and their output compared.
//!
//! The base URL is always passed explicitly (`https://api.resend.com` unless a
//! caller supplies another), so an invalid `RESEND_BASE_URL` cannot panic
//! inside resend-rs. The crate still reads `RESEND_RATE_LIMIT` (default 9
//! requests per 1.1 s) and panics if it is set to something other than a
//! positive integer.

use std::{env, fmt, sync::OnceLock};

use resend_rs::{
    ConfigBuilder, Resend,
    types::{CreateEmailBaseOptions, CreateEmailResponse},
};

/// Same default sender as the TypeScript service.
pub const DEFAULT_EMAIL_FROM: &str = "DomDimaBot <noreply@notifications.domdimabot.com>";
/// Resend's public API base URL.
pub const RESEND_API_URL: &str = "https://api.resend.com";

static CLIENT: OnceLock<Option<Resend>> = OnceLock::new();

/// A rendered message ready for delivery, matching `RenderedEmailPayload`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedEmail {
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub html: String,
    pub text: String,
}

#[derive(Debug)]
pub enum EmailError {
    /// `RESEND_API_KEY` was missing or blank when the client was first requested.
    NotConfigured,
    /// The recipient list was empty or contained a blank address.
    NoRecipient,
    /// Resend rejected the request or the transport failed.
    Api(resend_rs::Error),
}

impl fmt::Display for EmailError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => formatter.write_str("Email service not configured"),
            Self::NoRecipient => formatter.write_str("No recipient email provided"),
            Self::Api(error) => write!(formatter, "Failed to send email: {error}"),
        }
    }
}

impl std::error::Error for EmailError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Api(error) => Some(error),
            _ => None,
        }
    }
}

/// Returns the sender from `EMAIL_FROM`, or [`DEFAULT_EMAIL_FROM`] when unset or blank.
pub fn email_from() -> String {
    non_blank(env::var("EMAIL_FROM").ok()).unwrap_or_else(|| DEFAULT_EMAIL_FROM.to_owned())
}

/// Returns the process-wide Resend client, or `None` when `RESEND_API_KEY` is
/// missing or blank. The environment is read on the first call only.
pub fn get_resend_client() -> Option<&'static Resend> {
    CLIENT
        .get_or_init(|| {
            non_blank(env::var("RESEND_API_KEY").ok())
                .map(|key| resend_client(&key, RESEND_API_URL))
        })
        .as_ref()
}

/// Builds a Resend client for an explicit API key and base URL.
///
/// # Panics
///
/// Panics if `base_url` is not a valid URL.
pub fn resend_client(api_key: &str, base_url: &str) -> Resend {
    let url = base_url
        .parse()
        .expect("Resend base URL must be a valid URL");
    Resend::with_config(ConfigBuilder::new(api_key).base_url(url).build())
}

/// Sends a rendered email with the process-wide client.
pub async fn send_rendered_email(
    email: &RenderedEmail,
    idempotency_key: Option<&str>,
) -> Result<CreateEmailResponse, EmailError> {
    let client = get_resend_client().ok_or(EmailError::NotConfigured)?;
    send_rendered_email_with(client, email, idempotency_key).await
}

/// Sends a rendered email with an explicit client, matching `sendRenderedEmail`.
pub async fn send_rendered_email_with(
    client: &Resend,
    email: &RenderedEmail,
    idempotency_key: Option<&str>,
) -> Result<CreateEmailResponse, EmailError> {
    if email.to.is_empty() || email.to.iter().any(|recipient| recipient.is_empty()) {
        return Err(EmailError::NoRecipient);
    }

    let options = CreateEmailBaseOptions::new(&email.from, &email.to, &email.subject)
        .with_html(&email.html)
        .with_text(&email.text);
    let result = match idempotency_key {
        Some(key) => client.emails.send(options.with_idempotency_key(key)).await,
        None => client.emails.send(options).await,
    };
    result.map_err(EmailError::Api)
}

fn non_blank(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::utils::test_http::{CannedResponse, Recorder};

    fn message(to: Vec<&str>) -> RenderedEmail {
        RenderedEmail {
            from: DEFAULT_EMAIL_FROM.to_owned(),
            to: to.into_iter().map(str::to_owned).collect(),
            subject: "Welcome".to_owned(),
            html: "<p>Hello</p>".to_owned(),
            text: "Hello".to_owned(),
        }
    }

    #[test]
    fn blank_values_are_treated_as_unset() {
        assert_eq!(non_blank(Some(" \t".to_owned())), None);
        assert_eq!(non_blank(None), None);
        assert_eq!(non_blank(Some("key".to_owned())).as_deref(), Some("key"));
    }

    #[tokio::test]
    async fn sends_html_text_and_idempotency_key() {
        let recorder = Recorder::start(|_| CannedResponse::json(200, r#"{"id":"email_123"}"#));
        let client = resend_client("re_test_key", &recorder.base_url);

        let response =
            send_rendered_email_with(&client, &message(vec!["a@example.com"]), Some("welcome/1"))
                .await
                .expect("the recorder accepts the email");
        assert_eq!(response.id.to_string(), "email_123");

        let request = recorder.next(Duration::from_secs(10));
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/emails");
        assert_eq!(request.header("authorization"), Some("Bearer re_test_key"));
        assert_eq!(request.header("idempotency-key"), Some("welcome/1"));
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["from"], DEFAULT_EMAIL_FROM);
        assert_eq!(body["to"], serde_json::json!(["a@example.com"]));
        assert_eq!(body["subject"], "Welcome");
        assert_eq!(body["html"], "<p>Hello</p>");
        assert_eq!(body["text"], "Hello");
    }

    #[tokio::test]
    async fn omits_idempotency_header_when_not_requested() {
        let recorder = Recorder::start(|_| CannedResponse::json(200, r#"{"id":"email_456"}"#));
        let client = resend_client("re_test_key", &recorder.base_url);

        send_rendered_email_with(&client, &message(vec!["a@example.com"]), None)
            .await
            .expect("the recorder accepts the email");
        let request = recorder.next(Duration::from_secs(10));
        assert_eq!(request.header("idempotency-key"), None);
    }

    #[tokio::test]
    async fn rejects_missing_or_blank_recipients_without_a_request() {
        let client = resend_client("re_test_key", "http://127.0.0.1:9");
        for to in [vec![], vec!["a@example.com", ""]] {
            let error = send_rendered_email_with(&client, &message(to), None)
                .await
                .expect_err("recipients are required");
            assert!(matches!(error, EmailError::NoRecipient));
        }
    }

    #[tokio::test]
    async fn https_transport_selects_its_own_tls_provider() {
        // Port 9 refuses connections; the TLS client must build without a
        // process-wide rustls default and report a transport error.
        let client = resend_client("re_test_key", "https://127.0.0.1:9");
        let error = send_rendered_email_with(&client, &message(vec!["a@example.com"]), None)
            .await
            .expect_err("nothing listens on port 9");
        assert!(matches!(error, EmailError::Api(_)));
    }

    #[tokio::test]
    async fn surfaces_api_errors() {
        let recorder = Recorder::start(|_| {
            CannedResponse::json(
                422,
                r#"{"statusCode":422,"name":"validation_error","message":"Invalid `to` field."}"#,
            )
        });
        let client = resend_client("re_test_key", &recorder.base_url);

        let error = send_rendered_email_with(&client, &message(vec!["a@example.com"]), None)
            .await
            .expect_err("a 422 must be reported");
        assert!(matches!(error, EmailError::Api(_)));
        assert!(error.to_string().contains("Invalid `to` field."));
    }
}
