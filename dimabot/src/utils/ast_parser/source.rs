use super::{Diagnostic, DiagnosticCode, HARD_NESTING_CEILING, JsString, Limits, ParseStats, SourceSpan};
use std::{ops::Range, sync::Arc};

/// A code-unit view for the planned UTF-16 lexer. Maps every decoded boundary
/// back to the original source so chained quote decoding retains diagnostics.
/// It deliberately does not convert to UTF-8 or invent replacement scalars.
#[derive(Clone, Debug)]
pub(crate) struct Utf16View {
    pub units: Arc<[u16]>,
    map: Arc<[usize]>,
}
impl Utf16View {
    pub fn original(input: &JsString, limits: Limits) -> Result<Self, Diagnostic> {
        let len = input.len();
        if len > limits.source_utf16 {
            return Err(Diagnostic::new(DiagnosticCode::SourceLimit, "Source UTF16 limit exceeded", SourceSpan { start: 0, end: len }));
        }
        Ok(Self { units: Arc::from(input.units()), map: (0..=len).collect::<Vec<_>>().into() })
    }
    pub fn span(&self, range: Range<usize>) -> SourceSpan {
        let last = self.map.len() - 1;
        SourceSpan { start: self.map[range.start.min(last)], end: self.map[range.end.min(last)] }
    }
    pub fn decoded(&self, content: Range<usize>) -> Self {
        let mut units = self.units[content.clone()].to_vec();
        let mut map = self.map[content.start..=content.end].to_vec();
        for (needle, replacement) in [(b'n', b'\n'), (b't', b'\t'), (b'"', b'"'), (b'\\', b'\\')] {
            let mut out = Vec::with_capacity(units.len());
            let mut next_map = Vec::with_capacity(map.len());
            let mut pos = 0;
            while pos < units.len() {
                if units[pos] == u16::from(b'\\') && units.get(pos + 1) == Some(&u16::from(needle)) {
                    out.push(u16::from(replacement));
                    next_map.push(map[pos]);
                    pos += 2;
                } else {
                    out.push(units[pos]);
                    next_map.push(map[pos]);
                    pos += 1;
                }
            }
            next_map.push(map[units.len()]);
            units = out;
            map = next_map;
        }
        Self { units: units.into(), map: map.into() }
    }
}

#[cfg(test)]
mod utf16_view_tests {
    use super::*;

    #[test]
    fn decoding_preserves_surrogates_and_original_boundaries() {
        let source = JsString::from_units(vec![0xd800, 92, 110, 0xdc00, 92, 92]);
        let view = Utf16View::original(&source, Limits::default()).unwrap();
        let decoded = view.decoded(0..6);
        assert_eq!(&*decoded.units, &[0xd800, 10, 0xdc00, 92]);
        assert_eq!(decoded.span(1..2), SourceSpan { start: 1, end: 3 });
        assert_eq!(decoded.span(3..4), SourceSpan { start: 4, end: 6 });
    }
}

#[derive(Debug)]
pub(crate) struct Source {
    pub text: Arc<str>,
    utf16: Vec<usize>,
}
impl Source {
    pub fn new(input: &str, limits: Limits) -> Result<Arc<Self>, Diagnostic> {
        let units = input.encode_utf16().count();
        if units > limits.source_utf16 {
            return Err(Diagnostic::new(
                DiagnosticCode::SourceLimit,
                "Source UTF16 limit exceeded",
                SourceSpan {
                    start: 0,
                    end: units,
                },
            ));
        }
        let mut utf16 = vec![0; input.len() + 1];
        let mut count = 0;
        for (byte, ch) in input.char_indices() {
            utf16[byte..byte + ch.len_utf8()].fill(count);
            count += ch.len_utf16();
            utf16[byte + ch.len_utf8()] = count;
        }
        Ok(Arc::new(Self {
            text: Arc::from(input),
            utf16,
        }))
    }
    pub fn span(&self, range: Range<usize>) -> SourceSpan {
        SourceSpan {
            start: self.utf16[range.start.min(self.text.len())],
            end: self.utf16[range.end.min(self.text.len())],
        }
    }
}

/// Most tokens borrow ranges in the original shared source. Decoding a quoted
/// string is the only reason to allocate a derived view; its boundary map keeps
/// diagnostics attached to original bytes even after chained JS replacements.
#[derive(Clone, Debug)]
pub(crate) struct View {
    pub text: Arc<str>,
    pub source: Arc<Source>,
    map: Option<Arc<[usize]>>,
}
impl View {
    pub fn original(source: Arc<Source>) -> Self {
        Self {
            text: source.text.clone(),
            source,
            map: None,
        }
    }
    pub fn span(&self, range: Range<usize>) -> SourceSpan {
        let start = self.original_byte(range.start);
        let end = self.original_byte(range.end);
        self.source.span(start..end)
    }
    fn original_byte(&self, byte: usize) -> usize {
        self.map
            .as_ref()
            .map_or(byte, |m| m[byte.min(m.len().saturating_sub(1))])
    }
    pub fn decoded(&self, content: Range<usize>) -> Self {
        let mut text = self.text[content.clone()].to_owned();
        let mut map: Vec<usize> = (content.start..=content.end)
            .map(|i| self.original_byte(i))
            .collect();
        // Deliberately sequential, matching registry.ts rather than a generic
        // string-unescape routine (notably for doubled backslashes before n).
        for (needle, replacement) in [("\\n", "\n"), ("\\t", "\t"), ("\\\"", "\""), ("\\\\", "\\")]
        {
            if !text.contains(needle) {
                continue;
            }
            let mut result = String::with_capacity(text.len());
            let mut mapped = Vec::with_capacity(map.len());
            let mut pos = 0;
            while let Some(relative) = text[pos..].find(needle) {
                let at = pos + relative;
                result.push_str(&text[pos..at]);
                mapped.extend_from_slice(&map[pos..at]);
                result.push_str(replacement);
                mapped.extend(std::iter::repeat_n(map[at], replacement.len()));
                pos = at + needle.len();
            }
            result.push_str(&text[pos..]);
            mapped.extend_from_slice(&map[pos..]);
            text = result;
            map = mapped;
        }
        Self {
            text: text.into(),
            source: self.source.clone(),
            map: Some(map.into()),
        }
    }
}

pub(crate) struct Budget {
    pub limits: Limits,
    pub stats: ParseStats,
}
impl Budget {
    pub fn new(mut limits: Limits) -> Self {
        limits.nesting = limits.nesting.min(HARD_NESTING_CEILING);
        Self {
            limits,
            stats: ParseStats::default(),
        }
    }
    pub fn depth(&self, depth: usize, span: SourceSpan) -> Result<(), Diagnostic> {
        if depth > self.limits.nesting {
            Err(Diagnostic::new(
                DiagnosticCode::NestingLimit,
                "Nesting limit exceeded",
                span,
            ))
        } else {
            Ok(())
        }
    }
    pub fn token(&mut self, span: SourceSpan) -> Result<(), Diagnostic> {
        if self.stats.tokens >= self.limits.tokens {
            return Err(Diagnostic::new(
                DiagnosticCode::TokenLimit,
                "Token limit exceeded",
                span,
            ));
        }
        self.stats.tokens += 1;
        Ok(())
    }
    pub fn node(&mut self, depth: usize, span: SourceSpan) -> Result<(), Diagnostic> {
        self.depth(depth, span)?;
        if self.stats.nodes >= self.limits.nodes {
            return Err(Diagnostic::new(
                DiagnosticCode::NodeLimit,
                "Node limit exceeded",
                span,
            ));
        }
        self.stats.nodes += 1;
        Ok(())
    }
}
