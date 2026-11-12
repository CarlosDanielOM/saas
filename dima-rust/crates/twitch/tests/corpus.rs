//! Offline replay of `tests/corpus/reference.json`, recorded from the frozen TypeScript with
//! Node 24 by `tests/corpus/generate.mjs`: expiry checks, the directory entry of a user, the
//! classification of refused refreshes, and `formatBadges`. The refresh traces of the same file
//! are replayed against the stores by `refresh_parity_live.rs`.

use anyhow::{Context, Result};
use dima_core::crypto::CredentialCipher;
use dima_model::users::User;
use dima_store::dragonfly::plan_cache_fence::plan_cache_version;
use dima_twitch::badges::{Badge, format_badges};
use dima_twitch::oauth::{is_permanent_refresh_failure, refresh_failure_message};
use dima_twitch::streamers::directory_fields;
use dima_twitch::tokens::is_access_token_usable;
use serde_json::Value;

fn corpus() -> Result<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/corpus/reference.json");
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn cases<'a>(corpus: &'a Value, name: &str) -> Result<&'a Vec<Value>> {
    let cases = corpus[name].as_array().context("cases")?;
    assert!(!cases.is_empty(), "{name} has no cases");
    Ok(cases)
}

#[test]
fn the_corpus_was_recorded_from_the_current_reference() -> Result<()> {
    let corpus = corpus()?;
    assert!(
        corpus["node"]
            .as_str()
            .is_some_and(|v| v.starts_with("v24.")),
        "recorded with the production runtime"
    );
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");
    for (path, hash) in corpus["sources"].as_object().context("sources")? {
        let text = std::fs::read(format!("{root}/{path}"))?;
        assert_eq!(
            dima_core::crypto::sha256(&text).hex(),
            hash.as_str().unwrap_or_default(),
            "{path} changed since the corpus was recorded: regenerate it"
        );
    }
    Ok(())
}

#[test]
fn expiry_checks_match_the_reference() -> Result<()> {
    let corpus = corpus()?;
    for case in cases(&corpus, "usable")? {
        let got = is_access_token_usable(
            case["token"].as_str(),
            case["expiry"].as_str(),
            case["now"].as_i64().context("now")?,
            case["skew"].as_i64().context("skew")?,
        );
        assert_eq!(
            got,
            case["expected"].as_bool().context("expected")?,
            "{case}"
        );
    }
    Ok(())
}

#[test]
fn directory_entries_match_the_reference() -> Result<()> {
    let corpus = corpus()?;
    let cipher = CredentialCipher::new(corpus["secret_key"].as_str().context("key")?)?;
    for case in cases(&corpus, "mapping")? {
        let name = case["name"].as_str().unwrap_or_default();
        let user = bson::Bson::try_from(case["user"].clone())?;
        let bson::Bson::Document(user) = user else {
            panic!("{name}: user is a document");
        };
        let user: User = dima_model::decode_document(&user)?;
        let fields = directory_fields(&user, case["cached_expires_at"].as_str(), &cipher)?
            .context("a Twitch account")?;
        let version = plan_cache_version(
            user.polar_plan_event_at.map(|date| date.0),
            user.polar_plan_event_key.as_deref(),
        )?;
        let mut args = vec![version.clone()];
        for (field, value) in fields {
            args.push(field.to_owned());
            args.push(value);
        }
        args.push("__polar_plan_version".to_owned());
        args.push(version);
        let expected: Vec<String> = case["args"]
            .as_array()
            .context("args")?
            .iter()
            .map(|v| v.as_str().unwrap_or_default().to_owned())
            .collect();
        assert_eq!(args, expected, "{name}");
        let keys: Vec<&str> = case["keys"]
            .as_array()
            .context("keys")?
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let space = dima_twitch::KeySpace::production();
        assert_eq!(
            keys,
            [
                space.plan_fence("111"),
                space.account("111"),
                space.aggregate()
            ],
            "{name}"
        );
    }
    Ok(())
}

#[test]
fn refused_refreshes_are_classified_like_the_reference() -> Result<()> {
    let corpus = corpus()?;
    for case in cases(&corpus, "classification")? {
        let status = u16::try_from(case["status"].as_u64().context("status")?)?;
        let payload = &case["payload"];
        assert_eq!(
            refresh_failure_message(payload),
            case["message"].as_str().unwrap_or_default(),
            "{case}"
        );
        assert_eq!(
            is_permanent_refresh_failure(status, payload),
            case["permanent"].as_bool().context("permanent")?,
            "{case}"
        );
    }
    Ok(())
}

#[test]
fn badges_are_formatted_like_the_reference() -> Result<()> {
    let corpus = corpus()?;
    for case in cases(&corpus, "badges")? {
        let badges: Vec<Badge> = serde_json::from_value(case["badges"].clone())?;
        let got = format_badges(&badges);
        let expected = &case["expected"];
        assert_eq!(got.formatted_badges, expected["formattedBadges"], "{case}");
        let list: Vec<String> = serde_json::from_value(expected["badgeList"].clone())?;
        assert_eq!(got.badge_list, list, "{case}");
        assert_eq!(got.is_mod, expected["isMod"], "{case}");
        assert_eq!(got.is_sub, expected["isSub"], "{case}");
        assert_eq!(
            got.sub_months,
            expected["subMonths"].as_f64().context("subMonths")?,
            "{case}"
        );
    }
    Ok(())
}

#[test]
fn badges_with_emoji_combining_marks_and_rtl_text() {
    // Info text is user-visible digits in practice; anything else reads as 0 months.
    let badge = |set_id: &str, info: &str| Badge {
        set_id: set_id.into(),
        id: "1".into(),
        info: info.into(),
    };
    let got = format_badges(&[badge("subscriber", "e\u{301}12"), badge("vip", "")]);
    assert_eq!(got.formatted_badges, "[VIP] [SUB 0M] ");
    let got = format_badges(&[badge("founder", "٣"), badge("premium", "👑")]);
    assert_eq!(got.badge_list, ["[FOUNDER 0M]", "[PRIME]"]);
    let got = format_badges(&[badge("subscriber", "24🎉")]);
    assert_eq!(got.badge_list, ["[SUB 24M]"]);
    assert!(got.is_sub && !got.is_mod);
}
