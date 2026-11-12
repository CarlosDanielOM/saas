//! Pet speech filtering reuses the TTS package. Options and tags are supplied by
//! the channel-settings caller; no catalog fetch or provider invocation occurs.
use dima_tts::normalize::{Normalized, Options};
use std::collections::HashMap;
/// Filter cues before normal channel emote/link/length filtering.
pub fn filter_talk(
    text: &str,
    provider: &str,
    tags: &HashMap<String, bool>,
    options: &Options,
) -> Normalized {
    dima_tts::normalize::normalize(&dima_tts::tags::filter(text, provider, tags), options)
}
/// Refilter desktop output after a voice change, preserving the link placeholder.
pub fn refilter_desktop(
    text: &str,
    provider: &str,
    tags: &HashMap<String, bool>,
    options: &Options,
) -> Normalized {
    let text = text.replace('\u{e000}', "").replace("[link]", "\u{e000}");
    let mut result = filter_talk(&text, provider, tags, options);
    result.text = result.text.replace('\u{e000}', "[link]");
    result.error = dima_text::trim(&result.text).is_empty();
    result
}
