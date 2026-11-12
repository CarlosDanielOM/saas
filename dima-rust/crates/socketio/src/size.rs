//! What a value keeps alive on the heap, for the size of recovery sessions.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU32, AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use serde_json::Value;

/// The heap memory a value keeps alive beyond its own `size_of` (the contents of its strings,
/// vectors and maps, at their capacity where it is known, and of anything it owns behind a
/// pointer). A recovery session of a socket counts `size_of::<Data>()` plus this, so the
/// per-session and total session limits hold for what is really kept.
///
/// Every [`crate::Namespace::Data`] implements it. For a struct, add up its fields:
///
/// ```
/// use dima_socketio::RetainedSize;
///
/// struct Overlay {
///     channel: String,
///     queue: std::sync::Mutex<Vec<String>>,
///     ready: std::sync::atomic::AtomicBool,
/// }
///
/// impl RetainedSize for Overlay {
///     fn retained_bytes(&self) -> usize {
///         self.channel.retained_bytes() + self.queue.retained_bytes()
///     }
/// }
/// ```
///
/// The implementations here count a hash map's buckets at their capacity and a B-tree's
/// entries twice (its nodes may be half full); a value shared through an `Arc` is counted as if
/// the session owned it alone (it keeps it alive).
pub trait RetainedSize {
    /// Heap bytes kept alive beyond `size_of::<Self>()`.
    fn retained_bytes(&self) -> usize;
}

macro_rules! nothing_on_the_heap {
    ($($t:ty),* $(,)?) => {
        $(impl RetainedSize for $t {
            fn retained_bytes(&self) -> usize {
                0
            }
        })*
    };
}

nothing_on_the_heap!(
    (),
    bool,
    char,
    u8,
    u16,
    u32,
    u64,
    u128,
    usize,
    i8,
    i16,
    i32,
    i64,
    i128,
    isize,
    f32,
    f64,
    AtomicBool,
    AtomicI32,
    AtomicI64,
    AtomicU32,
    AtomicU64,
    AtomicUsize,
    std::time::Duration,
    std::time::Instant,
    std::time::SystemTime,
    &'static str,
);

impl RetainedSize for String {
    fn retained_bytes(&self) -> usize {
        self.capacity()
    }
}

impl<T: RetainedSize> RetainedSize for Option<T> {
    fn retained_bytes(&self) -> usize {
        self.as_ref().map_or(0, RetainedSize::retained_bytes)
    }
}

impl<T: RetainedSize> RetainedSize for Box<T> {
    fn retained_bytes(&self) -> usize {
        size_of::<T>() + self.as_ref().retained_bytes()
    }
}

impl<T: RetainedSize> RetainedSize for Arc<T> {
    fn retained_bytes(&self) -> usize {
        // The two reference counts and the value.
        2 * size_of::<usize>() + size_of::<T>() + self.as_ref().retained_bytes()
    }
}

impl<T: RetainedSize> RetainedSize for Mutex<T> {
    fn retained_bytes(&self) -> usize {
        self.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retained_bytes()
    }
}

impl<T: RetainedSize> RetainedSize for RwLock<T> {
    fn retained_bytes(&self) -> usize {
        self.read()
            .unwrap_or_else(PoisonError::into_inner)
            .retained_bytes()
    }
}

impl<T: RetainedSize> RetainedSize for Vec<T> {
    fn retained_bytes(&self) -> usize {
        self.capacity() * size_of::<T>() + self.iter().map(T::retained_bytes).sum::<usize>()
    }
}

impl<T: RetainedSize> RetainedSize for VecDeque<T> {
    fn retained_bytes(&self) -> usize {
        self.capacity() * size_of::<T>() + self.iter().map(T::retained_bytes).sum::<usize>()
    }
}

impl<K: RetainedSize, V: RetainedSize, S> RetainedSize for HashMap<K, V, S> {
    fn retained_bytes(&self) -> usize {
        // Buckets of (K, V) plus one control byte each, at the table's capacity.
        self.capacity() * (size_of::<(K, V)>() + 1)
            + self
                .iter()
                .map(|(k, v)| k.retained_bytes() + v.retained_bytes())
                .sum::<usize>()
    }
}

impl<K: RetainedSize, S> RetainedSize for HashSet<K, S> {
    fn retained_bytes(&self) -> usize {
        self.capacity() * (size_of::<K>() + 1) + self.iter().map(K::retained_bytes).sum::<usize>()
    }
}

impl<K: RetainedSize, V: RetainedSize> RetainedSize for BTreeMap<K, V> {
    fn retained_bytes(&self) -> usize {
        2 * self.len() * size_of::<(K, V)>()
            + self
                .iter()
                .map(|(k, v)| k.retained_bytes() + v.retained_bytes())
                .sum::<usize>()
    }
}

impl<K: RetainedSize> RetainedSize for BTreeSet<K> {
    fn retained_bytes(&self) -> usize {
        2 * self.len() * size_of::<K>() + self.iter().map(K::retained_bytes).sum::<usize>()
    }
}

impl<A: RetainedSize, B: RetainedSize> RetainedSize for (A, B) {
    fn retained_bytes(&self) -> usize {
        self.0.retained_bytes() + self.1.retained_bytes()
    }
}

impl<A: RetainedSize, B: RetainedSize, C: RetainedSize> RetainedSize for (A, B, C) {
    fn retained_bytes(&self) -> usize {
        self.0.retained_bytes() + self.1.retained_bytes() + self.2.retained_bytes()
    }
}

impl RetainedSize for Value {
    fn retained_bytes(&self) -> usize {
        match self {
            Value::String(text) => text.capacity(),
            Value::Array(items) => items.retained_bytes(),
            Value::Object(map) => map.retained_bytes(),
            Value::Null | Value::Bool(_) | Value::Number(_) => 0,
        }
    }
}

impl RetainedSize for serde_json::Map<String, Value> {
    fn retained_bytes(&self) -> usize {
        // An `IndexMap` (`preserve_order`) whose capacity is not exposed: its entries (hash,
        // key, value) and its index, counted as grown to twice the length.
        let bucket = size_of::<Value>() + size_of::<String>() + size_of::<usize>();
        self.len() * (2 * bucket + 24)
            + self
                .iter()
                .map(|(key, value)| key.capacity() + value.retained_bytes())
                .sum::<usize>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_contents_not_handles() {
        assert_eq!("x".repeat(1000).retained_bytes(), 1000);
        let strings = vec!["a".repeat(100); 10];
        assert!(strings.retained_bytes() >= 10 * 24 + 1000);
        let map: HashMap<String, Vec<u8>> = [("k".to_owned(), vec![0; 5000])].into();
        assert!(map.retained_bytes() >= 5001);
        let shared = Mutex::new(Some(Arc::new("y".repeat(300))));
        assert!(shared.retained_bytes() >= 300 + 24);
        let value = serde_json::json!({"a": ["b".repeat(500)]});
        assert!(value.retained_bytes() >= 500);
    }
}
