//! Metric and span names that the seams derive at run time, from a bounded registered set.
//!
//! Every name and outcome the public API takes is a `&'static str`: written in the source, so
//! the set of series a process can create is fixed when it is compiled. A few seams derive a name
//! from what a request carries; they do so only from values that are themselves static (a
//! provider, a Dragonfly command, an HTTP method of the standard set, a status code) or from a
//! registered pattern (a route template, a worker prefix and its metric), and the derived name is
//! interned here once. The registry holds at most [`MAX_NAMES`] names for the whole process (the
//! strings live as long as the process); past that a derivation returns [`OVERFLOW_NAME`] and is
//! counted ([`overflowed`]). The bound on resident series ([`crate::aggregate::MAX_SERIES`])
//! applies on top.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};

/// Most derived names per process.
pub const MAX_NAMES: usize = 4096;
/// Longest derived name kept (longer text maps to [`OVERFLOW_NAME`]).
pub const MAX_NAME_LEN: usize = 200;
/// The name of everything the registry could not hold.
pub const OVERFLOW_NAME: &str = "other";
/// An HTTP method outside the standard set.
pub const OTHER_METHOD: &str = "OTHER";

struct Registry {
    max: usize,
    joined: HashMap<(&'static str, &'static str, &'static str), &'static str>,
    texts: HashSet<&'static str>,
}

impl Registry {
    fn new(max: usize) -> Self {
        Self {
            max,
            joined: HashMap::new(),
            texts: HashSet::new(),
        }
    }

    fn full(&self) -> bool {
        self.joined.len() + self.texts.len() >= self.max
    }

    fn join(&mut self, a: &'static str, separator: &'static str, b: &'static str) -> &'static str {
        if let Some(name) = self.joined.get(&(a, separator, b)) {
            return name;
        }
        if self.full() || a.len() + separator.len() + b.len() > MAX_NAME_LEN {
            return overflow();
        }
        let name: &'static str = Box::leak(format!("{a}{separator}{b}").into_boxed_str());
        self.joined.insert((a, separator, b), name);
        name
    }

    fn intern(&mut self, text: &str) -> &'static str {
        if let Some(name) = self.texts.get(text) {
            return name;
        }
        if self.full() || text.len() > MAX_NAME_LEN {
            return overflow();
        }
        let name: &'static str = Box::leak(text.to_owned().into_boxed_str());
        self.texts.insert(name);
        name
    }
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::new(MAX_NAMES)));
static OVERFLOWED: AtomicU64 = AtomicU64::new(0);

fn overflow() -> &'static str {
    OVERFLOWED.fetch_add(1, Ordering::Relaxed);
    OVERFLOW_NAME
}

/// Derivations that returned [`OVERFLOW_NAME`] because the registry was full, process-wide.
pub fn overflowed() -> u64 {
    OVERFLOWED.load(Ordering::Relaxed)
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `a`, `separator`, `b` as one name, interned (no allocation once it is known).
pub(crate) fn join(a: &'static str, separator: &'static str, b: &'static str) -> &'static str {
    registry().join(a, separator, b)
}

/// A name built from a registered pattern, interned.
pub(crate) fn intern(text: &str) -> &'static str {
    registry().intern(text)
}

/// The standard HTTP methods; anything else is [`OTHER_METHOD`].
pub(crate) fn method(method: &http::Method) -> &'static str {
    match method.as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        "CONNECT" => "CONNECT",
        "TRACE" => "TRACE",
        _ => OTHER_METHOD,
    }
}

static STATUSES: LazyLock<Box<[&'static str]>> = LazyLock::new(|| {
    (100..600_u16)
        .map(|code| &*Box::leak(code.to_string().into_boxed_str()))
        .collect()
});

/// A status code as an outcome (`200`); a code outside 100 to 599 is [`OVERFLOW_NAME`].
pub(crate) fn status(code: u16) -> &'static str {
    code.checked_sub(100)
        .and_then(|index| STATUSES.get(usize::from(index)))
        .copied()
        .unwrap_or(OVERFLOW_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_names_are_interned_once() {
        let a = join("goals.worker", ".", "run");
        assert_eq!(a, "goals.worker.run");
        assert!(std::ptr::eq(a, join("goals.worker", ".", "run")));
        let b = intern("GET /speech/:channelID");
        assert!(std::ptr::eq(b, intern("GET /speech/:channelID")));
        assert_eq!(status(200), "200");
        assert_eq!(status(599), "599");
        assert_eq!(status(99), OVERFLOW_NAME);
        assert_eq!(status(600), OVERFLOW_NAME);
        assert_eq!(method(&http::Method::PATCH), "PATCH");
        let custom = http::Method::from_bytes(b"BREW").unwrap();
        assert_eq!(method(&custom), OTHER_METHOD);
        assert_eq!(intern(&"x".repeat(MAX_NAME_LEN + 1)), OVERFLOW_NAME);
    }

    #[test]
    fn the_registry_is_bounded() {
        let mut registry = Registry::new(100);
        let before = overflowed();
        let mut distinct = HashSet::new();
        for index in 0..600 {
            distinct.insert(registry.intern(&format!("registry-bound-{index}")));
            distinct.insert(registry.join("w", ".", if index % 2 == 0 { "a" } else { "b" }));
        }
        assert_eq!(registry.joined.len() + registry.texts.len(), 100);
        assert_eq!(distinct.len(), 101);
        assert!(distinct.contains(OVERFLOW_NAME));
        // Known names are still found when the registry is full.
        assert_eq!(registry.join("w", ".", "a"), "w.a");
        assert!(overflowed() - before >= 500);
    }
}
