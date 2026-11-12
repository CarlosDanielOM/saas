//! Transactional email templates and the Resend transport. Configuration is injected.
#![forbid(unsafe_code)]
mod templates;
use dima_core::SecretString;
use dima_http::{HttpClient, Provider, ProviderBuilder, RetryPolicy};
use serde::{Deserialize, Serialize};
use std::time::Duration;
pub use templates::*;

/// Startup configuration; empty environment values must be resolved by the binary.
#[derive(Clone, Debug)]
pub struct Config {
    pub api_key: SecretString,
    pub from: String,
    pub base_url: String,
    pub activation_url: String,
    pub dashboard_url: String,
    pub default_discount_code: String,
    pub email_auth_base_url: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            api_key: SecretString::default(),
            from: "DomDimaBot <noreply@notifications.domdimabot.com>".into(),
            base_url: "https://api.resend.com".into(),
            activation_url: "https://domdimabot.com/login".into(),
            dashboard_url: "https://domdimabot.com".into(),
            default_discount_code: String::new(),
            email_auth_base_url: "https://api.domdimabot.com/email/auth".into(),
        }
    }
}
/// Persist this payload before retrying a clip notification.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RenderedEmailPayload {
    pub from: String,
    pub to: Vec<String>,
    pub subject: String,
    pub html: String,
    pub text: String,
}
impl std::fmt::Debug for RenderedEmailPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RenderedEmailPayload(<private>)")
    }
}
/// Resend's successful answer.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SendResponse {
    pub id: String,
}
/// Errors intentionally discard provider bodies, which can echo addresses and credentials.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("Email service not configured")]
    NotConfigured,
    #[error("No recipient email provided")]
    NoRecipient,
    #[error("Resend rejected email (HTTP {0})")]
    Rejected(u16),
    #[error("Unable to fetch data. The request could not be resolved.")]
    Transport,
    #[error("Malformed Resend response")]
    Malformed,
    #[error("Invalid generated template data")]
    Template,
}
/// Declare the sole Resend provider. No retries: delivery may already have occurred.
pub fn provider(config: &Config) -> ProviderBuilder {
    Provider::builder("resend", &config.base_url)
        .secret_header(
            "authorization",
            &SecretString::new(format!("Bearer {}", config.api_key.expose())),
        )
        .header("user-agent", "resend-node:6.20.0")
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(60))
        .retry(RetryPolicy::none())
}
/// Typed service result consumed by workers and HTTP routes.
#[derive(Clone, Debug, Serialize)]
pub struct SendResult {
    pub error: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<SendResponse>,
}
/// Injectable log sink; event strings never include recipients or provider error bodies.
pub trait Log: Send + Sync {
    fn event(&self, message: &'static str);
}
impl Log for () {
    fn event(&self, _message: &'static str) {}
}
/// Thin transport, using the application's shared connection pool and declared provider.
pub struct EmailService<L = ()> {
    client: HttpClient,
    provider: Provider,
    config: Config,
    log: L,
}
impl<L: Log> EmailService<L> {
    pub fn new(client: HttpClient, provider: Provider, config: Config, log: L) -> Self {
        Self {
            client,
            provider,
            config,
            log,
        }
    }
    /// Unlike sending, rendering is available even without an API key.
    pub fn render_email(
        &self,
        to: String,
        email: Email,
        from: Option<String>,
    ) -> RenderedEmailPayload {
        RenderedEmailPayload {
            from: from
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| self.config.from.clone()),
            to: vec![to],
            subject: email.subject,
            html: email.html,
            text: email.text,
        }
    }
    pub async fn send_rendered_email(
        &self,
        payload: &RenderedEmailPayload,
        key: Option<&str>,
    ) -> Result<SendResponse, Error> {
        if self.config.api_key.is_empty() {
            self.log
                .event("[EmailService] Resend not configured - missing RESEND_API_KEY");
            return Err(Error::NotConfigured);
        }
        if payload.to.is_empty() || payload.to.iter().any(String::is_empty) {
            self.log.event("[EmailService] No recipient email provided");
            return Err(Error::NoRecipient);
        }
        let mut request = self.client.post(&self.provider, "/emails").json(payload);
        if let Some(key) = key.filter(|s| !s.is_empty()) {
            request = request.header("idempotency-key", key);
        }
        let response = request.send().await.map_err(|_| {
            self.log.event("[EmailService] Failed to send email");
            Error::Transport
        })?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            self.log.event("[EmailService] Failed to send email");
            return Err(Error::Rejected(status));
        }
        let data: SendResponse = response.json().await.map_err(|_| {
            self.log.event("[EmailService] Failed to send email");
            Error::Malformed
        })?;
        self.log.event("[EmailService] Email sent successfully");
        Ok(data)
    }
    /// The reference catches errors and returns an error/message envelope.
    pub async fn send_email(
        &self,
        payload: &RenderedEmailPayload,
        key: Option<&str>,
    ) -> SendResult {
        match self.send_rendered_email(payload, key).await {
            Ok(data) => SendResult {
                error: false,
                message: "Email sent successfully".into(),
                data: Some(data),
            },
            Err(error) => SendResult {
                error: true,
                message: error.to_string(),
                data: None,
            },
        }
    }
}
