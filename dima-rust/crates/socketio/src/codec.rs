//! Socket.IO protocol revision 5 packets, text only, as `socket.io-parser` 4.2.7 reads and writes
//! them (`build/cjs/index.js`, `Decoder.decodeString` and `Encoder.encodeAsString`).
//!
//! A packet is one Engine.IO message: `<type>[<namespace>,][<ack id>][<JSON>]`. The namespace is
//! written only when it is not `/`; the JSON is `JSON.stringify` of the data.
//!
//! Where this decoder is stricter than the reference (each one is a malformed packet that no
//! `socket.io-client` sends; the connection is closed, as it is for any packet the reference
//! cannot decode):
//!
//! - **Type**: exactly one of `0`–`6`. The reference reads `Number(str.charAt(0))`, so an empty
//!   message or one starting with a space is a CONNECT to `/` there.
//! - **Binary packets** (`5`, `6`) are refused: the server never sends binary data and no client
//!   of this backend does (`ledger/socketio.md`, section 1 point 19).
//! - **Acknowledgement ids** are ASCII digits up to 2^53 − 1. The reference also takes JavaScript
//!   whitespace in the digit run (`Number(" ") == " "`, so `2 ["a"]` asks for ack 0) and rounds
//!   longer runs to a double; whitespace where an id may start is refused here.
//! - **JSON** with more than 127 arrays and objects open at once is refused (the bound
//!   `serde_json`'s recursion limit set before the shared parser was used); V8 parses
//!   thousands of levels.
//!
//! Everything else is read as the reference reads it, including its odd corners: a namespace
//! without the closing comma runs to the end of the packet (`0/abc` is a CONNECT to `/abc`), an
//! EVENT without data and an ACK without an id are accepted and ignored, an ACK without data
//! acknowledges with no arguments, a numeric event name is the event named by its JavaScript text (`[1]` is event
//! `"1"`), and `\uD800`-style escapes outside a surrogate pair become U+FFFD (text rule 3).

use serde_json::{Map, Value};

/// The largest acknowledgement id accepted: `Number.MAX_SAFE_INTEGER`.
pub const MAX_ACK_ID: u64 = (1 << 53) - 1;

/// Event names the reference refuses in an EVENT packet (`RESERVED_EVENTS` of the parser).
pub const RESERVED_EVENTS: [&str; 6] = [
    "connect",
    "connect_error",
    "disconnect",
    "disconnecting",
    "newListener",
    "removeListener",
];

/// One decoded packet from a client.
#[derive(Debug, Clone, PartialEq)]
pub struct Packet {
    /// The namespace (`/` when the packet names none).
    pub nsp: String,
    /// What it carries.
    pub kind: Kind,
}

/// The packet types a client may send, with their data.
#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    /// `0`: join the namespace; the data object is the handshake's `auth` (`{}` when absent).
    Connect(Map<String, Value>),
    /// `1`: leave the namespace.
    Disconnect,
    /// `2` with data: an event (`[name, ...args]`), with an acknowledgement id when the client
    /// waits for an answer.
    Event {
        /// The event name (a numeric name is its JavaScript text).
        name: String,
        /// The arguments after the name.
        args: Vec<Value>,
        /// The id to acknowledge with, when the client asked for one.
        ack: Option<u64>,
    },
    /// Accepted and ignored, as the reference does: an EVENT without data (dispatched with no
    /// name, so no listener receives it) and an ACK without an id (no callback has id
    /// `undefined`).
    Ignored,
    /// `3`: the answer to a server event that asked for an acknowledgement.
    Ack {
        /// The id the server sent.
        id: u64,
        /// The arguments (none when the packet had no data).
        args: Vec<Value>,
    },
    /// `4` from a client: decodes, but the reference closes the connection on it.
    ConnectError,
}

/// Why a client packet could not be decoded. Each closes the connection.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// The first character is not a packet type `0`–`6`.
    #[error("unknown packet type")]
    UnknownType,
    /// A binary packet (`5` or `6`): refused.
    #[error("binary packets are not supported")]
    Binary,
    /// An acknowledgement id beyond 2^53 − 1.
    #[error("invalid acknowledgement id")]
    BadAckId,
    /// The JSON is malformed, too deep, or not the shape the packet type requires.
    #[error("invalid payload")]
    InvalidPayload,
}

/// A packet's header, read without touching its JSON: what the server needs to know whom the
/// packet is for and to reserve the memory its data will take before parsing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Head<'a> {
    /// The packet type, `0`–`4`.
    pub kind: u8,
    /// The namespace (`/` when the packet names none).
    pub nsp: &'a str,
    /// The acknowledgement id, when there is one.
    pub id: Option<u64>,
    /// The JSON text, when there is one.
    pub data: Option<&'a str>,
}

/// Reads the header of one packet as `Decoder.decodeString` does (see the module documentation
/// for where it is stricter); [`decode_body`] finishes it once the JSON is parsed.
pub fn decode_head(text: &str) -> Result<Head<'_>, DecodeError> {
    let mut rest = text;
    let kind = match rest.as_bytes().first() {
        Some(b'0') => 0,
        Some(b'1') => 1,
        Some(b'2') => 2,
        Some(b'3') => 3,
        Some(b'4') => 4,
        Some(b'5' | b'6') => return Err(DecodeError::Binary),
        _ => return Err(DecodeError::UnknownType),
    };
    rest = rest.get(1..).unwrap_or_default();

    // Namespace: from `/` up to the first `,` (consumed) or the end of the packet.
    let nsp = if rest.starts_with('/') {
        match rest.find(',') {
            Some(comma) => {
                let nsp = rest.get(..comma).unwrap_or_default();
                rest = rest.get(comma + 1..).unwrap_or_default();
                nsp
            }
            None => {
                let nsp = rest;
                rest = "";
                nsp
            }
        }
    } else {
        "/"
    };

    // Acknowledgement id: a run of digits. The reference also counts JavaScript whitespace as
    // digits here (`Number(" ") == " "`): refused rather than read differently.
    if rest.chars().next().is_some_and(dima_text::is_js_whitespace) {
        return Err(DecodeError::BadAckId);
    }
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let id = if digits > 0 {
        let run = rest.get(..digits).unwrap_or_default();
        rest = rest.get(digits..).unwrap_or_default();
        let id = run
            .parse::<u64>()
            .ok()
            .filter(|id| *id <= MAX_ACK_ID)
            .ok_or(DecodeError::BadAckId)?;
        Some(id)
    } else {
        None
    };
    Ok(Head {
        kind,
        nsp,
        id,
        data: (!rest.is_empty()).then_some(rest),
    })
}

/// Finishes a packet from its header and its parsed JSON (`None` when it had none).
pub fn decode_body(head: Head<'_>, data: Option<Value>) -> Result<Packet, DecodeError> {
    let Head { kind, nsp, id, .. } = head;
    let kind = match (kind, data) {
        (0, None) => Kind::Connect(Map::new()),
        (0, Some(Value::Object(auth))) => Kind::Connect(auth),
        (1, None) => Kind::Disconnect,
        (2, None) => Kind::Ignored,
        (2, Some(Value::Array(items))) => event(items, id)?,
        (3, None | Some(Value::Array(_))) if id.is_none() => Kind::Ignored,
        (3, None) => Kind::Ack {
            id: id.unwrap_or_default(),
            args: Vec::new(),
        },
        (3, Some(Value::Array(args))) => Kind::Ack {
            id: id.unwrap_or_default(),
            args,
        },
        (4, None | Some(Value::String(_) | Value::Object(_))) => Kind::ConnectError,
        _ => return Err(DecodeError::InvalidPayload),
    };
    Ok(Packet {
        nsp: nsp.to_owned(),
        kind,
    })
}

/// Decodes one packet as `Decoder.decodeString` does: [`decode_head`], the JSON, then
/// [`decode_body`].
#[cfg(test)]
pub fn decode(text: &str) -> Result<Packet, DecodeError> {
    let head = decode_head(text)?;
    let data = head.data.map(parse_json).transpose()?;
    decode_body(head, data)
}

/// An upper bound of the memory the parsed form of the JSON text `data` takes, computed from
/// the text without parsing it (one pass, no allocation), so it can be reserved first.
///
/// What [`parse_json`] builds, on a 64-bit target: every value is a `Value`
/// (`size_of::<Value>()`, 80 bytes with `preserve_order`) in a `Vec` that may have grown to
/// twice its length; every object entry adds a bucket (hash, key `String`, value) in an
/// `IndexMap` that may have grown to twice its length, plus its hash index; every array or
/// object has a minimal capacity of four; string contents (keys included) take at most their
/// text's length, twice over for growth. The number of values is at most the commas plus the
/// opening brackets plus one, the number of entries at most the colons, both counted outside
/// strings. So a 1,000,000-byte array of zeros (`[0,0,…]`) is bounded at about 80 MB (it really
/// takes 40 to 80 MB), and a 1,000,000-byte string at 2 MB.
pub fn parsed_size_bound(data: &str) -> usize {
    const VALUE: usize = std::mem::size_of::<Value>();
    const BUCKET: usize = VALUE + std::mem::size_of::<String>() + std::mem::size_of::<usize>();
    const ENTRY: usize = 2 * BUCKET + 48;
    const CONTAINER: usize = 4 * BUCKET + 64;
    let (mut commas, mut colons, mut opens) = (0_usize, 0_usize, 0_usize);
    let (mut in_string, mut escaped) = (false, false);
    for &byte in data.as_bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b',' => commas += 1,
            b':' => colons += 1,
            b'[' | b'{' => opens += 1,
            _ => {}
        }
    }
    let values = commas.saturating_add(opens).saturating_add(1);
    data.len()
        .saturating_mul(2)
        .saturating_add(values.saturating_mul(2 * VALUE))
        .saturating_add(colons.saturating_mul(ENTRY))
        .saturating_add(opens.saturating_mul(CONTAINER))
}

/// `[name, ...args]` with a string name that is not reserved, or a numeric name.
fn event(mut items: Vec<Value>, ack: Option<u64>) -> Result<Kind, DecodeError> {
    let name = match items.first() {
        Some(Value::String(name)) if !RESERVED_EVENTS.contains(&name.as_str()) => name.clone(),
        Some(Value::Number(number)) => number
            .as_f64()
            .map(dima_text::number_to_string)
            .ok_or(DecodeError::InvalidPayload)?,
        _ => return Err(DecodeError::InvalidPayload),
    };
    items.remove(0);
    Ok(Kind::Event {
        name,
        args: items,
        ack,
    })
}

/// `JSON.parse` of a packet's data, holding what JavaScript holds: lone surrogate escapes become
/// U+FFFD, object keys enumerate in JavaScript order, numbers are doubles. The shared
/// `dima_text::parse_js_json`, with 127 open containers at most (the bound `serde_json`'s
/// recursion limit set before) and no length limit of its own (the transport's 1 MB applies).
pub fn parse_json(text: &str) -> Result<Value, DecodeError> {
    dima_text::parse_js_json(
        text,
        dima_text::JsonLimits {
            max_depth: 127,
            max_bytes: usize::MAX,
        },
    )
    .map_err(|_| DecodeError::InvalidPayload)
}

/// The start of a packet: type, then the namespace and its comma unless it is `/`.
fn head(kind: u8, nsp: &str, capacity: usize) -> String {
    let mut out = String::with_capacity(capacity + nsp.len() + 24);
    out.push(char::from(b'0' + kind));
    if nsp != "/" {
        out.push_str(nsp);
        out.push(',');
    }
    out
}

/// CONNECT from the server: `0[nsp,]{"sid":…,"pid":…}`.
pub fn encode_connect(nsp: &str, sid: &str, pid: &str) -> String {
    let data = Value::Object(Map::from_iter([
        ("sid".to_owned(), Value::String(sid.to_owned())),
        ("pid".to_owned(), Value::String(pid.to_owned())),
    ]));
    let json = dima_text::to_js_json(&data);
    let mut out = head(0, nsp, json.len());
    out.push_str(&json);
    out
}

/// CONNECT_ERROR: `4[nsp,]{"message":…[,"data":…]}` (`data` is left out when absent, as
/// `JSON.stringify` drops `undefined`).
pub fn encode_connect_error(nsp: &str, message: &str, data: Option<&Value>) -> String {
    let mut object = Map::new();
    object.insert("message".to_owned(), Value::String(message.to_owned()));
    if let Some(data) = data {
        object.insert("data".to_owned(), data.clone());
    }
    let json = dima_text::to_js_json(&Value::Object(object));
    let mut out = head(4, nsp, json.len());
    out.push_str(&json);
    out
}

/// DISCONNECT from the server: `1[nsp,]`.
pub fn encode_disconnect(nsp: &str) -> String {
    head(1, nsp, 0)
}

/// EVENT from the server with its data already written as a JSON array (`["name",…]`).
pub fn encode_event(nsp: &str, ack: Option<u64>, array_json: &str) -> String {
    let mut out = head(2, nsp, array_json.len());
    if let Some(id) = ack {
        out.push_str(&id.to_string());
    }
    out.push_str(array_json);
    out
}

/// ACK from the server: `3[nsp,]<id>[…]`.
pub fn encode_ack(nsp: &str, id: u64, args: &[Value]) -> String {
    let json = array_json(None, args, None);
    let mut out = head(3, nsp, json.len());
    out.push_str(&id.to_string());
    out.push_str(&json);
    out
}

/// `JSON.stringify([name, ...args, offset])` with the parts that are present.
pub fn array_json(name: Option<&str>, args: &[Value], offset: Option<&str>) -> String {
    let mut out = String::with_capacity(64);
    out.push('[');
    let mut first = true;
    let mut push = |out: &mut String, text: &str| {
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(text);
    };
    if let Some(name) = name {
        push(
            &mut out,
            &dima_text::to_js_json(&Value::String(name.to_owned())),
        );
    }
    for arg in args {
        push(&mut out, &dima_text::to_js_json(arg));
    }
    if let Some(offset) = offset {
        push(
            &mut out,
            &dima_text::to_js_json(&Value::String(offset.to_owned())),
        );
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(nsp: &str, name: &str, args: Vec<Value>, ack: Option<u64>) -> Packet {
        Packet {
            nsp: nsp.to_owned(),
            kind: Kind::Event {
                name: name.to_owned(),
                args,
                ack,
            },
        }
    }

    #[test]
    fn decodes_what_the_javascript_client_sends() {
        let auth = json!({"token": "abc", "pid": "p", "offset": "o"});
        assert_eq!(
            decode(r#"0/clip/123,{"token":"abc","pid":"p","offset":"o"}"#),
            Ok(Packet {
                nsp: "/clip/123".to_owned(),
                kind: Kind::Connect(auth.as_object().cloned().unwrap_or_default()),
            })
        );
        assert_eq!(
            decode("0"),
            Ok(Packet {
                nsp: "/".to_owned(),
                kind: Kind::Connect(Map::new())
            })
        );
        assert_eq!(
            decode("0/admin,"),
            Ok(Packet {
                nsp: "/admin".to_owned(),
                kind: Kind::Connect(Map::new())
            })
        );
        assert_eq!(
            decode(r#"2["hello",1,{"a":true}]"#),
            Ok(event(
                "/",
                "hello",
                vec![json!(1), json!({"a": true})],
                None
            ))
        );
        assert_eq!(
            decode(r#"2/chat,12["msg"]"#),
            Ok(event("/chat", "msg", vec![], Some(12)))
        );
        assert_eq!(
            decode(r#"3/chat,7["ok",null]"#),
            Ok(Packet {
                nsp: "/chat".to_owned(),
                kind: Kind::Ack {
                    id: 7,
                    args: vec![json!("ok"), Value::Null]
                }
            })
        );
        assert_eq!(
            decode("1/chat,"),
            Ok(Packet {
                nsp: "/chat".to_owned(),
                kind: Kind::Disconnect
            })
        );
    }

    #[test]
    fn reads_the_reference_corner_cases() {
        // No closing comma: the namespace runs to the end.
        assert_eq!(
            decode(r#"0/abc{"x":1}"#),
            Ok(Packet {
                nsp: r#"/abc{"x":1}"#.to_owned(),
                kind: Kind::Connect(Map::new())
            })
        );
        // An EVENT without data and an ACK without id are accepted and ignored.
        for text in ["2/chat,", "3/chat,", "3/chat,[1]"] {
            assert_eq!(
                decode(text),
                Ok(Packet {
                    nsp: "/chat".to_owned(),
                    kind: Kind::Ignored
                }),
                "{text}"
            );
        }
        // An ACK without data acknowledges with no arguments; leading zeros are a number.
        assert_eq!(
            decode("3007"),
            Ok(Packet {
                nsp: "/".to_owned(),
                kind: Kind::Ack {
                    id: 7,
                    args: vec![]
                }
            })
        );
        // Numeric event names are their JavaScript text.
        assert_eq!(decode("2[1,2]"), Ok(event("/", "1", vec![json!(2)], None)));
        assert_eq!(decode("2[1.5]"), Ok(event("/", "1.5", vec![], None)));
        assert_eq!(decode("2[1e21]"), Ok(event("/", "1e+21", vec![], None)));
        // A connect error from a client decodes (the connection then closes on it).
        assert_eq!(
            decode(r#"4{"message":"x"}"#).map(|p| p.kind),
            Ok(Kind::ConnectError)
        );
        assert_eq!(decode(r#"4"x""#).map(|p| p.kind), Ok(Kind::ConnectError));
        // Trailing JSON whitespace is fine.
        assert_eq!(
            decode("2[\"a\"] \n").map(|p| p.kind),
            Ok(Kind::Event {
                name: "a".to_owned(),
                args: vec![],
                ack: None
            })
        );
        // A leading space would be read as acknowledgement id 0 by the reference: refused.
        assert_eq!(decode("2 [\"a\"]"), Err(DecodeError::BadAckId));
        assert_eq!(decode("2/n,\u{3000}[\"a\"]"), Err(DecodeError::BadAckId));
    }

    #[test]
    fn refuses_malformed_packets() {
        for text in ["", " ", "7", "x", "a2[\"x\"]", "٣"] {
            assert_eq!(decode(text), Err(DecodeError::UnknownType), "{text:?}");
        }
        for text in ["51-[\"x\",{\"_placeholder\":true,\"num\":0}]", "61-0[]"] {
            assert_eq!(decode(text), Err(DecodeError::Binary), "{text:?}");
        }
        for text in [
            "0[]",
            "0\"auth\"",
            "0null",
            "0{",
            "1{}",
            "2[]",
            "2{}",
            "2[\"connect\"]",
            "2[\"disconnect\",1]",
            "2[\"newListener\"]",
            "2[null]",
            "2[true]",
            "2[[\"a\"]]",
            "2[\"a\"",
            "2[\"a\"]x",
            "3[]x",
            "31\"a\"",
            "4[]",
            "4true",
            "0/nsp,{\"a\":1}{",
        ] {
            assert_eq!(decode(text), Err(DecodeError::InvalidPayload), "{text:?}");
        }
        assert_eq!(decode("3{}"), Err(DecodeError::InvalidPayload));
        assert!(decode("2[\"a\"]").is_ok());
        assert!(decode("29007199254740991[\"a\"]").is_ok());
        assert_eq!(
            decode("29007199254740992[\"a\"]"),
            Err(DecodeError::BadAckId)
        );
        assert_eq!(
            decode("2123456789012345678901234567890[\"a\"]"),
            Err(DecodeError::BadAckId)
        );
    }

    /// The heap a parsed value holds, from the capacities of its vectors and strings (an
    /// object's map, whose capacity is not exposed, is counted as grown to twice its length).
    fn retained(value: &Value) -> usize {
        const VALUE: usize = std::mem::size_of::<Value>();
        match value {
            Value::String(text) => text.capacity(),
            Value::Array(items) => {
                items.capacity() * VALUE + items.iter().map(retained).sum::<usize>()
            }
            Value::Object(map) => {
                let bucket = VALUE + std::mem::size_of::<String>() + 8;
                map.len() * (2 * bucket + 24)
                    + map
                        .iter()
                        .map(|(key, value)| key.capacity() + retained(value))
                        .sum::<usize>()
            }
            _ => 0,
        }
    }

    /// Finding 2: the bound reserved before parsing is at least what the parsed value holds,
    /// for the shapes that cost the most per byte of text.
    #[test]
    fn the_size_bound_covers_what_parsing_allocates() {
        let mut shapes = vec![
            "[]".to_owned(),
            "{}".to_owned(),
            "0".to_owned(),
            format!("[{}0]", "0,".repeat(10_000)),
            format!("[{}[]]", "[],".repeat(10_000)),
            format!("[{}{{}}]", "{},".repeat(10_000)),
            format!(
                "{{{}\"z\":0}}",
                (0..5_000)
                    .map(|i| format!("\"{i}\":0,"))
                    .collect::<String>()
            ),
            format!("[{}1]", "[1],".repeat(5_000)),
            format!("\"{}\"", "a".repeat(100_000)),
            format!("\"{}\"", "\\n".repeat(10_000)),
            format!("{}0{}", "[".repeat(100), "]".repeat(100)),
            format!("[{}\"\"]", "\"\",".repeat(10_000)),
            format!("[{}\"😀é\"]", "\"😀é\",".repeat(3_000)),
        ];
        shapes.push(format!("[{}]", shapes.join(",")));
        for text in &shapes {
            let value = parse_json(text).unwrap();
            let held = retained(&value);
            let bound = parsed_size_bound(text);
            assert!(
                bound >= held,
                "{} bytes of text: bound {bound} < {held}",
                text.len()
            );
        }
        // A long string costs about its length; dense numbers cost much more per byte.
        let string = format!("\"{}\"", "a".repeat(1_000_000));
        assert!(parsed_size_bound(&string) < 2_100_000);
        let numbers = format!("[{}0]", "0,".repeat(499_999));
        assert!(parsed_size_bound(&numbers) > 40_000_000);
        // Commas, colons and brackets inside strings are text, not structure.
        assert_eq!(
            parsed_size_bound("\",:[{\\\",:[{\""),
            parsed_size_bound("\"aaaaaaaaaa\"")
        );
    }

    #[test]
    fn deep_and_large_payloads() {
        let deep_ok = format!("2[\"a\",{}{}]", "[".repeat(120), "]".repeat(120));
        assert!(decode(&deep_ok).is_ok());
        let too_deep = format!("2[\"a\",{}{}]", "[".repeat(200), "]".repeat(200));
        assert_eq!(decode(&too_deep), Err(DecodeError::InvalidPayload));
        let unbalanced = format!("2[\"a\",{}", "[".repeat(100_000));
        assert_eq!(decode(&unbalanced), Err(DecodeError::InvalidPayload));
        let big = format!("2[\"a\",\"{}\"]", "x".repeat(999_000));
        assert!(decode(&big).is_ok());
    }

    #[test]
    fn text_is_utf8_and_lone_surrogates_are_replaced() {
        assert_eq!(
            decode(r#"2["e","😀 é ע́"]"#),
            Ok(event("/", "e", vec![json!("😀 é ע\u{301}")], None))
        );
        assert_eq!(
            decode(r#"2["e","😀","\ud800","\udc00x"]"#),
            Ok(event(
                "/",
                "e",
                vec![json!("😀"), json!("\u{FFFD}"), json!("\u{FFFD}x")],
                None
            ))
        );
        // Namespaces are kept as sent, Unicode included.
        assert_eq!(decode("0/é😀,").map(|p| p.nsp), Ok("/é😀".to_owned()));
    }

    #[test]
    fn numbers_and_keys_are_what_javascript_holds() {
        let Ok(Packet {
            kind: Kind::Event { args, .. },
            ..
        }) = decode(r#"2["e",{"b":1,"2":2,"a":3,"1":4},9007199254740993,1.0,-0.0,1e2]"#)
        else {
            panic!("decoded");
        };
        assert_eq!(
            dima_text::to_js_json(&Value::Array(args)),
            r#"[{"1":4,"2":2,"b":1,"a":3},9007199254740992,1,0,100]"#
        );
    }

    #[test]
    fn encodes_like_the_reference() {
        assert_eq!(
            encode_connect("/", "s1", "p1"),
            r#"0{"sid":"s1","pid":"p1"}"#
        );
        assert_eq!(
            encode_connect("/a", "s1", "p1"),
            r#"0/a,{"sid":"s1","pid":"p1"}"#
        );
        assert_eq!(
            encode_connect_error("/a", "Invalid namespace", None),
            r#"4/a,{"message":"Invalid namespace"}"#
        );
        assert_eq!(
            encode_connect_error("/", "nope", Some(&json!({"code": "x"}))),
            r#"4{"message":"nope","data":{"code":"x"}}"#
        );
        assert_eq!(encode_disconnect("/"), "1");
        assert_eq!(encode_disconnect("/a"), "1/a,");
        let data = array_json(Some("ev"), &[json!(1), json!("é😀\u{2028}")], Some("off"));
        assert_eq!(data, "[\"ev\",1,\"é😀\u{2028}\",\"off\"]");
        assert_eq!(encode_event("/", None, &data), format!("2{data}"));
        assert_eq!(encode_event("/n", Some(3), "[\"e\"]"), "2/n,3[\"e\"]");
        assert_eq!(encode_ack("/", 0, &[]), "30[]");
        assert_eq!(
            encode_ack("/n", 12, &[json!(null), json!(-0.0), json!(1e21)]),
            "3/n,12[null,0,1e+21]"
        );
        // A round trip through the decoder.
        let wire = encode_event(
            "/n",
            Some(5),
            &array_json(Some("x"), &[json!({"k": [1]})], None),
        );
        assert_eq!(
            decode(&wire),
            Ok(event("/n", "x", vec![json!({"k": [1]})], Some(5)))
        );
    }
}
