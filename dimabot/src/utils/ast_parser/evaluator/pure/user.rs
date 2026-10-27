use super::super::ExecutionContext;
use super::{
    EvalError, JsString, JsValue, PureFunction, categories, checked_string, js_truthy, push_char,
    string_arg, whitespace,
};

pub(super) fn apply(
    function: PureFunction,
    args: &[JsValue],
    context: &ExecutionContext,
) -> Result<JsValue, EvalError> {
    if matches!(function, PureFunction::ToUser) {
        if let Some(target) = args.first().filter(|value| js_truthy(value)) {
            return sanitize(target);
        }
        let argument = context.effective_argument();
        if js_truthy(&argument) {
            return sanitize(&argument);
        }
        return name(context);
    }
    let name = name(context)?;
    let Some((remove_symbols, remove_numbers)) = filters(args)? else {
        return Ok(name);
    };
    let mut output = Vec::new();
    let mut usable = false;
    match name {
        JsValue::String(name) => {
            output.reserve(name.len());
            for character in char::decode_utf16(name.units().iter().copied()) {
                match character {
                    Ok(character) => {
                        let (letter, mark, number) = categories(character);
                        if (remove_symbols && !(letter || mark || number))
                            || (remove_numbers && number)
                        {
                            continue;
                        }
                        usable |= letter || number;
                        push_char(&mut output, character);
                    }
                    Err(error) if !remove_symbols => output.push(error.unpaired_surrogate()),
                    Err(_) => {}
                }
            }
        }
        JsValue::Array(values) => {
            // A raw display-name override can be an array. Source for-of visits
            // its elements, and each regex tests the element's entire string.
            for value in values.borrow().iter() {
                let text = checked_string(value)?;
                let (letter, mark, number) = text_categories(&text);
                if (remove_symbols && !(letter || mark || number)) || (remove_numbers && number) {
                    continue;
                }
                usable |= letter || number;
                output.extend_from_slice(text.units());
            }
        }
        _ => {
            return Err(EvalError {
                name: "TypeError".into(),
                message: "name is not iterable".into(),
            });
        }
    }
    let output = JsString::from_units(output);
    // Removing a numeric character may join two previously lone surrogate
    // units into a letter. Preserve the source's final test on the output.
    if !usable {
        let (letter, _, number) = text_categories(&output);
        usable = letter || number;
    }
    Ok(JsValue::String(if usable {
        output
    } else {
        "viewer".into()
    }))
}
fn text_categories(text: &JsString) -> (bool, bool, bool) {
    let mut result = (false, false, false);
    for character in char::decode_utf16(text.units().iter().copied()).flatten() {
        let (letter, mark, number) = categories(character);
        result.0 |= letter;
        result.1 |= mark;
        result.2 |= number;
    }
    result
}
fn sanitize(target: &JsValue) -> Result<JsValue, EvalError> {
    Ok(JsValue::String(match target {
        JsValue::String(text) => escape(text),
        _ => checked_string(target)?.into_owned(),
    }))
}
fn name(context: &ExecutionContext) -> Result<JsValue, EvalError> {
    for (object, key) in [
        (&context.event_data, "chatter_user_name"),
        (&context.event_data, "chatter_user_login"),
        (&context.extra_context, "userName"),
        (&context.extra_context, "userLogin"),
    ] {
        let value = object.get(key);
        if js_truthy(&value) {
            return Ok(JsValue::String(checked_string(&value)?.into_owned()));
        }
    }
    let display = context.effective_user_display_name();
    Ok(if js_truthy(&display) {
        display
    } else {
        JsValue::string(&context.user_login)
    })
}
fn escape(text: &JsString) -> JsString {
    let mut output = Vec::with_capacity(text.len());
    for &unit in text.units() {
        if matches!(unit, 36 | 37 | 42) {
            output.push(92);
        }
        output.push(unit);
    }
    JsString::from_units(output)
}
fn token_eq(token: &[u16], expected: &[u8]) -> bool {
    // All accepted words contain ASCII letters without Unicode lowercase
    // equivalents (notably none contains 'k', for Kelvin sign). Thus an ASCII
    // fold is exactly the source lowercase comparison, with no token allocation.
    token.len() == expected.len()
        && token.iter().zip(expected).all(|(&unit, &byte)| {
            let lower = if (65..=90).contains(&unit) {
                unit + 32
            } else {
                unit
            };
            lower == u16::from(byte)
        })
}
fn filters(args: &[JsValue]) -> Result<Option<(bool, bool)>, EvalError> {
    let mut saw_ignore = false;
    let mut symbols = false;
    let mut numbers = false;
    let mut valid = true;
    for arg in args {
        // Source flattens/coerces ALL arguments before parsing the filter list.
        // An invalid token must not hide a later coercion failure.
        let text = string_arg(arg)?;
        if !valid {
            continue;
        }
        for token in text
            .units()
            .split(|unit| whitespace(*unit))
            .filter(|token| !token.is_empty())
        {
            if !saw_ignore {
                if !token_eq(token, b"ignore") {
                    valid = false;
                    break;
                }
                saw_ignore = true;
            } else if token_eq(token, b"symbols") {
                symbols = true;
            } else if token_eq(token, b"numbers") {
                numbers = true;
            } else {
                valid = false;
                break;
            }
        }
    }
    Ok(if valid && (symbols || numbers) {
        Some((symbols, numbers))
    } else {
        None
    })
}
