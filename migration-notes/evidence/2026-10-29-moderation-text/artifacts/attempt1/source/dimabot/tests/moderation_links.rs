#![cfg(feature = "moderation-links")]
use dima_rust::utils::js_string::JsString;
use dima_rust::utils::moderation::links_rule::{
    LinksEvaluationInput, LinksRule, evaluate_links_rule,
};

#[test]
fn duplicates_order_and_allowlist() {
    let text = JsString::from("www.Example.com/path EXAMPLE.com https://x.bad.org/ok");
    let allowed = [JsString::from("example.com")];
    let result = evaluate_links_rule(
        LinksRule {
            allowlist_domains: Some(&allowed),
        },
        LinksEvaluationInput { text: Some(&text) },
    );
    assert_eq!(
        result.urls,
        vec![
            JsString::from("example.com"),
            JsString::from("example.com"),
            JsString::from("x.bad.org")
        ]
    );
    assert_eq!(result.blocked_url, Some(JsString::from("x.bad.org")));
    assert!(result.triggered);
}

#[test]
fn prefix_hosts_nullish_and_surrogates() {
    let empty = evaluate_links_rule(
        LinksRule {
            allowlist_domains: None,
        },
        LinksEvaluationInput { text: None },
    );
    assert!(!empty.triggered);
    assert!(empty.urls.is_empty());
    assert!(empty.blocked_url.is_none());
    let text = JsString::from_units(vec![
        104, 116, 116, 112, 58, 47, 47, 0xd800, 46, 65, 47, 0xdc00,
    ]);
    let result = evaluate_links_rule(
        LinksRule {
            allowlist_domains: None,
        },
        LinksEvaluationInput { text: Some(&text) },
    );
    assert_eq!(
        result.urls,
        vec![JsString::from_units(vec![0xd800, 46, 97])]
    );
    assert_eq!(result.blocked_url, result.urls.first().cloned());
    let text = JsString::from(format!("{}a.x", "a.".repeat(20000)));
    let result = evaluate_links_rule(
        LinksRule {
            allowlist_domains: None,
        },
        LinksEvaluationInput { text: Some(&text) },
    );
    assert!(result.urls.is_empty());
}

#[test]
fn backtracking_and_non_url_parser_behavior() {
    let text = JsString::from("a.ab-foo.xy a.ab-c http://USER:PASS@EXAMPLE.COM/path");
    let result = evaluate_links_rule(
        LinksRule {
            allowlist_domains: None,
        },
        LinksEvaluationInput { text: Some(&text) },
    );
    assert_eq!(
        result.urls,
        vec![JsString::from("a.ab-foo.xy"), JsString::from("a.ab")]
    );
    // The last prefix matches but host "user" has no dot, so it is omitted.
}

#[test]
#[ignore = "external pinned actual-source corpus required"]
fn replay_actual_source() {
    use serde_json::Value;
    let dir = std::env::var("DIMA_LINKS_REFERENCE_DIR").expect("reference directory");
    let data: Value = serde_json::from_slice(
        &std::fs::read(std::path::Path::new(&dir).join("moderation_links_reference.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        data["metadata"]["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    assert_eq!(
        data["metadata"]["pins"]["src/utils/moderation/rules/links.rule.ts"],
        "802150266d30c163a4069dd434b723e0320aed50ed34bc2f5674ac267aa41ad0"
    );
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(
        data["metadata"]["total"].as_u64().unwrap() as usize,
        cases.len()
    );
    assert!(cases.len() > 40000);
    let units = |v: &Value| {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u16)
            .collect::<Vec<_>>()
    };
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let text = match case["textKind"].as_str().unwrap() {
            "string" => Some(JsString::from_units(units(&case["text"]))),
            "missing" | "null" => {
                assert!(case["text"].is_null());
                None
            }
            _ => panic!("invalid text kind"),
        };
        let domains = match case["allowKind"].as_str().unwrap() {
            "array" => Some(
                case["domains"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| JsString::from_units(units(x)))
                    .collect::<Vec<_>>(),
            ),
            "missing" | "null" => {
                assert!(case["domains"].is_null());
                None
            }
            _ => panic!("invalid allow kind"),
        };
        let actual = evaluate_links_rule(
            LinksRule {
                allowlist_domains: domains.as_deref(),
            },
            LinksEvaluationInput {
                text: text.as_ref(),
            },
        );
        assert_eq!(
            actual.triggered,
            case["triggered"].as_bool().unwrap(),
            "{id}"
        );
        let expected = case["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| units(x))
            .collect::<Vec<_>>();
        assert_eq!(
            actual.urls.iter().map(JsString::units).collect::<Vec<_>>(),
            expected,
            "{id}"
        );
        assert_eq!(
            actual.blocked_url.as_ref().map(JsString::units),
            case["blocked"].as_array().map(|_| units(&case["blocked"])),
            "{id}"
        );
        let mut wire = format!("{{\"triggered\":{},\"urls\":[", actual.triggered);
        for (i, url) in actual.urls.iter().enumerate() {
            if i != 0 {
                wire.push(',');
            }
            url.write_json_string(&mut wire);
        }
        wire.push_str("],\"blockedUrl\":");
        if let Some(url) = &actual.blocked_url {
            url.write_json_string(&mut wire);
        } else {
            wire.push_str("null");
        }
        wire.push('}');
        assert_eq!(wire, case["wire"].as_str().unwrap(), "{id}");
    }
}
