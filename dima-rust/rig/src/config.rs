//! Settings from the command line and the environment, read once.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::error::{Result, config};
use crate::run::Settings;
use crate::stores::StoreConfig;

/// Options given on the command line (all optional).
#[derive(Debug, Default, Clone)]
pub struct Overrides {
    pub rig_dir: Option<PathBuf>,
    pub captures_dir: Option<PathBuf>,
    pub out_dir: Option<PathBuf>,
    pub mongo_uri: Option<String>,
    pub dragonfly: Option<String>,
    pub dragonfly_dbs: Option<String>,
    pub vars: Vec<String>,
    pub keep: bool,
    /// The byte-sensitive key list [default: byte_sensitive.json in the rig crate].
    pub byte_sensitive: Option<PathBuf>,
}

/// The local Qdrant the sides reach through their prefixing proxies.
#[derive(Debug, Clone)]
pub struct QdrantStore {
    pub url: String,
    pub api_key: Option<String>,
}

/// The local Qdrant: `DIMA_RIG_QDRANT_URL` or `DIMA_TEST_QDRANT_URL` (default
/// `http://127.0.0.1:6333`), its API key from `DIMA_RIG_QDRANT_API_KEY` or
/// `DIMA_TEST_QDRANT_API_KEY`, else read from the running `qdrant` container (as `tools/test-env`
/// reads the MongoDB credentials; never written anywhere).
pub fn qdrant_store(env: &BTreeMap<String, String>) -> Result<QdrantStore> {
    let get = |k: &str| env.get(k).filter(|v| !v.is_empty()).cloned();
    let url = get("DIMA_RIG_QDRANT_URL")
        .or_else(|| get("DIMA_TEST_QDRANT_URL"))
        .unwrap_or_else(|| "http://127.0.0.1:6333".into());
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        return Err(config(format!(
            "Qdrant URL `{url}`: the rig only uses a Qdrant on loopback"
        )));
    }
    let api_key = get("DIMA_RIG_QDRANT_API_KEY")
        .or_else(|| get("DIMA_TEST_QDRANT_API_KEY"))
        .or_else(|| {
            std::process::Command::new("docker")
                .args(["exec", "qdrant", "printenv", "QDRANT__SERVICE__API_KEY"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|k| !k.is_empty())
        });
    Ok(QdrantStore { url, api_key })
}

/// The rig crate's directory, fixed at build time.
pub fn default_rig_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// `1-9` or `3,4,7`. Index 0 is never allowed.
pub fn parse_dbs(s: &str) -> Result<Vec<u8>> {
    let bad = || {
        config(format!(
            "--dragonfly-dbs `{s}`: use a range such as 1-9 or a list such as 3,4 (1 to 15; never 0)"
        ))
    };
    let mut out = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (
                a.trim().parse::<u8>().map_err(|_| bad())?,
                b.trim().parse::<u8>().map_err(|_| bad())?,
            ),
            None => {
                let n = part.parse::<u8>().map_err(|_| bad())?;
                (n, n)
            }
        };
        if a == 0 || b > 15 || a > b {
            return Err(bad());
        }
        out.extend(a..=b);
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        return Err(bad());
    }
    Ok(out)
}

/// Build the settings from command-line options and a snapshot of the environment.
pub fn settings(o: &Overrides, env: BTreeMap<String, String>) -> Result<Settings> {
    let get = |k: &str| env.get(k).filter(|v| !v.is_empty()).cloned();
    let rig_dir = o
        .rig_dir
        .clone()
        .or_else(|| get("DIMA_RIG_DIR").map(PathBuf::from))
        .unwrap_or_else(default_rig_dir);
    // Templates join paths onto it, and a container mount needs an absolute path.
    let rig_dir = rig_dir.canonicalize().unwrap_or(rig_dir);
    let repo_dir = default_rig_dir()
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| default_rig_dir().join("../.."));
    let mongo_uri = o.mongo_uri.clone().or_else(|| get("DIMA_RIG_MONGO_URI")).or_else(|| get("DIMA_TEST_MONGO_URI")).ok_or_else(|| {
        config("no MongoDB URI: run `eval \"$(dima-rust/tools/test-env)\"` (sets DIMA_TEST_MONGO_URI) or pass --mongo-uri")
    })?;
    let df = o
        .dragonfly
        .clone()
        .or_else(|| get("DIMA_RIG_DRAGONFLY"))
        .or_else(|| get("DIMA_TEST_DRAGONFLY"))
        .unwrap_or_else(|| "127.0.0.1:6379".into());
    let (host, port) = df
        .rsplit_once(':')
        .ok_or_else(|| config(format!("Dragonfly address `{df}`: use host:port")))?;
    let port: u16 = port
        .parse()
        .map_err(|_| config(format!("Dragonfly address `{df}`: bad port")))?;
    let dbs = parse_dbs(o.dragonfly_dbs.as_deref().unwrap_or("1-9"))?;
    let lock_dir = get("DIMA_RIG_LOCK_DIR")
        .map(PathBuf::from)
        .or_else(|| get("XDG_RUNTIME_DIR").map(|d| PathBuf::from(d).join("dima-rig")))
        .unwrap_or_else(|| PathBuf::from("/tmp/dima-rig-locks"));
    let mut vars = BTreeMap::new();
    for kv in &o.vars {
        let (k, v) = kv
            .split_once('=')
            .ok_or_else(|| config(format!("--set `{kv}`: use name=value")))?;
        if k.is_empty()
            || !k
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(config(format!("--set `{kv}`: bad name")));
        }
        vars.insert(k.to_string(), v.to_string());
    }
    // tools/cargo builds every checkout into its own dima-rust/target.
    let cargo_target_dir = get("CARGO_TARGET_DIR")
        .unwrap_or_else(|| repo_dir.join("dima-rust/target").display().to_string());
    let byte_sensitive = crate::bytesens::load(
        &o.byte_sensitive
            .clone()
            .unwrap_or_else(|| default_rig_dir().join("byte_sensitive.json")),
    )?;
    Ok(Settings {
        byte_sensitive,
        captures_dir: o
            .captures_dir
            .clone()
            .unwrap_or_else(|| rig_dir.join("captures")),
        out_dir: o.out_dir.clone().unwrap_or_else(|| rig_dir.join("out")),
        rig_dir,
        repo_dir,
        stores: StoreConfig {
            postgres_uri: get("DIMA_TEST_POSTGRES_URI"),
            mongo_uri,
            dragonfly_host: host.to_string(),
            dragonfly_port: port,
            dragonfly_dbs: dbs,
            lock_dir,
            lock_wait: Duration::from_secs(600),
        },
        vars,
        keep: o.keep,
        env,
        cargo_target_dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_lists() {
        assert_eq!(parse_dbs("1-3").unwrap(), vec![1, 2, 3]);
        assert_eq!(parse_dbs("4,2,2").unwrap(), vec![2, 4]);
        assert!(parse_dbs("0-3").is_err());
        assert!(parse_dbs("3-1").is_err());
        assert!(parse_dbs("16").is_err());
    }

    #[test]
    fn needs_a_mongo_uri() {
        let e = settings(&Overrides::default(), BTreeMap::new())
            .unwrap_err()
            .to_string();
        assert!(e.contains("test-env"), "{e}");
        let env: BTreeMap<String, String> =
            [("DIMA_TEST_MONGO_URI".to_string(), "mongodb://x".to_string())].into();
        let s = settings(
            &Overrides {
                vars: vec!["fixture=/bin/x".into()],
                ..Overrides::default()
            },
            env,
        )
        .unwrap();
        assert_eq!(s.vars.get("fixture").map(String::as_str), Some("/bin/x"));
        assert_eq!(s.stores.dragonfly_dbs, (1..=9).collect::<Vec<u8>>());
    }
}
