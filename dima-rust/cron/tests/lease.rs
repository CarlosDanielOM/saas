//! The Dragonfly lease a worker may declare, against the local Dragonfly (database 11, a unique
//! prefix removed afterwards): two supervisors (two processes) never run the worker at once,
//! the second takes over when the first stops, and a lease taken away ends the run, which is
//! restarted and waits for the lease again.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use dima_core::SystemRandom;
use dima_core::runtime::{Backoff, Deadline, Shutdown, SupervisorConfig, WorkScope};
use dima_cron::host;
use dima_cron::lease::LeaseSpec;
use dima_cron::pacing::IdleBackoff;
use dima_cron::runner::LeaseContext;
use dima_cron::worker::{Lease, Pacing, Spec, TickFuture, Work, Worker};
use dima_store::dragonfly::{SetExpiry, SetOptions, Ttl};
use dima_telemetry::{ConsoleTarget, Telemetry, TelemetryConfig};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use support::eventually;

/// A worker whose ticks take 30 ms, counting its own ticks and how many run at once overall.
struct Leased {
    spec: Spec,
    ticks: AtomicU64,
    running: Arc<AtomicU64>,
    most: Arc<AtomicU64>,
}

impl Worker for Leased {
    fn spec(&self) -> &Spec {
        &self.spec
    }

    fn pacing(&self) -> Box<dyn Pacing> {
        Box::new(IdleBackoff::default())
    }

    fn tick(&self, _scope: WorkScope) -> TickFuture {
        self.ticks.fetch_add(1, Ordering::SeqCst);
        let (running, most) = (Arc::clone(&self.running), Arc::clone(&self.most));
        Box::pin(async move {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            most.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(30)).await;
            running.fetch_sub(1, Ordering::SeqCst);
            // Always "worked": the next tick at once, so the lease is renewed constantly.
            Ok(Work::items(1))
        })
    }
}

fn leased(running: &Arc<AtomicU64>, most: &Arc<AtomicU64>) -> Arc<Leased> {
    Arc::new(Leased {
        spec: Spec {
            name: "leased",
            telemetry: "leased",
            batch_metric: "batch_items",
            deadline: Deadline {
                limit: Duration::from_millis(500),
                grace: Duration::from_millis(100),
            },
            lease: Lease::Dragonfly(LeaseSpec {
                key: "worker:leased:lock".to_owned(),
                ttl: Duration::from_millis(2000),
                retry: Duration::from_millis(100),
            }),
            enabled_env: None,
        },
        ticks: AtomicU64::new(0),
        running: Arc::clone(running),
        most: Arc::clone(most),
    })
}

fn quiet_telemetry() -> Telemetry {
    let mut config = TelemetryConfig::new("cron", "index");
    config.export = false;
    config.console = ConsoleTarget::Off;
    Telemetry::new(config).unwrap()
}

fn timing() -> (SupervisorConfig, Backoff) {
    (
        SupervisorConfig {
            restart_delay: Duration::from_millis(50),
            stop_deadline: Duration::from_secs(1),
            stop_grace: Duration::from_millis(200),
        },
        Backoff {
            max: Duration::from_millis(200),
            reset_after: Duration::from_secs(60),
        },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_process_at_a_time_holds_a_leased_worker() -> Result<()> {
    let Some(stores) = support::Stores::new().await? else {
        return Ok(());
    };
    let result = async {
        let context = LeaseContext {
            dragonfly: stores.dragonfly.clone(),
            prefix: stores.prefix.clone(),
            random: Arc::new(SystemRandom),
        };
        let (running, most) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let (first, second) = (leased(&running, &most), leased(&running, &most));
        let telemetry = quiet_telemetry();
        let (config, backoff) = timing();
        let start = |worker: Arc<Leased>| {
            let shutdown = Shutdown::new();
            let handle = host::supervisor(
                vec![worker],
                config,
                backoff,
                &telemetry,
                Some(context.clone()),
            )
            .unwrap()
            .start(&shutdown);
            (shutdown, handle)
        };
        let (_a_shutdown, a) = start(Arc::clone(&first));
        eventually("the first process works", Duration::from_secs(10), || {
            let ticks = first.ticks.load(Ordering::SeqCst);
            async move { Ok(ticks >= 5) }
        })
        .await?;
        let (_b_shutdown, b) = start(Arc::clone(&second));
        // The second waits (retrying every 100 ms) while the first keeps renewing.
        let before = first.ticks.load(Ordering::SeqCst);
        eventually("the first goes on", Duration::from_secs(10), || {
            let ticks = first.ticks.load(Ordering::SeqCst);
            async move { Ok(ticks >= before + 20) }
        })
        .await?;
        assert_eq!(second.ticks.load(Ordering::SeqCst), 0);
        // The first process stops and releases: the second takes over within its retry.
        assert!(a.stop().await.is_clean());
        let stopped_at = first.ticks.load(Ordering::SeqCst);
        eventually("the second takes over", Duration::from_secs(10), || {
            let ticks = second.ticks.load(Ordering::SeqCst);
            async move { Ok(ticks >= 5) }
        })
        .await?;
        assert_eq!(first.ticks.load(Ordering::SeqCst), stopped_at);
        assert_eq!(most.load(Ordering::SeqCst), 1, "two ticks ran at once");
        let key = format!("{}worker:leased:lock", stores.prefix);
        assert!(matches!(
            stores.dragonfly.ttl(&key).await?,
            Ttl::Seconds(1..=2) | Ttl::Seconds(0)
        ));
        assert!(b.stop().await.is_clean());
        // Released at the end.
        assert_eq!(stores.dragonfly.get(&key).await?, None);
        Ok(())
    }
    .await;
    stores.clean().await?;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lease_taken_away_ends_the_run_and_the_worker_waits_for_it_again() -> Result<()> {
    let Some(stores) = support::Stores::new().await? else {
        return Ok(());
    };
    let result = async {
        let context = LeaseContext {
            dragonfly: stores.dragonfly.clone(),
            prefix: stores.prefix.clone(),
            random: Arc::new(SystemRandom),
        };
        let (running, most) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let worker = leased(&running, &most);
        let telemetry = quiet_telemetry();
        let (config, backoff) = timing();
        let shutdown = Shutdown::new();
        let handle = host::supervisor(
            vec![Arc::clone(&worker) as Arc<dyn Worker>],
            config,
            backoff,
            &telemetry,
            Some(context),
        )
        .unwrap()
        .start(&shutdown);
        eventually("it works", Duration::from_secs(10), || {
            let ticks = worker.ticks.load(Ordering::SeqCst);
            async move { Ok(ticks >= 3) }
        })
        .await?;
        // Another owner takes the key for 600 ms.
        let key = format!("{}worker:leased:lock", stores.prefix);
        stores
            .dragonfly
            .set(
                &key,
                b"someone-else",
                SetOptions {
                    expiry: SetExpiry::Millis(600),
                    ..SetOptions::default()
                },
            )
            .await?;
        eventually(
            "the run ended and was restarted",
            Duration::from_secs(10),
            || {
                let restarts = handle.snapshot()[0].restarts;
                async move { Ok(restarts >= 1) }
            },
        )
        .await?;
        let stalled = worker.ticks.load(Ordering::SeqCst);
        // While the other owner holds it, nothing runs; once it expires, the worker takes it.
        eventually("it works again", Duration::from_secs(10), || {
            let ticks = worker.ticks.load(Ordering::SeqCst);
            async move { Ok(ticks >= stalled + 3) }
        })
        .await?;
        assert_ne!(
            stores.dragonfly.get(&key).await?.as_deref(),
            Some(&b"someone-else"[..])
        );
        assert!(handle.stop().await.is_clean());
        Ok(())
    }
    .await;
    stores.clean().await?;
    result
}
