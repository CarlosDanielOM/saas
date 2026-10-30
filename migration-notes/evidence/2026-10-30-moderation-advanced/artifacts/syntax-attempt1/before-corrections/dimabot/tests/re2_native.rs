#![cfg(feature = "re2-native")]

use dima_rust::utils::{js_string::JsString, re2_native::Re2Native};

fn run(source: &str, input: &str, ignore_case: bool) -> Option<Vec<Option<Vec<u16>>>> {
    Re2Native::compile(&JsString::from(source), ignore_case, true)
        .unwrap()
        .exec(&JsString::from(input))
        .map(|m| {
            m.captures
                .into_iter()
                .map(|c| c.map(|c| c.text.units()))
                .collect()
        })
}

#[test]
fn pinned_properties_folds_and_ascii_words() {
    assert!(run(r"\p{Letter}+", "123Σ", false).is_some());
    assert!(run("Σ", "ς", true).is_some());
    assert!(run("k", "K", true).is_some());
    assert!(run(r"\w+", "é", false).is_none());
    assert!(run(r"\p{Emoji}", "😀", false).is_some());
    assert!(Re2Native::compile(&JsString::from(r"\p{Tolong_Siki}"), false, true).is_err());
}

#[test]
fn groups_offsets_and_partial_byte_captures() {
    let re = Re2Native::compile(&JsString::from(r"(\C)(\C)"), false, true).unwrap();
    let m = re.exec(&JsString::from("😀")).unwrap();
    let first = m.captures[1].as_ref().unwrap();
    let second = m.captures[2].as_ref().unwrap();
    assert_eq!(first.text.units(), vec![0xfffd]);
    assert_eq!(
        (first.byte_start, first.byte_end, first.start, first.end),
        (0, 1, 0, 2)
    );
    assert_eq!(
        (second.byte_start, second.byte_end, second.start, second.end),
        (1, 2, 2, 3)
    );
    assert!(run(r"\C", "\n", false).is_some());
    let m = Re2Native::compile(&JsString::from("(a)?b"), false, true)
        .unwrap()
        .exec(&JsString::from("😀b"))
        .unwrap();
    assert_eq!(m.index, 2);
    assert!(m.captures[1].is_none());
}

#[test]
fn unsupported_syntax_and_case_scopes() {
    for pattern in [r"(a)\1", "a(?=b)", "a**", "a*+"] {
        assert!(
            Re2Native::compile(&JsString::from(pattern), false, false).is_err(),
            "{pattern}"
        );
    }
    assert!(run("(?i:a)b", "Ab", false).is_some());
    assert!(run("(?i:a)b", "AB", false).is_none());
}

#[path = "support/sha256.rs"]
mod digest;

/// Reports each mismatch rather than hiding unsupported SDK behavior.
/// Independent pinned source fixture; no production dependencies.
#[test]
#[ignore = "requires the pinned external source oracle and integration feature"]
fn replay_node24_reference() {
    use serde_json::Value;
    let path = std::env::var("DIMA_RE2_ADVANCED_REFERENCE").expect("reference path");
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        digest::sha256_hex(&bytes),
        "dbdc74c2127fdbe434de83bb4153521d4cc22b639bb7c08c10db375da2e0c78a"
    );
    let doc: Value = serde_json::from_slice(&bytes).unwrap();
    let units = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u16)
            .collect::<Vec<_>>()
    };
    let field = |obj: &Value, name: &str| -> Value {
        obj["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|pair| {
                let key: String = units(&pair[0])
                    .into_iter()
                    .map(|c| char::from_u32(c as u32).unwrap())
                    .collect();
                (key == name).then(|| pair[1].clone())
            })
            .unwrap()
    };
    let number = |v: &Value| {
        f64::from_bits(u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap()) as usize
    };
    let mut mismatches = Vec::new();
    for (section, expected_count) in [
        ("re2Cases", 91),
        ("regexBehaviorCases", 604),
        ("wrapperCases", 45),
    ] {
        let cases = doc[section].as_array().unwrap();
        assert_eq!(cases.len(), expected_count);
        let mut passed = 0;
        for (n, case) in cases.iter().enumerate() {
            let mut source = units(&case["source"]);
            if section == "wrapperCases" {
                let mut prefix: Vec<u16> = r"(^|[^\p{L}\p{N}])(".encode_utf16().collect();
                prefix.append(&mut source);
                prefix.extend(r")($|[^\p{L}\p{N}])".encode_utf16());
                source = prefix;
            }
            let flags = case.get("flags").map(&units).unwrap_or_default();
            let icase = flags.contains(&(b'i' as u16));
            let compiled = Re2Native::compile(&JsString::from_units(source), icase, true);
            let expected = &case["result"];
            let matches = if expected["ok"] == false {
                compiled.is_err()
            } else if let Ok(re) = compiled {
                let actual = re.exec(&JsString::from_units(units(&case["text"])));
                let value = &expected["value"];
                if value["kind"] == "null" {
                    actual.is_none()
                } else if let Some(actual) = actual {
                    let groups = field(value, "groups");
                    let indices = field(value, "indices");
                    let expected_groups = groups["items"].as_array().unwrap();
                    let expected_indices = indices["items"].as_array().unwrap();
                    actual.index == number(&field(value, "index"))
                        && actual.captures.len() == expected_groups.len()
                        && actual
                            .captures
                            .iter()
                            .zip(expected_groups)
                            .zip(expected_indices)
                            .all(|((actual, group), index)| match actual {
                                None => group["kind"] == "undefined",
                                Some(actual) => {
                                    group["kind"] == "string"
                                        && actual.text.units() == units(&group["utf16"])
                                        && actual.start == number(&index["items"][0])
                                        && actual.end == number(&index["items"][1])
                                }
                            })
                } else {
                    false
                }
            } else {
                false
            };
            if matches {
                passed += 1;
            } else {
                mismatches.push(format!("{section}[{n}]: {case}"));
            }
        }
        eprintln!("{section}: {passed}/{expected_count}");
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
