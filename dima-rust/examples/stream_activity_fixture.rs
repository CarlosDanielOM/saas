//! Fixture-only process driver. Never reads dotenv files or MONGO_URI.
use dima_rust::workers::stream_activity::StreamActivityProjector;
use mongodb::{Client, bson::doc, options::ClientOptions};
use std::{env, error::Error, time::Instant};

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn Error>> {
    let uri = env::var("STREAM_ACTIVITY_TEST_URI").map_err(
        |_| "STREAM_ACTIVITY_TEST_URI must explicitly name a disposable MongoDB fixture",
    )?;
    let mut args = env::args().skip(1);
    let database = args.next().ok_or("expected fixture database name")?;
    if !database.starts_with("stream_activity_fixture_")
        || !database
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("database must use the stream_activity_fixture_ prefix".into());
    }
    let batch_size = args.next().ok_or("expected batch size")?.parse::<usize>()?;
    let once = args.next().as_deref() == Some("once");
    let warmup_target = args
        .next()
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(1000);
    if warmup_target == 0 {
        return Err("warmup event target must be positive".into());
    }
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    let mut options = ClientOptions::parse(uri).await?;
    options.server_selection_timeout = Some(std::time::Duration::from_secs(5));
    let client = Client::with_options(options)?;
    client
        .database(&database)
        .run_command(doc! { "ping": 1 })
        .await?;
    let projector = StreamActivityProjector::new(client.database(&database));
    let start = Instant::now();
    let mut total = 0;
    let mut first_ms = 0.0;
    let mut steady_start = start;
    let mut warmup_end = None;
    let mut warmup_events = 0;
    let mut batch_ms = Vec::new();
    let mut after_warmup_batch_ms = Vec::new();
    loop {
        let warming = total < warmup_target;
        let limit = if warming {
            batch_size.clamp(1, 1000).min(warmup_target - total)
        } else {
            batch_size
        };
        let batch_start = Instant::now();
        let count = projector.project_batch(limit).await?;
        let finished = Instant::now();
        let duration_ms = finished.duration_since(batch_start).as_secs_f64() * 1000.0;
        if batch_ms.is_empty() {
            first_ms = finished.duration_since(start).as_secs_f64() * 1000.0;
            steady_start = finished;
        }
        if count == 0 {
            break;
        }
        batch_ms.push(duration_ms);
        if !warming {
            after_warmup_batch_ms.push(duration_ms);
        }
        total += count;
        if warming {
            warmup_events += count;
            if total >= warmup_target {
                warmup_end = Some(finished);
            }
        }
        if once {
            break;
        }
    }
    let finished = Instant::now();
    println!(
        "{}",
        serde_json::json!({
            "total": total, "batches": batch_ms.len(), "firstBatchMs": first_ms,
            "remainingMs": finished.duration_since(steady_start).as_secs_f64() * 1000.0,
            "projectMs": finished.duration_since(start).as_secs_f64() * 1000.0,
            "warmupEvents": warmup_events,
            "afterWarmupEvents": total - warmup_events,
            "afterWarmupMs": warmup_end.map(|at| finished.duration_since(at).as_secs_f64() * 1000.0),
            "batchMs": batch_ms, "afterWarmupBatchMs": after_warmup_batch_ms
        })
    );
    client.shutdown().await;
    Ok(())
}
