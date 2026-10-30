#![cfg(feature = "moderation-blacklist")]

use dima_rust::utils::{
    js_string::JsString,
    moderation::blacklist::{
        BlacklistPattern, BlacklistRule, compile_blacklist_pattern, evaluate_blacklist_rule,
    },
};

fn js(text: &str) -> JsString {
    JsString::from(text)
}
fn pattern(terms: &[&str]) -> BlacklistPattern {
    compile_blacklist_pattern(Some(&terms.iter().map(|s| js(s)).collect::<Vec<_>>())).unwrap()
}
fn evaluate(pattern: &BlacklistPattern, text: &str) -> Option<JsString> {
    evaluate_blacklist_rule(&BlacklistRule::default(), Some(&js(text)), Some(pattern)).matched_text
}

#[test]
fn original_blacklist_groups() {
    let p = pattern(&["badword"]);
    assert_eq!(
        evaluate(&p, "you said a BADWORD there"),
        Some(js("badword"))
    );
    let p = pattern(&["ass"]);
    assert_eq!(evaluate(&p, "that is a classic move"), None);
    assert_eq!(evaluate(&p, "you are an ass"), Some(js("ass")));
    assert_eq!(
        evaluate(&pattern(&["café"]), "meet at the cafe"),
        Some(js("cafe"))
    );
    assert_eq!(
        evaluate(&pattern(&["cafe"]), "meet at the CAFÉ"),
        Some(js("cafe"))
    );
    let p = pattern(&["buy followers now"]);
    assert_eq!(
        evaluate(&p, "BUY  FOLLOWERS   NOW cheap"),
        Some(js("buy  followers   now"))
    );
    assert_eq!(evaluate(&p, "buy followers tomorrow"), None);
    assert!(compile_blacklist_pattern(None).is_none());
    assert!(compile_blacklist_pattern(Some(&[])).is_none());
    assert!(compile_blacklist_pattern(Some(&[js("  "), js("")])).is_none());
    assert!(
        !evaluate_blacklist_rule(&BlacklistRule::default(), Some(&js("anything")), None).triggered
    );
    let p = pattern(&["free.money"]);
    assert_eq!(evaluate(&p, "get free.money here"), Some(js("free.money")));
    assert_eq!(evaluate(&p, "get freexmoney here"), None);
    let p = pattern(&["ñoño"]);
    assert_eq!(evaluate(&p, "di Nono"), Some(js("nono")));
    assert_eq!(evaluate(&p, "añonimo"), None);
}

#[test]
fn alternation_priority_and_boundary_fallback() {
    // The first term wins even though its matched span is shorter.
    let p = pattern(&["a       b", "a b!"]);
    let hit = p.exec(&js("a b!")).unwrap();
    assert_eq!((hit.start, hit.end, hit.matched_text), (0, 3, js("a b")));
    // An earlier terminal rejected by the lookahead must fall through.
    let p = pattern(&["a      b", "a bc"]);
    assert_eq!(p.exec(&js("a bc")).unwrap().matched_text, js("a bc"));
    let p = pattern(&["a b", "a b!"]);
    assert_eq!(p.exec(&js("prefix a b! then a b")).unwrap().start, 7);
}

#[test]
fn ascii_boundaries_priority_and_case_are_preserved() {
    let p = pattern(&["bad"]);
    let hit = p.exec(&js("a_bad! next BAD")).unwrap();
    assert_eq!((hit.start, hit.end, hit.matched_text), (2, 5, js("bad")));
    assert!(p.exec(&js("abad bad2")).is_none());
    let hit = p.exec(&js("!BAD_")).unwrap();
    assert_eq!((hit.start, hit.end, hit.matched_text), (1, 4, js("BAD")));

    // Prefix punctuation can itself be the start of the earliest alternative.
    let p = pattern(&["!ab", "ab"]);
    assert_eq!(p.exec(&js("!ab!")).unwrap().matched_text, js("!ab"));
    // The longer source term has higher priority, even when its whitespace
    // run matches fewer characters; a failed right boundary retries another.
    let p = pattern(&["a       b", "a b!"]);
    assert_eq!(p.exec(&js("a b!")).unwrap().matched_text, js("a b"));
    let p = pattern(&["a       b", "a bc"]);
    assert_eq!(p.exec(&js("a bc")).unwrap().matched_text, js("a bc"));
    assert_eq!(
        pattern(&[".*(x)[y]\\z"])
            .exec(&js("!.*(X)[y]\\Z_"))
            .unwrap()
            .matched_text,
        js(".*(X)[y]\\Z")
    );
}

#[test]
fn ascii_whitespace_runs_and_unicode_fallback() {
    let p = pattern(&["a b"]);
    for space in [" ", "\t", "\n", "\r", "\u{000b}", "\u{000c}"] {
        let text = format!("!A{space}{space}B_");
        assert_eq!(
            p.exec(&js(&text)).unwrap().matched_text,
            js(&text[1..text.len() - 1])
        );
    }
    assert!(p.exec(&js("a\0b")).is_none());
    assert_eq!(
        p.exec(&js("a\u{feff}b")).unwrap().matched_text,
        js("a\u{feff}b")
    );
    assert!(p.exec(&js("a\u{0085}b")).is_none());

    // Non-ASCII case folding and lone surrogates must use the UTF-16 trie.
    let p = pattern(&["k"]);
    assert_eq!(p.exec(&js("K")).unwrap().matched_text, js("K"));
    assert!(pattern(&["x"]).exec(&js("𐐀x")).is_none());
    let lone = JsString::from_units(vec![0xd800, u16::from(b'k'), 0xdc00]);
    let hit = p.exec(&lone).unwrap();
    assert_eq!((hit.start, hit.end, hit.matched_text), (1, 2, js("k")));
}

#[test]
fn long_ascii_prefilter_preserves_boundaries_and_priority() {
    let prefix = "ordinary message ".repeat(40);
    let p = pattern(&["badword", "free money"]);
    assert!(p.exec(&js(&prefix)).is_none());
    assert!(p.exec(&js(&format!("{prefix}xbadword badword2"))).is_none());
    let text = format!("{prefix}xbadword BADWORD! free money");
    let hit = p.exec(&js(&text)).unwrap();
    assert_eq!(
        (hit.start, hit.end, hit.matched_text),
        (prefix.len() + 9, prefix.len() + 16, js("BADWORD"))
    );
    let text = format!("{prefix}FREE\t MONEY_");
    assert_eq!(p.exec(&js(&text)).unwrap().matched_text, js("FREE\t MONEY"));

    let p = pattern(&["a       b", "a b!", "a bc"]);
    let hit = p.exec(&js(&format!("{prefix}a b!"))).unwrap();
    assert_eq!((hit.start, hit.matched_text), (prefix.len(), js("a b")));
    let hit = p.exec(&js(&format!("{prefix}a bc"))).unwrap();
    assert_eq!((hit.start, hit.matched_text), (prefix.len(), js("a bc")));
}

#[test]
fn source_escape_and_whitespace() {
    let p = pattern(&["  a/b.+\\c\t  d  "]);
    assert_eq!(p.flags(), "iu");
    assert_eq!(
        p.source().as_str(),
        Some(r"(?<![\p{L}\p{N}])(?:a\/b\.\+\\c\s+d)(?![\p{L}\p{N}])")
    );
    assert_eq!(
        p.exec(&js("!a/b.+\\c\n\u{feff}d!")).unwrap().matched_text,
        js("a/b.+\\c\n\u{feff}d")
    );
    assert!(p.exec(&js("!a/b.+\\c\u{0085}d!")).is_none());
}

#[test]
fn unicode_cases_boundaries_and_utf16() {
    let p = pattern(&["σ", "s", "k"]);
    assert_eq!(p.exec(&js("ς")).unwrap().matched_text, js("ς"));
    assert_eq!(p.exec(&js("ſ")).unwrap().matched_text, js("ſ"));
    assert_eq!(p.exec(&js("K")).unwrap().matched_text, js("K"));
    assert!(pattern(&["x"]).exec(&js("\u{0345}x")).is_none());
    assert!(pattern(&["x"]).exec(&js("𐐀x")).is_none());
    assert!(pattern(&["x"]).exec(&js("\u{1e6c0}x")).is_none());
    assert_eq!(pattern(&["x"]).exec(&js("😀x")).unwrap().start, 2);
    let lone_high = JsString::from_units(vec![0xd83d]);
    let p = compile_blacklist_pattern(Some(std::slice::from_ref(&lone_high))).unwrap();
    assert!(p.exec(&js("😀")).is_none());
    let text = JsString::from_units(vec![0xdc00, u16::from(b' '), 0xd83d, u16::from(b'!')]);
    let hit = p.exec(&text).unwrap();
    assert_eq!((hit.start, hit.end, hit.matched_text), (2, 3, lone_high));
    let p = compile_blacklist_pattern(Some(&[JsString::from_units(vec![0xdc00])])).unwrap();
    assert!(p.exec(&js("😀")).is_none());
    assert_eq!(p.exec(&text).unwrap().matched_text.units(), vec![0xdc00]);
    assert!(
        !evaluate_blacklist_rule(&BlacklistRule::default(), None, Some(&pattern(&["x"]))).triggered
    );
}
#[path = "support/sha256.rs"]
mod digest;
use digest::sha256_hex;

fn fixture_units(value: &serde_json::Value) -> JsString {
    JsString::from_units(
        value
            .as_array()
            .expect("UTF-16 units")
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().expect("unit")).expect("u16"))
            .collect(),
    )
}

#[test]
#[ignore = "requires hash-pinned external fixture from actual TypeScript exports"]
fn replay_actual_blacklist_exports() {
    use dima_rust::utils::moderation::normalize::fold_text;
    use std::path::PathBuf;

    let dir = PathBuf::from(
        std::env::var_os("DIMA_MODERATION_BLACKLIST_FIXTURE_DIR")
            .expect("external fixture directory required"),
    );
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(
        !dir.starts_with(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .canonicalize()
                .unwrap()
        )
    );
    let expected_hash = std::env::var("DIMA_MODERATION_BLACKLIST_FIXTURE_SHA256")
        .expect("independently verified fixture SHA-256 required");
    assert!(
        expected_hash.len() == 64
            && expected_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = std::fs::read(dir.join("moderation-blacklist-reference.json"))
        .expect("external actual-source fixture required");
    assert_eq!(sha256_hex(&bytes), expected_hash);
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let metadata = &fixture["metadata"];
    assert_eq!(metadata["format"], 1);
    assert_eq!(
        metadata["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (key, expected) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(metadata["versions"][key], expected);
    }
    for (key, source, pinned) in [
        (
            "src/utils/moderation/rules/blacklist.rule.ts",
            include_bytes!("../src/utils/moderation/rules/blacklist.rule.ts").as_slice(),
            "8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff",
        ),
        (
            "src/utils/moderation/normalize.ts",
            include_bytes!("../src/utils/moderation/normalize.ts").as_slice(),
            "07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab",
        ),
    ] {
        assert_eq!(sha256_hex(source), pinned);
        assert_eq!(metadata["pins"][key], pinned);
    }
    let cases = fixture["cases"].as_array().expect("fixture cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let terms = case["terms"]
            .as_array()
            .map(|items| items.iter().map(fixture_units).collect::<Vec<_>>());
        let text = (!case["text"].is_null()).then(|| fixture_units(&case["text"]));
        let pattern = compile_blacklist_pattern(terms.as_deref());
        if let Some(pattern) = &pattern {
            assert_eq!(
                pattern.source(),
                &fixture_units(&case["compiled"]["source"]),
                "{name} source"
            );
            assert_eq!(
                pattern.flags(),
                case["compiled"]["flags"].as_str().unwrap(),
                "{name} flags"
            );
        } else {
            assert!(case["compiled"].is_null(), "{name} compiled");
        }
        let folded = fold_text(text.as_ref());
        assert_eq!(
            folded.as_ref(),
            &fixture_units(&case["foldedText"]),
            "{name} fold"
        );
        let empty = JsString::from_static("");
        for (actual, expected) in [
            (
                pattern.as_ref().and_then(|p| p.exec(&folded)),
                &case["execFolded"],
            ),
            (
                pattern
                    .as_ref()
                    .and_then(|p| p.exec(text.as_ref().unwrap_or(&empty))),
                &case["execRaw"],
            ),
        ] {
            match actual {
                Some(hit) => {
                    assert_eq!(
                        hit.start as u64,
                        expected["start"].as_u64().unwrap(),
                        "{name} start"
                    );
                    assert_eq!(
                        hit.end as u64,
                        expected["end"].as_u64().unwrap(),
                        "{name} end"
                    );
                    assert_eq!(
                        hit.matched_text,
                        fixture_units(&expected["match"]),
                        "{name} match"
                    );
                }
                None => assert!(expected.is_null(), "{name} expected match"),
            }
        }
        let result =
            evaluate_blacklist_rule(&BlacklistRule::default(), text.as_ref(), pattern.as_ref());
        assert_eq!(
            result.triggered,
            case["evaluation"]["triggered"].as_bool().unwrap(),
            "{name} triggered"
        );
        let expected = &case["evaluation"]["matchedText"];
        assert_eq!(
            result.matched_text,
            (!expected.is_null()).then(|| fixture_units(expected)),
            "{name} evaluation"
        );
    }
}
