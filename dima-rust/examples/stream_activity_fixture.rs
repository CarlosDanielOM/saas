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
    let first = projector.project_batch(batch_size).await?;
    let first_ms = start.elapsed().as_secs_f64() * 1000.0;
    let steady_start = Instant::now();
    let mut total = first;
    let mut batches = usize::from(first != 0);
    if !once {
        loop {
            let count = projector.project_batch(batch_size).await?;
            if count == 0 {
                break;
            }
            total += count;
            batches += 1;
        }
    }
    let steady_ms = steady_start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{{\"total\":{total},\"batches\":{batches},\"firstBatchMs\":{first_ms},\"remainingMs\":{steady_ms},\"projectMs\":{}}}",
        start.elapsed().as_secs_f64() * 1000.0
    );
    client.shutdown().await;
    Ok(())
}
