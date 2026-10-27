use super::super::value::js_string;
use super::{EvalError, JsString, JsValue};
use std::{borrow::Cow, collections::HashSet, rc::Rc};

/// String(value) for plain data, including non-callable own toString fields.
/// Keep this checked boundary private to the pure handlers; the existing
/// evaluator's infallible coercion contract is unchanged.
pub(super) fn checked_string(value: &JsValue) -> Result<Cow<'_, JsString>, EvalError> {
    match value {
        JsValue::String(text) => Ok(Cow::Borrowed(text)),
        JsValue::Array(_) => array_string(value).map(Cow::Owned),
        JsValue::Object(entries)
            if entries
                .borrow()
                .iter()
                .any(|(key, _)| key.units().iter().copied().eq("toString".encode_utf16())) =>
        {
            // None of this value model's own properties are callable. An own
            // toString shadows Object.prototype.toString; valueOf cannot then
            // produce a primitive. Presence matters, even for undefined.
            Err(EvalError {
                name: "TypeError".into(),
                message: "Cannot convert object to primitive value".into(),
            })
        }
        _ => Ok(Cow::Owned(js_string(value))),
    }
}

/// String(value ?? '') for argument families that use the nullish fallback.
pub(super) fn string_arg(value: &JsValue) -> Result<Cow<'_, JsString>, EvalError> {
    if value.is_nullish() {
        Ok(Cow::Owned(JsString::default()))
    } else {
        checked_string(value)
    }
}

fn array_string(value: &JsValue) -> Result<JsString, EvalError> {
    enum Part {
        Value(JsValue),
        Comma,
        End(usize),
    }
    let mut tasks = vec![Part::Value(value.clone())];
    let mut active = HashSet::new();
    let mut output = Vec::new();
    while let Some(part) = tasks.pop() {
        match part {
            Part::Comma => output.push(44),
            Part::End(identity) => {
                active.remove(&identity);
            }
            Part::Value(JsValue::Array(array)) => {
                let identity = Rc::as_ptr(&array) as usize;
                if !active.insert(identity) {
                    continue;
                }
                tasks.push(Part::End(identity));
                for (index, value) in array.borrow().iter().enumerate().rev() {
                    if !value.is_nullish() {
                        tasks.push(Part::Value(value.clone()));
                    }
                    if index > 0 {
                        tasks.push(Part::Comma);
                    }
                }
            }
            Part::Value(value) => {
                output.extend_from_slice(checked_string(&value)?.units());
            }
        }
    }
    Ok(JsString::from_units(output))
}
