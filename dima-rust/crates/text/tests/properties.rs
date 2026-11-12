//! Property tests over seeded random inputs (no external crate: a SplitMix64 stream, so every
//! run checks the same cases and a failure names the seed that produced it).

use dima_text::*;

/// SplitMix64: small, fast and good enough to spread inputs over every class.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    /// A scalar value from a random class: ASCII, two-, three- and four-byte UTF-8, the edges.
    fn char(&mut self) -> char {
        let code = match self.below(6) {
            0 => self.below(0x80) as u32,
            1 => 0x80 + self.below(0x780) as u32,
            2 => 0x800 + self.below(0xd000) as u32,
            3 => 0xe000 + self.below(0x2000) as u32,
            4 => 0x1_0000 + self.below(0x10_0000) as u32,
            _ => *self.pick(&[
                0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x1_0000, 0x10_ffff,
            ]),
        };
        char::from_u32(code).unwrap_or('\u{fffd}')
    }

    fn string(&mut self, max: usize) -> String {
        let length = self.below(max + 1);
        (0..length).map(|_| self.char()).collect()
    }

    /// Text made of URI-ish pieces: escapes (good and broken), reserved characters, letters.
    fn uri_soup(&mut self, max: usize) -> String {
        const PIECES: &[&str] = &[
            "%",
            "%2",
            "%2F",
            "%2f",
            "%41",
            "%C3",
            "%A9",
            "%C3%A9",
            "%E2%82%AC",
            "%F0%9F%98%80",
            "%ED%A0%80",
            "%C0%80",
            "%FF",
            "%zz",
            "a",
            "Z",
            "0",
            " ",
            "+",
            "/",
            "?",
            "#",
            "é",
            "😀",
            "%25",
            "%%",
        ];
        let length = self.below(max + 1);
        (0..length).map(|_| *self.pick(PIECES)).collect()
    }
}

const CASES: u64 = 20_000;

#[test]
fn uri_encoding_round_trips_every_string() {
    let mut rng = Rng(0x0e1c_0de5);
    for case in 0..CASES {
        let text = rng.string(24);
        let component = encode_uri_component(&text);
        assert_eq!(
            decode_uri_component(&component).as_deref(),
            Ok(text.as_str()),
            "case {case}"
        );
        let uri = encode_uri(&text);
        assert_eq!(
            decode_uri(&uri).as_deref(),
            Ok(text.as_str()),
            "case {case}"
        );
        // Only ASCII comes out of the encoders.
        assert!(component.is_ascii() && uri.is_ascii(), "case {case}");
    }
}

#[test]
fn uri_decoding_never_panics_and_errors_point_at_a_percent() {
    let mut rng = Rng(0xdec0_de00);
    for case in 0..CASES {
        let text = if case % 2 == 0 {
            rng.uri_soup(12)
        } else {
            rng.string(12)
        };
        for result in [decode_uri_component(&text), decode_uri(&text)] {
            if let Err(error) = result {
                assert_eq!(text.as_bytes().get(error.offset), Some(&b'%'), "{text:?}");
            }
        }
        // Both fail on exactly the same inputs; decodeURI only keeps some escapes as written.
        let (uri, component) = (decode_uri(&text), decode_uri_component(&text));
        assert_eq!(uri.is_ok(), component.is_ok(), "{text:?}");
        if let (Ok(uri), Ok(component)) = (uri, component) {
            assert!(uri.len() >= component.len(), "{text:?}");
        }
    }
}
