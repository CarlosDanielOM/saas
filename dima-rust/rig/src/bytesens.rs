//! `rig/byte_sensitive.json`: Dragonfly keys whose values are compared as exact text.
//!
//! Some values are compared byte by byte by their readers (a queue item removed by value, JSON
//! compared inside Lua, a hashed payload: MIGRATION.md section 7 rule 6). For keys matching
//! these patterns the rig never parses a value as JSON: key order, number text, escaping and
//! whitespace all count, and only generated identifiers and times are normalised. Every other
//! value holding compact JSON is parsed and compared by value, key order being a note.

use std::path::Path;

use serde::Deserialize;

use crate::error::{Result, config};

pub const BYTE_SENSITIVE_VERSION: u64 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    rig_byte_sensitive: u64,
    #[serde(default, rename = "description")]
    _description: String,
    keys: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    pattern: String,
    /// The key id in `ledger/dragonfly.json`.
    #[serde(default, rename = "ledger")]
    _ledger: Option<String>,
    #[serde(default, rename = "type")]
    _type: Option<String>,
    why: String,
}

/// The key-name globs of a byte-sensitive list.
pub fn load(path: &Path) -> Result<Vec<String>> {
    let at = path.display().to_string();
    let text = std::fs::read_to_string(path).map_err(|e| config(format!("{at}: {e}")))?;
    let f: File = serde_json::from_str(&text).map_err(|e| config(format!("{at}: {e}")))?;
    if f.rig_byte_sensitive != BYTE_SENSITIVE_VERSION {
        return Err(config(format!(
            "{at}: rig_byte_sensitive {} is not supported; this rig reads version {BYTE_SENSITIVE_VERSION}",
            f.rig_byte_sensitive
        )));
    }
    let mut out = Vec::with_capacity(f.keys.len());
    for (i, e) in f.keys.into_iter().enumerate() {
        if e.pattern.is_empty() || e.why.trim().is_empty() {
            return Err(config(format!(
                "{at}: keys[{i}]: a pattern and why it is byte-sensitive"
            )));
        }
        out.push(e.pattern);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use crate::path::name_glob;

    #[test]
    fn the_shipped_list_loads_and_covers_the_ledger_queues() {
        let list =
            super::load(&crate::config::default_rig_dir().join("byte_sensitive.json")).unwrap();
        assert!(list.len() > 40, "{list:?}");
        let hit = |k: &str| list.iter().any(|g| name_glob(g, k));
        assert!(hit("cron:jobs:queue"));
        assert!(hit("cron:stream-memory:processing"));
        assert!(hit("twitch:123:ai:credits"));
        assert!(hit("accounts:twitch:123:data"));
        assert!(!hit("item:650000000000000000000001"));
        assert!(!hit("config:greeting"));
    }
}
