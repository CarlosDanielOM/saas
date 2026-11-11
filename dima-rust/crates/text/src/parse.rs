//! Text to numbers, the way JavaScript reads them.

use crate::whitespace::{trim, trim_start};

/// `Number(text)` for a string: JavaScript whitespace trimmed, empty is 0, `0x`/`0o`/`0b`
/// integers (unsigned), decimals with optional sign and exponent, `Infinity`; anything else NaN.
pub fn parse_number(text: &str) -> f64 {
    let text = trim(text);
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return 0.0;
    }
    if let [b'0', prefix, digits @ ..] = bytes {
        let bits = match prefix {
            b'x' | b'X' => Some(4),
            b'o' | b'O' => Some(3),
            b'b' | b'B' => Some(1),
            _ => None,
        };
        if let Some(bits) = bits {
            let (value, used) = power_of_two_radix(digits, bits);
            return if used > 0 && used == digits.len() {
                value
            } else {
                f64::NAN
            };
        }
    }
    match text {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if decimal_prefix_len(bytes) == bytes.len() => text.parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// `parseInt(text, radix)`; `radix` 0 means "not given" (base 10, or 16 after `0x`).
///
/// Radix 10 and powers of two are correctly rounded; other radices reproduce V8's chunked
/// arithmetic, which JavaScript allows to be approximate above 2^53.
pub fn parse_int(text: &str, radix: u32) -> f64 {
    let bytes = trim_start(text).as_bytes();
    let (negative, mut digits) = match bytes {
        [b'-', rest @ ..] => (true, rest),
        [b'+', rest @ ..] => (false, rest),
        _ => (false, bytes),
    };
    let mut radix = radix;
    if radix == 0 || radix == 16 {
        if let [b'0', b'x' | b'X', rest @ ..] = digits {
            digits = rest;
            radix = 16;
        } else if radix == 0 {
            radix = 10;
        }
    }
    if !(2..=36).contains(&radix) {
        return f64::NAN;
    }
    let used = digits
        .iter()
        .take_while(|byte| digit_value(**byte) < radix)
        .count();
    let Some(digits) = digits.get(..used).filter(|digits| !digits.is_empty()) else {
        return f64::NAN;
    };
    let magnitude = match radix {
        10 => std::str::from_utf8(digits)
            .ok()
            .and_then(|digits| digits.parse().ok())
            .unwrap_or(f64::NAN),
        2 | 4 | 8 | 16 | 32 => power_of_two_radix(digits, radix.trailing_zeros()).0,
        _ => v8_generic_radix(digits, radix),
    };
    if negative { -magnitude } else { magnitude }
}

/// `parseFloat(text)`: the longest decimal (or `Infinity`) prefix after leading whitespace.
pub fn parse_float(text: &str) -> f64 {
    let text = trim_start(text);
    let bytes = text.as_bytes();
    let unsigned = bytes
        .strip_prefix(b"-")
        .or_else(|| bytes.strip_prefix(b"+"))
        .unwrap_or(bytes);
    if unsigned.starts_with(b"Infinity") {
        return if bytes.first() == Some(&b'-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    text.get(..decimal_prefix_len(bytes))
        .and_then(|prefix| prefix.parse().ok())
        .unwrap_or(f64::NAN)
}

/// Length of the longest prefix of the form `[+-]? (D+ (. D*)? | . D+) ([eE] [+-]? D+)?`, or 0.
fn decimal_prefix_len(bytes: &[u8]) -> usize {
    let digits_from = |start: usize| {
        bytes
            .iter()
            .skip(start)
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let int = digits_from(end);
    end += int;
    let mut frac = 0;
    if bytes.get(end) == Some(&b'.') {
        frac = digits_from(end + 1);
        if int > 0 || frac > 0 {
            end += 1 + frac;
        }
    }
    if int == 0 && frac == 0 {
        return 0;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits_from(end + 1 + sign);
        if exponent > 0 {
            end += 1 + sign + exponent;
        }
    }
    end
}

/// Value of an ASCII digit or letter in radix 36; 99 for anything else.
fn digit_value(byte: u8) -> u32 {
    match byte {
        b'0'..=b'9' => u32::from(byte - b'0'),
        b'a'..=b'z' => u32::from(byte - b'a') + 10,
        b'A'..=b'Z' => u32::from(byte - b'A') + 10,
        _ => 99,
    }
}

/// The longest prefix of `digits` in radix 2^`bits`, correctly rounded (ties to even), and the
/// number of digits it used.
fn power_of_two_radix(digits: &[u8], bits: u32) -> (f64, usize) {
    let radix = 1 << bits;
    // The first 54 significant bits (53 kept plus the rounding bit), then a count and a sticky
    // flag for the rest.
    let mut significand: u64 = 0;
    let mut stored = 0u32;
    let mut dropped = 0u64;
    let mut sticky = false;
    let mut used = 0;
    for byte in digits {
        let digit = digit_value(*byte);
        if digit >= radix {
            break;
        }
        used += 1;
        for shift in (0..bits).rev() {
            let bit = (digit >> shift) & 1;
            if stored == 0 && bit == 0 {
                continue;
            }
            if stored < 54 {
                significand = (significand << 1) | u64::from(bit);
                stored += 1;
            } else {
                dropped += 1;
                sticky |= bit == 1;
            }
        }
    }
    if stored <= 53 {
        return (significand as f64, used);
    }
    let round = significand & 1 == 1;
    let mut kept = significand >> 1;
    if round && (sticky || kept & 1 == 1) {
        kept += 1;
    }
    let exponent = dropped + 1;
    let value = if exponent > 1023 {
        f64::INFINITY
    } else {
        kept as f64 * f64::from_bits((exponent + 1023) << 52)
    };
    (value, used)
}

/// V8's `parseInt` for radices other than 2, 4, 8, 10, 16 and 32: digits are gathered in
/// 32-bit chunks and folded into a double, rounding at every chunk.
fn v8_generic_radix(digits: &[u8], radix: u32) -> f64 {
    const MAX_MULTIPLIER: u32 = u32::MAX / 36;
    let mut result = 0.0;
    let mut part = 0;
    let mut multiplier = 1;
    for byte in digits {
        let digit = digit_value(*byte);
        let next = multiplier * radix;
        if next > MAX_MULTIPLIER {
            result = result * f64::from(multiplier) + f64::from(part);
            part = digit;
            multiplier = radix;
        } else {
            part = part * radix + digit;
            multiplier = next;
        }
    }
    result * f64::from(multiplier) + f64::from(part)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from the evaluator's `json_order_rounding_and_deep_values`.
    #[test]
    fn octal_literals_round_to_nearest() {
        assert_eq!(
            parse_number("0o1706467650045030172466317145567324"),
            1.1966040324345679e30
        );
    }

    #[test]
    fn number_coercion_follows_the_string_grammar() {
        assert_eq!(parse_number(" \u{feff}12\u{a0}"), 12.0);
        assert_eq!(parse_number(""), 0.0);
        assert!(parse_number("\u{85}12").is_nan());
        assert!(parse_number("-0x10").is_nan());
        assert!(parse_number("inf").is_nan());
        assert!(parse_number("1_000").is_nan());
        assert_eq!(parse_number("0x20000000000003"), 9007199254740996.0);
        assert_eq!(parse_number(".5"), 0.5);
        assert_eq!(parse_number("5."), 5.0);
        assert!(parse_number(".").is_nan());
        assert!(parse_number("-0").is_sign_negative());
    }

    #[test]
    fn parse_int_handles_prefixes_and_radices() {
        assert_eq!(parse_int("  -0x1F", 0), -31.0);
        assert_eq!(parse_int("0x1F", 10), 0.0);
        assert_eq!(parse_int("0x1F", 16), 31.0);
        assert_eq!(parse_int("12.9px", 0), 12.0);
        assert_eq!(parse_int("zz", 36), 1295.0);
        assert!(parse_int("11", 37).is_nan());
        assert!(parse_int("11", 1).is_nan());
        assert!(parse_int("-0", 0).is_sign_negative());
        assert!(parse_int("0x", 0).is_nan());
    }

    #[test]
    fn parse_float_takes_the_longest_decimal_prefix() {
        assert_eq!(parse_float("-.5e-3abc"), -0.0005);
        assert_eq!(parse_float("1e"), 1.0);
        assert_eq!(parse_float("Infinityx"), f64::INFINITY);
        assert_eq!(parse_float("0x10"), 0.0);
        assert!(parse_float(".e5").is_nan());
        assert!(parse_float("-").is_nan());
    }
}
