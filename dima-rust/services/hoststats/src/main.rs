#![forbid(unsafe_code)]
use dima_core::{Shutdown, SystemClock, SystemRandom};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let env: std::collections::HashMap<_, _> = std::env::vars().collect();
    let config = dima_hoststats::config::Config::from_values(|k| env.get(k).cloned());
    let port = config.port;
    let app = dima_hoststats::build(config, Arc::new(SystemClock), Arc::new(SystemRandom))?;
    app.state().sample().await;
    let shutdown = Shutdown::new();
    let signal = shutdown.clone();
    let signals = tokio::spawn(async move {
        let _ = dima_core::runtime::shutdown::stop_signal().await;
        signal.trigger();
    });
    let sampling = app.clone();
    let token = shutdown.cancellation_token();
    let sampler = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(
            sampling.state().config.sample_ms,
        ));
        interval.tick().await;
        loop {
            tokio::select! {_ = token.cancelled()=>break,_ = interval.tick()=>{tokio::select!{_ = token.cancelled()=>break,_ = sampling.state().sample()=>{}}}}
        }
    });
    let listener = dima_web::bind_to(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))?;
    let result = dima_web::serve(
        listener,
        app,
        shutdown.cancellation_token(),
        Default::default(),
    )
    .await;
    shutdown.trigger();
    sampler.abort();
    let _ = sampler.await;
    signals.abort();
    let _ = signals.await;
    result?;
    Ok(())
}
