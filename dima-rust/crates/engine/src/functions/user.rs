//! `user.functions.ts`: `user` (with the `ignore symbols|numbers` filters) and `touser`.
//! (`randomuser` reads the chatter list and the blacklist: it is a host function.)

use super::Failure;
use crate::context::Context;
use crate::value::CoercionError;
use crate::value::Value;
use dima_text::{is_js_whitespace, to_lower, trim};
use regex::Regex;
use std::sync::LazyLock;

static LETTER_MARK_OR_NUMBER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[\p{L}\p{M}\p{N}]$").ok());
static NUMBER: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"^\p{N}$").ok());
static LETTER_OR_NUMBER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]").ok());

fn matches(regex: &LazyLock<Option<Regex>>, text: &str) -> bool {
    regex.as_ref().is_some_and(|regex| regex.is_match(text))
}

/// `getUserName`: the chatter from the event, then the extra context, then the caller.
pub(crate) fn user_name(context: &Context) -> Result<String, CoercionError> {
    for (source, key) in [
        (&context.event_data, "chatter_user_name"),
        (&context.event_data, "chatter_user_login"),
        (&context.extra_context, "userName"),
        (&context.extra_context, "userLogin"),
    ] {
        if let Some(value) = source.get(key).filter(|value| value.js_truthy()) {
            return Ok(value.to_text()?.into_owned());
        }
    }
    if !context.user_display_name.is_empty() {
        return Ok(context.user_display_name.clone());
    }
    Ok(context.user_login.clone())
}

/// `flattenArgumentTokens`: every argument split on whitespace, lowercased.
pub(crate) fn argument_tokens(args: &[Value]) -> Result<Vec<String>, CoercionError> {
    let mut tokens = Vec::new();
    for arg in args {
        let text = arg.to_text_or_empty()?;
        for part in trim(&text).split(is_js_whitespace) {
            if !part.is_empty() {
                tokens.push(to_lower(part));
            }
        }
    }
    Ok(tokens)
}

/// `parseUserNameFilter`: `(remove symbols, remove numbers)` for `ignore symbols|numbers…`.
fn name_filter(args: &[Value]) -> Result<Option<(bool, bool)>, CoercionError> {
    let tokens = argument_tokens(args)?;
    let Some((first, rest)) = tokens.split_first() else {
        return Ok(None);
    };
    if first != "ignore" || rest.is_empty() {
        return Ok(None);
    }
    let mut plan = (false, false);
    for token in rest {
        match token.as_str() {
            "symbols" => plan.0 = true,
            "numbers" => plan.1 = true,
            _ => return Ok(None),
        }
    }
    Ok(Some(plan))
}

/// `$(user)`: the name first, then the filter, as the reference reads them.
pub(crate) fn user(args: &[Value], context: &Context) -> Result<String, CoercionError> {
    let name = user_name(context)?;
    let Some((symbols, numbers)) = name_filter(args)? else {
        return Ok(name);
    };
    let mut filtered = String::new();
    let mut buffer = [0u8; 4];
    for ch in name.chars() {
        let text = ch.encode_utf8(&mut buffer);
        if symbols && !matches(&LETTER_MARK_OR_NUMBER, text) {
            continue;
        }
        if numbers && matches(&NUMBER, text) {
            continue;
        }
        filtered.push(ch);
    }
    if !matches(&LETTER_OR_NUMBER, &filtered) {
        return Ok("viewer".into());
    }
    Ok(filtered)
}

/// `$(touser)`: the target with `$`, `%` and `*` escaped, else the chatter's name. Escaping
/// adds a byte per escaped character, counted before the result is built.
pub(crate) fn touser(args: &[Value], context: &Context, max: usize) -> Result<String, Failure> {
    let target = match args.first() {
        Some(arg) if arg.js_truthy() => Some(arg.clone()),
        _ => context
            .argument
            .as_ref()
            .filter(|argument| !argument.is_empty())
            .map(|argument| Value::text(argument.as_str())),
    };
    Ok(match target {
        Some(Value::Text(text)) => {
            let escapes = text
                .bytes()
                .filter(|b| matches!(b, b'$' | b'%' | b'*'))
                .count();
            let size = text
                .len()
                .checked_add(escapes)
                .filter(|size| *size <= max)
                .ok_or(Failure::TooLong)?;
            let mut out = String::with_capacity(size);
            for ch in text.chars() {
                if matches!(ch, '$' | '%' | '*') {
                    out.push('\\');
                }
                out.push(ch);
            }
            out
        }
        Some(other) => other.to_text()?.into_owned(),
        None => user_name(context)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(display: &str, event: Value) -> Context {
        Context {
            user_display_name: display.into(),
            user_login: "login".into(),
            event_data: event,
            ..Context::default()
        }
    }

    #[test]
    fn user_and_touser() {
        let ctx = context("Ca_ll3r😀", Value::Undefined);
        assert_eq!(user(&[], &ctx).unwrap(), "Ca_ll3r😀");
        assert_eq!(
            user(&[Value::text("ignore symbols")], &ctx).unwrap(),
            "Call3r"
        );
        assert_eq!(
            user(&[Value::text("ignore"), Value::text("numbers")], &ctx).unwrap(),
            "Ca_llr😀"
        );
        assert_eq!(
            user(&[Value::text("ignore symbols numbers")], &ctx).unwrap(),
            "Callr"
        );
        assert_eq!(
            user(&[Value::text("ignore other")], &ctx).unwrap(),
            "Ca_ll3r😀"
        );
        let digits = context("123", Value::Undefined);
        assert_eq!(
            user(&[Value::text("ignore numbers")], &digits).unwrap(),
            "viewer"
        );
        let event = context(
            "x",
            Value::object(vec![("chatter_user_name".into(), Value::text("Ev"))]),
        );
        assert_eq!(user(&[], &event).unwrap(), "Ev");
        assert_eq!(
            touser(&[Value::text("a$b%c*")], &ctx, 64).unwrap(),
            "a\\$b\\%c\\*"
        );
        assert_eq!(touser(&[Value::empty()], &ctx, 64).unwrap(), "Ca_ll3r😀");
        assert_eq!(touser(&[Value::Number(5.0)], &ctx, 64).unwrap(), "5");
        assert_eq!(
            touser(&[Value::text("$$$")], &ctx, 5),
            Err(Failure::TooLong)
        );
        assert_eq!(touser(&[Value::text("$$$")], &ctx, 6).unwrap(), "\\$\\$\\$");
    }
}
