#![forbid(unsafe_code)]
use dima_core::{SecretString, Shutdown, SystemClock};
use std::{collections::HashMap, sync::Arc};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let env: HashMap<_, _> = std::env::vars().collect();
    let value = |key: &str, default: &str| {
        env.get(key)
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| default.to_owned())
    };
    let port = dima_text::parse_number(&value("PORT", "8080"));
    if !port.is_finite() || port.fract() != 0. || !(0.0..=65535.).contains(&port) {
        anyhow::bail!("invalid PORT");
    }
    let config = dimafx_server::Config {
        internal_url: value("DIMABOT_INTERNAL_API_URL", "http://dima-server:3000"),
        public_url: value("DIMABOT_PUBLIC_API_URL", "https://api.domdimabot.com"),
        service_token: SecretString::new(value("DIMAFX_SERVICE_TOKEN", "")),
        signing_secret: SecretString::new(value("TWITCH_EXTENSION_SECRET", "")),
        allow_unverified: value("DIMAFX_ALLOW_UNVERIFIED_TWITCH_JWT", "") == "true",
    };
    let shutdown = Shutdown::new();
    let app = dimafx_server::build(config, Arc::new(SystemClock), shutdown.clone())?;
    let signal = shutdown.clone();
    let signals = tokio::spawn(async move {
        let _ = dima_core::runtime::shutdown::stop_signal().await;
        signal.trigger();
    });
    let result = dima_web::serve(
        dima_web::bind(port as u16)?,
        app,
        shutdown.cancellation_token(),
        Default::default(),
    )
    .await;
    shutdown.trigger();
    signals.abort();
    let _ = signals.await;
    result?;
    Ok(())
}
