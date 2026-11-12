//! Numbers to text, the way JavaScript writes them.

use serde_json::Value;

/// `Number.prototype.toString()`, which is also `String(x)` and `${x}`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let Decimal { digits, point } = Decimal::shortest(x);
    let count = digits.len() as i32;
    let mut out = String::with_capacity(digits.len() + 8);
    if x < 0.0 {
        out.push('-');
    }
    if count <= point && point <= 21 {
        push_digits(&mut out, &digits);
        push_zeros(&mut out, point - count);
    } else if 0 < point && point <= 21 {
        let (int, frac) = digits.split_at(point as usize);
        push_digits(&mut out, int);
        out.push('.');
        push_digits(&mut out, frac);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        push_zeros(&mut out, -point);
        push_digits(&mut out, &digits);
    } else {
        let (first, rest) = digits.split_at(1);
        push_digits(&mut out, first);
        if !rest.is_empty() {
            out.push('.');
            push_digits(&mut out, rest);
        }
        let exponent = point - 1;
        out.push('e');
        out.push(if exponent < 0 { '-' } else { '+' });
        out.push_str(&exponent.unsigned_abs().to_string());
    }
    out
}

/// `x.toFixed(digits)`: exact decimal rounding, ties away from zero, `toString` from 1e21 up.
///
/// `digits` above 100 is treated as 100 (JavaScript throws a `RangeError`).
pub fn to_fixed(x: f64, digits: u8) -> String {
    let digits = usize::from(digits.min(100));
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    // Enough places to print |x| exactly, so the first dropped digit decides the rounding:
    // JavaScript picks the larger candidate on a tie.
    let exact = format!("{:.*}", fraction_digits(x).max(digits + 1), x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut kept: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).collect();
    if frac
        .as_bytes()
        .get(digits)
        .is_some_and(|digit| *digit >= b'5')
    {
        increment(&mut kept);
    }
    let (int, frac) = kept.split_at(kept.len() - digits);
    let mut out = String::with_capacity(kept.len() + 2);
    // `x < 0`, not the sign bit: (-0).toFixed(2) is "0.00" but (-0.0001).toFixed(2) is "-0.00".
    if x < 0.0 {
        out.push('-');
    }
    push_digits(&mut out, int);
    if digits > 0 {
        out.push('.');
        push_digits(&mut out, frac);
    }
    out
}

/// The locales the TypeScript formats numbers for (`Intl.NumberFormat`, `toLocaleString`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NumberLocale {
    /// `en-US`, same output as `en`: `1,234.568`.
    EnUs,
    /// `es-ES`, same output as `es`: `1234,568` and `12.345` (no grouping below five digits).
    EsEs,
}

/// `new Intl.NumberFormat(locale).format(x)` with default options, also `x.toLocaleString(locale)`.
///
/// At most three fraction digits, rounded half away from zero on the shortest decimal form of
/// `x`; grouped integer digits; `NaN`, `∞`, `-∞` and `-0` written as Node writes them.
pub fn to_locale_string(x: f64, locale: NumberLocale) -> String {
    let (group, point, min_grouped) = match locale {
        NumberLocale::EnUs => (',', '.', 4),
        NumberLocale::EsEs => ('.', ',', 5),
    };
    if x.is_nan() {
        return "NaN".into();
    }
    let mut out = String::new();
    if x.is_sign_negative() {
        out.push('-');
    }
    if x.is_infinite() {
        out.push('∞');
        return out;
    }
    // round(|x| * 1000), at least four digits so the integer part is never empty.
    let mut scaled = if x == 0.0 { Vec::new() } else { thousandths(x) };
    while scaled.len() < 4 {
        scaled.insert(0, b'0');
    }
    let (int, frac) = scaled.split_at(scaled.len() - 3);
    let frac_len = frac
        .iter()
        .rposition(|digit| *digit != b'0')
        .map_or(0, |last| last + 1);
    for (index, digit) in int.iter().enumerate() {
        if index > 0 && int.len() >= min_grouped && (int.len() - index) % 3 == 0 {
            out.push(group);
        }
        out.push(char::from(*digit));
    }
    if frac_len > 0 {
        out.push(point);
        push_digits(&mut out, frac.get(..frac_len).unwrap_or_default());
    }
    out
}

/// `Math.round(x)`: ties toward +∞, and -0 for -0.5 ≤ x < 0.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    let floor = x.floor();
    // Exact: for |x| < 2^52 the fraction is representable; above, x is already whole.
    if x - floor < 0.5 { floor } else { floor + 1.0 }
}

/// `String(value)` for a JSON value: [`crate::js_string`].
///
/// Arrays are comma-joined with `null` items as empty text (nested arrays likewise), objects are
/// `[object Object]`, numbers use [`number_to_string`].
pub fn string_of(value: &Value) -> String {
    crate::view::js_string(value)
}

/// A positive decimal: `0.d1d2… × 10^point`, digits as ASCII without trailing zeros.
pub(crate) struct Decimal {
    pub(crate) digits: Vec<u8>,
    pub(crate) point: i32,
}

impl Decimal {
    /// The shortest digits that read back as `x` (sign ignored; `x` finite and nonzero), the
    /// digits JavaScript prints.
    pub(crate) fn shortest(x: f64) -> Self {
        let text = format!("{:e}", x.abs());
        let (mantissa, exponent) = text.split_once('e').unwrap_or((text.as_str(), "0"));
        let mut decimal = Self {
            digits: mantissa.bytes().filter(u8::is_ascii_digit).collect(),
            point: exponent.parse::<i32>().unwrap_or(0) + 1,
        };
        decimal.break_tie_to_even(x.abs());
        decimal
    }

    /// When `x` lies exactly halfway between two shortest candidates, Rust picks the upper one and
    /// ECMAScript (V8, ICU) the one with the even last digit: step down when they differ.
    fn break_tie_to_even(&mut self, x: f64) {
        let Some(last) = self
            .digits
            .last()
            .copied()
            .filter(|digit| (digit - b'0') % 2 == 1)
        else {
            return;
        };
        if !self.is_exactly_halfway_below(x) {
            return;
        }
        let mut lower = self.digits.clone();
        if let Some(digit) = lower.last_mut() {
            *digit = last - 1;
        }
        while lower.last() == Some(&b'0') {
            lower.pop();
        }
        // Near a power of two the rounding interval is narrower below: keep the lower candidate
        // only if it still reads back as `x`.
        let text: String = lower.iter().map(|digit| char::from(*digit)).collect();
        if format!("0.{text}e{}", self.point).parse::<f64>().ok() == Some(x) {
            self.digits = lower;
        }
    }

    /// Whether `x` (positive, finite) equals the digits with the last one lowered by a half.
    fn is_exactly_halfway_below(&self, x: f64) -> bool {
        let Some(upper) = self.digits.iter().try_fold(0u128, |value, digit| {
            value.checked_mul(10)?.checked_add(u128::from(digit - b'0'))
        }) else {
            return false;
        };
        // The midpoint (upper - 0.5) scaled to an integer of one more digit.
        let midpoint = (upper - 1) * 10 + 5;
        let scale = self.digits.len() as i32 + 1 - self.point;
        // x * 10^scale = mantissa * 5^scale * 2^(exponent + scale) must equal the midpoint. A
        // negative scale means a large integer, which is never halfway (it is even).
        let (mantissa, exponent) = binary_parts(x);
        let Ok(scale) = u32::try_from(scale) else {
            return false;
        };
        let Some(value) = 5u128
            .checked_pow(scale)
            .and_then(|five| five.checked_mul(u128::from(mantissa)))
        else {
            return false;
        };
        let shift = exponent + scale as i32;
        let scaled = if shift >= 0 {
            let shift = shift as u32;
            if shift >= value.leading_zeros() {
                return false;
            }
            value << shift
        } else {
            let shift = shift.unsigned_abs();
            if shift >= 128 || value & ((1u128 << shift) - 1) != 0 {
                return false;
            }
            value >> shift
        };
        scaled == midpoint
    }
}

/// `x = mantissa × 2^exponent` exactly (sign ignored).
fn binary_parts(x: f64) -> (u64, i32) {
    let bits = x.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1 << 52) - 1);
    if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1 << 52), biased - 1075)
    }
}

/// Digits of round(|x| × 1000) with ties away from zero, applied to the shortest digits of `x`.
fn thousandths(x: f64) -> Vec<u8> {
    let Decimal { mut digits, point } = Decimal::shortest(x);
    let Ok(keep) = usize::try_from(point + 3) else {
        return Vec::new();
    };
    if keep >= digits.len() {
        digits.resize(keep, b'0');
        return digits;
    }
    let round_up = digits.get(keep).is_some_and(|digit| *digit >= b'5');
    digits.truncate(keep);
    if round_up {
        increment(&mut digits);
    }
    digits
}

/// Number of fraction digits in the exact decimal expansion of `x`.
fn fraction_digits(x: f64) -> usize {
    let (mantissa, exponent) = binary_parts(x);
    if mantissa == 0 {
        return 0;
    }
    usize::try_from(-(exponent + mantissa.trailing_zeros() as i32)).unwrap_or(0)
}

/// Adds one to an ASCII digit string, growing it on carry.
pub(crate) fn increment(digits: &mut Vec<u8>) {
    for digit in digits.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return;
        }
    }
    digits.insert(0, b'1');
}

fn push_digits(out: &mut String, digits: &[u8]) {
    out.extend(digits.iter().map(|digit| char::from(*digit)));
}

fn push_zeros(out: &mut String, count: i32) {
    for _ in 0..count {
        out.push('0');
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from the evaluator's `number_string` assertions.
    #[test]
    fn exponent_boundaries_match_javascript() {
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(123e-20), "1.23e-18");
        assert_eq!(number_to_string(1e20), "100000000000000000000");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(-1.5), "-1.5");
    }

    #[test]
    fn halfway_shortest_digits_take_the_even_candidate() {
        // 1e15 + 0.3 is exactly 1000000000000000.25: .2 and .3 are equally close.
        assert_eq!(number_to_string(1e15 + 0.3), "1000000000000000.2");
        assert_eq!(number_to_string(2f64.powi(50) + 0.75), "1125899906842624.8");
        assert_eq!(
            to_locale_string(1e15 + 0.3, NumberLocale::EnUs),
            "1,000,000,000,000,000.2"
        );
        assert_eq!(number_to_string(2f64.powi(-25)), "2.9802322387695312e-8");
    }

    #[test]
    fn fixed_rounding_uses_the_exact_binary_value() {
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(-0.0001, 2), "-0.00");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(9.995, 2), "9.99");
        assert_eq!(to_fixed(99.5, 0), "100");
        assert_eq!(to_fixed(1e21, 2), "1e+21");
        assert_eq!(to_fixed(f64::NAN, 2), "NaN");
        assert_eq!(to_fixed(0.5, 200), to_fixed(0.5, 100));
    }

    #[test]
    fn locale_numbers_group_and_round_like_intl() {
        assert_eq!(
            to_locale_string(1_000_000.0, NumberLocale::EnUs),
            "1,000,000"
        );
        assert_eq!(to_locale_string(1000.0, NumberLocale::EsEs), "1000");
        assert_eq!(to_locale_string(12345.0, NumberLocale::EsEs), "12.345");
        assert_eq!(to_locale_string(1.0005, NumberLocale::EnUs), "1.001");
        assert_eq!(to_locale_string(-0.0001, NumberLocale::EsEs), "-0");
        assert_eq!(
            to_locale_string(f64::NEG_INFINITY, NumberLocale::EnUs),
            "-∞"
        );
    }

    #[test]
    fn rounding_ties_go_toward_positive_infinity() {
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(math_round(-2.5), -2.0);
        assert!(math_round(-0.5).is_sign_negative());
        assert_eq!(math_round(0.49999999999999994), 0.0);
    }

    // Ported from the evaluator's `typed_values_and_utf16` string assertions.
    #[test]
    fn string_of_joins_arrays_like_javascript() {
        assert_eq!(string_of(&json!(-0.0)), "0");
        assert_eq!(string_of(&json!([null, null, false])), ",,false");
        assert_eq!(
            string_of(&json!([[1, [2, null]], {}, "x"])),
            "1,2,,[object Object],x"
        );
        assert_eq!(string_of(&json!(null)), "null");
        assert_eq!(string_of(&json!(1.0)), "1");
    }
}
