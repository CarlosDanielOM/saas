//! The language's own conversions (`evaluator.ts`): arithmetic, comparisons, truthiness, list
//! positions and loop counter assignments. All visible in chat, all kept exactly, except the
//! one ordering rule noted on [`compare`].

use crate::functions::Failure;
use crate::syntax::{BinaryOp, LoopAssignOp};
use crate::value::{CoercionError, Value};
use dima_text::{
    Radix, math_round, number_to_string, parse_float, parse_int, parse_number, to_lower, trim,
};

/// `toNumberSafe`: a finite number as is; otherwise the text's leading decimal number
/// (`parseFloat`), with empty text, `null`, `undefined`, NaN and the infinities all 0.
pub(crate) fn to_number_safe(value: &Value) -> Result<f64, CoercionError> {
    if let Value::Number(number) = value
        && number.is_finite()
    {
        return Ok(*number);
    }
    let text = value.to_text_or_empty()?;
    let text = trim(&text);
    if text.is_empty() || text == "null" || text == "undefined" {
        return Ok(0.0);
    }
    let number = parse_float(text);
    Ok(if number.is_finite() { number } else { 0.0 })
}

/// `isTruthy`: the language's conditions. `true`/`1` are true; `false`, `0`, `null` and
/// `undefined` are false; any other value is false when its text, lowercased and trimmed, is
/// `false`, `0` or empty.
pub(crate) fn is_truthy(value: &Value) -> Result<bool, CoercionError> {
    match value {
        Value::Bool(flag) => return Ok(*flag),
        Value::Number(number) if *number == 1.0 => return Ok(true),
        Value::Number(number) if *number == 0.0 => return Ok(false),
        Value::Null | Value::Undefined => return Ok(false),
        _ => {}
    }
    let text = to_lower(&value.to_text()?);
    Ok(!matches!(trim(&text), "false" | "0" | ""))
}

/// `resolveArrayIndex`: a number is truncated, anything else read with `parseInt(…, 10)`;
/// negative counts from the end. `None` when invalid or out of range.
pub(crate) fn resolve_array_index(
    value: &Value,
    length: usize,
) -> Result<Option<usize>, CoercionError> {
    let index = match value {
        Value::Number(number) => number.trunc(),
        other => parse_int(trim(&other.to_text()?), Radix::Decimal),
    };
    if !index.is_finite() {
        return Ok(None);
    }
    let length = length as f64;
    let index = if index < 0.0 { length + index } else { index };
    Ok((index >= 0.0 && index < length).then_some(index as usize))
}

/// `/^-?\d+(\.\d+)?$/` (ASCII digits).
fn plain_decimal(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    let all_digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    all_digits(whole) && fraction.is_none_or(all_digits)
}

/// `safeCompare`: both sides trimmed; two plain decimals compare as numbers, anything else as
/// text (equality ignoring case, `~=` a case-insensitive substring test).
///
/// Intended difference: `<`, `>`, `<=` and `>=` on text order by code point (Rust's `str`
/// order) where JavaScript orders by UTF-16 unit. They differ only when, at the first
/// difference, one side has a character above U+FFFF and the other one in U+E000 to U+FFFF.
pub(crate) fn compare(left: &str, operator: BinaryOp, right: &str) -> bool {
    let left = trim(left);
    let right = trim(right);
    let numbers = (plain_decimal(left) && plain_decimal(right))
        .then(|| (parse_number(left), parse_number(right)));
    match (operator, numbers) {
        (BinaryOp::Equal | BinaryOp::Assign, Some((l, r))) => l == r,
        (BinaryOp::Equal | BinaryOp::Assign, None) => to_lower(left) == to_lower(right),
        (BinaryOp::NotEqual | BinaryOp::AlternateNotEqual, Some((l, r))) => l != r,
        (BinaryOp::NotEqual | BinaryOp::AlternateNotEqual, None) => {
            to_lower(left) != to_lower(right)
        }
        (BinaryOp::Greater, Some((l, r))) => l > r,
        (BinaryOp::Greater, None) => left > right,
        (BinaryOp::Less, Some((l, r))) => l < r,
        (BinaryOp::Less, None) => left < right,
        (BinaryOp::GreaterEqual, Some((l, r))) => l >= r,
        (BinaryOp::GreaterEqual, None) => left >= right,
        (BinaryOp::LessEqual, Some((l, r))) => l <= r,
        (BinaryOp::LessEqual, None) => left <= right,
        (BinaryOp::Match, _) => to_lower(left).contains(&to_lower(right)),
        _ => false,
    }
}

/// `+ - * / %` on `toNumberSafe` operands; division and remainder by zero give 0; a
/// fractional result is rounded to six decimals (`Math.round(x * 1e6) / 1e6`).
pub(crate) fn arithmetic(operator: BinaryOp, left: f64, right: f64) -> String {
    let result = match operator {
        BinaryOp::Add => left + right,
        BinaryOp::Subtract => left - right,
        BinaryOp::Multiply => left * right,
        BinaryOp::Divide if right == 0.0 => 0.0,
        BinaryOp::Divide => left / right,
        BinaryOp::Modulo if right == 0.0 => 0.0,
        BinaryOp::Modulo => left % right,
        _ => 0.0,
    };
    let is_integer = result.is_finite() && result.trunc() == result;
    let result = if is_integer {
        result
    } else {
        math_round(result * 1_000_000.0) / 1_000_000.0
    };
    number_to_string(result)
}

/// `applyLoopAssignment`: `#i++`, `#i += 2`, `#i = …`. A `+=` that joins text longer than
/// `max` bytes is refused before the text is built.
pub(crate) fn loop_assignment(
    current: Option<&str>,
    operator: LoopAssignOp,
    value: &Value,
    max: usize,
) -> Result<String, Failure> {
    let current_value = || Value::text(current.unwrap_or_default());
    match operator {
        LoopAssignOp::Increment => {
            return Ok(number_to_string(to_number_safe(&current_value())? + 1.0));
        }
        LoopAssignOp::Decrement => {
            return Ok(number_to_string(to_number_safe(&current_value())? - 1.0));
        }
        _ => {}
    }
    let next = value.to_text_or_empty()?;
    Ok(match operator {
        LoopAssignOp::Assign => next.into_owned(),
        LoopAssignOp::Add => {
            let current = current.unwrap_or_default();
            let left = parse_number(trim(current));
            let right = parse_number(trim(&next));
            if left.is_finite() && right.is_finite() {
                number_to_string(left + right)
            } else {
                let size = current
                    .len()
                    .checked_add(next.len())
                    .filter(|size| *size <= max)
                    .ok_or(Failure::TooLong)?;
                let mut joined = String::with_capacity(size);
                joined.push_str(current);
                joined.push_str(&next);
                joined
            }
        }
        _ => {
            let left = to_number_safe(&current_value())?;
            let right = to_number_safe(&Value::text(next.as_ref()))?;
            number_to_string(match operator {
                LoopAssignOp::Subtract => left - right,
                LoopAssignOp::Multiply => left * right,
                LoopAssignOp::Divide if right == 0.0 => 0.0,
                LoopAssignOp::Divide => left / right,
                LoopAssignOp::Modulo if right == 0.0 => 0.0,
                LoopAssignOp::Modulo => left % right,
                _ => return Ok(next.into_owned()),
            })
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_match_the_reference() {
        assert_eq!(to_number_safe(&Value::text(" 5abc ")), Ok(5.0));
        assert_eq!(to_number_safe(&Value::text("Infinity")), Ok(0.0));
        assert_eq!(to_number_safe(&Value::Null), Ok(0.0));
        assert_eq!(is_truthy(&Value::text(" TRUE ")), Ok(true));
        assert_eq!(is_truthy(&Value::text(" FALSE ")), Ok(false));
        assert_eq!(is_truthy(&Value::text("0")), Ok(false));
        assert_eq!(is_truthy(&Value::text("00")), Ok(true));
        assert_eq!(is_truthy(&Value::Number(f64::NAN)), Ok(true));
        assert_eq!(resolve_array_index(&Value::text("-1"), 3), Ok(Some(2)));
        assert_eq!(resolve_array_index(&Value::text("1.9"), 3), Ok(Some(1)));
        assert_eq!(resolve_array_index(&Value::text("0x1"), 3), Ok(Some(0)));
        assert_eq!(resolve_array_index(&Value::text("nope"), 3), Ok(None));
        let shadowed = Value::object(vec![("toString".into(), Value::text("x"))]);
        assert_eq!(to_number_safe(&shadowed), Err(CoercionError));
        assert_eq!(is_truthy(&shadowed), Err(CoercionError));
        assert_eq!(resolve_array_index(&shadowed, 3), Err(CoercionError));
        assert!(compare("01", BinaryOp::Equal, "1"));
        assert!(!compare("5abc", BinaryOp::Equal, "5"));
        assert!(compare("ABC", BinaryOp::Equal, "abc"));
        assert!(compare("Hello", BinaryOp::Match, "ELL"));
        assert!(compare("b", BinaryOp::Greater, "a"));
        assert_eq!(arithmetic(BinaryOp::Divide, 1.0, 3.0), "0.333333");
        assert_eq!(arithmetic(BinaryOp::Divide, 1.0, 0.0), "0");
        assert_eq!(arithmetic(BinaryOp::Add, 1.5, 2.25), "3.75");
        let assign =
            |current, op, value: &str| loop_assignment(current, op, &Value::text(value), 8);
        assert_eq!(assign(Some("2"), LoopAssignOp::Add, "3").unwrap(), "5");
        assert_eq!(assign(Some("a"), LoopAssignOp::Add, "3").unwrap(), "a3");
        assert_eq!(assign(None, LoopAssignOp::Increment, "").unwrap(), "1");
        assert!(assign(Some("abcde"), LoopAssignOp::Add, "fghij").is_err());
    }
}
