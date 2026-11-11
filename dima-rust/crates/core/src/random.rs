//! Randomness, injectable for tests, with the output shapes of every generator the reference uses.
//!
//! [`Random`] has one required method, [`Random::fill`]; every generator is built on it, so the
//! seeded implementation ([`SeededRandom`]) makes all of them deterministic. [`SystemRandom`]
//! reads the operating system's generator (`getrandom`), as Node's `crypto.randomBytes` does.
//!
//! | Reference | Method |
//! |---|---|
//! | `crypto.randomUUID()` | [`Random::uuid_v4`] |
//! | `generateUUIDv7()` in `utils/ai/openrouter/ai.ts` (not RFC 9562: no variant bits) | [`Random::uuid_v7_reference`] |
//! | `randomBytes(n).toString('hex')` | [`Random::hex_token`] |
//! | `randomBytes(n).toString('base64url')` | [`Random::base64url_token`] |
//! | `Math.random()` | [`Random::float`] |
//! | `Math.random().toString(36).substring(a, b)` (log ids, upload names) | [`Random::math_random_base36`] |
//! | `crypto.randomInt(min, max)` | [`Random::int`] |
//! | `randomTicket(total)` in `roulette/model.ts` | [`Random::ticket`] |
//! | a token over a custom alphabet | [`Random::alphabet_token`] |

use crate::crypto::encoding::{encode_base64url, encode_hex};
use std::fmt;
use std::sync::Mutex;

/// Why random output could not be produced.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RandomError {
    /// The operating system's generator failed.
    #[error("random number generator unavailable")]
    Unavailable,
    /// The requested range is empty or too large.
    #[error("invalid random range: {0}")]
    InvalidRange(&'static str),
}

/// A source of random bytes, plus every generator the reference uses, built on it.
pub trait Random: Send + Sync + fmt::Debug {
    /// Fills `buf` with random bytes (`crypto.randomFillSync`).
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError>;

    /// `crypto.randomBytes(n)`.
    fn bytes(&self, n: usize) -> Result<Vec<u8>, RandomError> {
        let mut out = vec![0; n];
        self.fill(&mut out)?;
        Ok(out)
    }

    /// `crypto.randomUUID()`: lowercase, hyphenated, version 4, RFC 4122 variant.
    fn uuid_v4(&self) -> Result<String, RandomError> {
        let mut b = [0_u8; 16];
        self.fill(&mut b)?;
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        let hex = encode_hex(&b);
        Ok(format!(
            "{}-{}-{}-{}-{}",
            hex.get(0..8).unwrap_or_default(),
            hex.get(8..12).unwrap_or_default(),
            hex.get(12..16).unwrap_or_default(),
            hex.get(16..20).unwrap_or_default(),
            hex.get(20..32).unwrap_or_default()
        ))
    }

    /// The reference's hand-rolled "UUIDv7" for AI request tracing: `Date.now()` as 12 hex digits,
    /// then `7`, then 3 + 4 hex digits from 5 random bytes and 12 from 6 more. The variant bits
    /// are not set, exactly as in the reference.
    fn uuid_v7_reference(&self, now_ms: i64) -> Result<String, RandomError> {
        let digits = if now_ms < 0 {
            format!("-{:x}", now_ms.unsigned_abs())
        } else {
            format!("{now_ms:x}")
        };
        let time = format!("{digits:0>12}");
        let first = encode_hex(&self.bytes(5)?);
        let second = encode_hex(&self.bytes(6)?);
        Ok(format!(
            "{}-{}-7{}-{}-{}",
            time.get(0..8).unwrap_or_default(),
            time.get(8..12).unwrap_or_default(),
            first.get(0..3).unwrap_or_default(),
            first.get(3..7).unwrap_or_default(),
            second
        ))
    }

    /// `randomBytes(n).toString('hex')`: `2n` lowercase hex digits.
    fn hex_token(&self, n: usize) -> Result<String, RandomError> {
        Ok(encode_hex(&self.bytes(n)?))
    }

    /// `randomBytes(n).toString('base64url')`: unpadded (43 characters for 32 bytes).
    fn base64url_token(&self, n: usize) -> Result<String, RandomError> {
        Ok(encode_base64url(&self.bytes(n)?))
    }

    /// `Math.random()`: V8 draws 52 random bits, so the value is `k / 2^52` in `[0, 1)`.
    fn float(&self) -> Result<f64, RandomError> {
        let mut b = [0_u8; 8];
        self.fill(&mut b)?;
        let k = u64::from_be_bytes(b) >> 12;
        Ok(f64::from_bits(k | 0x3ff0_0000_0000_0000) - 1.0)
    }

    /// `Math.random().toString(36).substring(start, end)`: usually `end - start` base-36 digits,
    /// sometimes fewer, exactly as V8 prints the fraction.
    fn math_random_base36(&self, start: usize, end: usize) -> Result<String, RandomError> {
        let text = number_to_radix_string(self.float()?, 36);
        Ok(text
            .chars()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect())
    }

    /// `crypto.randomInt(min, max)`: uniform in `[min, max)`. Both must be safe integers with
    /// `min < max` and `max - min <= 2^48 - 1`. Drawn as Node does: 48-bit big-endian values with
    /// rejection above the largest multiple of the range.
    fn int(&self, min: i64, max: i64) -> Result<i64, RandomError> {
        const RAND_MAX: i64 = 0xffff_ffff_ffff;
        const MAX_SAFE: i64 = 9_007_199_254_740_991;
        if min.abs() > MAX_SAFE || max.abs() > MAX_SAFE {
            return Err(RandomError::InvalidRange("bounds must be safe integers"));
        }
        if max <= min {
            return Err(RandomError::InvalidRange("max must be greater than min"));
        }
        let range = max - min;
        if range > RAND_MAX {
            return Err(RandomError::InvalidRange(
                "max - min must be at most 2^48 - 1",
            ));
        }
        let limit = RAND_MAX - (RAND_MAX % range);
        loop {
            let mut b = [0_u8; 8];
            self.fill(&mut b[2..])?;
            let x = i64::from_be_bytes(b);
            if x < limit {
                return Ok(min + x % range);
            }
        }
    }

    /// The roulette's unbiased draw in `[0, total)`: 53-bit values from 7 random bytes
    /// (`(b[0] & 31) * 2^48 + b[1..7]`), rejected at or above the largest multiple of `total`
    /// below 2^53, computed in doubles as the reference does. `total` must be in `[1, 2^53 - 1]`.
    fn ticket(&self, total: u64) -> Result<u64, RandomError> {
        if total == 0 || total > 9_007_199_254_740_991 {
            return Err(RandomError::InvalidRange(
                "total must be between 1 and 2^53 - 1",
            ));
        }
        #[allow(clippy::cast_precision_loss)]
        let total_f = total as f64;
        let range = 9_007_199_254_740_992.0_f64;
        let limit = (range / total_f).floor() * total_f;
        loop {
            let mut b = [0_u8; 8];
            self.fill(&mut b[1..])?;
            b[1] &= 31;
            #[allow(clippy::cast_precision_loss)]
            let value = u64::from_be_bytes(b) as f64;
            if value < limit {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                return Ok((value % total_f) as u64);
            }
        }
    }

    /// `len` characters drawn uniformly from `alphabet` (by rejection sampling, no modulo bias).
    /// An empty alphabet gives an error.
    fn alphabet_token(&self, alphabet: &str, len: usize) -> Result<String, RandomError> {
        let symbols: Vec<char> = alphabet.chars().collect();
        let count = symbols.len();
        if count == 0 || count > 65_536 {
            return Err(RandomError::InvalidRange(
                "alphabet must have 1 to 65536 characters",
            ));
        }
        let limit = 65_536 - 65_536 % count;
        let mut out = String::with_capacity(len);
        while out.chars().count() < len {
            let mut b = [0_u8; 2];
            self.fill(&mut b)?;
            let x = usize::from(u16::from_be_bytes(b));
            if x < limit
                && let Some(symbol) = symbols.get(x % count)
            {
                out.push(*symbol);
            }
        }
        Ok(out)
    }
}

/// The operating system's generator.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemRandom;

impl Random for SystemRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        getrandom::fill(buf).map_err(|_| RandomError::Unavailable)
    }
}

/// A deterministic generator for tests (SplitMix64). Not for secrets.
#[derive(Debug)]
pub struct SeededRandom(Mutex<u64>);

impl SeededRandom {
    /// A generator whose output is fixed by `seed`.
    pub fn new(seed: u64) -> Self {
        Self(Mutex::new(seed))
    }

    fn next(&self) -> u64 {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

impl Random for SeededRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), RandomError> {
        for chunk in buf.chunks_mut(8) {
            let word = self.next().to_be_bytes();
            for (out, byte) in chunk.iter_mut().zip(word) {
                *out = byte;
            }
        }
        Ok(())
    }
}

/// `x.toString(radix)` for a double, as V8's `DoubleToRadixCString` writes it (radix 2 to 36).
pub fn number_to_radix_string(x: f64, radix: u32) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let radix = radix.clamp(2, 36);
    let radix_f = f64::from(radix);
    let digit = |d: u32| char::from(DIGITS.get(d as usize).copied().unwrap_or(b'0'));
    let negative = x < 0.0;
    let value = x.abs();
    let mut integer = value.floor();
    let mut fraction = value - integer;
    let next_up = |v: f64| f64::from_bits(v.to_bits() + 1);
    let mut delta = (0.5 * (next_up(value) - value)).max(next_up(0.0));
    let mut fraction_digits: Vec<u32> = Vec::new();
    let mut has_point = false;
    if fraction >= delta {
        has_point = true;
        loop {
            fraction *= radix_f;
            delta *= radix_f;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let d = fraction as u32;
            fraction_digits.push(d);
            fraction -= f64::from(d);
            if (fraction > 0.5 || (fraction == 0.5 && d & 1 == 1)) && fraction + delta > 1.0 {
                // Round up, carrying through digits that overflow.
                loop {
                    match fraction_digits.pop() {
                        None => {
                            integer += 1.0;
                            has_point = false;
                            break;
                        }
                        Some(last) if last + 1 < radix => {
                            fraction_digits.push(last + 1);
                            break;
                        }
                        Some(_) => {}
                    }
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }
    // Integer digits; digits below the double's precision are written as zeros.
    let exponent = |v: f64| -> i64 {
        let biased = ((v.to_bits() >> 52) & 0x7ff) as i64;
        if biased == 0 { -1074 } else { biased - 1075 }
    };
    let mut integer_digits: Vec<char> = Vec::new();
    while exponent(integer / radix_f) > 0 {
        integer /= radix_f;
        integer_digits.push('0');
    }
    loop {
        let remainder = integer % radix_f;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        integer_digits.push(digit(remainder as u32));
        integer = (integer - remainder) / radix_f;
        if integer <= 0.0 {
            break;
        }
    }
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.extend(integer_digits.iter().rev());
    if has_point && !fraction_digits.is_empty() {
        out.push('.');
        out.extend(fraction_digits.iter().map(|d| digit(*d)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes() {
        let random = SeededRandom::new(1);
        let uuid = random.uuid_v4().unwrap();
        assert_eq!(uuid.len(), 36);
        assert_eq!(uuid.as_bytes()[14], b'4');
        assert!(matches!(uuid.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        let v7 = random.uuid_v7_reference(1_700_000_000_000).unwrap();
        assert!(v7.starts_with("018bcfe5-6800-7"));
        assert_eq!(v7.len(), 36);
        assert_eq!(random.hex_token(24).unwrap().len(), 48);
        assert_eq!(random.base64url_token(32).unwrap().len(), 43);
        let float = random.float().unwrap();
        assert!((0.0..1.0).contains(&float));
        assert!(random.math_random_base36(2, 6).unwrap().chars().count() <= 4);
        assert_eq!(random.alphabet_token("ab", 10).unwrap().len(), 10);
        assert!(random.alphabet_token("", 1).is_err());
    }

    #[test]
    fn ranges() {
        let random = SeededRandom::new(2);
        for _ in 0..1000 {
            let n = random.int(-3, 4).unwrap();
            assert!((-3..4).contains(&n));
            assert!(random.ticket(7).unwrap() < 7);
        }
        assert!(random.int(5, 5).is_err());
        assert!(random.int(0, 1 << 48).is_err());
        assert!(random.int(0, (1 << 48) - 1).is_ok());
        assert!(random.ticket(0).is_err());
        assert_eq!(random.ticket(1).unwrap(), 0);
    }

    #[test]
    fn seeded_is_deterministic() {
        let a = SeededRandom::new(9);
        let b = SeededRandom::new(9);
        assert_eq!(a.bytes(20).unwrap(), b.bytes(20).unwrap());
    }

    #[test]
    fn radix_strings() {
        assert_eq!(number_to_radix_string(0.5, 36), "0.i");
        assert_eq!(number_to_radix_string(0.0, 36), "0");
        assert_eq!(number_to_radix_string(-255.5, 16), "-ff.8");
    }
}
