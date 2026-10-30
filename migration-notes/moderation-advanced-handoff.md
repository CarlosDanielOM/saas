# Advanced moderation adapter handoff

The integrated opt-in adapter in `dimabot/src/utils/moderation/advanced.rs`
reuses `advanced_policy` for semantic validation,
`normalize::fold_text` and `blacklist::compile_blacklist_pattern` for literal
matching, and `re2_native::Re2Native` for regex compilation and execution. It
provides pattern parsing, rule-type checks, per-character fold and UTF-16 offset
reconstruction, the regex wrapper, and bounded shared caches. It has no
TypeScript runtime dependency. The feature uses the existing concrete `uuid`,
RE2, blacklist, Unicode, and JavaScript-string support; no Cargo package was
added for this feature.

`parse_advanced_rule` uses UUID v4 generation;
`parse_advanced_rule_with` accepts a deterministic generator and independent
cache for fixture replay. `find_blacklist_matches` uses a shared global cache;
the explicit-cache variant permits isolation and sharing. The regex cache is
bounded to 1,000 entries and clears before inserting a miss at capacity. The
literal cache is separately bounded to 128 entries. Compilation is serialized
on misses, no sleeps are used, and matching proceeds after the cache lock is
released.

The typed regex cache key contains the four `ModerationPattern` fields. Source
`JSON.stringify(pattern)` also observes property order and extra fields on
values passed directly to `findBlacklistMatches`; those distinctions can
change cache hits and constructor counts without changing matching results for
values represented by the typed API. This is not constructor-observer parity
for arbitrary JavaScript objects. Parser-created pattern fields have fixed
order. The source uses a single-threaded map while Rust uses a process-level
shared mutex; timing and constructor observations are not whole-application
output contracts.

The source fixture replay passed all 464 application parse/match cases, 91
direct RE2 cases, 604 regex behavior observations, and 45 wrapper cases. The
owned-value adapter additionally checks all 464 parse cases and all 84 selected
semantic-policy cases, preserving tagged `NaN`, infinities, negative zero, and
root-null behavior. JSON-view replay remains limited to representable inputs.
The oracle is finite and does not establish all node-re2 behavior. Its fixture
is validation data, not an application runtime dependency. See the
[value-adapter handoff](moderation-advanced-value-handoff.md),
[native RE2 handoff](re2-native-handoff.md), and the
[integrated moderation evidence note](moderation-advanced.md).

One matcher boundary remains: invalid regex input reports a native compile
failure, but the source's node-re2 `SyntaxError` class and exact diagnostic
message are not represented. The adapter does not claim exact diagnostic
parity or complete node-re2 SDK API parity. Existing application callers remain
TypeScript. No deployment, caller adoption, TypeScript retirement, push, or
100% total migration completion is implied.
