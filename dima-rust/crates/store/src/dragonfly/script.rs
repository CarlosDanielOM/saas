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
//! # Loop check (a heuristic)
//!
//! Dragonfly has no `SCRIPT KILL` and no Lua time limit, and `TIME` is frozen inside a script, so
//! a loop that never ends hangs its shard until the server restarts (`MIGRATION.md` data rule 7).
//! Before a script is first sent, [`Script::check`] tokenises it (strings and comments skipped)
//! and refuses what obviously has no iteration bound:
//!
//! - `while`, `repeat ... until` and `goto`;
//! - a generic `for` over anything but `ipairs` / `pairs`;
//! - a numeric `for` whose start or end is not a literal up to [`MAX_LITERAL_BOUND`] (1e6), a
//!   length (`#ARGV`, `#t.items`, optionally `+`/`-` such a literal) or `math.min(...)` with one
//!   such argument, or whose step is not a literal of at least 1: so `1e309`, `math.huge`,
//!   `0x7fffffff`, `tonumber(ARGV[1])` and step `0` are refused, while `#ARGV - 1`,
//!   `#account, 2` and `math.min(tonumber(ARGV[1]), 1000)` pass;
//! - nested numeric `for` loops whose literal bounds multiply past 1e6 iterations (a loop
//!   bounded by a length counts as 1);
//! - a named function that calls itself by its own name inside its body (a tail call does not
//!   grow the stack, so it can run for ever).
//!
//! It is a check that catches the obvious, **not a proof**: mutual recursion, a function
//! reached through a variable, an iterator built by hand and a bound smuggled through a
//! variable are not detected. Keep scripts loop-free or bounded by a literal cap; a script that
//! fails is never sent ([`Script::run_value`] returns
//! [`super::DragonflyError::ScriptRefused`]).
//!
//! Every reference script passes except the AI usage backfill's reclaim script
//! (`RECLAIM_SCRIPT` in `dimabot/src/workers/ai_usage_backfill.worker.ts`), which moves items
//! back with `while true do ... LPOP ... end` until the list is empty;
//! `tests/dragonfly_lua_sources.rs` pins that. **Rule for reclaim scripts**: the package that
//! ports that worker ports them with an explicit iteration cap (for example
//! `for _ = 1, 1000 do ... end` returning how many it moved, the caller calling again while it
//! moved the whole cap) and records it in its report as an exception to "reused verbatim"
//! (data rule 7). The script then has its own source file and SHA-1, not the reference's.
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

/// The largest literal accepted as a numeric `for` bound or step (by absolute value). A loop of
/// a million trivial iterations takes milliseconds in Dragonfly's Lua; anything larger is
/// either a mistake or an attempt at "for ever".
pub const MAX_LITERAL_BOUND: f64 = 1_000_000.0;

/// The first construct in `source` that can loop without an iteration bound, if any (see the
/// module docs: a heuristic for the obvious cases).
fn unbounded_construct(source: &str) -> Option<&'static str> {
    let tokens = tokens(source.as_bytes());
    for (index, token) in tokens.iter().enumerate() {
        match *token {
            Token::Name(b"while") => return Some("a while loop has no iteration bound"),
            Token::Name(b"repeat") => return Some("a repeat loop has no iteration bound"),
            Token::Name(b"goto") => return Some("goto can loop without an iteration bound"),
            Token::Name(b"huge")
                if index >= 2
                    && tokens.get(index - 1) == Some(&Token::Symbol(b"."))
                    && tokens.get(index - 2) == Some(&Token::Name(b"math")) =>
            {
                return Some("math.huge as a bound never ends");
            }
            Token::Name(b"for") => {
                let header: Vec<Token<'_>> = tokens
                    .iter()
                    .skip(index + 1)
                    .take_while(|token| **token != Token::Name(b"do"))
                    .copied()
                    .collect();
                if let Some(reason) = unbounded_for(&header) {
                    return Some(reason);
                }
            }
            _ => {}
        }
    }
    nested_iterations(&tokens).or_else(|| recursion(&tokens))
}

/// Nested numeric `for` loops whose literal bounds multiply past [`MAX_LITERAL_BOUND`]
/// iterations (each loop alone may be within it). A loop bounded by a length counts as 1: its
/// size is unknown here.
fn nested_iterations(tokens: &[Token<'_>]) -> Option<&'static str> {
    // One factor per open block (1 for anything but a numeric for with literal bounds).
    let mut blocks: Vec<f64> = Vec::new();
    let mut header: Option<f64> = None;
    for (index, token) in tokens.iter().enumerate() {
        match token {
            Token::Name(b"for") => {
                let rest: Vec<Token<'_>> = tokens
                    .iter()
                    .skip(index + 1)
                    .take_while(|token| **token != Token::Name(b"do"))
                    .copied()
                    .collect();
                header = Some(iterations(&rest));
            }
            Token::Name(b"do") => {
                blocks.push(header.take().unwrap_or(1.0));
                if blocks.iter().product::<f64>() > MAX_LITERAL_BOUND {
                    return Some("nested loops multiply past 1e6 iterations");
                }
            }
            Token::Name(b"function" | b"if" | b"repeat") => blocks.push(1.0),
            Token::Name(b"end" | b"until") => {
                blocks.pop();
            }
            _ => {}
        }
    }
    None
}

/// How many times a `for` header (between `for` and `do`) runs at most, as far as its
/// literals tell: 1 when a bound is not a literal.
fn iterations(header: &[Token<'_>]) -> f64 {
    if header.get(1) != Some(&Token::Symbol(b"=")) {
        return 1.0;
    }
    let parts = split_top_level(header.get(2..).unwrap_or_default());
    let step = parts
        .get(2)
        .and_then(|step| literal(step))
        .map_or(1.0, f64::abs)
        .max(1.0);
    let start = parts.first().and_then(|start| literal(start));
    let end = parts.get(1).and_then(|end| capped(end));
    match (start, end) {
        (Some(start), Some(end)) => ((end - start).abs() / step).floor() + 1.0,
        (None, Some(end)) => end.abs() / step + 1.0,
        _ => 1.0,
    }
}

/// The literal a bound is, or the smallest literal a `math.min(...)` bound is capped by.
fn capped(expression: &[Token<'_>]) -> Option<f64> {
    if let Some(value) = literal(expression) {
        return Some(value);
    }
    if let [
        Token::Name(b"math"),
        Token::Symbol(b"."),
        Token::Name(b"min"),
        Token::Symbol(b"("),
        arguments @ ..,
        Token::Symbol(b")"),
    ] = expression
    {
        return split_top_level(arguments)
            .into_iter()
            .filter_map(literal)
            .reduce(f64::min);
    }
    None
}

/// A `for` header (between `for` and `do`) whose iteration count is not obviously bounded.
fn unbounded_for(header: &[Token<'_>]) -> Option<&'static str> {
    if header.get(1) == Some(&Token::Symbol(b"=")) {
        let parts = split_top_level(header.get(2..).unwrap_or_default());
        let (start, end, step) = match parts.as_slice() {
            [start, end] => (*start, *end, None),
            [start, end, step] => (*start, *end, Some(*step)),
            _ => return Some("a numeric for without a start and an end"),
        };
        if !bounded(start) || !bounded(end) {
            return Some(
                "a numeric for bound must be a literal up to 1e6, a length (#t, #t - 1) or capped with math.min(..., literal)",
            );
        }
        if let Some(step) = step
            && !literal(step).is_some_and(|value| value.abs() >= 1.0)
        {
            return Some("a numeric for step must be a literal of at least 1 (and at most 1e6)");
        }
        return None;
    }
    let mut after_in = header
        .iter()
        .skip_while(|token| **token != Token::Name(b"in"));
    if after_in.next().is_some()
        && !matches!(after_in.next(), Some(&Token::Name(b"ipairs" | b"pairs")))
    {
        return Some("a generic for over an iterator other than ipairs or pairs");
    }
    None
}

/// Splits an expression list at its top-level commas.
fn split_top_level<'t, 'a>(tokens: &'t [Token<'a>]) -> Vec<&'t [Token<'a>]> {
    let mut parts = Vec::new();
    let mut depth = 0_usize;
    let mut start = 0;
    for (index, token) in tokens.iter().enumerate() {
        match token {
            Token::Symbol(b"(" | b"[" | b"{") => depth += 1,
            Token::Symbol(b")" | b"]" | b"}") => depth = depth.saturating_sub(1),
            Token::Symbol(b",") if depth == 0 => {
                parts.push(tokens.get(start..index).unwrap_or_default());
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(tokens.get(start..).unwrap_or_default());
    parts
}

/// A numeric `for` bound with an obvious limit: a literal up to [`MAX_LITERAL_BOUND`], the
/// length of something (`#ARGV`, `#t.items`, `#KEYS[1]`) optionally plus or minus such a
/// literal, or `math.min(...)` with one such argument.
fn bounded(expression: &[Token<'_>]) -> bool {
    if literal(expression).is_some() {
        return true;
    }
    if let [Token::Symbol(b"#"), rest @ ..] = expression {
        let rest = skip_prefix_expression(rest);
        return match rest {
            [] => true,
            [Token::Symbol(b"+" | b"-"), offset @ ..] => literal(offset).is_some(),
            _ => false,
        };
    }
    if let [
        Token::Name(b"math"),
        Token::Symbol(b"."),
        Token::Name(b"min"),
        Token::Symbol(b"("),
        arguments @ ..,
        Token::Symbol(b")"),
    ] = expression
    {
        return split_top_level(arguments).into_iter().any(bounded);
    }
    false
}

/// What follows a name and its field or index accesses (`t.a[1].b`); the whole input when it
/// does not start with a name.
fn skip_prefix_expression<'t, 'a>(tokens: &'t [Token<'a>]) -> &'t [Token<'a>] {
    let [Token::Name(_), after_name @ ..] = tokens else {
        return tokens;
    };
    let mut rest: &'t [Token<'a>] = after_name;
    loop {
        match rest {
            [Token::Symbol(b"."), Token::Name(_), after @ ..] => rest = after,
            [Token::Symbol(b"["), after @ ..] => {
                let mut depth = 1_usize;
                let close = after.iter().position(|token| {
                    match token {
                        Token::Symbol(b"[") => depth += 1,
                        Token::Symbol(b"]") => depth -= 1,
                        _ => {}
                    }
                    depth == 0
                });
                match close {
                    Some(at) => rest = after.get(at + 1..).unwrap_or_default(),
                    None => return rest,
                }
            }
            _ => return rest,
        }
    }
}

/// The value of a numeric literal, optionally negated, within [`MAX_LITERAL_BOUND`].
fn literal(expression: &[Token<'_>]) -> Option<f64> {
    let (sign, number) = match expression {
        [Token::Number(number)] => (1.0, *number),
        [Token::Symbol(b"-"), Token::Number(number)] => (-1.0, *number),
        _ => return None,
    };
    let text = std::str::from_utf8(number).ok()?;
    let value = match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some(hex) => u64::from_str_radix(hex, 16).ok()? as f64,
        None => text.parse::<f64>().ok()?,
    };
    (value.is_finite() && value.abs() <= MAX_LITERAL_BOUND).then_some(sign * value)
}

/// A named function that calls itself (directly, by the same name) inside its own body: tail
/// calls do not grow the stack, so such a function can run for ever.
fn recursion(tokens: &[Token<'_>]) -> Option<&'static str> {
    // One entry per open block; a function's carries its name path.
    let mut blocks: Vec<Option<Vec<&[u8]>>> = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        match token {
            Token::Name(b"function") => {
                let mut name = name_after(tokens, index + 1);
                if name.is_empty()
                    && index >= 1
                    && tokens.get(index - 1) == Some(&Token::Symbol(b"="))
                {
                    name = name_before(tokens, index - 1);
                }
                blocks.push(Some(name));
            }
            Token::Name(b"if" | b"do" | b"repeat") => blocks.push(None),
            Token::Name(b"end" | b"until") => {
                blocks.pop();
            }
            Token::Name(_) if is_call(tokens, index) => {
                let called = name_before(tokens, index + 1);
                // `function a.b(` names the function being defined; it is not a call.
                let first = (index + 2).saturating_sub(2 * called.len());
                if first >= 1 && tokens.get(first - 1) == Some(&Token::Name(b"function")) {
                    continue;
                }
                if blocks
                    .iter()
                    .flatten()
                    .any(|name| !name.is_empty() && *name == called)
                {
                    return Some("a function that calls itself can recurse without a bound");
                }
            }
            _ => {}
        }
    }
    None
}

/// `true` when the name at `index` is called: followed by `(`, a string or a table.
fn is_call(tokens: &[Token<'_>], index: usize) -> bool {
    matches!(
        tokens.get(index + 1),
        Some(Token::Symbol(b"(" | b"{") | Token::Str)
    )
}

/// The dotted name starting at `at` (`a.b:c` is `[a, b, c]`).
fn name_after<'a>(tokens: &[Token<'a>], at: usize) -> Vec<&'a [u8]> {
    let mut name = Vec::new();
    let mut index = at;
    while let Some(Token::Name(part)) = tokens.get(index) {
        name.push(*part);
        match tokens.get(index + 1) {
            Some(Token::Symbol(b"." | b":")) => index += 2,
            _ => break,
        }
    }
    name
}

/// The dotted name that ends just before `at`.
fn name_before<'a>(tokens: &[Token<'a>], at: usize) -> Vec<&'a [u8]> {
    let mut name = Vec::new();
    let mut index = at;
    while index >= 1 {
        let Some(Token::Name(part)) = tokens.get(index - 1) else {
            break;
        };
        name.push(*part);
        if index >= 3 && matches!(tokens.get(index - 2), Some(Token::Symbol(b"." | b":"))) {
            index -= 2;
        } else {
            break;
        }
    }
    name.reverse();
    name
}

/// A token of Lua source; comments are skipped and a string literal is one [`Token::Str`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Token<'a> {
    Name(&'a [u8]),
    Number(&'a [u8]),
    Str,
    Symbol(&'a [u8]),
}

/// The tokens of Lua source, in order.
fn tokens(source: &[u8]) -> Vec<Token<'_>> {
    let mut tokens = Vec::new();
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
            tokens.push(Token::Str);
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
            tokens.push(Token::Str);
        } else if byte.is_ascii_alphabetic() || byte == b'_' {
            let start = index;
            while source
                .get(index)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            {
                index += 1;
            }
            tokens.push(Token::Name(source.get(start..index).unwrap_or_default()));
        } else if byte.is_ascii_digit()
            || (byte == b'.' && source.get(index + 1).is_some_and(u8::is_ascii_digit))
        {
            let start = index;
            let hex = rest.starts_with(b"0x") || rest.starts_with(b"0X");
            while let Some(&next) = source.get(index) {
                let exponent_sign = !hex
                    && (next == b'+' || next == b'-')
                    && matches!(source.get(index - 1), Some(b'e' | b'E'));
                if next.is_ascii_alphanumeric() || next == b'.' || next == b'_' || exponent_sign {
                    index += 1;
                } else {
                    break;
                }
            }
            tokens.push(Token::Number(source.get(start..index).unwrap_or_default()));
        } else if byte.is_ascii_whitespace() {
            index += 1;
        } else {
            let width = [&b"..."[..], b"==", b"~=", b"<=", b">=", b"..", b"::"]
                .iter()
                .find(|symbol| rest.starts_with(symbol))
                .map_or(1, |symbol| symbol.len());
            tokens.push(Token::Symbol(
                source.get(index..index + width).unwrap_or_default(),
            ));
            index += width;
        }
    }
    tokens
}

/// `true` when `source` reads `KEYS[n]` or `ARGV[n]` as code (not in a comment or a string).
pub(crate) fn reads(source: &str, table: &[u8], position: &[u8]) -> bool {
    tokens(source.as_bytes()).windows(4).any(|window| {
        window
            == [
                Token::Name(table),
                Token::Symbol(b"["),
                Token::Number(position),
                Token::Symbol(b"]"),
            ]
    })
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
            ("for i = 1, tonumber(ARGV[1]) do end", true),
            ("for i = 1, math.min(tonumber(ARGV[1]), 100) do end", false),
            ("for i = 1, 1000 do end", false),
            ("for i = 2, #KEYS do redis.call('DEL', KEYS[i]) end", false),
            ("for index = 1, #account, 2 do end", false),
            ("for i = #t, 1, -1 do end", false),
            ("for i = 1, #ARGV[1] + 2 do end", false),
            ("for i = 1, 1e309 do end", true),
            ("for i = 1, 0x7fffffff do end", true),
            ("for i = 1, 2000000 do end", true),
            ("for i = -1e309, #t do end", true),
            ("for i = 1, #t, 0 do end", true),
            ("for i = 1, #t, 1e-300 do end", true),
            ("for i = 1, #t * 1e9 do end", true),
            ("for i = 1, n do end", true),
            (
                "for a = 1, 1000 do for b = 1, 1000 do end end for c = 1, 1000 do end",
                false,
            ),
            (
                "for a = 1, 1000 do for b = 1, 1000 do for c = 1, 2 do end end end",
                true,
            ),
            (
                "for a = 1, math.min(tonumber(ARGV[1]), 1000) do for b = 1, 1e6 do end end",
                true,
            ),
            (
                "for _, k in ipairs(KEYS) do for i = 1, 1e6 do if k then end end end",
                false,
            ),
            ("for i = 1, math.min(n, m) do end", true),
            (
                "local function f(n) if n > 0 then return f(n - 1) end return 0 end return f(1)",
                true,
            ),
            ("function M.walk(t) return M.walk(t) end", true),
            (
                "local function encode(v) if v then return 1 end return 0 end return encode(1)",
                false,
            ),
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
