//! Asserts every golden vector written by `tests/vectors/generate.mjs` (real Node).
// Test helpers outside `#[test]` functions: a malformed vector file should fail loudly.
#![allow(clippy::panic)]

use dima_text::*;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

fn load(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/vectors")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn rows<'a>(file: &'a Value, key: &str) -> &'a [Value] {
    file[key]
        .as_array()
        .unwrap_or_else(|| panic!("missing vector list {key}"))
}

fn text(value: &Value) -> &str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected a string, got {value}"))
}

fn int(value: &Value) -> i64 {
    value
        .as_i64()
        .unwrap_or_else(|| panic!("expected an integer, got {value}"))
}

fn double(value: &Value) -> f64 {
    f64::from_bits(
        u64::from_str_radix(text(value), 16).unwrap_or_else(|_| panic!("bad bits {value}")),
    )
}

/// Same double, bit for bit (any NaN matches any NaN).
fn same(left: f64, right: f64) -> bool {
    left.to_bits() == right.to_bits() || (left.is_nan() && right.is_nan())
}

/// Collects mismatches and fails once with all of them (up to a limit), with the vector count.
struct Check {
    name: &'static str,
    count: usize,
    failures: Vec<String>,
}

impl Check {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            count: 0,
            failures: Vec::new(),
        }
    }

    fn expect(&mut self, ok: bool, describe: impl FnOnce() -> String) {
        self.count += 1;
        if !ok {
            self.failures.push(describe());
        }
    }

    fn finish(self) {
        assert!(self.count > 0, "{}: no vectors", self.name);
        assert!(
            self.failures.is_empty(),
            "{}: {} of {} vectors differ from Node:\n{}",
            self.name,
            self.failures.len(),
            self.count,
            self.failures
                .iter()
                .take(40)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}

fn ordering(sign: u8) -> Ordering {
    match sign {
        b'<' => Ordering::Less,
        b'>' => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

// ------------------------------------------------------------------ numbers

#[test]
fn number_to_string_matches_node() {
    let file = load("numbers.json");
    let mut check = Check::new("toString");
    for row in rows(&file, "to_string") {
        let (x, expected) = (double(&row[0]), text(&row[1]));
        let actual = number_to_string(x);
        check.expect(actual == expected, || {
            format!("{x:e}: {actual} != {expected}")
        });
    }
    check.finish();
}

#[test]
fn to_fixed_matches_node() {
    let file = load("numbers.json");
    let mut check = Check::new("toFixed");
    for row in rows(&file, "to_fixed") {
        let (x, digits, expected) = (double(&row[0]), int(&row[1]) as u8, text(&row[2]));
        let actual = to_fixed(x, digits);
        check.expect(actual == expected, || {
            format!("{x:e}.toFixed({digits}): {actual} != {expected}")
        });
    }
    check.finish();
}

#[test]
fn locale_numbers_match_node() {
    let file = load("numbers.json");
    let mut check = Check::new("Intl.NumberFormat");
    for row in rows(&file, "locale") {
        let x = double(&row[0]);
        for (locale, expected) in [
            (NumberLocale::EnUs, text(&row[1])),
            (NumberLocale::EsEs, text(&row[2])),
        ] {
            let actual = to_locale_string(x, locale);
            check.expect(actual == expected, || {
                format!("{x:e} {locale:?}: {actual} != {expected}")
            });
        }
    }
    check.finish();
}

#[test]
fn number_coercion_matches_node() {
    let file = load("numbers.json");
    let mut check = Check::new("Number()");
    for row in rows(&file, "parse_number") {
        let (input, expected) = (text(&row[0]), double(&row[1]));
        let actual = parse_number(input);
        check.expect(same(actual, expected), || {
            format!("{input:?}: {actual:e} != {expected:e}")
        });
    }
    check.finish();
}

#[test]
fn parse_int_matches_node() {
    let file = load("numbers.json");
    let mut check = Check::new("parseInt");
    let mut compared = 0;
    for row in rows(&file, "parse_int") {
        let (input, number, expected) = (text(&row[0]), int(&row[1]), double(&row[2]));
        // `Radix` offers only the radices ECMAScript defines exactly; the generator also records
        // others (3, 5, 7, 36, ...), which engines may approximate above 2^53. Those rows have
        // no Rust function to compare with.
        let radix = match number {
            0 => Radix::Auto,
            2 => Radix::Binary,
            8 => Radix::Octal,
            10 => Radix::Decimal,
            16 => Radix::Hex,
            _ => continue,
        };
        compared += 1;
        let actual = parse_int(input, radix);
        check.expect(same(actual, expected), || {
            format!("{input:?} radix {number}: {actual:e} != {expected:e}")
        });
    }
    assert!(
        compared >= 250,
        "only {compared} parseInt vectors were compared"
    );
    check.finish();
}

#[test]
fn parse_float_matches_node() {
    let file = load("numbers.json");
    let mut check = Check::new("parseFloat");
    for row in rows(&file, "parse_float") {
        let (input, expected) = (text(&row[0]), double(&row[1]));
        let actual = parse_float(input);
        check.expect(same(actual, expected), || {
            format!("{input:?}: {actual:e} != {expected:e}")
        });
    }
    check.finish();
}

#[test]
fn math_round_matches_node() {
    let file = load("numbers.json");
    let mut check = Check::new("Math.round");
    for row in rows(&file, "math_round") {
        let (x, expected) = (double(&row[0]), double(&row[1]));
        let actual = math_round(x);
        check.expect(same(actual, expected), || {
            format!("{x:e}: {actual:e} != {expected:e}")
        });
    }
    check.finish();
}

#[test]
fn string_of_matches_node() {
    let file = load("numbers.json");
    let mut check = Check::new("String()");
    for row in rows(&file, "string_of") {
        let (input, expected) = (text(&row[0]), text(&row[1]));
        let value: Value =
            serde_json::from_str(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        let actual = string_of(&value);
        check.expect(actual == expected, || {
            format!("{input}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

// ------------------------------------------------------------------ whitespace

#[test]
fn whitespace_set_matches_node_for_every_code_point() {
    let file = load("whitespace.json");
    let expected: HashSet<u32> = rows(&file, "whitespace")
        .iter()
        .map(|cp| int(cp) as u32)
        .collect();
    let mut check = Check::new("whitespace");
    for ch in (0..=0x10_ffff).filter_map(char::from_u32) {
        let node = expected.contains(&u32::from(ch));
        check.expect(is_js_whitespace(ch) == node, || {
            format!("U+{:04X}: node says {node}", u32::from(ch))
        });
    }
    for row in rows(&file, "trim") {
        let input = text(&row[0]);
        for (actual, expected) in [
            (trim(input), &row[1]),
            (trim_start(input), &row[2]),
            (trim_end(input), &row[3]),
        ] {
            check.expect(actual == text(expected), || {
                format!("{input:?}: {actual:?} != {expected}")
            });
        }
    }
    check.finish();
}

// ------------------------------------------------------------------ JSON

fn has_index_keys(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(has_index_keys),
        Value::Object(map) => map.iter().any(|(key, item)| {
            (key == "0"
                || (!key.starts_with('0')
                    && key.len() <= 10
                    && key.bytes().all(|b| b.is_ascii_digit())))
                || has_index_keys(item)
        }),
        _ => false,
    }
}

#[test]
fn json_stringify_matches_node() {
    let file = load("json.json");
    let mut check = Check::new("JSON.stringify");
    for row in rows(&file, "stringify") {
        let input = text(&row["input"]);
        let value: Value =
            serde_json::from_str(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        let mut ordered = value.clone();
        js_key_order(&mut ordered);
        let actual = to_js_json(&ordered);
        let expected = text(&row["expected"]);
        check.expect(actual == expected, || {
            format!("{input}\n  rust {actual}\n  node {expected}")
        });
        if !has_index_keys(&value) {
            let actual = to_js_json(&value);
            check.expect(actual == expected, || {
                format!("stored order {input}: {actual} != {expected}")
            });
        }
        // The one-pass writer for any `Serialize` type produces the same bytes.
        let one_pass = to_js_json_from(&ordered)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        check.expect(one_pass.as_deref() == Some(expected), || {
            format!("one pass {input}: {one_pass:?} != {expected}")
        });
        for (order, key) in [
            (SortedKeys::Plain, "sorted"),
            (SortedKeys::Rebuilt, "rebuilt"),
        ] {
            let actual = to_js_json_sorted(&value, order);
            let expected = text(&row[key]);
            check.expect(actual == expected, || {
                format!("{key} {input}\n  rust {actual}\n  node {expected}")
            });
        }
    }
    check.finish();
}

fn indent(value: &Value) -> JsonIndent<'_> {
    match (value.get("number"), value.get("text")) {
        (Some(bits), _) => JsonIndent::Number(double(bits)),
        (_, Some(space)) => JsonIndent::Text(text(space)),
        _ => panic!("bad indent {value}"),
    }
}

#[test]
fn json_stringify_pretty_matches_node() {
    let file = load("json.json");
    let mut check = Check::new("JSON.stringify(value, null, space)");
    for row in rows(&file, "pretty") {
        let input = text(&row["input"]);
        let space = indent(&row["indent"]);
        let mut value: Value =
            serde_json::from_str(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        js_key_order(&mut value);
        let expected = text(&row["expected"]);
        let actual = to_js_json_pretty(&value, space);
        check.expect(actual == expected, || {
            format!("{input} {space:?}\n  rust {actual}\n  node {expected}")
        });
        let one_pass = to_js_json_pretty_from(&value, space)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok());
        check.expect(one_pass.as_deref() == Some(expected), || {
            format!("one pass {input} {space:?}: {one_pass:?} != {expected}")
        });
    }
    for row in rows(&file, "gaps") {
        let space = indent(&row["indent"]);
        let expected = row["pretty"]
            .as_bool()
            .is_some_and(|pretty| pretty)
            .then(|| text(&row["gap"]));
        let actual = space.gap();
        check.expect(actual == expected, || {
            format!("gap {space:?}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

#[test]
fn lone_surrogate_repair_matches_node_well_formed_strings() {
    let file = load("json.json");
    let mut check = Check::new("sanitize");
    for row in rows(&file, "sanitize") {
        let (input, expected) = (text(&row["input"]), text(&row["expected"]));
        let repaired = sanitize_lone_surrogates(input.as_bytes());
        let actual = match serde_json::from_slice::<Value>(&repaired) {
            Ok(value) => to_js_json(&value),
            Err(error) => format!("serde_json error: {error}"),
        };
        check.expect(actual == expected, || {
            format!("{input}: {actual} != {expected}")
        });
    }
    check.finish();
}

// ------------------------------------------------------------------ dates

#[test]
fn iso_strings_match_node() {
    let file = load("dates.json");
    let mut check = Check::new("toISOString");
    for row in rows(&file, "iso") {
        let (ms, expected) = (int(&row[0]), row[1].as_str());
        let actual = to_iso_string(ms);
        check.expect(actual.as_deref() == expected, || {
            format!("{ms}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

#[test]
fn date_parse_matches_node() {
    let file = load("dates.json");
    let mut check = Check::new("Date.parse");
    for row in rows(&file, "parse") {
        let (input, expected) = (text(&row[0]), row[1].as_i64());
        let actual = parse_date(input);
        check.expect(actual == expected, || {
            format!("{input:?}: {actual:?} != {expected:?}")
        });
    }
    // Forms only V8's legacy fallback accepts: deliberately unsupported (documented on parse_date).
    for row in rows(&file, "parse_unsupported") {
        let input = text(&row[0]);
        check.expect(row[1].is_i64() && parse_date(input).is_none(), || {
            format!("unsupported {input:?}: {:?}", parse_date(input))
        });
    }
    check.finish();
}

#[test]
fn date_utc_matches_node() {
    let file = load("dates.json");
    let mut check = Check::new("Date.UTC");
    for row in rows(&file, "utc") {
        let f: Vec<i64> = row[0]
            .as_array()
            .map(|fields| fields.iter().map(int).collect())
            .unwrap_or_default();
        let expected = row[1].as_i64();
        let actual = date_utc(f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
        check.expect(actual == expected, || {
            format!("{f:?}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

#[test]
fn utc_fields_match_node() {
    let file = load("dates.json");
    let mut check = Check::new("getUTC*");
    for row in rows(&file, "fields") {
        let ms = int(&row[0]);
        let expected: Vec<i64> = row[1]
            .as_array()
            .map(|fields| fields.iter().map(int).collect())
            .unwrap_or_default();
        let actual = utc_fields(ms).map(|f| {
            vec![
                f.year,
                i64::from(f.month),
                i64::from(f.day),
                i64::from(f.hour),
                i64::from(f.minute),
                i64::from(f.second),
                i64::from(f.millisecond),
                i64::from(f.weekday),
            ]
        });
        check.expect(actual.as_ref() == Some(&expected), || {
            format!("{ms}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

#[test]
fn en_us_locale_strings_match_node() {
    let file = load("dates.json");
    let mut check = Check::new("toLocaleString en-US UTC");
    for row in rows(&file, "locale_string") {
        let (ms, expected) = (int(&row[0]), row[1].as_str());
        let actual = to_locale_string_en_us_utc(ms);
        check.expect(actual.as_deref() == expected, || {
            format!("{ms}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

#[test]
fn date_strings_match_node() {
    let file = load("dates.json");
    let mut check = Check::new("toDateString UTC");
    for row in rows(&file, "date_string") {
        let (ms, expected) = (int(&row[0]), row[1].as_str());
        let actual = to_date_string_utc(ms);
        check.expect(actual.as_deref() == expected, || {
            format!("{ms}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

// ------------------------------------------------------------------ ordering

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().map(|item| text(item).to_owned()).collect())
        .unwrap_or_default()
}

fn check_pairs(
    check: &mut Check,
    list: &[String],
    signs: &str,
    compare: impl Fn(&str, &str) -> Ordering,
) {
    let mut signs = signs.bytes();
    for (i, left) in list.iter().enumerate() {
        for right in list.iter().skip(i + 1) {
            let expected = ordering(signs.next().unwrap_or(b'?'));
            let actual = compare(left, right);
            check.expect(actual == expected, || {
                format!("{left:?} vs {right:?}: {actual:?} != {expected:?}")
            });
        }
    }
    assert!(signs.next().is_none(), "{}: unused pair signs", check.name);
}

#[test]
fn default_sort_order_matches_node() {
    let file = load("order.json");
    let mut check = Check::new("default sort");
    let list = strings(&file["utf16"]["strings"]);
    check_pairs(&mut check, &list, text(&file["utf16"]["pairs"]), cmp_utf16);
    for key in ["utf16", "utf16_random"] {
        let mut sorted = strings(&file[key]["strings"]);
        sorted.sort_by(|a, b| cmp_utf16(a, b));
        let expected = strings(&file[key]["sorted"]);
        check.expect(sorted == expected, || {
            format!("{key}: {sorted:?}\n!= {expected:?}")
        });
    }
    check.finish();
}

#[test]
fn locale_compare_matches_node() {
    let file = load("order.json");
    let collator = Collator::new().unwrap_or_else(|error| panic!("{error}"));
    let mut check = Check::new("localeCompare");
    let list = strings(&file["collation"]["strings"]);
    check_pairs(
        &mut check,
        &list,
        text(&file["collation"]["pairs"]),
        |a, b| collator.compare(a, b),
    );
    for group in rows(&file, "collation_sorted") {
        let mut sorted = strings(&group["input"]);
        sorted.sort_by(|a, b| collator.compare(a, b));
        let expected = strings(&group["sorted"]);
        check.expect(sorted == expected, || {
            format!("sorted {sorted:?}\n!= {expected:?}")
        });
    }
    check.finish();
}

// ------------------------------------------------------------------ characters, UTF-16, case

#[test]
fn utf16_numbers_match_node() {
    let file = load("text.json");
    let mut check = Check::new("UTF-16");
    for row in rows(&file, "utf16") {
        let input = text(&row["text"]);
        check.expect(char_len(input) as i64 == int(&row["chars"]), || {
            format!("{input:?}: char count")
        });
        check.expect(utf16_len(input) as i64 == int(&row["utf16"]), || {
            format!("{input:?}: utf16 length")
        });
        let boundaries: Vec<(usize, usize)> = rows(row, "boundaries")
            .iter()
            .map(|pair| (int(&pair[0]) as usize, int(&pair[1]) as usize))
            .collect();
        for byte in 0..=input.len() + 2 {
            let expected = boundaries
                .iter()
                .rev()
                .find(|(b, _)| *b <= byte)
                .map_or(0, |(_, unit)| *unit);
            let actual = utf16_offset(input, byte);
            check.expect(actual == expected, || {
                format!("{input:?} byte {byte}: {actual} != {expected}")
            });
        }
        for unit in 0..=utf16_len(input) + 2 {
            let expected = boundaries
                .iter()
                .rev()
                .find(|(_, u)| *u <= unit)
                .map_or(0, |(byte, _)| *byte);
            let actual = utf16_to_byte(input, unit);
            check.expect(actual == expected, || {
                format!("{input:?} unit {unit}: {actual} != {expected}")
            });
        }
        for budget in rows(row, "budgets") {
            let (units, expected) = (int(&budget[0]) as usize, text(&budget[1]));
            let actual = truncate_utf16_budget(input, units);
            check.expect(actual == expected, || {
                format!("{input:?} budget {units}: {actual:?} != {expected:?}")
            });
        }
    }
    check.finish();
}

fn mapping(file: &Value, key: &str) -> HashMap<char, String> {
    rows(file, key)
        .iter()
        .filter_map(|row| {
            Some((
                char::from_u32(int(&row[0]) as u32)?,
                text(&row[1]).to_owned(),
            ))
        })
        .collect()
}

#[test]
fn case_mapping_matches_node_for_every_code_point() {
    let file = load("text.json");
    let mut check = Check::new("toLowerCase/toUpperCase");
    let (lower, upper) = (mapping(&file, "lower"), mapping(&file, "upper"));
    for ch in (0..=0x10_ffff).filter_map(char::from_u32) {
        let single = ch.to_string();
        let expected = lower.get(&ch).unwrap_or(&single);
        let actual = to_lower(&single);
        check.expect(&actual == expected, || {
            format!("lower U+{:04X}: {actual:?} != {expected:?}", u32::from(ch))
        });
        let expected = upper.get(&ch).unwrap_or(&single);
        let actual = to_upper(&single);
        check.expect(&actual == expected, || {
            format!("upper U+{:04X}: {actual:?} != {expected:?}", u32::from(ch))
        });
    }
    for row in rows(&file, "case_strings") {
        let input = text(&row[0]);
        check.expect(to_lower(input) == text(&row[1]), || {
            format!("lower {input:?}: {:?}", to_lower(input))
        });
        check.expect(to_upper(input) == text(&row[2]), || {
            format!("upper {input:?}: {:?}", to_upper(input))
        });
    }
    check.finish();
}

#[test]
fn nfc_matches_node() {
    let file = load("text.json");
    let mut check = Check::new("normalize NFC");
    let singles = mapping(&file, "nfc_singles");
    for ch in (0..=0x10_ffff).filter_map(char::from_u32) {
        let single = ch.to_string();
        let expected = singles.get(&ch).unwrap_or(&single);
        let actual = nfc(&single);
        check.expect(actual == expected.as_str(), || {
            format!("U+{:04X}: {actual:?} != {expected:?}", u32::from(ch))
        });
    }
    for row in rows(&file, "nfc_strings") {
        let (input, expected) = (text(&row[0]), text(&row[1]));
        let actual = nfc(input);
        check.expect(actual == expected, || {
            format!("{input:?}: {actual:?} != {expected:?}")
        });
    }
    check.finish();
}

// ------------------------------------------------------------------ URI escapes

#[test]
fn uri_encoding_matches_node() {
    let file = load("uri.json");
    let mut check = Check::new("encodeURIComponent/encodeURI");
    for row in rows(&file, "encode") {
        let input = text(&row[0]);
        let component = encode_uri_component(input);
        check.expect(component == text(&row[1]), || {
            format!("encodeURIComponent({input:?}): {component:?} != {}", row[1])
        });
        let uri = encode_uri(input);
        check.expect(uri == text(&row[2]), || {
            format!("encodeURI({input:?}): {uri:?} != {}", row[2])
        });
    }
    // Above ASCII both escape every UTF-8 byte; the generator checks this rule with Node for every
    // scalar value, so it is applied here to every code point.
    for ch in (0x80..=0x10_ffff).filter_map(char::from_u32) {
        let mut buffer = [0; 4];
        let single = ch.encode_utf8(&mut buffer);
        let expected: String = single.bytes().map(|byte| format!("%{byte:02X}")).collect();
        check.expect(
            encode_uri_component(single) == expected && encode_uri(single) == expected,
            || format!("U+{:04X}", u32::from(ch)),
        );
    }
    check.finish();
}

#[test]
fn uri_decoding_matches_node() {
    let file = load("uri.json");
    let mut check = Check::new("decodeURIComponent/decodeURI");
    for row in rows(&file, "decode") {
        let input = text(&row[0]);
        let component = decode_uri_component(input).ok();
        check.expect(component.as_deref() == row[1].as_str(), || {
            format!("decodeURIComponent({input:?}): {component:?} != {}", row[1])
        });
        let uri = decode_uri(input).ok();
        check.expect(uri.as_deref() == row[2].as_str(), || {
            format!("decodeURI({input:?}): {uri:?} != {}", row[2])
        });
    }
    check.finish();
}

// ------------------------------------------------------------------ JSON.parse

/// The generator's dump: every number as `{"n": "<16 hex digits of its bits>"}`.
fn with_number_bits(value: &Value) -> Value {
    match value {
        Value::Number(number) => {
            let bits = number.as_f64().unwrap_or(f64::NAN).to_bits();
            serde_json::json!({ "n": format!("{bits:016x}") })
        }
        Value::Array(items) => Value::Array(items.iter().map(with_number_bits).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), with_number_bits(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn json_parse_matches_node() {
    let file = load("json_parse.json");
    let mut check = Check::new("JSON.parse");
    // JavaScript has no limits; these are high enough for every vector.
    let limits = JsonLimits {
        max_depth: 10_000,
        max_bytes: 1 << 20,
    };
    for row in rows(&file, "parse") {
        let input = text(&row["input"]);
        let actual = parse_js_json(input, limits);
        let shown = || format!("{:?}", input.chars().take(120).collect::<String>());
        if let Some(expected) = row["held"].as_str() {
            let actual = actual
                .as_ref()
                .map(|value| to_js_json(&with_number_bits(value)));
            check.expect(actual.as_deref() == Ok(expected), || {
                format!("{}\n  rust {actual:?}\n  node {expected}", shown())
            });
        } else if row["infinite"].as_bool() == Some(true) {
            // `Infinity` in JavaScript; a parse error here (allowed difference).
            check.expect(
                matches!(actual, Err(JsonParseError::NumberOutOfRange { .. })),
                || format!("{}: {actual:?} should be out of range", shown()),
            );
        } else {
            check.expect(matches!(actual, Err(JsonParseError::Syntax { .. })), || {
                format!("{}: {actual:?} should throw", shown())
            });
        }
    }
    check.finish();
}

// ------------------------------------------------------------------ Date text

#[test]
fn date_text_matches_node() {
    let file = load("date_text.json");
    let mut check = Check::new("toString/toUTCString/toISOString");
    for row in rows(&file, "date_text") {
        let ms = int(&row[0]);
        for (name, actual, expected) in [
            ("toString", to_string_utc(ms), &row[1]),
            ("toUTCString", to_utc_string(ms), &row[2]),
            ("toISOString", to_iso_string(ms), &row[3]),
        ] {
            check.expect(actual.as_deref() == expected.as_str(), || {
                format!("{ms} {name}: {actual:?} != {expected}")
            });
        }
    }
    check.finish();
}

// ------------------------------------------------------------------ a value as JavaScript sees it

#[test]
fn js_view_matches_node() {
    let file = load("view.json");
    let mut check = Check::new("String/Number/Boolean/Object.keys");
    for row in rows(&file, "js_view") {
        let input = text(&row[0]);
        // Keys in text order: the property order must come from `js_object_keys`.
        let value: Value =
            serde_json::from_str(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        let string = js_string(&value);
        check.expect(string == text(&row[1]), || {
            format!("String({input}): {string:?} != {}", row[1])
        });
        let number = js_number(&value);
        check.expect(same(number, double(&row[2])), || {
            format!("Number({input}): {number:e} != {:e}", double(&row[2]))
        });
        let truthy = js_truthy(&value);
        check.expect(Some(truthy) == row[3].as_bool(), || {
            format!("Boolean({input}): {truthy} != {}", row[3])
        });
        let keys = js_object_keys(&value);
        let expected: Vec<&str> = row[4]
            .as_array()
            .map(|keys| keys.iter().map(text).collect())
            .unwrap_or_default();
        check.expect(keys == expected, || {
            format!("Object.keys({input}): {keys:?} != {expected:?}")
        });
    }
    check.finish();
}
