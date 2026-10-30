//! Advanced blocked-word parser and matcher. Regex compatibility is limited by
//! the experimental `re2_native` implementation; see the migration handoff.
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};

pub use crate::utils::moderation::advanced_policy::{
    ALLOW_THRESHOLD, DECISION_POLICY_VERSION, MODERATION_RETENTION_DAYS, MODERATION_VISIBLE_DAYS,
    SEMANTIC_DEADLINE_MS, SEMANTIC_MODEL, SemanticPolicy, empty_semantic_policy, paid_moderation,
};
use crate::utils::{
    js_string::JsString,
    lossless_json::JsonValue,
    lossless_json_view::JsonView,
    moderation::{
        advanced_policy::{InputValue, parse_semantic_policy_input},
        blacklist::{BlacklistPattern, compile_blacklist_pattern},
        normalize::fold_text,
    },
    re2_native::{CompileError, Re2Native},
};

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum Boundary {
    WholeWord,
    Anywhere,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct ModerationPattern {
    pub id: JsString,
    pub source: JsString,
    pub boundary: Boundary,
    pub ignore_case: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AdvancedRule {
    pub patterns: Vec<ModerationPattern>,
    pub semantic: SemanticPolicy,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModerationMatch {
    pub matcher_id: JsString,
    pub text: JsString,
    pub start: usize,
    pub end: usize,
}

const INVALID_REGEX: &str = "Invalid or unsupported regex. Use RE2 syntax without lookaround/backreferences or empty matches; select whole-word boundaries separately.";
const CACHE_LIMIT: usize = 1000;
const LITERAL_CACHE_LIMIT: usize = 128;
type LiteralEntries = HashMap<Vec<JsString>, Option<Arc<BlacklistPattern>>>;

/// Shared cache; its typed key intentionally omits properties that are not in
/// the public pattern type. Construct independent caches for isolated callers.
#[derive(Default)]
pub struct PatternCache {
    entries: Mutex<HashMap<ModerationPattern, Arc<Re2Native>>>,
    literals: Mutex<LiteralEntries>,
}
impl PatternCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.literals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
    // Internal performance policy: cache raw typed terms, including filtered-out
    // sets, with an independent clear-all bound. Compilation is pure and the
    // mutex serializes misses; matching happens after the guard is released.
    fn compile_literal(&self, terms: &[JsString]) -> Option<Arc<BlacklistPattern>> {
        if terms.is_empty() {
            return None;
        }
        let mut entries = self.literals.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = entries.get(terms) {
            return found.clone();
        }
        let compiled = compile_blacklist_pattern(Some(terms)).map(Arc::new);
        if entries.len() >= LITERAL_CACHE_LIMIT {
            entries.clear();
        }
        entries.insert(terms.to_vec(), compiled.clone());
        compiled
    }
    fn compile(&self, pattern: &ModerationPattern) -> Result<Arc<Re2Native>, CompileError> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = entries.get(pattern) {
            return Ok(found.clone());
        }
        let source = if pattern.boundary == Boundary::WholeWord {
            let mut units: Vec<u16> = r"(^|[^\p{L}\p{N}])(".encode_utf16().collect();
            units.extend(pattern.source.code_units());
            units.extend(r")($|[^\p{L}\p{N}])".encode_utf16());
            JsString::from_units(units)
        } else {
            pattern.source.clone()
        };
        let compiled = Arc::new(Re2Native::compile(&source, pattern.ignore_case, false)?);
        if entries.len() >= CACHE_LIMIT {
            entries.clear();
        }
        entries.insert(pattern.clone(), compiled.clone());
        Ok(compiled)
    }
}
fn global_cache() -> &'static PatternCache {
    static CACHE: OnceLock<PatternCache> = OnceLock::new();
    CACHE.get_or_init(PatternCache::new)
}

fn valid_id(id: &JsString) -> bool {
    (1..=64).contains(&id.len())
        && id
            .code_units()
            .all(|c| matches!(c, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f | 0x2d))
}

/// The JavaScript error class and message produced by the parser.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdvancedRuleError {
    pub name: &'static str,
    pub message: &'static str,
}
impl From<&'static str> for AdvancedRuleError {
    fn from(message: &'static str) -> Self {
        Self {
            name: "Error",
            message,
        }
    }
}
impl std::fmt::Display for AdvancedRuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for AdvancedRuleError {}

/// Parse a validated JSON view. UUIDs default to real v4 values.
pub fn parse_advanced_rule(input: JsonView<'_>) -> Result<AdvancedRule, AdvancedRuleError> {
    parse_advanced_rule_with(input, global_cache(), || {
        JsString::from(uuid::Uuid::new_v4().to_string())
    })
}

/// Parse native values without serializing non-finite numbers or negative zero.
pub fn parse_advanced_rule_owned(input: &JsonValue) -> Result<AdvancedRule, AdvancedRuleError> {
    parse_advanced_rule_owned_with(input, global_cache(), || {
        JsString::from(uuid::Uuid::new_v4().to_string())
    })
}

/// UUID seams invoke the generator only for invalid or absent IDs.
pub fn parse_advanced_rule_with<F: FnMut() -> JsString>(
    input: JsonView<'_>,
    cache: &PatternCache,
    mut uuid: F,
) -> Result<AdvancedRule, AdvancedRuleError> {
    parse_advanced_rule_with_fallible_uuid(input, cache, || Ok(uuid()))
}
pub fn parse_advanced_rule_owned_with<F: FnMut() -> JsString>(
    input: &JsonValue,
    cache: &PatternCache,
    mut uuid: F,
) -> Result<AdvancedRule, AdvancedRuleError> {
    parse_advanced_rule_owned_with_fallible_uuid(input, cache, || Ok(uuid()))
}

/// Preserve failures from an explicitly supplied UUID source.
pub fn parse_advanced_rule_with_fallible_uuid<F: FnMut() -> Result<JsString, &'static str>>(
    input: JsonView<'_>,
    cache: &PatternCache,
    uuid: F,
) -> Result<AdvancedRule, AdvancedRuleError> {
    parse_advanced_rule_input(InputValue::View(input), cache, uuid)
}
pub fn parse_advanced_rule_owned_with_fallible_uuid<
    F: FnMut() -> Result<JsString, &'static str>,
>(
    input: &JsonValue,
    cache: &PatternCache,
    uuid: F,
) -> Result<AdvancedRule, AdvancedRuleError> {
    parse_advanced_rule_input(InputValue::Owned(input), cache, uuid)
}

fn parse_advanced_rule_input<F: FnMut() -> Result<JsString, &'static str>>(
    input: InputValue<'_>,
    cache: &PatternCache,
    mut uuid: F,
) -> Result<AdvancedRule, AdvancedRuleError> {
    if input.is_null() {
        return Err(AdvancedRuleError {
            name: "TypeError",
            message: "Cannot read properties of null (reading 'patterns')",
        });
    }
    let raw_patterns = match input.get("patterns") {
        None => Vec::new(),
        Some(value) => value
            .array()
            .ok_or("Patterns must be a list")?
            .take(11)
            .collect::<Vec<_>>(),
    };
    if raw_patterns.len() > 10 {
        return Err("A rule can have at most 10 regex patterns".into());
    }
    let mut ids = HashSet::new();
    let mut patterns = Vec::with_capacity(raw_patterns.len());
    for raw in raw_patterns {
        if !raw.is_object() && raw.array().is_none() {
            return Err("Invalid regex pattern".into());
        }
        let source = raw
            .get("source")
            .and_then(InputValue::as_string)
            .filter(|s| !s.trim().is_empty() && s.len() <= 250)
            .ok_or("Regex patterns must contain 1–250 characters")?;
        let boundary = match raw.get("boundary") {
            None => Boundary::WholeWord,
            Some(v) => match v.as_string().as_ref().and_then(JsString::as_str) {
                Some("whole_word") => Boundary::WholeWord,
                Some("anywhere") => Boundary::Anywhere,
                _ => return Err("Invalid regex boundary".into()),
            },
        };
        let ignore_case = match raw.get("ignoreCase") {
            None => true,
            Some(v) => v.as_bool().ok_or("Invalid regex case option")?,
        };
        let id = match raw
            .get("id")
            .and_then(InputValue::as_string)
            .filter(valid_id)
        {
            Some(id) => id,
            None => uuid()?,
        };
        if !ids.insert(id.clone()) {
            return Err("Regex pattern IDs must be unique".into());
        }
        let pattern = ModerationPattern {
            id,
            source,
            boundary,
            ignore_case,
        };
        let plain = Re2Native::compile(&pattern.source, pattern.ignore_case, false)
            .map_err(|_| INVALID_REGEX)?;
        if plain.exec(&JsString::from_static("")).is_some() {
            return Err(INVALID_REGEX.into());
        }
        cache.compile(&pattern).map_err(|_| INVALID_REGEX)?;
        patterns.push(pattern);
    }
    let semantic = parse_semantic_policy_input(input.get("semantic"))?;
    if input
        .get("type")
        .and_then(InputValue::as_string)
        .as_ref()
        .and_then(JsString::as_str)
        != Some("blacklist")
        && (!patterns.is_empty() || semantic.enabled)
    {
        return Err("Regex and contextual review are only available for blocked-word rules".into());
    }
    Ok(AdvancedRule { patterns, semantic })
}

pub fn find_blacklist_matches(
    text: &JsString,
    terms: &[JsString],
    patterns: &[ModerationPattern],
) -> Result<Vec<ModerationMatch>, CompileError> {
    find_blacklist_matches_with_cache(text, terms, patterns, global_cache())
}
pub fn find_blacklist_matches_with_cache(
    text: &JsString,
    terms: &[JsString],
    patterns: &[ModerationPattern],
    cache: &PatternCache,
) -> Result<Vec<ModerationMatch>, CompileError> {
    let mut matches = Vec::new();
    if let Some(pattern) = cache.compile_literal(terms)
        && let Some(literal) = find_literal_match(text, &pattern)
    {
        matches.push(literal);
    }
    for pattern in patterns {
        let Some(found) = cache.compile(pattern)?.exec(text) else {
            continue;
        };
        let group = if pattern.boundary == Boundary::WholeWord {
            2
        } else {
            0
        };
        let Some(Some(capture)) = found.captures.get(group) else {
            continue;
        };
        if capture.text.is_empty() {
            continue;
        }
        let prefix = if group == 2 {
            found
                .captures
                .get(1)
                .and_then(Option::as_ref)
                .map_or(0, |c| c.text.len())
        } else {
            0
        };
        let start = found.index + prefix;
        matches.push(ModerationMatch {
            matcher_id: pattern.id.clone(),
            text: capture.text.clone(),
            start,
            end: start + capture.text.len(),
        });
    }
    Ok(matches)
}

fn find_literal_match(text: &JsString, pattern: &BlacklistPattern) -> Option<ModerationMatch> {
    if text.as_str().is_some_and(str::is_ascii) {
        let folded = fold_text(Some(text));
        let found = pattern.exec(&folded)?;
        return Some(ModerationMatch {
            matcher_id: JsString::from_static("literal"),
            text: text.slice(found.start as i64, found.end as i64),
            start: found.start,
            end: found.end,
        });
    }
    let units = text.units();
    let mut folded = Vec::with_capacity(units.len());
    let mut offsets = Vec::with_capacity(units.len());
    let mut position = 0;
    while position < units.len() {
        let width = if (0xd800..=0xdbff).contains(&units[position])
            && position + 1 < units.len()
            && (0xdc00..=0xdfff).contains(&units[position + 1])
        {
            2
        } else {
            1
        };
        if units[position] <= 0x7f {
            let unit = units[position];
            folded.push(if (0x41..=0x5a).contains(&unit) {
                unit + 32
            } else {
                unit
            });
            offsets.push((position, position + width));
        } else {
            let character = JsString::from_units(units[position..position + width].to_vec());
            let normalized = fold_text(Some(&character));
            for unit in normalized.code_units() {
                folded.push(unit);
                offsets.push((position, position + width));
            }
        }
        position += width;
    }
    let literal = pattern.exec(&JsString::from_units(folded))?;
    let start = offsets.get(literal.start).map_or(0, |o| o.0);
    let end = literal
        .end
        .checked_sub(1)
        .and_then(|i| offsets.get(i))
        .map_or(start, |o| o.1);
    Some(ModerationMatch {
        matcher_id: JsString::from_static("literal"),
        text: text.slice(start as i64, end as i64),
        start,
        end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_cache_owns_keys_caches_empty_results_and_clears_independently() {
        let cache = PatternCache::new();
        let mut terms = vec![JsString::from("cat")];
        let first = cache.compile_literal(&terms).unwrap();
        terms[0] = "dog".into();
        let again = cache.compile_literal(&["cat".into()]).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert!(cache.compile_literal(&[]).is_none());
        assert!(cache.compile_literal(&["  ".into()]).is_none());
        assert_eq!(cache.literals.lock().unwrap().len(), 2);
        assert!(cache.compile_literal(&["  ".into()]).is_none());
        assert_eq!(cache.literals.lock().unwrap().len(), 2);
        assert_eq!(cache.len(), 0);

        let regex = ModerationPattern {
            id: "id".into(),
            source: "cat".into(),
            boundary: Boundary::Anywhere,
            ignore_case: false,
        };
        cache.compile(&regex).unwrap();
        for i in 0..LITERAL_CACHE_LIMIT - 2 {
            cache.compile_literal(&[format!("term{i}").into()]);
        }
        assert_eq!(cache.literals.lock().unwrap().len(), LITERAL_CACHE_LIMIT);
        cache.compile_literal(&["overflow".into()]);
        assert_eq!(cache.literals.lock().unwrap().len(), 1);
        assert_eq!(cache.len(), 1);
        assert!(!Arc::ptr_eq(
            &first,
            &cache.compile_literal(&["cat".into()]).unwrap()
        ));
        cache.clear();
        assert_eq!(cache.len(), 0);
        assert!(cache.literals.lock().unwrap().is_empty());
    }

    #[test]
    fn literal_cache_shares_compilation_across_threads() {
        let cache = Arc::new(PatternCache::new());
        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    let cache = cache.clone();
                    scope.spawn(move || cache.compile_literal(&["cat".into()]).unwrap())
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(results.iter().all(|p| Arc::ptr_eq(&results[0], p)));
        assert_eq!(cache.literals.lock().unwrap().len(), 1);
    }
}
