//! Keyword triggers (reference: `utils/keywords.ts`, `utils/keyword_cache.ts`).
//!
//! A keyword command runs when a chat message contains its keyword: at the start, anywhere as
//! a whole word or phrase, or as the exact message. Keywords and messages are compared after
//! [`normalize_keyword`]; words are runs of letters, numbers, marks and `_`.
//!
//! On the chat path build a [`PreparedMessage`] once per message and match it against the
//! channel's [`KeywordIndex`] (kept by [`KeywordIndexCache`]); nothing is compiled per message.
//!
//! # Text
//!
//! - The 60 limit of [`validate_keyword`] counts characters (Unicode scalar values) where the
//!   reference counts UTF-16 units: a keyword with astral characters (emoji, mathematical
//!   letters) of 31 to 60 characters is now valid. This is the intended change of
//!   `MIGRATION.md` section 4 (row U4 of `ledger/existing-rust.md`).
//! - Normalisation is the reference's, in its order: NFC, JavaScript `toLowerCase`, JavaScript
//!   `trim`, then every run of JavaScript whitespace becomes one space ([`dima_text`]).
//! - Word classes use the `regex` crate's Unicode tables (`\p{L}`, `\p{N}`, `\p{M}`); a code
//!   point assigned after that Unicode version may classify differently from Node's ICU.
//! - Match positions never leave this module (internal byte offsets).

mod cache;

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::value::{Js, JsView};

pub use cache::{
    BODY_SCRIPT, BODY_TTL_SECONDS, KEYWORD_TOPIC, KeywordCacheError, KeywordCacheLimits,
    KeywordIndexCache, KeywordLoader, KeywordRow, KeywordStorage, KeywordStorageError,
    MAX_CACHED_KEYWORD_BYTES, MAX_KEYWORD_INDEX_BYTES, MAX_KEYWORD_LOADS_IN_FLIGHT,
    MAX_KEYWORDS_PER_CHANNEL, MAX_LOOKUP_ATTEMPTS, MAX_LOOKUP_MS, MAX_REVISION_ATTEMPTS,
    MAX_SHARED_INDEX_JSON_BYTES, Overload, SHARED_INDEX_SCRIPT, SHARED_INDEX_TTL_SECONDS,
    SharedKeywordLoader, apply_keyword_change, get_keyword_body, keyword_body_key,
    keyword_index_key, keyword_revision_key, load_shared_index, refresh_keyword_index,
    save_keyword_count,
};

/// The longest keyword, in characters (the reference counts UTF-16 units).
pub const MAX_KEYWORD_CHARS: usize = 60;

/// One word: letters, numbers, marks and `_` (JavaScript `[\p{L}\p{N}\p{M}_]+` with `u`).
static WORDS: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}\p{M}_]+").ok());

/// A valid normalised keyword: words separated by single spaces.
static VALID: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\A[\p{L}\p{N}\p{M}_]+(?: [\p{L}\p{N}\p{M}_]+)*\z").ok());

/// Where a keyword must appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeywordMatchMode {
    /// At the start of the message, as a whole word or phrase.
    Start,
    /// Anywhere, as a whole word or phrase.
    Anywhere,
    /// The whole message.
    Exact,
}

impl KeywordMatchMode {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Anywhere => "anywhere",
            Self::Exact => "exact",
        }
    }

    /// A valid mode's text.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "start" => Some(Self::Start),
            "anywhere" => Some(Self::Anywhere),
            "exact" => Some(Self::Exact),
            _ => None,
        }
    }

    /// The mode a stored command behaves with: `start` when `keywordSettings.matchMode` is
    /// missing (`?? 'start'`), and `anywhere` for an unknown text, because the reference's
    /// matcher treats every mode other than `exact` and `start` that way.
    pub fn from_stored(mode: Option<&str>) -> Self {
        match mode {
            None => Self::Start,
            Some(text) => Self::parse(text).unwrap_or(Self::Anywhere),
        }
    }
}

/// A keyword in a channel's index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeywordEntry {
    /// The command id (`String(_id)`).
    pub id: String,
    /// The keyword, normalised when it was loaded (the index does not normalise again).
    pub text: String,
    /// Where it must appear.
    #[serde(rename = "matchMode")]
    pub match_mode: KeywordMatchMode,
}

/// Why a keyword was refused; the text is the reference's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KeywordError {
    /// Not text, too long, or not words separated by spaces.
    #[error("Keyword must contain words or a phrase, without !, and be at most 60 characters")]
    Text,
    /// Not one of the three modes.
    #[error("Keyword match mode must be start, anywhere, or exact")]
    MatchMode,
}

/// `normalizeKeyword`: NFC, lowercase, trim, and one space for each run of whitespace.
pub fn normalize_keyword(text: &str) -> String {
    let lower = dima_text::to_lower(&dima_text::nfc(text));
    let mut normalized = String::with_capacity(lower.len());
    let mut space = false;
    for ch in dima_text::trim(&lower).chars() {
        if dima_text::is_js_whitespace(ch) {
            space = true;
        } else {
            if space {
                normalized.push(' ');
                space = false;
            }
            normalized.push(ch);
        }
    }
    normalized
}

/// `validateKeyword`: the keyword is text of at most [`MAX_KEYWORD_CHARS`] characters whose
/// normalised form is words separated by spaces, and `settings.matchMode` is a mode.
///
/// The reference checks `String(matchMode)` and then stores the original value, so it accepts
/// a non-string whose text is a mode (`["start"]`) and Mongoose then refuses the write. Here
/// only a string mode passes, so that request fails one step earlier, with the mode message.
pub fn validate_keyword<T: JsView, S: JsView>(
    text: &T,
    settings: &S,
) -> Result<KeywordMatchMode, KeywordError> {
    let Js::String(text) = text.js() else {
        return Err(KeywordError::Text);
    };
    if dima_text::char_len(text) > MAX_KEYWORD_CHARS
        || !is_valid_normalized(&normalize_keyword(text))
    {
        return Err(KeywordError::Text);
    }
    match settings.get("matchMode").map(JsView::js) {
        Some(Js::String(mode)) => KeywordMatchMode::parse(mode).ok_or(KeywordError::MatchMode),
        _ => Err(KeywordError::MatchMode),
    }
}

fn is_valid_normalized(normalized: &str) -> bool {
    VALID
        .as_ref()
        .is_some_and(|valid| valid.is_match(normalized))
}

/// The keywords of one channel, by first word: only buckets whose word occurs in a message are
/// examined. Build it once per load (`compileKeywordIndex`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KeywordIndex {
    buckets: HashMap<String, Vec<KeywordEntry>>,
    entries: usize,
    heap_bytes: usize,
}

impl KeywordIndex {
    /// `compileKeywordIndex`: entries keep their order inside a bucket; the first word is the
    /// text before the first space (entries are expected normalised).
    pub fn new(entries: impl IntoIterator<Item = KeywordEntry>) -> Self {
        let mut buckets: HashMap<String, Vec<KeywordEntry>> = HashMap::new();
        let mut count = 0;
        let mut heap_bytes = 0;
        for entry in entries {
            count += 1;
            heap_bytes += size_of::<KeywordEntry>() + entry.id.capacity() + entry.text.capacity();
            let first = entry.text.split(' ').next().unwrap_or_default().to_owned();
            buckets.entry(first).or_default().push(entry);
        }
        // Each bucket: its key, its vector's spare room, and the map's slot (with control byte).
        heap_bytes += buckets
            .iter()
            .map(|(word, bucket)| {
                word.capacity()
                    + (bucket.capacity() - bucket.len()) * size_of::<KeywordEntry>()
                    + size_of::<(String, Vec<KeywordEntry>)>()
                    + 1
            })
            .sum::<usize>();
        Self {
            buckets,
            entries: count,
            heap_bytes,
        }
    }

    /// The number of keywords.
    pub fn len(&self) -> usize {
        self.entries
    }

    /// An estimate of the heap the index holds, in bytes (what the cache counts).
    pub fn heap_bytes(&self) -> usize {
        self.heap_bytes
    }

    /// The entries whose first word is `word`.
    pub fn bucket(&self, word: &str) -> &[KeywordEntry] {
        self.buckets.get(word).map_or(&[], Vec::as_slice)
    }

    /// Whether the channel has no keyword.
    pub fn is_empty(&self) -> bool {
        self.buckets.is_empty()
    }

    /// The number of distinct first words.
    pub fn word_count(&self) -> usize {
        self.buckets.len()
    }
}

/// A chat message normalised once, with its word spans.
#[derive(Debug, Clone)]
pub struct PreparedMessage {
    text: String,
    /// Byte ranges of the words, in order and disjoint.
    words: Vec<Range<usize>>,
}

impl PreparedMessage {
    /// Normalises `message` and finds its words.
    pub fn new(message: &str) -> Self {
        let text = normalize_keyword(message);
        let words = WORDS
            .as_ref()
            .map(|words| words.find_iter(&text).map(|word| word.range()).collect())
            .unwrap_or_default();
        Self { text, words }
    }

    /// The normalised text.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The distinct words, in order of first occurrence.
    pub fn distinct_words(&self) -> impl Iterator<Item = &str> {
        let mut seen = HashSet::new();
        self.words
            .iter()
            .filter_map(|range| self.text.get(range.clone()))
            .filter(move |word| seen.insert(*word))
    }

    /// Whether the character ending at byte `at` is a word character.
    fn word_char_before(&self, at: usize) -> bool {
        // The last word starting before `at`.
        let index = self.words.partition_point(|word| word.start < at);
        index > 0 && self.words.get(index - 1).is_some_and(|word| word.end >= at)
    }

    /// Whether the character starting at byte `at` is a word character.
    fn word_char_at(&self, at: usize) -> bool {
        let index = self.words.partition_point(|word| word.end <= at);
        self.words.get(index).is_some_and(|word| word.start <= at)
    }

    fn whole_at(&self, start: usize, end: usize) -> bool {
        !self.word_char_at(end) && (start == 0 || !self.word_char_before(start))
    }

    /// `keywordMatches` on this message: `exact` compares the whole text; `start` needs the
    /// keyword at the beginning and no word character right after it; `anywhere` needs some
    /// occurrence with no word character on either side.
    pub fn matches(&self, entry: &KeywordEntry) -> bool {
        let needle = entry.text.as_str();
        match entry.match_mode {
            KeywordMatchMode::Exact => self.text == needle,
            KeywordMatchMode::Start => {
                self.text.starts_with(needle) && !self.word_char_at(needle.len())
            }
            KeywordMatchMode::Anywhere => {
                // Every occurrence, overlapping ones included (`a a` in `xa a a`).
                let mut from = 0;
                while let Some(found) = self.text.get(from..).and_then(|rest| rest.find(needle)) {
                    let start = from + found;
                    if self.whole_at(start, start + needle.len()) {
                        return true;
                    }
                    let Some(next) = self.text.get(start..).and_then(|rest| rest.chars().next())
                    else {
                        return false;
                    };
                    from = start + next.len_utf8();
                }
                false
            }
        }
    }

    /// `matchKeywords`: the entries that match, in order of the first occurrence of their first
    /// word, then index order. Entries with the same id are one match (the later value, at the
    /// earlier position), as the reference's `Map` keeps them.
    pub fn match_index<'i>(&self, index: &'i KeywordIndex) -> Vec<&'i KeywordEntry> {
        let mut matches: Vec<&KeywordEntry> = Vec::new();
        let mut positions: HashMap<&str, usize> = HashMap::new();
        if index.is_empty() {
            return matches;
        }
        for word in self.distinct_words() {
            for entry in index.bucket(word) {
                if !self.matches(entry) {
                    continue;
                }
                match positions.get(entry.id.as_str()) {
                    Some(&position) => {
                        if let Some(slot) = matches.get_mut(position) {
                            *slot = entry;
                        }
                    }
                    None => {
                        positions.insert(&entry.id, matches.len());
                        matches.push(entry);
                    }
                }
            }
        }
        matches
    }
}

/// `keywordMatches`, normalising `message` on each call (use [`PreparedMessage`] on a hot path).
pub fn keyword_matches(message: &str, entry: &KeywordEntry) -> bool {
    PreparedMessage::new(message).matches(entry)
}

/// `matchKeywords(index, message)`.
pub fn match_keywords<'i>(index: &'i KeywordIndex, message: &str) -> Vec<&'i KeywordEntry> {
    PreparedMessage::new(message).match_index(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_constant_patterns_compile() {
        assert!(WORDS.is_some());
        assert!(VALID.is_some());
    }

    #[test]
    fn word_boundaries_come_from_the_spans() {
        let message = PreparedMessage::new("ab, c_d é");
        // "ab" 0..2, "c_d" 4..7, "é" 8..10
        assert!(!message.word_char_at(2));
        assert!(message.word_char_at(0));
        assert!(message.word_char_before(2));
        assert!(!message.word_char_before(3));
        assert!(message.word_char_at(8));
        assert!(message.word_char_before(10));
        assert!(!message.word_char_at(10));
    }
}
