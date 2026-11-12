//! `dimadb-server`: see the library documentation.
#![forbid(unsafe_code)]

use std::net::{Ipv4Addr, SocketAddr};
use std::process::ExitCode;
use std::sync::Arc;

use dima_core::env::EnvSource;
use dima_core::{Shutdown, SystemClock, SystemRandom};
use dimadb_server::config::Config;

fn main() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("dimadb: cannot start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dimadb: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<()> {
    // `rediss://` connections: rustls needs its provider chosen once per process.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let env = EnvSource::from_process();
    let program = std::env::current_exe().unwrap_or_default();
    let cwd = std::env::current_dir().ok();
    let config = Config::from_env(&env, &program, cwd.as_deref())?;
    let port = config.port;
    let (public, data) = (config.public_dir.clone(), config.data_dir.clone());
    let app = dimadb_server::build(config, Arc::new(SystemClock), Arc::new(SystemRandom))?;
    let listener = dima_web::bind_to(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
        .map_err(|error| anyhow::anyhow!("cannot listen on 0.0.0.0:{port}: {error}"))?;
    let actual = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    println!("dimadb listening on {actual}");
    println!("public={} data={}", public.display(), data.display());

    let shutdown = Shutdown::new();
    let signals = shutdown.clone();
    let token = tokio_util::sync::CancellationToken::new();
    let stop = token.clone();
    tokio::spawn(async move {
        match dima_core::runtime::shutdown::stop_signal().await {
            Ok(signal) => eprintln!("dimadb: {signal:?}, shutting down"),
            Err(error) => eprintln!("dimadb: signal handlers unavailable: {error}"),
        }
        signals.trigger();
        stop.cancel();
    });
    dima_web::serve(
        listener,
        app.clone(),
        token,
        dima_web::ServeOptions::default(),
    )
    .await?;
    app.state().redis.clear();
    app.state().mongo.clear();
    let _ = shutdown;
    Ok(())
}
