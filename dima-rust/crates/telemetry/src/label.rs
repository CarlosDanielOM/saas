//! Bounded, allocation-free labels: the reference's `clean` and `channelId` filters.
//!
//! Only fixed, sanitised metadata leaves the process. Every label is ASCII by construction, so its
//! byte length is its character count and the analytics consumer's `.length` checks hold.

use std::fmt;

/// Longest metric or span kind (`clean(kind, 30)`).
pub const KIND_MAX: usize = 30;
/// Longest metric or span name (`clean(name)`, 100).
pub const NAME_MAX: usize = 100;
/// Longest outcome (`clean(outcome, 30)`).
pub const OUTCOME_MAX: usize = 30;
/// Longest channel id (`/^[a-zA-Z0-9_-]{1,80}$/`).
pub const CHANNEL_MAX: usize = 80;

fn allowed(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'/' | b' ' | b'-')
}

/// A cleaned label of at most `N` characters, on the stack.
///
/// `clean(value, max)` in the reference: every character outside `[a-zA-Z0-9_.:/ -]` becomes `_`,
/// then the text is cut to `max`. The reference works on UTF-16 units (an emoji becomes `__`);
/// here one character becomes one `_` (internal label, MIGRATION.md section 4, last row).
#[derive(Clone, Copy)]
pub struct Label<const N: usize> {
    buf: [u8; N],
    len: usize,
}

impl<const N: usize> Label<N> {
    /// The empty label.
    pub const EMPTY: Self = Self {
        buf: [0; N],
        len: 0,
    };

    /// Cleans `value`.
    pub fn clean(value: &str) -> Self {
        let mut label = Self::EMPTY;
        for character in value.chars().take(N) {
            let byte = u8::try_from(character)
                .ok()
                .filter(|byte| allowed(*byte))
                .unwrap_or(b'_');
            label.buf[label.len] = byte;
            label.len += 1;
        }
        label
    }

    /// The label text.
    pub fn as_str(&self) -> &str {
        // Every byte is ASCII by construction.
        std::str::from_utf8(self.bytes()).unwrap_or_default()
    }

    /// The label bytes.
    pub fn bytes(&self) -> &[u8] {
        self.buf.get(..self.len).unwrap_or_default()
    }

    /// Whether the label is empty.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl<const N: usize> fmt::Debug for Label<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), f)
    }
}

impl<const N: usize> PartialEq for Label<N> {
    fn eq(&self, other: &Self) -> bool {
        self.bytes() == other.bytes()
    }
}

impl<const N: usize> Eq for Label<N> {}

/// A channel id as the telemetry pipeline keeps it: `[a-zA-Z0-9_-]{1,80}`, or empty ("System").
pub type Channel = Label<CHANNEL_MAX>;

/// The reference's `channelId(value)`: the id when it matches `^[a-zA-Z0-9_-]{1,80}$`, else empty.
pub fn channel(value: &str) -> Channel {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > CHANNEL_MAX
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Channel::EMPTY;
    }
    let mut label = Channel::EMPTY;
    label.buf[..bytes.len()].copy_from_slice(bytes);
    label.len = bytes.len();
    label
}

/// Separator between the parts of a metric key (never produced by [`Label::clean`]).
pub(crate) const SEPARATOR: u8 = 0x1f;
const KEY_MAX: usize = KIND_MAX + NAME_MAX + CHANNEL_MAX + OUTCOME_MAX + 3;

/// `kind \x1f name \x1f channel \x1f outcome`, cleaned, on the stack.
pub(crate) struct MetricKey {
    buf: [u8; KEY_MAX],
    len: usize,
}

impl MetricKey {
    pub(crate) fn new(kind: &str, name: &str, channel: &Channel, outcome: &str) -> Self {
        let mut key = Self {
            buf: [0; KEY_MAX],
            len: 0,
        };
        key.push(Label::<KIND_MAX>::clean(kind).bytes());
        key.push(&[SEPARATOR]);
        key.push(Label::<NAME_MAX>::clean(name).bytes());
        key.push(&[SEPARATOR]);
        key.push(channel.bytes());
        key.push(&[SEPARATOR]);
        key.push(Label::<OUTCOME_MAX>::clean(outcome).bytes());
        key
    }

    fn push(&mut self, bytes: &[u8]) {
        if let Some(target) = self.buf.get_mut(self.len..self.len + bytes.len()) {
            target.copy_from_slice(bytes);
            self.len += bytes.len();
        }
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        self.buf.get(..self.len).unwrap_or_default()
    }
}

/// Splits a stored key back into `(kind, name, channel, outcome)`.
pub(crate) fn split_key(key: &[u8]) -> (&str, &str, &str, &str) {
    let mut parts = key
        .split(|byte| *byte == SEPARATOR)
        .map(|part| std::str::from_utf8(part).unwrap_or_default());
    let kind = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    let channel = parts.next().unwrap_or_default();
    let outcome = parts.next().unwrap_or_default();
    (kind, name, channel, outcome)
}

/// The reference's HTTP route label: `/unmatched` without a route, and dynamic segments of five or
/// more digits, or 24 or more lowercase hex characters, replaced by `/:id`.
pub fn safe_route(route: &str) -> String {
    let mut out = String::with_capacity(route.len());
    for (index, segment) in route.split('/').enumerate() {
        if index > 0 {
            out.push('/');
        }
        let digits = segment.len() >= 5 && segment.bytes().all(|byte| byte.is_ascii_digit());
        let hex = segment.len() >= 24
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if index > 0 && (digits || hex) {
            out.push_str(":id");
        } else {
            out.push_str(segment);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_matches_the_reference_filter() {
        assert_eq!(
            Label::<30>::clean("GET /speech/:id").as_str(),
            "GET /speech/:id"
        );
        assert_eq!(Label::<30>::clean("a$b\nc").as_str(), "a_b_c");
        assert_eq!(Label::<5>::clean("abcdefgh").as_str(), "abcde");
        // One character, one underscore: emoji, combining marks, right-to-left text.
        assert_eq!(Label::<30>::clean("hi😀").as_str(), "hi_");
        assert_eq!(Label::<30>::clean("e\u{301}").as_str(), "e_");
        assert_eq!(Label::<30>::clean("שלום").as_str(), "____");
    }

    #[test]
    fn channel_ids_are_validated_not_cleaned() {
        assert_eq!(channel("123456").as_str(), "123456");
        assert_eq!(channel("chan_a-b").as_str(), "chan_a-b");
        assert!(channel("").is_empty());
        assert!(channel("a:b").is_empty());
        assert!(channel(&"1".repeat(81)).is_empty());
        assert_eq!(channel(&"1".repeat(80)).as_str().len(), 80);
    }

    #[test]
    fn keys_round_trip() {
        let key = MetricKey::new("http", "GET /x", &channel("42"), "200");
        assert_eq!(split_key(key.bytes()), ("http", "GET /x", "42", "200"));
        let key = MetricKey::new(&"k".repeat(99), &"n".repeat(300), &Channel::EMPTY, "o");
        let (kind, name, chan, outcome) = split_key(key.bytes());
        assert_eq!((kind.len(), name.len(), chan, outcome), (30, 100, "", "o"));
    }

    #[test]
    fn routes_hide_ids() {
        assert_eq!(safe_route("/speech/123456"), "/speech/:id");
        assert_eq!(safe_route("/speech/1234"), "/speech/1234");
        assert_eq!(safe_route("/w/0123456789abcdef01234567/x"), "/w/:id/x");
        assert_eq!(safe_route("/speech/:channelID"), "/speech/:channelID");
    }
}
