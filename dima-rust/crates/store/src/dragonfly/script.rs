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
//! # Bounded by construction
//!
//! Dragonfly has no `SCRIPT KILL` and no Lua time limit, and `TIME` is frozen inside a script, so
//! a loop that never ends hangs its shard until the server restarts (`MIGRATION.md` data rule 7).
//! Before a script is first sent, [`Script::check`] reads its text (strings and comments skipped)
//! and refuses `while`, `repeat ... until` and `goto`, a generic `for` over anything but
//! `ipairs` / `pairs`, and `math.huge`. What remains is the numeric `for`, whose bound is fixed
//! when the loop starts: take it from `#` of a table, a constant or a capped argument. Every
//! script the reference ships passes; a script that fails is never sent ([`Script::run_value`]
//! returns [`super::DragonflyError::ScriptRefused`]).
//!
//! The reference always sends `EVAL` with the full text. [`Script::run`] sends `EVALSHA` first and
//! falls back to `EVAL` on `NOSCRIPT` (after a Dragonfly restart or `SCRIPT FLUSH`), which also
//! loads it again. Dragonfly runs a script atomically over the keys it declares and refuses any
//! other key ("script tried accessing undeclared key"), so every key goes in `keys`.

use super::client::Dragonfly;
use super::error::{DragonflyError, Result};
use redis::{FromRedisValue, Value};
use std::sync::OnceLock;

/// One Lua script: its source text and lazily computed SHA-1.
#[derive(Debug)]
pub struct Script {
    name: &'static str,
    source: &'static str,
    sha1: OnceLock<String>,
    checked: OnceLock<Option<&'static str>>,
}

impl Script {
    /// A script from its embedded source. `name` is the reference's constant name (diagnostics).
    pub const fn new(name: &'static str, source: &'static str) -> Self {
        Self {
            name,
            source,
            sha1: OnceLock::new(),
            checked: OnceLock::new(),
        }
    }

    /// Refuses a script with a loop that has no iteration bound (see the module docs). The
    /// result is computed once.
    pub fn check(&self) -> Result<()> {
        match self
            .checked
            .get_or_init(|| unbounded_construct(self.source))
        {
            None => Ok(()),
            Some(reason) => Err(DragonflyError::ScriptRefused {
                name: self.name,
                reason,
            }),
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
    /// unknown and is returned as is (see [`super::DragonflyError::outcome_unknown`]). A script
    /// that fails [`Self::check`] is refused without being sent.
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
        self.check()?;
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

/// The first construct in `source` that can loop without an iteration bound, if any.
fn unbounded_construct(source: &str) -> Option<&'static str> {
    let words = identifiers(source.as_bytes());
    for (index, word) in words.iter().enumerate() {
        match *word {
            b"while" => return Some("a while loop has no iteration bound"),
            b"repeat" => return Some("a repeat loop has no iteration bound"),
            b"goto" => return Some("goto can loop without an iteration bound"),
            b"huge" if index > 0 && words.get(index - 1) == Some(&&b"math"[..]) => {
                return Some("math.huge as a bound never ends");
            }
            b"for" => {
                let header = words.iter().skip(index + 1).take_while(|w| **w != b"do");
                let mut header = header.skip_while(|w| **w != b"in");
                if header.next().is_some() && !matches!(header.next(), Some(&b"ipairs" | &b"pairs"))
                {
                    return Some("a generic for over an iterator other than ipairs or pairs");
                }
            }
            _ => {}
        }
    }
    None
}

/// Identifiers and keywords of Lua source, in order, with strings and comments skipped.
fn identifiers(source: &[u8]) -> Vec<&[u8]> {
    let mut words = Vec::new();
    let mut index = 0;
    while let Some(&byte) = source.get(index) {
        let rest = source.get(index..).unwrap_or_default();
        if rest.starts_with(b"--") {
            let after = index + 2;
            index = match long_bracket(source, after) {
                Some(level) => skip_long(source, after, level),
                None => source
                    .iter()
                    .skip(after)
                    .position(|b| *b == b'\n')
                    .map_or(source.len(), |at| after + at + 1),
            };
        } else if let Some(level) = long_bracket(source, index) {
            index = skip_long(source, index, level);
        } else if byte == b'"' || byte == b'\'' {
            index += 1;
            while let Some(&next) = source.get(index) {
                index += 1;
                if next == b'\\' {
                    index += 1;
                } else if next == byte || next == b'\n' {
                    break;
                }
            }
        } else if byte.is_ascii_alphabetic() || byte == b'_' {
            let start = index;
            while source
                .get(index)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            {
                index += 1;
            }
            words.push(source.get(start..index).unwrap_or_default());
        } else {
            index += 1;
        }
    }
    words
}

/// `[[`, `[=[`, `[==[` ... at `at`: the number of `=`.
fn long_bracket(source: &[u8], at: usize) -> Option<usize> {
    if source.get(at) != Some(&b'[') {
        return None;
    }
    let level = source
        .iter()
        .skip(at + 1)
        .take_while(|b| **b == b'=')
        .count();
    (source.get(at + 1 + level) == Some(&b'[')).then_some(level)
}

/// The index after the long string or comment opened at `at` with `level` signs.
fn skip_long(source: &[u8], at: usize, level: usize) -> usize {
    let mut close = Vec::with_capacity(level + 2);
    close.push(b']');
    close.extend(std::iter::repeat_n(b'=', level));
    close.push(b']');
    let body = at + level + 2;
    source
        .get(body..)
        .and_then(|rest| {
            rest.windows(close.len())
                .position(|w| w == close.as_slice())
        })
        .map_or(source.len(), |found| body + found + close.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loops_without_an_iteration_bound_are_refused() {
        for (source, refused) in [
            ("return 1", false),
            (
                "for i = 1, #ARGV - 1 do redis.call('GET', KEYS[i]) end",
                false,
            ),
            ("for i = 1, tonumber(ARGV[1]) do end", false),
            (
                "for _, k in ipairs(KEYS) do end for k, v in pairs(t) do end",
                false,
            ),
            (
                "local s = 'while repeat goto' -- while true do end\nreturn s",
                false,
            ),
            ("--[==[ while true do end ]==] return [[repeat]]", false),
            ("local t = \"a\\\"while\" return t", false),
            ("local whiles, repeated = 1, 2 return whiles", false),
            ("while true do end", true),
            ("local n = 0 repeat n = n + 1 until n > 3", true),
            ("::top:: goto top", true),
            ("for i = 1, math.huge do end", true),
            ("for k in string.gmatch(ARGV[1], '.') do end", true),
            ("for k, v in next, t do end", true),
            ("return 1 -- ok\nwhile false do end", true),
        ] {
            assert_eq!(
                unbounded_construct(source).is_some(),
                refused,
                "{source}: {:?}",
                unbounded_construct(source)
            );
        }
    }

    #[test]
    fn a_refused_script_reports_its_name() {
        static ENDLESS: Script = Script::new("ENDLESS", "while true do end");
        let error = ENDLESS.check().unwrap_err();
        assert!(matches!(
            error,
            DragonflyError::ScriptRefused {
                name: "ENDLESS",
                ..
            }
        ));
        static FINE: Script = Script::new("FINE", "return 1");
        assert!(FINE.check().is_ok());
    }

    #[test]
    fn sha1_is_the_servers_cache_key() {
        static PING: Script = Script::new("PING", "return 1");
        // SHA-1 of "return 1", as `SCRIPT LOAD` reports it.
        assert_eq!(PING.sha1(), "e0e1f9fabfc9d4800c877a703b823ac0578ff8db");
        assert_eq!(PING.source(), "return 1");
        assert_eq!(PING.name(), "PING");
    }
}
