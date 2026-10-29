//! Process-local bounded permission-error log limiter.
use crate::utils::js_string::JsString;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_INTERVAL_MS: f64 = 300_000.0;
pub const MAX_TRACKED: usize = 2_000;

struct Entry {
    key: Arc<JsString>,
    at: f64,
    prev: Option<usize>,
    next: Option<usize>,
}

/// A separately owned limiter with the same fixed capacity as the source.
/// The linked arena contains exactly one node per tracked key; denied calls do
/// not move nodes. All mutation and eviction take expected constant time.
#[derive(Default)]
pub struct PermissionErrorLimiter {
    lookup: HashMap<Arc<JsString>, usize>,
    entries: Vec<Entry>,
    head: Option<usize>,
    tail: Option<usize>,
}
impl PermissionErrorLimiter {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.lookup.len()
    }
    pub fn is_empty(&self) -> bool {
        self.lookup.is_empty()
    }
    fn unlink(&mut self, index: usize) {
        let (prev, next) = (self.entries[index].prev, self.entries[index].next);
        if let Some(p) = prev {
            self.entries[p].next = next;
        } else {
            self.head = next;
        }
        if let Some(n) = next {
            self.entries[n].prev = prev;
        } else {
            self.tail = prev;
        }
    }
    fn append(&mut self, index: usize) {
        self.entries[index].prev = self.tail;
        self.entries[index].next = None;
        if let Some(t) = self.tail {
            self.entries[t].next = Some(index);
        } else {
            self.head = Some(index);
        }
        self.tail = Some(index);
    }
    /// Explicit time and interval are IEEE-754 numbers, as in TypeScript.
    pub fn should_log(&mut self, key: &JsString, now: f64, interval_ms: f64) -> bool {
        if let Some(&index) = self.lookup.get(key) {
            if now - self.entries[index].at < interval_ms {
                return false;
            }
            self.entries[index].at = now;
            self.unlink(index);
            self.append(index);
        } else {
            let key = Arc::new(key.clone());
            let index = if self.entries.len() < MAX_TRACKED {
                let i = self.entries.len();
                self.entries.push(Entry {
                    key: key.clone(),
                    at: now,
                    prev: None,
                    next: None,
                });
                i
            } else {
                let i = self.head.expect("full limiter has a head");
                self.unlink(i);
                self.lookup.remove(&self.entries[i].key);
                self.entries[i] = Entry {
                    key: key.clone(),
                    at: now,
                    prev: None,
                    next: None,
                };
                i
            };
            self.lookup.insert(key, index);
            self.append(index);
        }
        true
    }
    /// Snapshot in least-recently-logged order for diagnostics and replay.
    pub fn snapshot(&self) -> Vec<(JsString, f64)> {
        let mut result = Vec::with_capacity(self.len());
        let mut cursor = self.head;
        while let Some(i) = cursor {
            let entry = &self.entries[i];
            result.push(((*entry.key).clone(), entry.at));
            cursor = entry.next;
        }
        result
    }
}

static GLOBAL: OnceLock<Mutex<PermissionErrorLimiter>> = OnceLock::new();
/// Shared process-wide limiter. `None` selects the source defaults; explicit
/// numbers, including NaN and infinities, are passed through unchanged.
pub fn should_log_permission_error(
    key: &JsString,
    now: Option<f64>,
    interval_ms: Option<f64>,
) -> bool {
    let now = now.unwrap_or_else(date_now);
    GLOBAL
        .get_or_init(|| Mutex::new(PermissionErrorLimiter::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .should_log(key, now, interval_ms.unwrap_or(DEFAULT_INTERVAL_MS))
}
fn date_now() -> f64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as f64,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0).ceil(),
    }
}
