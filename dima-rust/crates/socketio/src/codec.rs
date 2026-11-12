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
//! - **JSON** nested deeper than 128 levels is refused (`serde_json`'s recursion limit); V8 parses
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

/// Decodes one packet as `Decoder.decodeString` does (see the module documentation for where it
/// is stricter).
pub fn decode(text: &str) -> Result<Packet, DecodeError> {
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

    let data = if rest.is_empty() {
        None
    } else {
        Some(parse_json(rest)?)
    };

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
/// U+FFFD, object keys enumerate in JavaScript order, numbers are doubles.
pub fn parse_json(text: &str) -> Result<Value, DecodeError> {
    let text = dima_text::sanitize_lone_surrogates(text.as_bytes());
    // serde_json refuses nesting beyond 128 levels (its recursion limit).
    let mut value: Value =
        serde_json::from_slice(&text).map_err(|_| DecodeError::InvalidPayload)?;
    dima_text::js_key_order(&mut value);
    javascript_numbers(&mut value);
    Ok(value)
}

/// Integers beyond 2^53 become the nearest double and integral doubles within it become integers,
/// so a value is what `JSON.parse` would hold (the same rule as the body parser of `dima-web`).
fn javascript_numbers(value: &mut Value) {
    const EXACT: u64 = 1 << 53;
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Number(number) => {
                let replacement = if let Some(integer) = number.as_i64() {
                    (integer.unsigned_abs() > EXACT)
                        .then(|| serde_json::Number::from_f64(integer as f64))
                        .flatten()
                } else if let Some(integer) = number.as_u64() {
                    (integer > EXACT)
                        .then(|| serde_json::Number::from_f64(integer as f64))
                        .flatten()
                } else {
                    number.as_f64().and_then(|double| {
                        let integral = double.fract() == 0.0 && double.abs() <= EXACT as f64;
                        if !integral || (double == 0.0 && double.is_sign_negative()) {
                            None
                        } else if double < 0.0 {
                            Some(serde_json::Number::from(double as i64))
                        } else {
                            Some(serde_json::Number::from(double as u64))
                        }
                    })
                };
                if let Some(replacement) = replacement {
                    *number = replacement;
                }
            }
            Value::Array(items) => pending.extend(items.iter_mut()),
            Value::Object(map) => pending.extend(map.values_mut()),
            _ => {}
        }
    }
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
