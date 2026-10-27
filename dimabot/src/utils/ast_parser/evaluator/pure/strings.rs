use super::{
    EvalError, JsString, JsValue, PureFunction, casing, number_string, parse_int, string_arg,
};
use std::borrow::Cow;

pub(super) fn apply(function: PureFunction, args: &[JsValue]) -> Result<JsString, EvalError> {
    use PureFunction::*;
    Ok(match function {
        Length => {
            let mut length = args.len().saturating_sub(1);
            for arg in args {
                length += string_arg(arg)?.len();
            }
            number_string(length as f64).into()
        }
        Slice => slice(args)?,
        Replace => {
            let search = args
                .first()
                .map(string_arg)
                .transpose()?
                .unwrap_or_default();
            let replacement = args.get(1).map(string_arg).transpose()?.unwrap_or_default();
            let text = joined(args.get(2..).unwrap_or_default())?;
            replace(&text, &search, &replacement)
        }
        _ => {
            let text = joined(args)?;
            match function {
                Upper => casing::upper(&text),
                Lower => casing::lower(&text),
                Title => casing::title(&text),
                Capitalize => casing::capitalize(&text),
                Trim => text.trim(),
                _ => unreachable!("string family dispatch"),
            }
        }
    })
}

fn joined(args: &[JsValue]) -> Result<JsString, EvalError> {
    let mut output = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if index != 0 {
            output.push(32);
        }
        output.extend_from_slice(string_arg(arg)?.units());
    }
    Ok(JsString::from_units(output))
}
fn numeric(text: &JsString) -> bool {
    let units = text.units();
    let digits = if units.first() == Some(&45) {
        &units[1..]
    } else {
        units
    };
    !digits.is_empty() && digits.iter().all(|unit| (48..=57).contains(unit))
}

struct SliceArgs<'a> {
    values: &'a [JsValue],
    text: Vec<Cow<'a, JsString>>,
}
impl SliceArgs<'_> {
    fn get(&mut self, index: usize) -> Result<Option<&JsString>, EvalError> {
        while self.text.len() <= index && self.text.len() < self.values.len() {
            self.text.push(string_arg(&self.values[self.text.len()])?);
        }
        Ok(self.text.get(index).map(Cow::as_ref))
    }
    fn finish(&mut self) -> Result<(), EvalError> {
        if let Some(last) = self.values.len().checked_sub(1) {
            self.get(last)?;
        }
        Ok(())
    }
}
fn take_number(
    parts: &mut SliceArgs<'_>,
    index: usize,
) -> Result<(Option<JsString>, usize), EvalError> {
    let Some(part) = parts.get(index)? else {
        return Ok((None, index));
    };
    let token = part.trim();
    if token.units() == [45]
        && let Some(next) = parts.get(index + 1)?
    {
        let next = next.trim();
        if numeric(&next) {
            let mut raw = vec![45];
            raw.extend_from_slice(next.units());
            return Ok((Some(JsString::from_units(raw)), index + 2));
        }
    }
    if numeric(&token) {
        Ok((Some(token), index + 1))
    } else {
        Ok((None, index))
    }
}
fn resolve_index(raw: &JsString, length: usize, fallback: usize) -> usize {
    let index = parse_int(raw);
    if !index.is_finite() {
        return fallback;
    }
    let index = if index < 0.0 {
        length as f64 + index
    } else {
        index
    };
    index.max(0.0).min(length as f64) as usize
}
fn slice(args: &[JsValue]) -> Result<JsString, EvalError> {
    // Lazily memoize coercions: invalid start must leave the unused tail alone.
    // After both index probes, coerce the remaining text before resolving bounds.
    let mut parts = SliceArgs {
        values: args,
        text: Vec::new(),
    };
    let (start, next) = take_number(&mut parts, 0)?;
    let Some(start) = start else {
        return Ok(JsString::default());
    };
    let (end, next) = take_number(&mut parts, next)?;
    parts.finish()?;
    let parts = &parts.text[next..];
    let length = parts.iter().map(|part| part.len()).sum::<usize>() + parts.len().saturating_sub(1);
    let start = resolve_index(&start, length, 0);
    let end = end
        .as_ref()
        .map_or(length, |end| resolve_index(end, length, length));
    if end <= start {
        return Ok(JsString::default());
    }
    let mut output = Vec::with_capacity(end - start);
    let mut offset = 0;
    for (index, part) in parts.iter().enumerate() {
        if index != 0 {
            if offset >= start && offset < end {
                output.push(32);
            }
            offset += 1;
        }
        let from = start.saturating_sub(offset).min(part.len());
        let to = end.saturating_sub(offset).min(part.len());
        if from < to {
            output.extend_from_slice(&part.units()[from..to]);
        }
        offset += part.len();
        if offset >= end {
            break;
        }
    }
    Ok(JsString::from_units(output))
}

fn replace(text: &JsString, search: &JsString, replacement: &JsString) -> JsString {
    if search.is_empty() || text.is_empty() {
        return text.clone();
    }
    let pattern = search.units();
    // KMP avoids quadratic repeated-prefix comparisons. Reset after a match
    // gives split/join's non-overlapping semantics; replacement is never scanned.
    let mut prefix = vec![0; pattern.len()];
    let mut matched = 0;
    for index in 1..pattern.len() {
        while matched > 0 && pattern[index] != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if pattern[index] == pattern[matched] {
            matched += 1;
        }
        prefix[index] = matched;
    }
    let mut output = Vec::with_capacity(text.len());
    let mut copied = 0;
    matched = 0;
    for (index, &unit) in text.units().iter().enumerate() {
        while matched > 0 && unit != pattern[matched] {
            matched = prefix[matched - 1];
        }
        if unit == pattern[matched] {
            matched += 1;
        }
        if matched == pattern.len() {
            output.extend_from_slice(&text.units()[copied..index + 1 - pattern.len()]);
            output.extend_from_slice(replacement.units());
            copied = index + 1;
            matched = 0;
        }
    }
    output.extend_from_slice(&text.units()[copied..]);
    JsString::from_units(output)
}
