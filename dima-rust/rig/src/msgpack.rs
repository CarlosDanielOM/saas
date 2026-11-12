//! A small MessagePack reader, so a MessagePack request body (Fish Audio TTS) compares as data.
//! Map key order is kept. Binary values become `{"$rigBytes": "<base64>"}`; extension types,
//! NaN and infinities make the whole body unreadable (it then compares as bytes).

use base64::Engine as _;
use serde_json::{Map, Number, Value};

const MAX_DEPTH: usize = 64;

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(s)
    }

    fn byte(&mut self) -> Option<u8> {
        self.take(1).and_then(|s| s.first().copied())
    }

    fn uint(&mut self, n: usize) -> Option<u64> {
        let s = self.take(n)?;
        Some(s.iter().fold(0u64, |acc, x| (acc << 8) | u64::from(*x)))
    }

    fn int(&mut self, n: usize) -> Option<i64> {
        let u = self.uint(n)?;
        let bits = n * 8;
        Some(if bits < 64 && u >= 1 << (bits - 1) {
            i64::try_from(u).ok()? - (1i64 << bits)
        } else {
            u as i64
        })
    }

    fn str(&mut self, n: usize) -> Option<Value> {
        let s = self.take(n)?;
        Some(Value::String(std::str::from_utf8(s).ok()?.to_string()))
    }

    fn bin(&mut self, n: usize) -> Option<Value> {
        let s = self.take(n)?;
        let mut m = Map::new();
        m.insert(
            "$rigBytes".into(),
            Value::String(base64::engine::general_purpose::STANDARD.encode(s)),
        );
        Some(Value::Object(m))
    }

    fn array(&mut self, n: usize, depth: usize) -> Option<Value> {
        let mut out = Vec::with_capacity(n.min(1024));
        for _ in 0..n {
            out.push(self.value(depth + 1)?);
        }
        Some(Value::Array(out))
    }

    fn map(&mut self, n: usize, depth: usize) -> Option<Value> {
        let mut out = Map::new();
        for _ in 0..n {
            let k = match self.value(depth + 1)? {
                Value::String(s) => s,
                other => other.to_string(),
            };
            let v = self.value(depth + 1)?;
            out.insert(k, v);
        }
        Some(Value::Object(out))
    }

    fn len(&mut self, n: usize) -> Option<usize> {
        usize::try_from(self.uint(n)?).ok()
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        let t = self.byte()?;
        match t {
            0x00..=0x7f => Some(Value::from(t)),
            0x80..=0x8f => self.map(usize::from(t & 0x0f), depth),
            0x90..=0x9f => self.array(usize::from(t & 0x0f), depth),
            0xa0..=0xbf => self.str(usize::from(t & 0x1f)),
            0xc0 => Some(Value::Null),
            0xc2 => Some(Value::Bool(false)),
            0xc3 => Some(Value::Bool(true)),
            0xc4 => {
                let n = self.len(1)?;
                self.bin(n)
            }
            0xc5 => {
                let n = self.len(2)?;
                self.bin(n)
            }
            0xc6 => {
                let n = self.len(4)?;
                self.bin(n)
            }
            0xca => {
                let bits = u32::try_from(self.uint(4)?).ok()?;
                Number::from_f64(f64::from(f32::from_bits(bits))).map(Value::Number)
            }
            0xcb => Number::from_f64(f64::from_bits(self.uint(8)?)).map(Value::Number),
            0xcc => self.uint(1).map(Value::from),
            0xcd => self.uint(2).map(Value::from),
            0xce => self.uint(4).map(Value::from),
            0xcf => self.uint(8).map(Value::from),
            0xd0 => self.int(1).map(Value::from),
            0xd1 => self.int(2).map(Value::from),
            0xd2 => self.int(4).map(Value::from),
            0xd3 => self.int(8).map(Value::from),
            0xd9 => {
                let n = self.len(1)?;
                self.str(n)
            }
            0xda => {
                let n = self.len(2)?;
                self.str(n)
            }
            0xdb => {
                let n = self.len(4)?;
                self.str(n)
            }
            0xdc => {
                let n = self.len(2)?;
                self.array(n, depth)
            }
            0xdd => {
                let n = self.len(4)?;
                self.array(n, depth)
            }
            0xde => {
                let n = self.len(2)?;
                self.map(n, depth)
            }
            0xdf => {
                let n = self.len(4)?;
                self.map(n, depth)
            }
            0xe0..=0xff => Some(Value::from(i64::from(t as i8))),
            // 0xc1 is never used; 0xc7..=0xc9 and 0xd4..=0xd8 are extension types.
            _ => None,
        }
    }
}

/// The value of a whole MessagePack document, or `None` when it is not one.
pub fn decode(b: &[u8]) -> Option<Value> {
    let mut r = Reader { b, at: 0 };
    let v = r.value(0)?;
    (r.at == b.len()).then_some(v)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use serde_json::json;

    #[test]
    fn fish_audio_shape() {
        // {"text": "hola 👋", "reference_id": "abc", "format": "mp3", "latency": -1, "x": [1.5, null, true]}
        let mut b = vec![0x85];
        b.push(0xa4);
        b.extend_from_slice(b"text");
        let hola = "hola 👋".as_bytes();
        b.push(0xa0 | u8::try_from(hola.len()).unwrap());
        b.extend_from_slice(hola);
        b.push(0xac);
        b.extend_from_slice(b"reference_id");
        b.push(0xa3);
        b.extend_from_slice(b"abc");
        b.push(0xa6);
        b.extend_from_slice(b"format");
        b.push(0xa3);
        b.extend_from_slice(b"mp3");
        b.push(0xa7);
        b.extend_from_slice(b"latency");
        b.push(0xff);
        b.push(0xa1);
        b.push(b'x');
        b.push(0x93);
        b.push(0xcb);
        b.extend_from_slice(&1.5f64.to_bits().to_be_bytes());
        b.push(0xc0);
        b.push(0xc3);
        let v = decode(&b).unwrap();
        assert_eq!(
            v,
            json!({"text": "hola 👋", "reference_id": "abc", "format": "mp3", "latency": -1, "x": [1.5, null, true]})
        );
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["text", "reference_id", "format", "latency", "x"]);
        assert!(decode(&[0x92, 0x01]).is_none(), "truncated");
        assert!(decode(&[0x01, 0x02]).is_none(), "trailing bytes");
        assert!(decode(b"{\"a\":1}").is_none());
    }
}
