#![forbid(unsafe_code)]
use dima_core::{Shutdown, SystemClock, SystemRandom};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> anyhow::Result<()> {
    let env: std::collections::HashMap<_, _> = std::env::vars().collect();
    if std::env::args().nth(1).as_deref() == Some("--healthcheck") {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let port = env.get("PORT").map(String::as_str).unwrap_or("3211");
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}")).await?;
            stream
                .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .await?;
            let mut head = [0; 64];
            let n = stream.read(&mut head).await?;
            if !head[..n].starts_with(b"HTTP/1.1 200 ") {
                anyhow::bail!("hoststats unhealthy")
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        return Ok(());
    }
    if let Some(port) = env.get("PORT").filter(|s| !s.is_empty()) {
        let port = dima_text::parse_number(port);
        if !port.is_finite() || port.fract() != 0. || !(0.0..=65535.0).contains(&port) {
            anyhow::bail!("invalid PORT")
        }
    }
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
            sampling.state().config.sample_ms as u64,
        ));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await;
        let mut work: Option<tokio::task::JoinHandle<()>> = None;
        loop {
            tokio::select! {
                _ = token.cancelled()=>break,
                _ = interval.tick()=> {
                    if work.as_ref().is_none_or(|task|task.is_finished()) {
                        if let Some(task)=work.take(){let _=task.await;}
                        let app=sampling.clone();
                        work=Some(tokio::spawn(async move{app.state().sample().await;}));
                    }
                }
            }
        }
        if let Some(task) = work {
            task.abort();
            let _ = task.await;
        }
    });
    let listener = dima_web::bind_to(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))?;
    let result = dima_web::serve(
        listener,
        app.clone(),
        shutdown.cancellation_token(),
        Default::default(),
    )
    .await;
    shutdown.trigger();
    let _ = sampler.await;
    app.state().stop().await;
    signals.abort();
    let _ = signals.await;
    result?;
    Ok(())
}
