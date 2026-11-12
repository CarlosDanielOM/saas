//! Bounded-memory scan membership, missing from the shared stores. Files are named by the exact
//! UTF-8 identity encoded as hex, split into short path components (no hash collisions). An
//! unsuccessful scan never runs the missing-relationship sweep. Normal returns remove the spool;
//! cancellation drops it and schedules blocking filesystem cleanup. A process kill can leave a
//! temporary directory; it is never reused by another pass and contains no ledger records.
use crate::Error;
use std::path::{Path, PathBuf};
use tokio_util::task::TaskTracker;

pub(crate) struct Seen(PathBuf, TaskTracker);
impl Seen {
    pub(crate) async fn new(root: &Path, cleanup: TaskTracker) -> Result<Self, Error> {
        let path = root.join(format!("dima-stream-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&path).await?;
        Ok(Self(path, cleanup))
    }
    fn path(&self, id: &str) -> PathBuf {
        let mut path = self.0.clone();
        // Internal file identity, not a user text limit. Hex is injective over UTF-8 bytes.
        for bytes in id.as_bytes().chunks(64) {
            let part: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            path.push(part);
        }
        path.join("seen")
    }
    pub(crate) async fn add(&self, id: &str) -> Result<(), Error> {
        let path = self.path(id);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(path, []).await?;
        Ok(())
    }
    pub(crate) async fn contains(&self, id: &str) -> Result<bool, Error> {
        Ok(tokio::fs::try_exists(self.path(id)).await?)
    }
}
impl Drop for Seen {
    fn drop(&mut self) {
        let path = self.0.clone();
        // Filesystem removal must not block an async executor thread.
        self.1.spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(path);
        });
    }
}
