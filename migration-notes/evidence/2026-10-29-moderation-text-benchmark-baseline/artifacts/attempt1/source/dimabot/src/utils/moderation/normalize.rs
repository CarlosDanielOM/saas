//! Typed JavaScript-string counterparts of the two `normalize.ts` exports.
use std::borrow::Cow;

use crate::utils::{js_string::JsString, js_unicode};

/// Fold a string for blacklist matching. `None` represents either JavaScript
/// null or undefined and follows the source's `text ?? ''` behavior. Other
/// JavaScript value coercions are outside this typed string interface.
pub fn fold_text(text: Option<&JsString>) -> Cow<'_, JsString> {
    match text {
        Some(text) => js_unicode::fold_text(text),
        None => Cow::Owned(JsString::from_static("")),
    }
}

/// Escape the metacharacters selected by the source's non-Unicode RegExp.
/// Scanning UTF-16 units leaves every non-ASCII unit, including lone
/// surrogates, unchanged and can borrow strings that need no escaping.
pub fn escape_reg_exp(text: &JsString) -> Cow<'_, JsString> {
    fn is_meta(unit: u16) -> bool {
        matches!(
            unit,
            0x2e | 0x2a
                | 0x2b
                | 0x3f
                | 0x5e
                | 0x24
                | 0x7b
                | 0x7d
                | 0x28
                | 0x29
                | 0x7c
                | 0x5b
                | 0x5d
                | 0x5c
        )
    }
    if !text.code_units().any(is_meta) {
        return Cow::Borrowed(text);
    }
    let mut output = Vec::with_capacity(text.len());
    for unit in text.code_units() {
        if is_meta(unit) {
            output.push(u16::from(b'\\'));
        }
        output.push(unit);
    }
    Cow::Owned(JsString::from_units(output))
}
