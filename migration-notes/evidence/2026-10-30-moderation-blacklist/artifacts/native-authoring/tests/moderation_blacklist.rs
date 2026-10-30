#![cfg(feature = "moderation-blacklist")]

use dima_rust::utils::{
    js_string::JsString,
    moderation::blacklist::{compile_blacklist_pattern, evaluate_blacklist_rule, BlacklistPattern, BlacklistRule},
};

fn js(text: &str) -> JsString { JsString::from(text) }
fn pattern(terms: &[&str]) -> BlacklistPattern {
    compile_blacklist_pattern(Some(&terms.iter().map(|s| js(s)).collect::<Vec<_>>())).unwrap()
}
fn evaluate(pattern: &BlacklistPattern, text: &str) -> Option<JsString> {
    evaluate_blacklist_rule(&BlacklistRule::default(), Some(&js(text)), Some(pattern)).matched_text
}

#[test]
fn original_blacklist_groups() {
    let p = pattern(&["badword"]);
    assert_eq!(evaluate(&p, "you said a BADWORD there"), Some(js("badword")));
    let p = pattern(&["ass"]);
    assert_eq!(evaluate(&p, "that is a classic move"), None);
    assert_eq!(evaluate(&p, "you are an ass"), Some(js("ass")));
    assert_eq!(evaluate(&pattern(&["café"]), "meet at the cafe"), Some(js("cafe")));
    assert_eq!(evaluate(&pattern(&["cafe"]), "meet at the CAFÉ"), Some(js("cafe")));
    let p = pattern(&["buy followers now"]);
    assert_eq!(evaluate(&p, "BUY  FOLLOWERS   NOW cheap"), Some(js("buy  followers   now")));
    assert_eq!(evaluate(&p, "buy followers tomorrow"), None);
    assert!(compile_blacklist_pattern(None).is_none());
    assert!(compile_blacklist_pattern(Some(&[])).is_none());
    assert!(compile_blacklist_pattern(Some(&[js("  "), js("")])).is_none());
    assert!(!evaluate_blacklist_rule(&BlacklistRule::default(), Some(&js("anything")), None).triggered);
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
fn source_escape_and_whitespace() {
    let p = pattern(&["  a/b.+\\c\t  d  "]);
    assert_eq!(p.flags(), "iu");
    assert_eq!(p.source().as_str(), Some(r"(?<![\p{L}\p{N}])(?:a\/b\.\+\\c\s+d)(?![\p{L}\p{N}])"));
    assert_eq!(p.exec(&js("!a/b.+\\c\n\u{feff}d!")).unwrap().matched_text, js("a/b.+\\c\n\u{feff}d"));
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
    let p = compile_blacklist_pattern(Some(&[lone_high.clone()])).unwrap();
    assert!(p.exec(&js("😀")).is_none());
    let text = JsString::from_units(vec![0xdc00, b' ', 0xd83d, b'!']);
    let hit = p.exec(&text).unwrap();
    assert_eq!((hit.start, hit.end, hit.matched_text), (2, 3, lone_high));
    let p = compile_blacklist_pattern(Some(&[JsString::from_units(vec![0xdc00])])).unwrap();
    assert!(p.exec(&js("😀")).is_none());
    assert_eq!(p.exec(&text).unwrap().matched_text.units(), vec![0xdc00]);
    assert!(!evaluate_blacklist_rule(&BlacklistRule::default(), None, Some(&pattern(&["x"]))).triggered);
}
pub fn sha256_hex(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut padded = bytes.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&(bytes.len() as u64 * 8).to_be_bytes());
    for chunk in padded.as_chunks::<64>().0 {
        let mut words = [0u32; 64];
        for (index, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            words[index] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let a = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let b = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(a)
                .wrapping_add(words[i - 7])
                .wrapping_add(b);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let x = h
                .wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add((e & f) ^ (!e & g))
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let y = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22))
                .wrapping_add((a & b) ^ (a & c) ^ (b & c));
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(x);
            d = c;
            c = b;
            b = a;
            a = x.wrapping_add(y);
        }
        for (slot, word) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(word);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

fn fixture_units(value: &serde_json::Value) -> JsString {
    JsString::from_units(value.as_array().expect("UTF-16 units").iter()
        .map(|unit| u16::try_from(unit.as_u64().expect("unit")).expect("u16"))
        .collect())
}

#[test]
#[ignore = "requires hash-pinned external fixture from actual TypeScript exports"]
fn replay_actual_blacklist_exports() {
    use dima_rust::utils::moderation::normalize::fold_text;
    use std::path::PathBuf;

    let dir = PathBuf::from(std::env::var_os("DIMA_MODERATION_BLACKLIST_FIXTURE_DIR")
        .expect("external fixture directory required"));
    assert!(dir.is_absolute());
    assert_eq!(dir.canonicalize().unwrap(), dir);
    assert!(!dir.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap()));
    let expected_hash = std::env::var("DIMA_MODERATION_BLACKLIST_FIXTURE_SHA256")
        .expect("independently verified fixture SHA-256 required");
    assert!(expected_hash.len() == 64 && expected_hash.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let bytes = std::fs::read(dir.join("moderation-blacklist-reference.json"))
        .expect("external actual-source fixture required");
    assert_eq!(sha256_hex(&bytes), expected_hash);
    let fixture: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let metadata = &fixture["metadata"];
    assert_eq!(metadata["format"], 1);
    assert_eq!(metadata["nodeSha"], "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108");
    for (key, expected) in [("node", "24.22.1"), ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"), ("unicode", "17.0"), ("typescript", "5.9.3")] {
        assert_eq!(metadata["versions"][key], expected);
    }
    for (key, source, pinned) in [
        ("src/utils/moderation/rules/blacklist.rule.ts", include_bytes!("../src/utils/moderation/rules/blacklist.rule.ts").as_slice(), "8feb8779f829b72e6fc1f6907a7a8e3b3284dd92b04dcc08980b25120f9144ff"),
        ("src/utils/moderation/normalize.ts", include_bytes!("../src/utils/moderation/normalize.ts").as_slice(), "07822ff6efe5d707173b6b9e9415b16edfb0eb055c3a03416bf4b4c0c11740ab"),
    ] {
        assert_eq!(sha256_hex(source), pinned);
        assert_eq!(metadata["pins"][key], pinned);
    }
    let cases = fixture["cases"].as_array().expect("fixture cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let terms = case["terms"].as_array().map(|items| items.iter().map(fixture_units).collect::<Vec<_>>());
        let text = (!case["text"].is_null()).then(|| fixture_units(&case["text"]));
        let pattern = compile_blacklist_pattern(terms.as_deref());
        if let Some(pattern) = &pattern {
            assert_eq!(pattern.source(), &fixture_units(&case["compiled"]["source"]), "{name} source");
            assert_eq!(pattern.flags(), case["compiled"]["flags"].as_str().unwrap(), "{name} flags");
        } else {
            assert!(case["compiled"].is_null(), "{name} compiled");
        }
        let folded = fold_text(text.as_ref());
        assert_eq!(folded.as_ref(), &fixture_units(&case["foldedText"]), "{name} fold");
        let empty = JsString::from_static("");
        for (actual, expected) in [
            (pattern.as_ref().and_then(|p| p.exec(&folded)), &case["execFolded"]),
            (pattern.as_ref().and_then(|p| p.exec(text.as_ref().unwrap_or(&empty))), &case["execRaw"]),
        ] {
            match actual {
                Some(hit) => {
                    assert_eq!(hit.start as u64, expected["start"].as_u64().unwrap(), "{name} start");
                    assert_eq!(hit.end as u64, expected["end"].as_u64().unwrap(), "{name} end");
                    assert_eq!(hit.matched_text, fixture_units(&expected["match"]), "{name} match");
                }
                None => assert!(expected.is_null(), "{name} expected match"),
            }
        }
        let result = evaluate_blacklist_rule(&BlacklistRule::default(), text.as_ref(), pattern.as_ref());
        assert_eq!(result.triggered, case["evaluation"]["triggered"].as_bool().unwrap(), "{name} triggered");
        let expected = &case["evaluation"]["matchedText"];
        assert_eq!(result.matched_text, (!expected.is_null()).then(|| fixture_units(expected)), "{name} evaluation");
    }
}
