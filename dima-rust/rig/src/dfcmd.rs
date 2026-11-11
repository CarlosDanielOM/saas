//! The Dragonfly commands a scenario may run (steps and seeds): an allow-list of data commands
//! that act on the side's own logical database only. Anything that selects or reaches another
//! database (`SELECT`, `SWAPDB`, `MOVE`, `COPY ... DB`), affects the server or other clients
//! (`FLUSHALL`, `CONFIG`, `SHUTDOWN`, `DEBUG`, `CLIENT`, `PUBLISH` (channels are server-wide),
//! `SCRIPT FLUSH`), blocks (`BLPOP`, `XREAD ... BLOCK`) or holds connection state (`MULTI`,
//! `WATCH`, `SUBSCRIBE`) is refused. Scripts (`EVAL`, `EVALSHA`, `SCRIPT LOAD|EXISTS`) are
//! refused unless the scenario sets `allow_scripts`; a script can still do anything, so it must
//! stay on its keys and be bounded by an iteration count (Dragonfly has no `SCRIPT KILL`).
//!
//! The check runs on the fully rendered command when the step runs (a `${saved}` value can
//! become a command name), and at load time where the name is written literally.

/// Data commands on the selected logical database.
const DATA: &[&str] = &[
    // Keys.
    "DEL",
    "UNLINK",
    "EXISTS",
    "TYPE",
    "TOUCH",
    "RENAME",
    "RENAMENX",
    "COPY",
    "KEYS",
    "SCAN",
    "DBSIZE",
    "RANDOMKEY",
    "DUMP",
    "RESTORE",
    "SORT",
    "SORT_RO",
    "OBJECT",
    // Expiry.
    "EXPIRE",
    "PEXPIRE",
    "EXPIREAT",
    "PEXPIREAT",
    "EXPIRETIME",
    "PEXPIRETIME",
    "TTL",
    "PTTL",
    "PERSIST",
    // Strings.
    "GET",
    "SET",
    "SETNX",
    "SETEX",
    "PSETEX",
    "GETSET",
    "GETDEL",
    "GETEX",
    "MGET",
    "MSET",
    "MSETNX",
    "APPEND",
    "STRLEN",
    "INCR",
    "INCRBY",
    "INCRBYFLOAT",
    "DECR",
    "DECRBY",
    "GETRANGE",
    "SETRANGE",
    "SUBSTR",
    // Bits and HyperLogLog.
    "SETBIT",
    "GETBIT",
    "BITCOUNT",
    "BITPOS",
    "BITOP",
    "BITFIELD",
    "BITFIELD_RO",
    "PFADD",
    "PFCOUNT",
    "PFMERGE",
    // Hashes.
    "HSET",
    "HSETNX",
    "HMSET",
    "HGET",
    "HMGET",
    "HGETALL",
    "HDEL",
    "HEXISTS",
    "HINCRBY",
    "HINCRBYFLOAT",
    "HKEYS",
    "HVALS",
    "HLEN",
    "HSTRLEN",
    "HSCAN",
    "HRANDFIELD",
    // Lists (non-blocking).
    "LPUSH",
    "RPUSH",
    "LPUSHX",
    "RPUSHX",
    "LPOP",
    "RPOP",
    "LLEN",
    "LRANGE",
    "LINDEX",
    "LSET",
    "LINSERT",
    "LREM",
    "LTRIM",
    "LPOS",
    "LMOVE",
    "RPOPLPUSH",
    "LMPOP",
    // Sets.
    "SADD",
    "SREM",
    "SMEMBERS",
    "SISMEMBER",
    "SMISMEMBER",
    "SCARD",
    "SPOP",
    "SRANDMEMBER",
    "SMOVE",
    "SINTER",
    "SINTERSTORE",
    "SINTERCARD",
    "SUNION",
    "SUNIONSTORE",
    "SDIFF",
    "SDIFFSTORE",
    "SSCAN",
    // Sorted sets (non-blocking).
    "ZADD",
    "ZREM",
    "ZSCORE",
    "ZMSCORE",
    "ZINCRBY",
    "ZCARD",
    "ZCOUNT",
    "ZLEXCOUNT",
    "ZRANGE",
    "ZRANGEBYSCORE",
    "ZRANGEBYLEX",
    "ZREVRANGE",
    "ZREVRANGEBYSCORE",
    "ZREVRANGEBYLEX",
    "ZRANGESTORE",
    "ZRANK",
    "ZREVRANK",
    "ZPOPMIN",
    "ZPOPMAX",
    "ZMPOP",
    "ZREMRANGEBYRANK",
    "ZREMRANGEBYSCORE",
    "ZREMRANGEBYLEX",
    "ZUNION",
    "ZUNIONSTORE",
    "ZINTER",
    "ZINTERSTORE",
    "ZINTERCARD",
    "ZDIFF",
    "ZDIFFSTORE",
    "ZSCAN",
    "ZRANDMEMBER",
    // Streams (XREAD and XREADGROUP without BLOCK).
    "XADD",
    "XRANGE",
    "XREVRANGE",
    "XLEN",
    "XDEL",
    "XTRIM",
    "XGROUP",
    "XACK",
    "XPENDING",
    "XCLAIM",
    "XAUTOCLAIM",
    "XINFO",
    "XSETID",
    "XREAD",
    "XREADGROUP",
    // Harmless.
    "PING",
    "ECHO",
    "TIME",
];

/// Allowed only with the scenario's `allow_scripts`.
const SCRIPTS: &[&str] = &["EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "SCRIPT"];

fn has_word(args: &[String], word: &str) -> bool {
    args.iter().any(|a| a.eq_ignore_ascii_case(word))
}

/// `Err` with the reason when the rendered command may not run in a scenario.
pub fn check(args: &[String], allow_scripts: bool) -> Result<(), String> {
    let Some((name, rest)) = args.split_first() else {
        return Err("empty command".into());
    };
    let upper = name.to_ascii_uppercase();
    if SCRIPTS.contains(&upper.as_str()) {
        if !allow_scripts {
            return Err(format!(
                "{upper} runs a script, which can reach anything: set \"allow_scripts\": true in the scenario (and keep every loop bounded by an iteration count)"
            ));
        }
        if upper == "SCRIPT" {
            let sub = rest
                .first()
                .map(|s| s.to_ascii_uppercase())
                .unwrap_or_default();
            if sub != "LOAD" && sub != "EXISTS" {
                return Err(format!(
                    "SCRIPT {sub} is not allowed (only SCRIPT LOAD and SCRIPT EXISTS): it affects the whole server"
                ));
            }
        }
        return Ok(());
    }
    if !DATA.contains(&upper.as_str()) {
        return Err(format!(
            "{upper} is not allowed in scenarios: only data commands on the side's own logical database are (it would reach another database, affect the server or other clients, block, or hold connection state)"
        ));
    }
    match upper.as_str() {
        // COPY source destination [DB destination-db] [REPLACE]
        "COPY" if rest.iter().skip(2).any(|a| a.eq_ignore_ascii_case("DB")) => {
            Err("COPY ... DB is not allowed: it writes to another logical database".into())
        }
        "XREAD" | "XREADGROUP" if has_word(rest, "BLOCK") => {
            Err(format!("{upper} ... BLOCK is not allowed: it blocks"))
        }
        "OBJECT" => {
            let sub = rest
                .first()
                .map(|s| s.to_ascii_uppercase())
                .unwrap_or_default();
            if ["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"].contains(&sub.as_str()) {
                Ok(())
            } else {
                Err(format!("OBJECT {sub} is not allowed"))
            }
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::check;

    fn cmd(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn data_commands_on_the_own_database_are_allowed() {
        for c in [
            &["SET", "k", "v", "EX", "60"][..],
            &["get", "k"],
            &["HSET", "h", "f", "1"],
            &["RPUSH", "q", "a"],
            &["ZADD", "z", "1", "m"],
            &["XADD", "s", "*", "f", "v"],
            &["XREAD", "COUNT", "1", "STREAMS", "s", "0"],
            &["COPY", "a", "b", "REPLACE"],
            &["OBJECT", "ENCODING", "k"],
            &["PTTL", "k"],
        ] {
            assert!(check(&cmd(c), false).is_ok(), "{c:?}");
        }
    }

    #[test]
    fn anything_that_leaves_the_database_or_affects_the_server_is_refused() {
        for c in [
            &["SELECT", "0"][..],
            &["select", "2"],
            &["SWAPDB", "1", "2"],
            &["MOVE", "k", "2"],
            &["FLUSHALL"],
            &["FLUSHDB"],
            &["CONFIG", "GET", "maxmemory"],
            &["SHUTDOWN"],
            &["DEBUG", "SLEEP", "0"],
            &["CLIENT", "KILL", "ID", "1"],
            &["PUBLISH", "ch", "m"],
            &["SUBSCRIBE", "ch"],
            &["MULTI"],
            &["WATCH", "k"],
            &["BLPOP", "q", "0"],
            &["XREAD", "BLOCK", "0", "STREAMS", "s", "$"],
            &["COPY", "a", "b", "DB", "3"],
            &["COPY", "a", "b", "db", "3"],
            &["OBJECT", "FREQ2"],
            &["MIGRATE", "h", "1", "k", "0", "0"],
            &["DFLY", "REPLICAOF"],
            &["FUNCTION", "FLUSH"],
            &["INFO"],
            &[],
        ] {
            assert!(check(&cmd(c), false).is_err(), "{c:?} should be refused");
        }
    }

    #[test]
    fn scripts_need_the_scenario_flag() {
        let eval = cmd(&["EVAL", "return 1", "0"]);
        assert!(check(&eval, false).unwrap_err().contains("allow_scripts"));
        assert!(check(&eval, true).is_ok());
        assert!(check(&cmd(&["EVALSHA", "abc", "0"]), true).is_ok());
        assert!(check(&cmd(&["SCRIPT", "LOAD", "return 1"]), true).is_ok());
        assert!(check(&cmd(&["SCRIPT", "FLUSH"]), true).is_err());
        assert!(check(&cmd(&["SCRIPT", "KILL"]), true).is_err());
        assert!(check(&cmd(&["SCRIPT", "LOAD", "x"]), false).is_err());
    }
}
