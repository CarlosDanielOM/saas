//! Configuration, read once from the environment (`index.mjs:19-21`, `connections.mjs:4-21`,
//! `store.mjs:82-84`).
//!
//! | Variable | Reference | Here |
//! |---|---|---|
//! | `PORT` | `Number(process.env.PORT \|\| 80)`; `listen` throws unless an integer 0-65535 | same; refused at startup |
//! | `PUBLIC_DIR` | `resolve(PUBLIC_DIR \|\| '<server dir>/../public')` | `resolve(PUBLIC_DIR \|\| '<binary dir>/../public')` (the image sets `/app/public`) |
//! | `DATA_DIR` | `resolve(DATA_DIR \|\| '/data')` | same |
//! | `DIMADB_SECRET` | used when non-empty, not trimmed | same |
//! | `DIMADB_REDIS_<NAME>`, `DIMADB_MONGO_<NAME>` | every non-empty one, in environment order | same |

use std::path::{Component, Path, PathBuf};

use dima_core::SecretString;
use dima_core::env::{EnvSource, EnvVar};

/// The variables this binary reads (for `EnvSource::audit`).
pub const ENV: &[EnvVar] = &[];

/// A connection configured through the environment.
#[derive(Clone, PartialEq, Eq)]
pub struct EnvConnection {
    /// `env:<suffix>` or `env:mongo:<suffix>`, lowercased.
    pub id: String,
    /// The suffix lowercased, `_` as spaces.
    pub name: String,
    /// The URL as set (may hold a password; never logged).
    pub url: String,
    /// `redis` or `mongo`.
    pub engine: Engine,
}

impl std::fmt::Debug for EnvConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnvConnection")
            .field("id", &self.id)
            .field("engine", &self.engine)
            .finish_non_exhaustive()
    }
}

/// The two engines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// Redis or Dragonfly.
    Redis,
    /// MongoDB.
    Mongo,
}

impl Engine {
    /// `'redis'` or `'mongo'`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Redis => "redis",
            Self::Mongo => "mongo",
        }
    }
}

/// Everything the server reads at startup.
#[derive(Debug, Clone)]
pub struct Config {
    /// Listening port (on `0.0.0.0`).
    pub port: u16,
    /// Static files root, absolute and normalised.
    pub public_dir: PathBuf,
    /// Data directory, absolute and normalised.
    pub data_dir: PathBuf,
    /// `DIMADB_SECRET` when non-empty.
    pub secret: Option<SecretString>,
    /// Environment connections, Redis ones first, each group in environment order.
    pub env_connections: Vec<EnvConnection>,
}

/// A configuration the reference would refuse at startup.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// `PORT` is not an integer from 0 to 65535 (Node's `ERR_SOCKET_BAD_PORT`).
    #[error("Invalid PORT: options.port should be >= 0 and < 65536 (received {0:?})")]
    Port(String),
    /// The working directory is needed to resolve a relative path and is unavailable.
    #[error("cannot resolve {0}: the working directory is unavailable")]
    Cwd(&'static str),
}

impl Config {
    /// Reads the configuration. `program` is the binary's path (for the `PUBLIC_DIR` default),
    /// `cwd` the working directory (relative paths resolve against it, as `path.resolve` does).
    pub fn from_env(
        env: &EnvSource,
        program: &Path,
        cwd: Option<&Path>,
    ) -> Result<Self, ConfigError> {
        let port_text = dima_core::env::read::string_or(env.get("PORT"), "80");
        let port = parse_port(port_text).ok_or_else(|| ConfigError::Port(port_text.to_owned()))?;
        let public_dir = match dima_core::env::read::non_empty(env.get("PUBLIC_DIR")) {
            Some(dir) => resolve_path(cwd, Path::new(dir)).ok_or(ConfigError::Cwd("PUBLIC_DIR"))?,
            None => {
                let base = program.parent().unwrap_or_else(|| Path::new("/"));
                resolve_path(cwd, &base.join("..").join("public"))
                    .ok_or(ConfigError::Cwd("PUBLIC_DIR"))?
            }
        };
        let data_dir = resolve_path(
            cwd,
            Path::new(dima_core::env::read::string_or(
                env.get("DATA_DIR"),
                "/data",
            )),
        )
        .ok_or(ConfigError::Cwd("DATA_DIR"))?;
        let secret = dima_core::env::read::non_empty(env.get("DIMADB_SECRET"))
            .map(|value| SecretString::new(value.to_owned()));
        let mut env_connections = env_rows(env, "DIMADB_REDIS_", Engine::Redis, "env:");
        env_connections.extend(env_rows(env, "DIMADB_MONGO_", Engine::Mongo, "env:mongo:"));
        Ok(Self {
            port,
            public_dir,
            data_dir,
            secret,
            env_connections,
        })
    }
}

fn env_rows(env: &EnvSource, prefix: &str, engine: Engine, id_prefix: &str) -> Vec<EnvConnection> {
    env.iter()
        .filter(|(name, value)| name.starts_with(prefix) && !value.is_empty())
        .map(|(name, value)| {
            let suffix = name.strip_prefix(prefix).unwrap_or_default();
            EnvConnection {
                id: format!("{id_prefix}{}", dima_text::to_lower(suffix)),
                name: dima_text::to_lower(&suffix.replace('_', " ")),
                url: value.to_owned(),
                engine,
            }
        })
        .collect()
}

/// `server.listen(Number(text))` accepts integers from 0 to 65535.
fn parse_port(text: &str) -> Option<u16> {
    let n = dima_text::parse_number(text);
    if !crate::js::is_integer(n) || !(0.0..=65535.0).contains(&n) {
        return None;
    }
    format!("{n}").parse().ok()
}

/// `path.resolve(p)`: absolute against `cwd`, `.` and `..` removed lexically, no trailing slash.
pub fn resolve_path(cwd: Option<&Path>, path: &Path) -> Option<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd?.join(path)
    };
    Some(normalize(&joined))
}

/// Lexical normalisation of an absolute path (`path.normalize` without symlinks).
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        Config::from_env(
            &EnvSource::from_pairs(pairs.iter().copied()),
            Path::new("/opt/dimadb/bin/dimadb-server"),
            Some(Path::new("/work")),
        )
    }

    #[test]
    fn defaults_and_parsing() -> Result<(), ConfigError> {
        let c = config(&[])?;
        assert_eq!(c.port, 80);
        assert_eq!(c.public_dir, PathBuf::from("/opt/dimadb/public"));
        assert_eq!(c.data_dir, PathBuf::from("/data"));
        assert!(c.secret.is_none());
        let c = config(&[
            ("PORT", " 0x50 "),
            ("DATA_DIR", "rel/./x/../d/"),
            ("PUBLIC_DIR", "/app/public/"),
        ])?;
        assert_eq!(c.port, 80);
        assert_eq!(c.data_dir, PathBuf::from("/work/rel/d"));
        assert_eq!(c.public_dir, PathBuf::from("/app/public"));
        assert_eq!(config(&[("PORT", "")])?.port, 80);
        for bad in ["abc", "80.5", "65536", "-1"] {
            assert_eq!(
                config(&[("PORT", bad)]).err(),
                Some(ConfigError::Port(bad.to_owned()))
            );
        }
        Ok(())
    }

    #[test]
    fn environment_connections_keep_environment_order() -> Result<(), ConfigError> {
        let c = config(&[
            ("DIMADB_MONGO_MAIN_DB", "mongodb://m"),
            ("DIMADB_REDIS_DRAGONFLY", "redis://d:6379"),
            ("DIMADB_REDIS_EMPTY", ""),
            ("DIMADB_REDIS_Cache_Two", "redis://c"),
            ("DIMADB_SECRET", "s3cret"),
        ])?;
        let rows: Vec<(&str, &str, Engine)> = c
            .env_connections
            .iter()
            .map(|row| (row.id.as_str(), row.name.as_str(), row.engine))
            .collect();
        assert_eq!(
            rows,
            [
                ("env:dragonfly", "dragonfly", Engine::Redis),
                ("env:cache_two", "cache two", Engine::Redis),
                ("env:mongo:main_db", "main db", Engine::Mongo),
            ]
        );
        assert_eq!(c.secret.as_ref().map(SecretString::expose), Some("s3cret"));
        Ok(())
    }
}
