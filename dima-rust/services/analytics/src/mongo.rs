//! Local adapter gap: MongoStore connects eagerly; the reference clients connect lazily.
//! Keep retryable lazy initialisation here, retaining the shared store for every command.
use dima_store::mongo::{MongoConfig, MongoStore};
use std::time::Duration;
pub struct LazyMongo {
    config: MongoConfig,
    store: tokio::sync::OnceCell<MongoStore>,
}
impl LazyMongo {
    pub fn new(uri: &str, pool: u32, timeout_ms: u64) -> Self {
        let mut config = MongoConfig::new(uri);
        config.max_pool_size = Some(pool);
        config.connect_timeout = Some(Duration::from_millis(timeout_ms));
        config.server_selection_timeout = Some(Duration::from_millis(timeout_ms));
        Self {
            config,
            store: Default::default(),
        }
    }
    pub async fn get(&self) -> Result<&MongoStore, dima_store::mongo::error::MongoError> {
        self.store
            .get_or_try_init(|| MongoStore::connect(&self.config, None))
            .await
    }
    pub async fn close(&self) {
        if let Some(store) = self.store.get() {
            store.clone().shutdown().await;
        }
    }
}
