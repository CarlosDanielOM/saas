#![allow(clippy::panic)] // Test-only deadline guard.
use std::{future::Future, time::Duration};
/// Drive loopback IO without Tokio's automatic time jumps racing socket readiness.
/// Retry sleeps and deadlines use a controlled clock; allow IO to settle per tick.
pub async fn virtual_time<T>(work: impl Future<Output = T>) -> T {
    tokio::time::pause();
    tokio::pin!(work);
    for _ in 0..500_000 {
        for _ in 0..100 {
            tokio::select! {biased; value=&mut work=>{tokio::time::resume();return value;}, _=tokio::task::yield_now()=>{}}
        }
        tokio::time::advance(Duration::from_millis(10)).await;
    }
    panic!("work exceeded the virtual-time test budget");
}
