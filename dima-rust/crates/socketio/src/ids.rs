//! Identifiers the clients see: socket ids and private session ids (`base64id.generateId()`),
//! and recovery offsets (`yeast()` of `socket.io-adapter` 2.5.8).

use std::sync::Mutex;

use dima_core::{Clock, SecureRandom};

/// A socket id or a private session id: 15 random bytes in URL-safe base64 (20 characters), the
/// shape of `base64id.generateId()` (which is standard base64 with `/` and `+` replaced by `_`
/// and `-`). The private id is the recovery secret, so it comes from the secure generator.
pub fn base64id(random: &dyn SecureRandom) -> Option<String> {
    random.base64url_token(15).ok()
}

const ALPHABET: &[u8; 64] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/// `yeast`'s `encode`: base 64 with its own alphabet, most significant digit first.
fn encode(mut number: u64) -> String {
    let mut digits = Vec::with_capacity(11);
    loop {
        digits.push(
            ALPHABET
                .get((number % 64) as usize)
                .copied()
                .unwrap_or(b'0'),
        );
        number /= 64;
        if number == 0 {
            break;
        }
    }
    digits.iter().rev().map(|&byte| char::from(byte)).collect()
}

/// The offset generator: `yeast()` is the encoded `Date.now()`, and within the same millisecond
/// that text followed by `.` and a counter (`.0`, `.1`, …) from the second call on.
///
/// One difference, so offsets stay unique: when the clock goes back, the last millisecond seen is
/// used instead (`yeast` would start over and could repeat an offset that is still stored).
#[derive(Debug, Default)]
pub struct Offsets {
    state: Mutex<OffsetState>,
}

#[derive(Debug, Default)]
struct OffsetState {
    millisecond: u64,
    seed: u64,
    started: bool,
}

impl Offsets {
    /// The next offset.
    pub fn next(&self, clock: &dyn Clock) -> String {
        let now = u64::try_from(clock.now_ms()).unwrap_or(0);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.started || now > state.millisecond {
            state.started = true;
            state.millisecond = now;
            state.seed = 0;
            return encode(now);
        }
        let seed = state.seed;
        state.seed += 1;
        format!("{}.{}", encode(state.millisecond), encode(seed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dima_core::{ManualClock, SeededRandom};

    #[test]
    fn yeast_shape() {
        assert_eq!(encode(0), "0");
        assert_eq!(encode(63), "_");
        assert_eq!(encode(64), "10");
        // `yeast.encode(1762862400000)` in Node.
        assert_eq!(encode(1_762_862_400_000), "PfooO80");
        let clock = ManualClock::new(1_762_862_400_000);
        let offsets = Offsets::default();
        assert_eq!(offsets.next(&clock), "PfooO80");
        assert_eq!(offsets.next(&clock), "PfooO80.0");
        assert_eq!(offsets.next(&clock), "PfooO80.1");
        clock.advance(1);
        assert_eq!(offsets.next(&clock), "PfooO81");
        // The clock going back does not repeat an offset.
        clock.advance(-5);
        assert_eq!(offsets.next(&clock), "PfooO81.0");
    }

    #[test]
    fn ids_are_twenty_url_safe_characters() {
        let random = SeededRandom::new(7);
        let id = base64id(&random).unwrap_or_default();
        assert_eq!(id.len(), 20);
        assert!(
            id.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_ne!(base64id(&random), Some(id));
    }
}
