//! Pure native counterparts of `variations.ts`. Transport is intentionally separate.
use crate::utils::{
    js_compat, js_regexp_unicode,
    js_string::JsString,
    js_unicode,
    lossless_json::JsonValue,
    moderation::{
        advanced::{Boundary, ModerationPattern, find_blacklist_matches},
        normalize::{escape_reg_exp, fold_text},
    },
    re2_native::Re2Native,
};
use sha2::{Digest, Sha256};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet, VecDeque},
    fmt,
    sync::{Arc, Mutex, OnceLock},
};

pub const VARIATION_VERSION: &str = "spelling-variants-v1";
pub const VARIATION_MODEL: &str = "meta/muse-spark-1.3-contributor";
pub const SYMBOL_VERSION: &str = "symbol-families-v1";
const MAX_SOURCE: usize = 16000;

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum VariationMode {
    Off,
    Common,
    Broad,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct GeneratedVariation {
    pub term: JsString,
    pub spellings: Vec<JsString>,
    pub pattern: ModerationPattern,
    pub version: JsString,
    pub allow_spaces: Option<bool>,
    pub symbol_version: Option<JsString>,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct VariationOverride {
    pub term: JsString,
    pub source: JsString,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModerationVariations {
    pub mode: VariationMode,
    pub entries: Vec<GeneratedVariation>,
    pub overrides: Option<Vec<VariationOverride>>,
    pub allow_spaces: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct VariationRule {
    pub patterns: Option<Vec<ModerationPattern>>,
    pub variations: Option<ModerationVariations>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VariationError(pub String);
impl fmt::Display for VariationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for VariationError {}
fn error(message: &str) -> VariationError {
    VariationError(message.to_owned())
}

pub fn variation_allow_spaces(raw: Option<&JsonValue>) -> Result<bool, VariationError> {
    match raw {
        None => Ok(false),
        Some(JsonValue::Bool(b)) => Ok(*b),
        _ => Err(error("Match spaces must be true or false")),
    }
}
pub fn variation_mode(raw: Option<&JsonValue>) -> Result<VariationMode, VariationError> {
    let Some(raw) = raw else {
        return Ok(VariationMode::Off);
    };
    if !matches!(raw, JsonValue::Object(_)) {
        return Err(error("Invalid word variations"));
    }
    match raw.get("mode") {
        Some(JsonValue::String(s)) if s.as_str() == Some("off") => Ok(VariationMode::Off),
        Some(JsonValue::String(s)) if s.as_str() == Some("common") => Ok(VariationMode::Common),
        Some(JsonValue::String(s)) if s.as_str() == Some("broad") => Ok(VariationMode::Broad),
        _ => Err(error(
            "Choose exact words, common variations, or broader variations",
        )),
    }
}
pub fn variation_term(term: &JsString) -> JsString {
    let normalized = js_unicode::normalize_nfc(term).trim();
    let mut out = Vec::new();
    let mut was_space = false;
    for c in char::decode_utf16(normalized.code_units()) {
        match c {
            Ok(c) if js_compat::is_whitespace(c) => {
                if !was_space {
                    out.push(32);
                }
                was_space = true;
            }
            Ok(c) => {
                let mut b = [0; 2];
                out.extend_from_slice(c.encode_utf16(&mut b));
                was_space = false;
            }
            Err(e) => {
                out.push(e.unpaired_surrogate());
                was_space = false;
            }
        }
    }
    js_unicode::lowercase(&JsString::from_units(out)).into_owned()
}
fn hash_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        write!(&mut out, "{byte:02x}").unwrap();
    }
    out
}
pub fn variation_key(channel_id: &JsString, term: &JsString) -> String {
    let json = format!(
        "[{},{},\"{}\"]",
        channel_id.to_json_string(),
        variation_term(term).to_json_string(),
        VARIATION_VERSION
    );
    hash_hex(json.as_bytes())
}
fn unique_push<T: Eq + std::hash::Hash + Clone>(
    values: &mut Vec<T>,
    seen: &mut HashSet<T>,
    value: T,
) {
    if seen.insert(value.clone()) {
        values.push(value);
    }
}
pub fn variation_terms(raw: Option<&JsonValue>) -> Result<Vec<JsString>, VariationError> {
    let Some(JsonValue::Array(items)) = raw else {
        return Err(error("Use up to 200 words or phrases of 1–100 characters"));
    };
    if items.len() > 200
        || items
            .iter()
            .any(|v| !matches!(v, JsonValue::String(s) if !s.trim().is_empty() && s.len() <= 100))
    {
        return Err(error("Use up to 200 words or phrases of 1–100 characters"));
    }
    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    for item in items {
        if let JsonValue::String(s) = item {
            unique_push(&mut terms, &mut seen, variation_term(s));
        }
    }
    Ok(terms)
}
pub fn variation_overrides(
    raw: Option<&JsonValue>,
    terms: &[JsString],
    mode: VariationMode,
) -> Result<Vec<VariationOverride>, VariationError> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let JsonValue::Array(items) = raw else {
        return Err(error("Use at most one edited regex per blocked word"));
    };
    if items.len() > 200 {
        return Err(error("Use at most one edited regex per blocked word"));
    }
    let allowed: HashSet<_> = terms.iter().map(variation_term).collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let (Some(JsonValue::String(term)), Some(JsonValue::String(source))) =
            (item.get("term"), item.get("source"))
        else {
            return Err(error("Invalid edited variation regex"));
        };
        let term = variation_term(term);
        if !allowed.contains(&term) || !seen.insert(term.clone()) {
            return Err(error(
                "Each edited regex must belong to a different blocked word",
            ));
        }
        if source.trim().is_empty() || source.len() > MAX_SOURCE {
            return Err(error(
                "Edited variation regex must contain 1–16000 characters",
            ));
        }
        if Re2Native::compile(source, true, false)
            .map_or(true, |re| re.exec(&JsString::from_static("")).is_some())
        {
            return Err(error(
                "Invalid variation regex. Use RE2 without lookaround, backreferences, or empty matches.",
            ));
        }
        out.push(VariationOverride {
            term,
            source: source.clone(),
        });
    }
    if mode == VariationMode::Off && !out.is_empty() {
        return Err(error(
            "Edited variation regex requires common or broader variations",
        ));
    }
    Ok(out)
}
fn points(s: &JsString) -> Vec<JsString> {
    char::decode_utf16(s.code_units())
        .map(|c| match c {
            Ok(c) => JsString::from(c.to_string()),
            Err(e) => JsString::from_units(vec![e.unpaired_surrogate()]),
        })
        .collect()
}
fn letter(s: &JsString) -> bool {
    let mut c = char::decode_utf16(s.code_units());
    matches!(c.next(), Some(Ok(ch)) if js_regexp_unicode::is_letter(ch as u32))
}
fn append(out: &mut Vec<u16>, s: &JsString) {
    out.extend(s.code_units());
}
fn literal(text: &JsString) -> JsString {
    escape_reg_exp(text).into_owned()
}
fn edit_distance(a: &JsString, b: &JsString) -> usize {
    let a = points(a);
    let b = points(b);
    let mut prev: Vec<_> = (0..=b.len()).collect();
    for (i, ac) in a.iter().enumerate() {
        let mut next = vec![i + 1];
        for (j, bc) in b.iter().enumerate() {
            next.push(
                (next[j] + 1)
                    .min(prev[j + 1] + 1)
                    .min(prev[j] + usize::from(ac != bc)),
            );
        }
        prev = next;
    }
    prev[b.len()]
}
fn join(parts: &[JsString], sep: &str) -> JsString {
    let mut out = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i != 0 {
            out.extend(sep.encode_utf16());
        }
        append(&mut out, p);
    }
    JsString::from_units(out)
}
fn surround(prefix: &str, body: &JsString, suffix: &str) -> JsString {
    let mut out: Vec<u16> = prefix.encode_utf16().collect();
    append(&mut out, body);
    out.extend(suffix.encode_utf16());
    JsString::from_units(out)
}
fn stretched(text: &JsString) -> JsString {
    let mut prior = None;
    let mut out = Vec::new();
    for c in points(text) {
        if letter(&c) {
            if prior.as_ref() == Some(&c) {
                continue;
            }
            prior = Some(c.clone());
            append(&mut out, &literal(&c));
            out.push(43);
        } else {
            prior = None;
            if c.as_str() == Some(" ") {
                out.extend("\\s+".encode_utf16());
            } else {
                append(&mut out, &literal(&c));
            }
        }
    }
    JsString::from_units(out)
}
fn symbol(c: &JsString) -> JsString {
    match c.as_str() {
        Some("a") => "[a4@]",
        Some("b") => "[b8]",
        Some("e") => "[e3]",
        Some("g") => "[g9]",
        Some("i") => "[i1!¡|]",
        Some("l") => "[l1!¡|]",
        Some("o") => "[o0]",
        Some("s") => "[s5$]",
        Some("t") => "[t7+]",
        Some("z") => "[z2]",
        _ => return literal(c),
    }
    .into()
}
fn source_for(text: &JsString, short: bool, symbols: bool, spaces: bool) -> JsString {
    if !symbols && !spaces {
        return if short {
            literal(text)
        } else {
            stretched(text)
        };
    }
    let mut prior = None;
    let mut tokens = Vec::new();
    for c in points(text) {
        let is_letter = letter(&c);
        if (symbols || !short) && is_letter {
            if prior.as_ref() == Some(&c) {
                continue;
            }
            prior = Some(c.clone());
            let unit = if symbols { symbol(&c) } else { literal(&c) };
            if symbols {
                let index = tokens.len();
                let value = if spaces {
                    if index == 0 {
                        let mut suffix = Vec::new();
                        suffix.extend("(?:\\s*".encode_utf16());
                        append(&mut suffix, &unit);
                        suffix.extend(")*".encode_utf16());
                        let mut out = unit.units();
                        out.extend(suffix);
                        JsString::from_units(out)
                    } else {
                        surround("(?:\\s*", &unit, ")+")
                    }
                } else {
                    surround("", &unit, "+")
                };
                tokens.push(value);
            } else {
                let mut out = unit.units();
                out.extend("(?:\\s*".encode_utf16());
                append(&mut out, &unit);
                out.extend(")*".encode_utf16());
                tokens.push(JsString::from_units(out));
            }
        } else {
            prior = None;
            let unit = if c.as_str() == Some(" ") {
                JsString::from_static("\\s+")
            } else {
                literal(&c)
            };
            if symbols && spaces && !tokens.is_empty() {
                tokens.push(surround("\\s*", &unit, ""));
            } else {
                tokens.push(unit);
            }
        }
    }
    join(&tokens, if symbols { "" } else { "\\s*" })
}
pub fn build_variation(
    term: &JsString,
    suggestions: Option<&JsonValue>,
) -> Result<GeneratedVariation, VariationError> {
    let normalized = variation_term(term);
    let suggestions = match suggestions {
        None => &[][..],
        Some(JsonValue::Array(v)) => v.as_slice(),
        _ => return Err(error("Invalid generated variations")),
    };
    if normalized.is_empty() || normalized.len() > 100 || suggestions.len() > 8 {
        return Err(error("Invalid generated variations"));
    }
    let mut spellings = Vec::new();
    let mut seen = HashSet::new();
    unique_push(&mut spellings, &mut seen, normalized.clone());
    unique_push(
        &mut spellings,
        &mut seen,
        fold_text(Some(&normalized)).into_owned(),
    );
    let short = points(&normalized).len() < 3;
    for raw in suggestions {
        let JsonValue::String(raw) = raw else {
            return Err(error("Invalid generated spelling"));
        };
        let candidate = variation_term(raw);
        let has_suffix = ["ing", "ed"]
            .iter()
            .any(|suffix| candidate == surround("", &normalized, suffix));
        if candidate.is_empty()
            || candidate.len() > 100
            || (short && candidate != normalized)
            || (edit_distance(&fold_text(Some(&normalized)), &fold_text(Some(&candidate))) > 2
                && !has_suffix)
        {
            return Err(error("Generated spelling is too far from its blocked word"));
        }
        unique_push(&mut spellings, &mut seen, candidate);
    }
    let mut sources = Vec::new();
    let mut seen_sources = HashSet::new();
    for spelling in &spellings {
        unique_push(
            &mut sources,
            &mut seen_sources,
            if short {
                literal(spelling)
            } else {
                stretched(spelling)
            },
        );
    }
    let source = surround("(?:", &join(&sources, "|"), ")");
    if source.len() > 2000 {
        return Err(error("Generated pattern is too long"));
    }
    let pattern = ModerationPattern {
        id: format!(
            "auto-{}",
            &variation_key(&JsString::from_static(""), &normalized)[..24]
        )
        .into(),
        source,
        boundary: Boundary::WholeWord,
        ignore_case: true,
    };
    let mut repeated = Vec::new();
    let mut changed = false;
    for c in points(&normalized) {
        append(&mut repeated, &c);
        if !short && !changed && letter(&c) {
            append(&mut repeated, &c);
            append(&mut repeated, &c);
            changed = true;
        }
    }
    unique_push(&mut spellings, &mut seen, JsString::from_units(repeated));
    Ok(GeneratedVariation {
        term: normalized,
        spellings,
        pattern,
        version: VARIATION_VERSION.into(),
        allow_spaces: None,
        symbol_version: None,
    })
}

type CacheKey = (GeneratedVariation, bool, bool);
#[derive(Default)]
struct CacheEntries {
    values: HashMap<CacheKey, Arc<GeneratedVariation>>,
    order: VecDeque<CacheKey>,
}
/// Borrowed means the input already had the requested configuration; Shared
/// retains JavaScript's same-object cache identity across hits.
#[derive(Clone, Debug)]
pub enum CompiledVariation<'a> {
    Borrowed(&'a GeneratedVariation),
    Shared(Arc<GeneratedVariation>),
}
impl AsRef<GeneratedVariation> for CompiledVariation<'_> {
    fn as_ref(&self) -> &GeneratedVariation {
        match self {
            Self::Borrowed(e) => e,
            Self::Shared(e) => e.as_ref(),
        }
    }
}
impl CompiledVariation<'_> {
    pub fn into_owned(self) -> GeneratedVariation {
        match self {
            Self::Borrowed(e) => e.clone(),
            Self::Shared(e) => (*e).clone(),
        }
    }
}
/// Clones share a FIFO cache; a cache hit does not change insertion order.
#[derive(Clone, Default)]
pub struct VariationCache {
    entries: Arc<Mutex<CacheEntries>>,
}
impl VariationCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values
            .len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn with_spacing_shared<'a>(
        &self,
        entry: &'a GeneratedVariation,
        allow_spaces: bool,
        mode: VariationMode,
    ) -> Result<CompiledVariation<'a>, VariationError> {
        let symbols = mode == VariationMode::Broad && points(&entry.term).len() >= 3;
        if entry.allow_spaces.unwrap_or(false) == allow_spaces
            && (entry.symbol_version.as_ref().and_then(JsString::as_str) == Some(SYMBOL_VERSION))
                == symbols
        {
            return Ok(CompiledVariation::Borrowed(entry));
        }
        let key = (entry.clone(), allow_spaces, symbols);
        let mut cache = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = cache.values.get(&key) {
            return Ok(CompiledVariation::Shared(found.clone()));
        }
        let short = points(&entry.term).len() < 3;
        let mut sources = Vec::new();
        let mut seen = HashSet::new();
        for spelling in &entry.spellings {
            unique_push(
                &mut sources,
                &mut seen,
                source_for(spelling, short, symbols, allow_spaces),
            );
        }
        let source = surround("(?:", &join(&sources, "|"), ")");
        if source.len() > MAX_SOURCE {
            return Err(error("Generated pattern is too long"));
        }
        let mut result = entry.clone();
        result.allow_spaces = Some(allow_spaces);
        result.symbol_version = symbols.then(|| SYMBOL_VERSION.into());
        result.pattern.source = source;
        if cache.values.len() >= 1000
            && let Some(oldest) = cache.order.pop_front()
        {
            cache.values.remove(&oldest);
        }
        let result = Arc::new(result);
        cache.order.push_back(key.clone());
        cache.values.insert(key, result.clone());
        Ok(CompiledVariation::Shared(result))
    }
    pub fn with_spacing<'a>(
        &self,
        entry: &'a GeneratedVariation,
        allow_spaces: bool,
        mode: VariationMode,
    ) -> Result<Cow<'a, GeneratedVariation>, VariationError> {
        Ok(match self.with_spacing_shared(entry, allow_spaces, mode)? {
            CompiledVariation::Borrowed(entry) => Cow::Borrowed(entry),
            CompiledVariation::Shared(entry) => Cow::Owned((*entry).clone()),
        })
    }
}
fn global_cache() -> &'static VariationCache {
    static CACHE: OnceLock<VariationCache> = OnceLock::new();
    CACHE.get_or_init(VariationCache::new)
}
pub fn with_variation_spacing(
    entry: &GeneratedVariation,
    allow_spaces: bool,
    mode: VariationMode,
) -> Result<Cow<'_, GeneratedVariation>, VariationError> {
    global_cache().with_spacing(entry, allow_spaces, mode)
}
pub fn compile_rule_variations(
    rule: &VariationRule,
) -> Result<Cow<'_, VariationRule>, VariationError> {
    let Some(variations) = &rule.variations else {
        return Ok(Cow::Borrowed(rule));
    };
    if variations.mode == VariationMode::Off {
        return Ok(Cow::Borrowed(rule));
    }
    let mut result = rule.clone();
    let target = result.variations.as_mut().expect("present");
    target.entries = variations
        .entries
        .iter()
        .map(|entry| {
            with_variation_spacing(
                entry,
                variations.allow_spaces.unwrap_or(false),
                variations.mode,
            )
            .map(Cow::into_owned)
        })
        .collect::<Result<_, _>>()?;
    Ok(Cow::Owned(result))
}
pub fn rule_patterns(rule: &VariationRule) -> Result<Cow<'_, [ModerationPattern]>, VariationError> {
    let patterns = rule.patterns.as_deref().unwrap_or(&[]);
    let Some(variations) = &rule.variations else {
        return Ok(Cow::Borrowed(patterns));
    };
    if variations.mode == VariationMode::Off || variations.entries.is_empty() {
        return Ok(Cow::Borrowed(patterns));
    }
    let overrides: HashMap<_, _> = variations
        .overrides
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|o| (&o.term, &o.source))
        .collect();
    let mut sources = Vec::new();
    for entry in &variations.entries {
        let source = match overrides.get(&entry.term) {
            Some(s) => (*s).clone(),
            None => with_variation_spacing(
                entry,
                variations.allow_spaces.unwrap_or(false),
                variations.mode,
            )?
            .pattern
            .source
            .clone(),
        };
        sources.push(surround("(?:", &source, ")"));
    }
    let source = surround("(?:", &join(&sources, "|"), ")");
    let id = format!(
        "auto-all-{}",
        &hash_hex(source.to_utf8_lossy().as_bytes())[..24]
    );
    let mut result = patterns.to_vec();
    result.push(ModerationPattern {
        id: id.into(),
        source,
        boundary: Boundary::WholeWord,
        ignore_case: true,
    });
    Ok(Cow::Owned(result))
}
pub fn validate_variations(
    entries: &[GeneratedVariation],
    allow_spaces: bool,
    mode: VariationMode,
) -> Result<(), VariationError> {
    if entries.is_empty() {
        return Ok(());
    }
    let terms = entries
        .iter()
        .map(|entry| entry.term.clone())
        .collect::<Vec<_>>();
    let text = join(&terms, " ");
    let rule = VariationRule {
        patterns: None,
        variations: Some(ModerationVariations {
            mode,
            entries: entries.to_vec(),
            overrides: None,
            allow_spaces: Some(allow_spaces),
        }),
    };
    let patterns = rule_patterns(&rule)?;
    let matches =
        find_blacklist_matches(&text, &[], &patterns).map_err(|e| error(&e.to_string()))?;
    if matches.is_empty() {
        return Err(error("Generated pattern failed validation"));
    }
    Ok(())
}

// Lossless JSON adapters preserve enumerable unknown properties when the TS
// spreads a caller's rule, variations, entry or pattern. Undefined-valued own
// properties cannot be represented by JsonValue; their JSON wire is preserved.
fn field<'a>(value: &'a JsonValue, name: &str) -> Result<&'a JsonValue, VariationError> {
    value
        .get(name)
        .ok_or_else(|| error("Invalid trusted variation value"))
}
fn as_string(value: &JsonValue) -> Result<JsString, VariationError> {
    if let JsonValue::String(s) = value {
        Ok(s.clone())
    } else {
        Err(error("Invalid trusted variation value"))
    }
}
fn mode_value(value: &JsonValue) -> VariationMode {
    match value.as_str_value() {
        Some("off") => VariationMode::Off,
        Some("broad") => VariationMode::Broad,
        _ => VariationMode::Common,
    }
}
trait StringValue {
    fn as_str_value(&self) -> Option<&str>;
}
impl StringValue for JsonValue {
    fn as_str_value(&self) -> Option<&str> {
        if let JsonValue::String(s) = self {
            s.as_str()
        } else {
            None
        }
    }
}
fn string_field(v: &JsonValue, key: &str) -> Result<JsString, VariationError> {
    as_string(field(v, key)?)
}
fn pattern_from_value(v: &JsonValue) -> Result<ModerationPattern, VariationError> {
    Ok(ModerationPattern {
        id: string_field(v, "id")?,
        source: string_field(v, "source")?,
        boundary: if field(v, "boundary")?.as_str_value() == Some("whole_word") {
            Boundary::WholeWord
        } else {
            Boundary::Anywhere
        },
        ignore_case: matches!(v.get("ignoreCase"), Some(JsonValue::Bool(true))),
    })
}
fn entry_from_value(v: &JsonValue) -> Result<GeneratedVariation, VariationError> {
    let JsonValue::Array(spellings) = field(v, "spellings")? else {
        return Err(error("Invalid trusted variation value"));
    };
    Ok(GeneratedVariation {
        term: string_field(v, "term")?,
        spellings: spellings.iter().map(as_string).collect::<Result<_, _>>()?,
        pattern: pattern_from_value(field(v, "pattern")?)?,
        version: string_field(v, "version")?,
        allow_spaces: match v.get("allowSpaces") {
            Some(JsonValue::Bool(b)) => Some(*b),
            _ => None,
        },
        symbol_version: match v.get("symbolVersion") {
            Some(JsonValue::String(s)) => Some(s.clone()),
            _ => None,
        },
    })
}
fn replace_field(
    v: &mut JsonValue,
    key: &str,
    value: Option<JsonValue>,
) -> Result<(), VariationError> {
    let JsonValue::Object(fields) = v else {
        return Err(error("Invalid trusted variation value"));
    };
    if let Some(i) = fields.iter().rposition(|(k, _)| k.as_str() == Some(key)) {
        if let Some(value) = value {
            fields[i].1 = value;
        } else {
            fields.remove(i);
        }
    } else if let Some(value) = value {
        fields.push((key.into(), value));
    }
    Ok(())
}
#[derive(Default)]
struct ValueCacheEntries {
    values: HashMap<String, Arc<JsonValue>>,
    order: VecDeque<String>,
}
/// Object adapter cache preserves all JSON fields in keys and results.
#[derive(Clone, Default)]
pub struct VariationValueCache {
    entries: Arc<Mutex<ValueCacheEntries>>,
    compiler: VariationCache,
}
#[derive(Clone, Debug)]
pub enum CompiledVariationValue<'a> {
    Borrowed(&'a JsonValue),
    Shared(Arc<JsonValue>),
}
impl AsRef<JsonValue> for CompiledVariationValue<'_> {
    fn as_ref(&self) -> &JsonValue {
        match self {
            Self::Borrowed(v) => v,
            Self::Shared(v) => v.as_ref(),
        }
    }
}
impl CompiledVariationValue<'_> {
    pub fn into_owned(self) -> JsonValue {
        match self {
            Self::Borrowed(v) => v.clone(),
            Self::Shared(v) => (*v).clone(),
        }
    }
}
impl VariationValueCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_spacing<'a>(
        &self,
        value: &'a JsonValue,
        allow_spaces: bool,
        mode: VariationMode,
    ) -> Result<CompiledVariationValue<'a>, VariationError> {
        let entry = entry_from_value(value)?;
        let symbols = mode == VariationMode::Broad && points(&entry.term).len() >= 3;
        if entry.allow_spaces.unwrap_or(false) == allow_spaces
            && (entry.symbol_version.as_ref().and_then(JsString::as_str) == Some(SYMBOL_VERSION))
                == symbols
        {
            return Ok(CompiledVariationValue::Borrowed(value));
        }
        let key = format!("[{},{},{}]", value.to_json_string(), allow_spaces, symbols);
        let mut cache = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(result) = cache.values.get(&key) {
            return Ok(CompiledVariationValue::Shared(result.clone()));
        }
        let compiled = self.compiler.with_spacing(&entry, allow_spaces, mode)?;
        let mut result = value.clone();
        replace_field(
            &mut result,
            "allowSpaces",
            Some(JsonValue::Bool(allow_spaces)),
        )?;
        replace_field(
            &mut result,
            "symbolVersion",
            symbols.then(|| JsonValue::String(SYMBOL_VERSION.into())),
        )?;
        let mut pattern = field(value, "pattern")?.clone();
        replace_field(
            &mut pattern,
            "source",
            Some(JsonValue::String(compiled.pattern.source.clone())),
        )?;
        replace_field(&mut result, "pattern", Some(pattern))?;
        if cache.values.len() >= 1000
            && let Some(old) = cache.order.pop_front()
        {
            cache.values.remove(&old);
        }
        let result = Arc::new(result);
        cache.order.push_back(key.clone());
        cache.values.insert(key, result.clone());
        Ok(CompiledVariationValue::Shared(result))
    }
}
fn global_value_cache() -> &'static VariationValueCache {
    static CACHE: OnceLock<VariationValueCache> = OnceLock::new();
    CACHE.get_or_init(VariationValueCache::new)
}
pub fn with_variation_spacing_value(
    value: &JsonValue,
    allow_spaces: bool,
    mode: VariationMode,
) -> Result<CompiledVariationValue<'_>, VariationError> {
    global_value_cache().with_spacing(value, allow_spaces, mode)
}
pub fn compile_rule_variations_value(
    rule: &JsonValue,
) -> Result<Cow<'_, JsonValue>, VariationError> {
    let Some(variations) = rule.get("variations") else {
        return Ok(Cow::Borrowed(rule));
    };
    if matches!(variations, JsonValue::Null | JsonValue::Bool(false))
        || variations
            .get("mode")
            .is_some_and(|m| m.as_str_value() == Some("off"))
    {
        return Ok(Cow::Borrowed(rule));
    }
    let mode = variations
        .get("mode")
        .map(mode_value)
        .unwrap_or(VariationMode::Common);
    let spaces = matches!(variations.get("allowSpaces"), Some(JsonValue::Bool(true)));
    let JsonValue::Array(entries) = field(variations, "entries")? else {
        return Err(error("Invalid trusted variation value"));
    };
    let compiled = entries
        .iter()
        .map(|entry| {
            with_variation_spacing_value(entry, spaces, mode)
                .map(CompiledVariationValue::into_owned)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut variations = variations.clone();
    replace_field(&mut variations, "entries", Some(JsonValue::Array(compiled)))?;
    let mut rule = rule.clone();
    replace_field(&mut rule, "variations", Some(variations))?;
    Ok(Cow::Owned(rule))
}
pub fn rule_patterns_value(rule: &JsonValue) -> Result<Cow<'_, JsonValue>, VariationError> {
    static EMPTY: OnceLock<JsonValue> = OnceLock::new();
    let empty = || EMPTY.get_or_init(|| JsonValue::Array(Vec::new()));
    let patterns = match rule.get("patterns") {
        Some(p @ JsonValue::Array(_)) => p,
        _ => empty(),
    };
    let Some(variations) = rule.get("variations") else {
        return Ok(Cow::Borrowed(patterns));
    };
    if variations
        .get("mode")
        .is_some_and(|v| v.as_str_value() == Some("off"))
    {
        return Ok(Cow::Borrowed(patterns));
    }
    let Some(JsonValue::Array(entries)) = variations.get("entries") else {
        return Ok(Cow::Borrowed(patterns));
    };
    if entries.is_empty() {
        return Ok(Cow::Borrowed(patterns));
    }
    let mode = variations
        .get("mode")
        .map(mode_value)
        .unwrap_or(VariationMode::Common);
    let spaces = matches!(variations.get("allowSpaces"), Some(JsonValue::Bool(true)));
    let mut overrides = HashMap::new();
    if let Some(JsonValue::Array(items)) = variations.get("overrides") {
        for item in items {
            overrides.insert(string_field(item, "term")?, string_field(item, "source")?);
        }
    }
    let mut sources = Vec::new();
    for entry in entries {
        let term = string_field(entry, "term")?;
        let source = if let Some(s) = overrides.get(&term) {
            s.clone()
        } else {
            string_field(
                field(
                    with_variation_spacing_value(entry, spaces, mode)?.as_ref(),
                    "pattern",
                )?,
                "source",
            )?
        };
        sources.push(surround("(?:", &source, ")"));
    }
    let source = surround("(?:", &join(&sources, "|"), ")");
    let id = format!(
        "auto-all-{}",
        &hash_hex(source.to_utf8_lossy().as_bytes())[..24]
    );
    let JsonValue::Array(mut result) = patterns.clone() else {
        unreachable!()
    };
    result.push(JsonValue::Object(vec![
        ("id".into(), JsonValue::String(id.into())),
        ("source".into(), JsonValue::String(source)),
        ("boundary".into(), JsonValue::String("whole_word".into())),
        ("ignoreCase".into(), JsonValue::Bool(true)),
    ]));
    Ok(Cow::Owned(JsonValue::Array(result)))
}
pub fn validate_variations_value(
    entries: &JsonValue,
    allow_spaces: bool,
    mode: VariationMode,
) -> Result<(), VariationError> {
    let JsonValue::Array(entries) = entries else {
        return Err(error("Invalid trusted variation value"));
    };
    let entries = entries
        .iter()
        .map(entry_from_value)
        .collect::<Result<Vec<_>, _>>()?;
    validate_variations(&entries, allow_spaces, mode)
}

/// Dynamic adapter for source calls whose declared TypeScript argument is a
/// string. `None` denotes JavaScript undefined; null remains distinct.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VariationInputError {
    pub name: &'static str,
    pub message: &'static str,
}
impl fmt::Display for VariationInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for VariationInputError {}
pub fn variation_term_value(term: Option<&JsonValue>) -> Result<JsString, VariationInputError> {
    match term {
        Some(JsonValue::String(s)) => Ok(variation_term(s)),
        None => Err(VariationInputError {
            name: "TypeError",
            message: "Cannot read properties of undefined (reading 'normalize')",
        }),
        Some(JsonValue::Null) => Err(VariationInputError {
            name: "TypeError",
            message: "Cannot read properties of null (reading 'normalize')",
        }),
        _ => Err(VariationInputError {
            name: "TypeError",
            message: "term.normalize is not a function",
        }),
    }
}
pub fn variation_key_value(
    channel_id: &JsString,
    term: Option<&JsonValue>,
) -> Result<String, VariationInputError> {
    variation_term_value(term).map(|term| variation_key(channel_id, &term))
}
