#![cfg(feature = "ai-credit-projection")]
#[path = "ai_credit_projection_support/mod.rs"]
mod support;
use dima_rust::utils::{
    ai_credit_projection::{self as p, AiCreditProjection, PlanTier},
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use support::{Command, Endpoint, bulk};
fn f<'a>(v: &'a JsonValue, k: &str) -> &'a JsonValue {
    v.get(k).unwrap_or_else(|| panic!("missing {k}"))
}
fn a(v: &JsonValue) -> &[JsonValue] {
    if let JsonValue::Array(v) = v {
        v
    } else {
        panic!("array")
    }
}
fn s(v: &JsonValue) -> &JsString {
    if let JsonValue::String(v) = v {
        v
    } else {
        panic!("string")
    }
}
fn t(v: &JsonValue) -> &str {
    s(v).as_str().expect("utf8")
}
fn n(v: &JsonValue) -> f64 {
    if let JsonValue::Number(n) = v {
        *n
    } else {
        panic!("number")
    }
}
fn b(v: &JsonValue) -> bool {
    matches!(v, JsonValue::Bool(true))
}
fn hash(v: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(v.as_ref()))
}
fn undefined(v: &JsonValue) -> bool {
    v.get("$undefined") == Some(&JsonValue::Bool(true))
}
fn decode(v: &JsonValue) -> Option<JsonValue> {
    if undefined(v) {
        return None;
    }
    if let Some(bits) = v.get("$f64") {
        return Some(JsonValue::Number(f64::from_bits(
            u64::from_str_radix(t(bits), 16).unwrap(),
        )));
    }
    if let Some(values) = v.get("$array") {
        return Some(JsonValue::Array(
            a(values)
                .iter()
                .map(|v| decode(v).unwrap_or(JsonValue::Null))
                .collect(),
        ));
    }
    if let Some(fields) = v.get("$object") {
        return Some(JsonValue::Object(
            a(fields)
                .iter()
                .filter_map(|row| {
                    let row = a(row);
                    decode(&row[1]).map(|v| (s(&row[0]).clone(), v))
                })
                .collect(),
        ));
    }
    Some(v.clone())
}
fn input(c: &JsonValue) -> JsonValue {
    decode(f(c, "input")).unwrap()
}
fn tier(v: Option<&JsonValue>) -> Option<PlanTier> {
    Some(match v {
        None => PlanTier::Undefined,
        Some(JsonValue::Null) => PlanTier::Null,
        Some(v) => match t(v) {
            "free" => PlanTier::Free,
            "premium" => PlanTier::Premium,
            "pro" => PlanTier::Pro,
            _ => panic!("tier"),
        },
    })
}
fn fixed() -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(1767323045000)
}
fn assert_raw(actual: &JsonValue, expected: &JsonValue) {
    let JsonValue::Object(fields) = expected else {
        panic!("raw fields")
    };
    for (key, bits) in fields {
        let v = n(f(actual, key.as_str().unwrap()));
        assert_eq!(format!("{:016x}", v.to_bits()), t(bits), "raw {key:?}");
    }
}
fn same(actual: &JsonValue, expected: &JsonValue) {
    // NaN payload/sign can be platform-dependent arithmetic results. All other
    // raw bits (including +/-0 and infinities) must be identical.
    match (actual, expected) {
        (JsonValue::Number(a), JsonValue::Number(b)) => assert!(
            a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()),
            "{a:?} != {b:?}"
        ),
        (JsonValue::Object(a), JsonValue::Object(b)) => {
            assert_eq!(a.len(), b.len());
            for ((ak, av), (bk, bv)) in a.iter().zip(b) {
                assert_eq!(ak, bk);
                same(av, bv);
            }
        }
        (JsonValue::Array(a), JsonValue::Array(b)) => {
            assert_eq!(a.len(), b.len());
            for (a, b) in a.iter().zip(b) {
                same(a, b);
            }
        }
        _ => assert_eq!(actual, expected),
    }
}
fn fixture() -> JsonValue {
    let dir = std::env::var("DIMA_AI_PROJECTION_REFERENCE_DIR")
        .expect("external actual-source oracle directory");
    let raw = std::fs::read_to_string(
        std::path::Path::new(&dir).join("ai_credit_projection_reference.json"),
    )
    .unwrap();
    assert!(!raw.is_empty());
    parse_json(&raw).unwrap()
}
fn metadata(root: &JsonValue) {
    let m = f(root, "metadata");
    assert_eq!(n(f(m, "schema")), 2.0);
    for (k, want) in [
        ("node", "v24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("typescript", "5.9.3"),
    ] {
        assert_eq!(t(f(m, k)), want);
    }
    let hashes = f(m, "hashes");
    let files = [
        (
            "source",
            "src/utils/billing.ts",
            "a14d58f094e58dbb34ff5191cbb09b792759187adaca862413873fa83c780c0d",
        ),
        (
            "package",
            "package.json",
            "cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef",
        ),
        (
            "lock",
            "package-lock.json",
            "abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7",
        ),
    ];
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (k, path, pin) in files {
        assert_eq!(t(f(hashes, k)), pin);
        assert_eq!(hash(std::fs::read(base.join(path)).unwrap()), pin);
    }
    assert_eq!(
        t(f(hashes, "oracle")),
        hash(
            std::fs::read(base.join("tests/fixtures/ai_credit_projection_reference.cjs")).unwrap()
        )
    );
    // Parent mounts the exact oracle Node/TS files, binding the runtime binaries
    // rather than merely trusting 64-character metadata strings.
    for (k, env) in [
        ("node", "DIMA_AI_PROJECTION_NODE_BINARY"),
        ("typescript", "DIMA_AI_PROJECTION_TYPESCRIPT_IMPLEMENTATION"),
        ("typescriptPackage", "DIMA_AI_PROJECTION_TYPESCRIPT_PACKAGE"),
    ] {
        assert_eq!(
            t(f(hashes, k)),
            hash(std::fs::read(std::env::var(env).expect(env)).unwrap())
        );
    }
    assert_eq!(
        t(f(hashes, "typescript")),
        "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675"
    );
    assert_eq!(
        t(f(hashes, "typescriptPackage")),
        "822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6"
    );
    assert!(a(f(m, "typeDiagnostics")).is_empty());
    assert_eq!(t(f(m, "lua")), p::APPLY_AI_CREDIT_USAGE_SCRIPT);
    assert_eq!(t(f(m, "luaSha256")), hash(p::APPLY_AI_CREDIT_USAGE_SCRIPT));
    let source = std::fs::read(base.join("src/utils/billing.ts")).unwrap();
    let names = [
        "PlanTier",
        "AI_CREDITS_METER_ID",
        "AI_CREDIT_LIMITS",
        "AI_CREDITS_CACHE_TTL_SECONDS",
        "AI_CREDITS_CACHE_SCHEMA_VERSION",
        "AiCreditStatus",
        "AiCreditsData",
        "PolarAiCreditsMeterLike",
        "toFiniteNumber",
        "getAiCreditLimitForPlan",
        "buildAiCreditsDataFromMeter",
        "applyAiCreditUsageToSnapshot",
        "APPLY_AI_CREDIT_USAGE_SCRIPT",
        "recordAiCreditUsage",
        "syncAiCreditExhaustionStatus",
        "isAiCreditsExhausted",
    ];
    let ds = a(f(m, "declarations"));
    assert_eq!(ds.len(), names.len());
    let mut extraction = Vec::new();
    for (d, name) in ds.iter().zip(names) {
        assert_eq!(t(f(d, "name")), name);
        let start = n(f(d, "startByte")) as usize;
        let end = n(f(d, "endByte")) as usize;
        assert_eq!(&source[start..end], t(f(d, "text")).as_bytes());
        assert_eq!(t(f(d, "sha256")), hash(&source[start..end]));
        let private = [
            "PlanTier",
            "toFiniteNumber",
            "APPLY_AI_CREDIT_USAGE_SCRIPT",
            "syncAiCreditExhaustionStatus",
        ]
        .contains(&name);
        assert_eq!(b(f(d, "exported")), !private);
        let kind = if name == "PlanTier" || name == "AiCreditStatus" {
            "TypeAliasDeclaration"
        } else if ["AiCreditsData", "PolarAiCreditsMeterLike"].contains(&name) {
            "InterfaceDeclaration"
        } else if name.starts_with("AI_") || name == "APPLY_AI_CREDIT_USAGE_SCRIPT" {
            "VariableStatement"
        } else {
            "FunctionDeclaration"
        };
        assert_eq!(t(f(d, "kind")), kind);
        if kind == "FunctionDeclaration" {
            assert!(t(f(d, "type")).contains('('));
        }
        assert_shape(d, name);
        extraction.push(t(f(d, "text")));
    }
    assert_eq!(t(f(m, "extractionSha256")), hash(extraction.join("\n")));
    let dir = std::path::PathBuf::from(std::env::var("DIMA_AI_PROJECTION_REFERENCE_DIR").unwrap());
    for (key, file) in [
        ("extractionSha256", "ai_credit_projection_extracted.ts"),
        ("typecheckSourceSha256", "ai_credit_projection_typecheck.ts"),
        ("transpiledSha256", "ai_credit_projection_compiled.cjs"),
    ] {
        assert_eq!(t(f(m, key)), hash(std::fs::read(dir.join(file)).unwrap()));
    }
    let constants = f(m, "constants");
    assert_eq!(t(f(constants, "meterId")), p::AI_CREDITS_METER_ID);
    assert_eq!(
        n(f(constants, "cacheTtl")),
        p::AI_CREDITS_CACHE_TTL_SECONDS as f64
    );
    assert_eq!(
        n(f(constants, "schemaVersion")),
        p::AI_CREDITS_CACHE_SCHEMA_VERSION as f64
    );
    for (k, tier) in [
        ("free", PlanTier::Free),
        ("premium", PlanTier::Premium),
        ("pro", PlanTier::Pro),
    ] {
        assert_eq!(
            n(f(f(constants, "limits"), k)),
            p::get_ai_credit_limit_for_plan(Some(tier))
        );
    }
    assert_eq!(n(f(m, "fixedMillis")), 1767323045000.0);
}
fn assert_shape(d: &JsonValue, name: &str) {
    let shape = f(d, "shape");
    let cache = "Awaited<ReturnType<typeof getDragonflyClient>>";
    let params: Vec<(&str, Option<&str>, bool, Option<&str>)> = match name {
        "toFiniteNumber" => vec![
            ("value", Some("unknown"), false, None),
            ("fallback", None, true, Some("0")),
        ],
        "getAiCreditLimitForPlan" => {
            vec![("planTier", Some("PlanTier | null | undefined"), false, None)]
        }
        "buildAiCreditsDataFromMeter" => vec![
            (
                "meter",
                Some("PolarAiCreditsMeterLike | null | undefined"),
                false,
                None,
            ),
            ("planTier", Some("PlanTier | null | undefined"), false, None),
            ("updatedAt", None, true, Some("new Date().toISOString()")),
        ],
        "applyAiCreditUsageToSnapshot" => vec![
            ("snapshot", Some("AiCreditsData"), false, None),
            ("credits", Some("number"), false, None),
            ("updatedAt", None, true, Some("new Date().toISOString()")),
        ],
        "recordAiCreditUsage" => vec![
            ("channelID", Some("string"), false, None),
            ("credits", Some("number"), false, None),
            ("externalId", Some("string"), true, None),
            ("cacheOverride", Some(cache), true, None),
        ],
        "syncAiCreditExhaustionStatus" => vec![
            ("cache", Some(cache), false, None),
            ("channelID", Some("string"), false, None),
            ("exhausted", Some("boolean"), false, None),
        ],
        "isAiCreditsExhausted" => vec![
            ("channelID", Some("string"), false, None),
            ("cacheOverride", Some(cache), true, None),
        ],
        _ => vec![],
    };
    if !params.is_empty() {
        let actual = a(f(shape, "parameters"));
        assert_eq!(actual.len(), params.len());
        for (p, (name, ty, optional, initializer)) in actual.iter().zip(params) {
            assert_eq!(t(f(p, "name")), name);
            assert_eq!(b(f(p, "optional")), optional);
            for (key, want) in [("type", ty), ("initializer", initializer)] {
                if let Some(want) = want {
                    assert_eq!(t(f(p, key)), want);
                } else {
                    assert_eq!(f(p, key), &JsonValue::Null);
                }
            }
        }
        let result = match name {
            "toFiniteNumber" | "getAiCreditLimitForPlan" => "number",
            "buildAiCreditsDataFromMeter" | "applyAiCreditUsageToSnapshot" => "AiCreditsData",
            "isAiCreditsExhausted" => "Promise<boolean>",
            _ => "Promise<void>",
        };
        assert_eq!(t(f(shape, "returnType")), result);
        assert_eq!(b(f(shape, "async")), result.starts_with("Promise<"));
    } else if name == "AiCreditsData" || name == "PolarAiCreditsMeterLike" {
        let members: Vec<(&str, &str, bool)> = if name == "AiCreditsData" {
            vec![
                ("version", "number", false),
                ("used", "number", false),
                ("limit", "number", false),
                ("balance", "number", false),
                ("meterId", "string", false),
                ("updatedAt", "string", false),
                ("available", "boolean", false),
                ("status", "AiCreditStatus", false),
            ]
        } else {
            vec![
                ("meter_id", "string", true),
                ("consumed_units", "number | string | null", true),
                ("credited_units", "number | string | null", true),
                ("balance", "number | string | null", true),
                ("limit", "number | string | null", true),
            ]
        };
        let actual = a(f(shape, "members"));
        assert_eq!(actual.len(), members.len());
        for (m, (name, ty, optional)) in actual.iter().zip(members) {
            assert_eq!(t(f(m, "name")), name);
            assert_eq!(t(f(m, "type")), ty);
            assert_eq!(b(f(m, "optional")), optional);
        }
    } else if name == "PlanTier" || name == "AiCreditStatus" {
        assert_eq!(
            t(f(shape, "type")),
            if name == "PlanTier" {
                "'free' | 'premium' | 'pro'"
            } else {
                "'unavailable' | 'available' | 'exhausted'"
            }
        );
    } else {
        assert_eq!(shape, &JsonValue::Null);
    }
}
fn source_command(call: &JsonValue) -> Command {
    let args = decode(f(call, "args")).unwrap();
    let args = a(&args);
    if t(f(call, "method")) == "eval" {
        let mut out = vec!["EVAL".into(), t(&args[0]).into(), "4".into()];
        for k in ["keys", "arguments"] {
            out.extend(a(f(&args[1], k)).iter().map(|v| s(v).to_utf8_lossy()));
        }
        out
    } else {
        let mut out = vec![t(f(call, "method")).to_ascii_uppercase()];
        out.extend(args.iter().map(|v| s(v).to_utf8_lossy()));
        out
    }
}
fn endpoint(input: &JsonValue) -> Endpoint {
    let input = input.clone();
    Endpoint::new(move |args| {
        if args[0] == "PING" {
            return b"+PONG\r\n".to_vec();
        }
        let key = if args[0] == "EVAL" {
            "eval"
        } else {
            args[1].as_str()
        };
        let fault = input.get("faults").and_then(|f| f.get(key)).is_some_and(b)
            || (args[0] == "SET" && input.get("setFault").is_some_and(|v| t(v) == key));
        if fault {
            return b"-ERR fixture command failure\r\n".to_vec();
        }
        match args[0].as_str() {
            "EVAL" => {
                format!(":{}\r\n", input.get("evalResult").map(n).unwrap_or(0.0)).into_bytes()
            }
            "EXISTS" => format!(
                ":{}\r\n",
                input
                    .get(if key.starts_with("twitch:") {
                        "canonical"
                    } else {
                        "legacy"
                    })
                    .map(n)
                    .unwrap_or(0.0)
            )
            .into_bytes(),
            "GET" => bulk(input.get("cached").and_then(|v| {
                if let JsonValue::String(s) = v {
                    s.as_str()
                } else {
                    None
                }
            })),
            "SET" => b"+OK\r\n".to_vec(),
            _ => b"-ERR unexpected command\r\n".to_vec(),
        }
    })
}
#[tokio::test]
#[ignore = "actual-source corpus and binary provenance mounts required"]
async fn replay_every_actual_source_case() {
    let root = fixture();
    metadata(&root);
    let mut counts = BTreeMap::<String, usize>::new();
    for c in a(f(&root, "cases")) {
        let kind = t(f(c, "kind"));
        *counts.entry(kind.into()).or_default() += 1;
        let i = input(c);
        let e = f(c, "expected");
        match kind {
            "limit" | "meter" | "apply" => {
                let result = match kind {
                    "limit" => {
                        JsonValue::Number(p::get_ai_credit_limit_for_plan(tier(i.get("tier"))))
                    }
                    "meter" => p::build_ai_credits_data_from_meter_at(
                        i.get("meter"),
                        tier(i.get("tier")),
                        i.get("at").map(s),
                        fixed(),
                    )
                    .unwrap(),
                    _ => p::apply_ai_credit_usage_to_snapshot_at(
                        f(&i, "snapshot"),
                        n(f(&i, "credits")),
                        i.get("at").map(s),
                        fixed(),
                    )
                    .unwrap(),
                };
                same(&result, &decode(f(e, "value")).unwrap());
                assert_raw(&result, f(e, "rawFields"));
                assert_eq!(
                    result.to_json_string(),
                    t(f(e, "wire")),
                    "{}",
                    t(f(c, "id"))
                );
                assert_eq!(
                    n(f(c, "dateReads")),
                    if kind != "limit" && i.get("at").is_none() {
                        1.0
                    } else {
                        0.0
                    }
                );
            }
            "record" | "exhausted" => {
                let expected_calls: Vec<_> = a(f(e, "calls")).iter().map(source_command).collect();
                let channel = s(f(&i, "channel"));
                let acquiring = i.get("defaultCache").is_some_and(b)
                    && !channel.is_empty()
                    && (kind != "record"
                        || n(f(&i, "credits")).is_finite() && n(f(&i, "credits")) > 0.0);
                assert_eq!(a(f(e, "acquisitions")).len(), usize::from(acquiring));
                if acquiring {
                    assert_eq!(
                        t(&a(f(e, "acquisitions"))[0]),
                        if kind == "record" {
                            "recordAiCreditUsage"
                        } else {
                            "isAiCreditsExhausted"
                        }
                    );
                }
                // Acquisition failures execute default functions in a fresh child
                // (separate ignored test below), with no global env mutation.
                if acquiring && i.get("acquireError").is_some_and(b) {
                    assert!(expected_calls.is_empty());
                    assert_eq!(n(f(c, "dateReads")), 0.0);
                    if kind == "record" {
                        assert_eq!(a(f(e, "logs")).len(), 1);
                        same(
                            &decode(f(&a(f(e, "logs"))[0], "payload")).unwrap(),
                            &p::record_error_payload(channel, "fixture acquisition failure"),
                        );
                    } else {
                        assert_eq!(t(f(e, "error")), "fixture acquisition failure");
                    }
                    replay_acquisition_failure_child(c).await;
                    continue;
                }
                let ep = endpoint(&i);
                let mut connection = ep.manager().await;
                let adapter = AiCreditProjection::new(connection.clone(), Duration::from_secs(2));
                if kind == "record" {
                    let credits = n(f(&i, "credits"));
                    let id = i.get("externalId").map(s);
                    let command = p::record_command_at(channel, credits, id, fixed()).unwrap();
                    if let Some(request) = command {
                        let mut actual = vec![
                            "EVAL".into(),
                            p::APPLY_AI_CREDIT_USAGE_SCRIPT.into(),
                            "4".into(),
                        ];
                        actual.extend(request.keys);
                        actual.extend(request.arguments);
                        assert_eq!(expected_calls, vec![actual]);
                    } else {
                        assert!(expected_calls.is_empty());
                    }
                    let result = adapter
                        .record_ai_credit_usage_at(channel, credits, id, fixed())
                        .await;
                    let logs = a(f(e, "logs"));
                    assert!(undefined(f(e, "result")));
                    assert_eq!(f(e, "error"), &JsonValue::Null);
                    if logs.is_empty() {
                        assert_eq!(
                            result.unwrap(),
                            if expected_calls.is_empty() {
                                None
                            } else {
                                Some(i.get("evalResult").map(n).unwrap_or(0.0) as i64)
                            }
                        );
                    } else {
                        assert_eq!(logs.len(), 1);
                        assert!(
                            result
                                .as_ref()
                                .unwrap_err()
                                .contains("fixture command failure")
                        );
                        let log = &logs[0];
                        assert_eq!(t(f(log, "prefix")), p::RECORD_ERROR_PREFIX);
                        let payload = decode(f(log, "payload")).unwrap();
                        assert_eq!(
                            f(&payload, "channelID"),
                            &JsonValue::String(channel.clone())
                        );
                        // Redis native diagnostics have an ERR prefix. Logical
                        // payload is source-exact for its message component.
                        let message = i
                            .get("nonError")
                            .map(s)
                            .cloned()
                            .unwrap_or_else(|| "fixture command failure".into());
                        same(
                            &p::record_error_payload_lossless(channel, &message),
                            &payload,
                        );
                    }
                    assert_eq!(
                        n(f(c, "dateReads")),
                        if expected_calls.is_empty() { 0.0 } else { 1.0 }
                    );
                } else {
                    let result = adapter.is_ai_credits_exhausted(channel).await;
                    if f(e, "error") == &JsonValue::Null {
                        assert_eq!(result.unwrap(), b(&decode(f(e, "result")).unwrap()));
                    } else {
                        assert!(result.unwrap_err().contains(t(f(e, "error"))));
                    }
                    assert!(a(f(e, "logs")).is_empty());
                    assert_eq!(n(f(c, "dateReads")), 0.0);
                }
                let _: String = redis::cmd("PING")
                    .query_async(&mut connection)
                    .await
                    .unwrap();
                let mut actual = ep.calls.lock().unwrap().clone();
                let mut expected = expected_calls;
                // Promise.all and join may interleave independent commands. Exact
                // byte arguments and cardinality matter, sibling order does not.
                actual.sort();
                expected.sort();
                assert_eq!(actual, expected, "{}", t(f(c, "id")));
            }
            _ => panic!("unreplayed fixture kind {kind}"),
        }
    }
    let declared = f(f(&root, "metadata"), "counts");
    for (kind, count) in &counts {
        assert_eq!(*count, n(f(declared, kind)) as usize);
    }
    assert_eq!(
        counts,
        BTreeMap::from([
            ("limit".into(), 5),
            ("meter".into(), 1015),
            ("apply".into(), 504),
            ("record".into(), 387),
            ("exhausted".into(), 45)
        ])
    );
    assert_eq!(
        a(f(&root, "cases")).len(),
        n(f(f(&root, "metadata"), "total")) as usize
    );
}
#[test]
fn concrete_clock_and_lossless_timestamp_defaults() {
    assert_eq!(
        p::iso_at(fixed()).unwrap(),
        JsString::from("2026-01-02T03:04:05.000Z")
    );
    assert_eq!(
        p::iso_at(UNIX_EPOCH - Duration::from_millis(1)).unwrap(),
        JsString::from("1969-12-31T23:59:59.999Z")
    );
    let at = JsString::from_units(vec![0xd800, 0xd83d, 0xde00]);
    let meter = p::build_ai_credits_data_from_meter(None, None, Some(&at)).unwrap();
    assert_eq!(f(&meter, "updatedAt"), &JsonValue::String(at));
    let before = SystemTime::now();
    let default = p::build_ai_credits_data_from_meter(None, None, None).unwrap();
    let after = SystemTime::now();
    let actual = t(f(&default, "updatedAt"));
    assert!(
        actual >= p::iso_at(before).unwrap().as_str().unwrap()
            && actual <= p::iso_at(after).unwrap().as_str().unwrap()
    );
    // Guards run before even an out-of-range clock is evaluated.
    let invalid = UNIX_EPOCH + Duration::from_secs(9_000_000_000_000);
    assert!(
        p::record_command_at(&"".into(), 1.0, None, invalid)
            .unwrap()
            .is_none()
    );
    assert!(
        p::record_command_at(&"x".into(), f64::NAN, None, invalid)
            .unwrap()
            .is_none()
    );
    assert!(p::record_command_at(&"x".into(), 1.0, None, invalid).is_err());
}
async fn replay_acquisition_failure_child(case: &JsonValue) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let pings = Arc::new(AtomicUsize::new(0));
    let counter = pings.clone();
    let ep = Endpoint::new(move |args| {
        assert_eq!(args[0], "PING");
        counter.fetch_add(1, Ordering::SeqCst);
        b"-ERR fixture acquisition failure\r\n".to_vec()
    });
    let (host, port) = support::parse_fixture_url(&ep.url);
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "oracle_default_acquisition_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env("DRAGONFLY_HOST", host)
        .env("DRAGONFLY_PORT", port.to_string())
        .env("DIMA_TEST_REDIS_URL", &ep.url)
        .env("DIMA_RUST_TEST_RESOURCE_OWNER", "dimabot-migration")
        .env("DIMA_PROJECTION_ORACLE_CHILD", t(f(case, "id")))
        .env(
            "DIMA_AI_PROJECTION_REFERENCE_DIR",
            std::env::var("DIMA_AI_PROJECTION_REFERENCE_DIR").unwrap(),
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = command.spawn().unwrap();
    // Bounded wait without process-global environment mutation. Kill/reap on a
    // deadline so a failed child cannot remain as an orphan fixture process.
    let result =
        tokio::task::spawn_blocking(move || support::child_output(child, Duration::from_secs(8)))
            .await
            .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(pings.load(Ordering::SeqCst), 1);
    assert!(ep.calls.lock().unwrap().is_empty());
    if t(f(case, "kind")) == "record" {
        let stderr = String::from_utf8(result.stderr).unwrap();
        let lines: Vec<_> = stderr
            .lines()
            .filter(|line| line.starts_with(p::RECORD_ERROR_PREFIX))
            .collect();
        assert_eq!(lines.len(), 1);
        let payload = parse_json(
            lines[0]
                .strip_prefix(p::RECORD_ERROR_PREFIX)
                .unwrap()
                .trim(),
        )
        .unwrap();
        let i = input(case);
        assert_eq!(f(&payload, "channelID"), f(&i, "channel"));
        assert!(t(f(&payload, "error")).contains("fixture acquisition failure"));
    }
}
#[test]
#[ignore = "isolated actual-source replay child only"]
fn oracle_default_acquisition_child() {
    let Ok(id) = std::env::var("DIMA_PROJECTION_ORACLE_CHILD") else {
        return;
    };
    let (_, host, port) = support::fixture_url();
    assert_eq!(std::env::var("DRAGONFLY_HOST").unwrap(), host);
    assert_eq!(std::env::var("DRAGONFLY_PORT").unwrap(), port.to_string());
    let root = fixture();
    let c = a(f(&root, "cases"))
        .iter()
        .find(|c| t(f(c, "id")) == id)
        .unwrap();
    let i = input(c);
    let channel = s(f(&i, "channel"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        if t(f(c, "kind")) == "record" {
            p::record_ai_credit_usage_default(
                channel,
                n(f(&i, "credits")),
                i.get("externalId").map(s),
                Duration::from_secs(1),
            )
            .await;
        } else {
            assert!(
                p::is_ai_credits_exhausted_default(channel, Duration::from_secs(1))
                    .await
                    .unwrap_err()
                    .contains("fixture acquisition failure")
            );
        }
    });
}
