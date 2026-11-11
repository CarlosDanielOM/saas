//! Lua scripts: `EVALSHA` with an `EVAL` fallback, one source file per script.
//!
//! # Convention
//!
//! Each script lives in its own file under `src/dragonfly/lua/` and is embedded at compile time:
//!
//! ```ignore
//! pub static WRITE_PLAN_ACCOUNT: Script =
//!     Script::new("WRITE_PLAN_ACCOUNT_SCRIPT", include_str!("lua/plan_write_account.lua"));
//! ```
//!
//! The file holds exactly the text between the backticks of the TypeScript template literal
//! (including its leading and trailing newline), so the script exists once in Rust, has the same
//! SHA-1 as the text the TypeScript sends with `EVAL`, and a test can compare it with the
//! TypeScript source byte for byte (`tests/dragonfly_lua_sources.rs`). Scripts that exist only in
//! Rust follow the same layout.
//!
//! The reference always sends `EVAL` with the full text. [`Script::run`] sends `EVALSHA` first and
//! falls back to `EVAL` on `NOSCRIPT` (after a Dragonfly restart or `SCRIPT FLUSH`), which also
//! loads it again. Dragonfly runs a script atomically over the keys it declares and refuses any
//! other key ("script tried accessing undeclared key"), so every key goes in `keys`.

use super::client::Dragonfly;
use super::error::Result;
use redis::{FromRedisValue, Value};
use std::sync::OnceLock;

/// One Lua script: its source text and lazily computed SHA-1.
#[derive(Debug)]
pub struct Script {
    name: &'static str,
    source: &'static str,
    sha1: OnceLock<String>,
}

impl Script {
    /// A script from its embedded source. `name` is the reference's constant name (diagnostics).
    pub const fn new(name: &'static str, source: &'static str) -> Self {
        Self {
            name,
            source,
            sha1: OnceLock::new(),
        }
    }

    /// The reference's name for it.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// The exact source text.
    pub fn source(&self) -> &'static str {
        self.source
    }

    /// Lowercase hex SHA-1 of the source, the server's script cache key.
    pub fn sha1(&self) -> &str {
        self.sha1
            .get_or_init(|| redis::Script::new(self.source).get_hash().to_owned())
    }

    /// Runs the script: `EVALSHA`, then `EVAL` if the server answers `NOSCRIPT`. Keys and
    /// arguments are sent as given (bytes); Lua sees every argument as a string.
    ///
    /// Only a confirmed `NOSCRIPT` is retried. A timeout or dropped connection leaves the outcome
    /// unknown and is returned as is (see [`super::DragonflyError::outcome_unknown`]).
    pub async fn run_value<K, A>(
        &self,
        dragonfly: &Dragonfly,
        keys: &[K],
        args: &[A],
    ) -> Result<Value>
    where
        K: AsRef<[u8]>,
        A: AsRef<[u8]>,
    {
        let mut evalsha = redis::cmd("EVALSHA");
        evalsha.arg(self.sha1());
        push_keys_and_args(&mut evalsha, keys, args);
        match dragonfly.query_value(&evalsha).await {
            Err(error) if error.is_server_code("NOSCRIPT") => {
                let mut eval = redis::cmd("EVAL");
                eval.arg(self.source);
                push_keys_and_args(&mut eval, keys, args);
                dragonfly.query_value(&eval).await
            }
            other => other,
        }
    }

    /// [`Self::run_value`] converted with redis-rs's [`FromRedisValue`] (use the decoders in
    /// [`super::commands::reply`] where the reply mixes integers and strings).
    pub async fn run<T, K, A>(&self, dragonfly: &Dragonfly, keys: &[K], args: &[A]) -> Result<T>
    where
        T: FromRedisValue,
        K: AsRef<[u8]>,
        A: AsRef<[u8]>,
    {
        let value = self.run_value(dragonfly, keys, args).await?;
        Ok(redis::from_redis_value(value).map_err(redis::RedisError::from)?)
    }
}

fn push_keys_and_args<K: AsRef<[u8]>, A: AsRef<[u8]>>(
    cmd: &mut redis::Cmd,
    keys: &[K],
    args: &[A],
) {
    cmd.arg(keys.len());
    for key in keys {
        cmd.arg(key.as_ref());
    }
    for arg in args {
        cmd.arg(arg.as_ref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_is_the_servers_cache_key() {
        static PING: Script = Script::new("PING", "return 1");
        // SHA-1 of "return 1", as `SCRIPT LOAD` reports it.
        assert_eq!(PING.sha1(), "e0e1f9fabfc9d4800c877a703b823ac0578ff8db");
        assert_eq!(PING.source(), "return 1");
        assert_eq!(PING.name(), "PING");
    }
}
