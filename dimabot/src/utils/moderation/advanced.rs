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
    lossless_json_view::JsonView,
    moderation::{
        advanced_policy::parse_semantic_policy, blacklist::compile_blacklist_pattern,
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

/// Shared cache; its typed key intentionally omits properties that are not in
/// the public pattern type. Construct independent caches for isolated callers.
#[derive(Default)]
pub struct PatternCache {
    entries: Mutex<HashMap<ModerationPattern, Arc<Re2Native>>>,
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

/// Parse a JSON object. Missing keys model undefined; non-JSON JS values and
/// null input are outside this typed boundary. UUIDs default to real v4 values.
pub fn parse_advanced_rule(input: JsonView<'_>) -> Result<AdvancedRule, &'static str> {
    parse_advanced_rule_with(input, global_cache(), || {
        JsString::from(uuid::Uuid::new_v4().to_string())
    })
}

/// The UUID generator seam permits deterministic fixture replay. It is invoked
/// only for invalid or absent IDs, at the same point as the source.
pub fn parse_advanced_rule_with<F: FnMut() -> JsString>(
    input: JsonView<'_>,
    cache: &PatternCache,
    mut uuid: F,
) -> Result<AdvancedRule, &'static str> {
    parse_advanced_rule_with_fallible_uuid(input, cache, || Ok(uuid()))
}

/// Preserve failures from an explicitly supplied UUID source.
pub fn parse_advanced_rule_with_fallible_uuid<F: FnMut() -> Result<JsString, &'static str>>(
    input: JsonView<'_>,
    cache: &PatternCache,
    mut uuid: F,
) -> Result<AdvancedRule, &'static str> {
    let raw_patterns = match input.get("patterns") {
        None => Vec::new(),
        Some(value) => value
            .array()
            .ok_or("Patterns must be a list")?
            .collect::<Vec<_>>(),
    };
    if raw_patterns.len() > 10 {
        return Err("A rule can have at most 10 regex patterns");
    }
    let mut ids = HashSet::new();
    let mut patterns = Vec::with_capacity(raw_patterns.len());
    for raw in raw_patterns {
        if !raw.raw().starts_with('{') && !raw.raw().starts_with('[') {
            return Err("Invalid regex pattern");
        }
        let source = raw
            .get("source")
            .and_then(JsonView::as_string)
            .filter(|s| !s.trim().is_empty() && s.len() <= 250)
            .ok_or("Regex patterns must contain 1–250 characters")?;
        let boundary = match raw.get("boundary") {
            None => Boundary::WholeWord,
            Some(v) => match v.as_string().as_ref().and_then(JsString::as_str) {
                Some("whole_word") => Boundary::WholeWord,
                Some("anywhere") => Boundary::Anywhere,
                _ => return Err("Invalid regex boundary"),
            },
        };
        let ignore_case = match raw.get("ignoreCase") {
            None => true,
            Some(v) => v.as_bool().ok_or("Invalid regex case option")?,
        };
        let id = match raw.get("id").and_then(JsonView::as_string).filter(valid_id) {
            Some(id) => id,
            None => uuid()?,
        };
        if !ids.insert(id.clone()) {
            return Err("Regex pattern IDs must be unique");
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
            return Err(INVALID_REGEX);
        }
        cache.compile(&pattern).map_err(|_| INVALID_REGEX)?;
        patterns.push(pattern);
    }
    let semantic = parse_semantic_policy(input.get("semantic"))?;
    if input
        .get("type")
        .and_then(JsonView::as_string)
        .as_ref()
        .and_then(JsString::as_str)
        != Some("blacklist")
        && (!patterns.is_empty() || semantic.enabled)
    {
        return Err("Regex and contextual review are only available for blocked-word rules");
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
    let units = text.units();
    let mut folded = Vec::new();
    let mut offsets = Vec::new();
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
        let character = JsString::from_units(units[position..position + width].to_vec());
        let normalized = fold_text(Some(&character));
        for unit in normalized.code_units() {
            folded.push(unit);
            offsets.push((position, position + width));
        }
        position += width;
    }
    if let Some(literal) =
        compile_blacklist_pattern(Some(terms)).and_then(|p| p.exec(&JsString::from_units(folded)))
    {
        let start = offsets.get(literal.start).map_or(0, |o| o.0);
        let end = literal
            .end
            .checked_sub(1)
            .and_then(|i| offsets.get(i))
            .map_or(start, |o| o.1);
        matches.push(ModerationMatch {
            matcher_id: JsString::from_static("literal"),
            text: text.slice(start as i64, end as i64),
            start,
            end,
        });
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
