//! Reference heuristic language detector used by batch payloads. The reference's
//! global regexes retain lastIndex across words and calls, so repeated inputs can
//! produce different answers. Regex offsets are internal byte offsets into ASCII words. An owned detector preserves that quirk without a
//! process-global mutable singleton. Token counts are internal ratios, not billing.
use regex::Regex;
pub struct Detector {
    patterns: Vec<(String, Regex, usize)>,
    words: Regex,
}
impl Detector {
    pub fn new() -> Result<Self, Error> {
        let source: Vec<(String, String)> =
            serde_json::from_str(include_str!("language_patterns.json"))?;
        let patterns = source
            .into_iter()
            .map(|(name, p)| {
                Regex::new(&format!("(?i){}", p.replace(r"\b", r"(?-u:\b)"))).map(|r| (name, r, 0))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            patterns,
            words: Regex::new(r"(?-u:\b)[a-zA-Z]+(?-u:\b)")?,
        })
    }
    pub fn detect_language(&mut self, text: &str, threshold: f64) -> String {
        let lower = dima_text::to_lower(text);
        let words: Vec<_> = self.words.find_iter(&lower).map(|m| m.as_str()).collect();
        if words.is_empty() {
            return "unknown".into();
        }
        let mut best = "unknown";
        let mut best_score = 0.0;
        for (name, regex, index) in &mut self.patterns {
            let mut matches = 0;
            for word in &words {
                if *index <= word.len()
                    && let Some(m) = regex.find_at(word, *index)
                {
                    *index = m.end();
                    matches += 1;
                } else {
                    *index = 0;
                }
            }
            let score = matches as f64 / words.len() as f64;
            if score > best_score && score >= threshold {
                best_score = score;
                best = name;
            }
        }
        best.into()
    }
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Regex(#[from] regex::Error),
}
