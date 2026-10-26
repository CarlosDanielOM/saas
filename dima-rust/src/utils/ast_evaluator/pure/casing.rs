use super::{JsString, categories, push_char};

pub(super) fn lower(text: &JsString) -> JsString {
    text.lower()
}
pub(super) fn upper(text: &JsString) -> JsString {
    // Whole well-formed runs retain Unicode expansion and contextual casing;
    // invalid UTF16 units survive exactly, as in the existing lower helper.
    let mut output = Vec::with_capacity(text.len());
    let mut run = String::new();
    for character in char::decode_utf16(text.units().iter().copied()) {
        match character {
            Ok(character) => run.push(character),
            Err(error) => {
                output.extend(run.to_uppercase().encode_utf16());
                run.clear();
                output.push(error.unpaired_surrogate());
            }
        }
    }
    output.extend(run.to_uppercase().encode_utf16());
    JsString::from_units(output)
}
pub(super) fn capitalize(text: &JsString) -> JsString {
    let Some(first) = text.units().first() else {
        return JsString::default();
    };
    // JavaScript text[0] selects one UNIT, even if it splits a surrogate pair.
    let first = upper(&JsString::from_units(vec![*first]));
    let mut output = Vec::with_capacity(first.len() + text.len() - 1);
    output.extend_from_slice(first.units());
    output.extend_from_slice(&text.units()[1..]);
    JsString::from_units(output)
}
pub(super) fn title(text: &JsString) -> JsString {
    let lower = lower(text);
    let mut output = Vec::with_capacity(lower.len());
    let mut word_start = true;
    for character in char::decode_utf16(lower.units().iter().copied()) {
        match character {
            Ok(character) => {
                if word_start && categories(character).0 {
                    for upper in character.to_uppercase() {
                        push_char(&mut output, upper);
                    }
                } else {
                    push_char(&mut output, character);
                }
                word_start = crate::utils::js_compat::is_whitespace(character);
            }
            Err(error) => {
                output.push(error.unpaired_surrogate());
                word_start = false;
            }
        }
    }
    JsString::from_units(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_casing_preserves_expansions_context_and_utf16() {
        assert_eq!(upper(&"ßﬃ".into()), JsString::from("SSFFI"));
        assert_eq!(lower(&"ΟΣ İ".into()), JsString::from("ος i\u{307}"));
        assert_eq!(
            title(&"foo-BAR !HELLO\u{feff}ßETA".into()),
            JsString::from("Foo-bar !hello\u{feff}SSeta")
        );
        assert_eq!(capitalize(&"𐐨abc".into()), JsString::from("𐐨abc"));
        assert_eq!(
            upper(&JsString::from_units(vec![0xd800, 0x00df, 0xdc00, 0x0061])).units(),
            &[0xd800, 83, 83, 0xdc00, 65]
        );
    }
}
