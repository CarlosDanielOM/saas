//! Explicit fixture URL only: never falls back to application environment or localhost.
use redis::aio::ConnectionManager;
pub async fn isolated_connection() -> ConnectionManager {
    let url = std::env::var("BOT_METRICS_TEST_REDIS_URL").expect("set BOT_METRICS_TEST_REDIS_URL to a dedicated disposable Redis fixture");
    let client = redis::Client::open(url).expect("fixture URL");
    client.get_connection_manager().await.expect("isolated Redis fixture")
}
