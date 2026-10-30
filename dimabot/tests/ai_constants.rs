#![cfg(feature = "ai-constants")]
//! Zero-dependency parity tests for `src/utils/ai/constants.rs`.
//!
//! The ordinary tests are self-contained. The ignored replay consumes a
//! reference fixture generated externally by the pinned actual TypeScript
//! source oracle; no Node process, network, or application service is started
//! by this test binary.
//!
//! Tests exercise the public library module used by native callers.
use dima_rust::utils::ai_constants as constants;
#[path = "support/sha256.rs"]
mod digest;

use constants::{
    BACKGROUND_MODEL_FALLBACK, BACKGROUND_MODELS, BackgroundModels, CODING_MODELS, CodingModels,
    DEFAULT_TIMEOUT_MS, EMBEDDING_DIMENSIONS, EMBEDDING_MODELS, EXPORTS, EmbeddingModels,
    MINIMAX_BASE_URL, MINIMAX_COST_PER_M_INPUT, MINIMAX_COST_PER_M_INPUT_BITS,
    MINIMAX_COST_PER_M_OUTPUT, MINIMAX_COST_PER_M_OUTPUT_BITS, MINIMAX_MODEL,
    MODEL_PROVIDER_RESTRICTION_KEYS, MODEL_PROVIDER_RESTRICTIONS, MODELS, Models, PlanTierValue,
    SELECT_CHAT_MODEL_DEFAULT_IS_EXHAUSTED, TOKEN_LIMITS, TokenLimits, embedding_dimensions,
    get_background_summary_model, get_background_summary_model_units, get_provider_restriction,
    get_provider_restriction_units, select_chat_model, select_chat_model_value, to_json_string,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

const SOURCE_SHA: &str = "7505c5481b8681c83ec57c8b89b856250bdd3970586810e900075d06fb5eb0f4";
const PACKAGE_SHA: &str = "cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef";
const LOCK_SHA: &str = "abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7";
const TOOLCHAIN_SHA: &str = "b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2";
const NODE_SHA: &str = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108";
const TYPESCRIPT_SHA: &str = "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
const TYPESCRIPT_PACKAGE_SHA: &str =
    "822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6";

const EXPECTED_JSON: &str = concat!(
    r#"{"MODELS":{"free":"deepseek/deepseek-v4.1-flash","exhausted":"meta/muse-spark-1.3-contributor","premium":"deepseek/deepseek-v4.1-flash","pro":"deepseek/deepseek-v4.1-flash"},"#,
    r#""BACKGROUND_MODELS":{"free":"meta/muse-spark-1.2-contributor","premium":"deepseek/deepseek-v4.1-flash","pro":"deepseek/deepseek-v4.1-flash"},"#,
    r#""BACKGROUND_MODEL_FALLBACK":"deepseek/deepseek-v4.1-flash","#,
    r#""MODEL_PROVIDER_RESTRICTIONS":{"deepseek/deepseek-v4-pro":{"only":["deepseek"]}},"#,
    r#""TOKEN_LIMITS":{"default":25000},"#,
    r#""CODING_MODELS":{"pro":"google/gemini-2.5-flash-lite","premium":"google/gemini-2.5-flash-lite","free":"z-ai/glm-4.5-air:nitro","exhausted":"z-ai/glm-4.5-air"},"#,
    r#""MINIMAX_MODEL":"MiniMax-M2.7-highspeed","#,
    r#""MINIMAX_BASE_URL":"https://api.minimax.io/anthropic","#,
    r#""MINIMAX_COST_PER_M_INPUT":0.6,"#,
    r#""MINIMAX_COST_PER_M_OUTPUT":2.4,"#,
    r#""DEFAULT_TIMEOUT_MS":8000,"#,
    r#""EMBEDDING_MODELS":{"default":"lfm2.5-embedding-350m","multilingual":"lfm2.5-embedding-350m"},"#,
    r#""EMBEDDING_DIMENSIONS":{"lfm2.5-embedding-350m":1024}}"#
);

const NATIVE_FILES: &[(&str, &[u8])] = &[
    (
        "src/utils/ai/constants.rs",
        include_bytes!("../src/utils/ai/constants.rs"),
    ),
    ("tests/ai_constants.rs", include_bytes!("ai_constants.rs")),
    (
        "tests/fixtures/ai_constants_reference.cjs",
        include_bytes!("fixtures/ai_constants_reference.cjs"),
    ),
    (
        "tests/fixtures/ai_constants_benchmark.cjs",
        include_bytes!("fixtures/ai_constants_benchmark.cjs"),
    ),
    (
        "tests/ai_constants_benchmark.rs",
        include_bytes!("ai_constants_benchmark.rs"),
    ),
    (
        "tests/support/sha256.rs",
        include_bytes!("support/sha256.rs"),
    ),
    ("Cargo.toml", include_bytes!("../Cargo.toml")),
    ("Cargo.lock", include_bytes!("../Cargo.lock")),
    (
        "rust-toolchain.toml",
        include_bytes!("../rust-toolchain.toml"),
    ),
    ("package.json", include_bytes!("../package.json")),
    ("package-lock.json", include_bytes!("../package-lock.json")),
    (
        "src/utils/ai/constants.ts",
        include_bytes!("../src/utils/ai/constants.ts"),
    ),
];

#[test]
fn tables_keep_source_order_and_values() {
    assert_eq!(Models::KEYS, ["free", "exhausted", "premium", "pro"]);
    assert_eq!(
        MODELS.entries().map(|(key, _)| key),
        ["free", "exhausted", "premium", "pro"]
    );
    assert_eq!(MODELS.free, "deepseek/deepseek-v4.1-flash");
    assert_eq!(MODELS.exhausted, "meta/muse-spark-1.3-contributor");
    assert_eq!(MODELS.premium, MODELS.free);
    assert_eq!(MODELS.pro, MODELS.free);

    assert_eq!(BackgroundModels::KEYS, ["free", "premium", "pro"]);
    assert_eq!(BACKGROUND_MODELS.free, "meta/muse-spark-1.2-contributor");
    assert_eq!(BACKGROUND_MODELS.premium, "deepseek/deepseek-v4.1-flash");
    assert_eq!(BACKGROUND_MODELS.pro, "deepseek/deepseek-v4.1-flash");
    assert_eq!(BACKGROUND_MODEL_FALLBACK, MODELS.free);

    assert_eq!(CodingModels::KEYS, ["pro", "premium", "free", "exhausted"]);
    assert_eq!(CODING_MODELS.pro, "google/gemini-2.5-flash-lite");
    assert_eq!(CODING_MODELS.premium, CODING_MODELS.pro);
    assert_eq!(CODING_MODELS.free, "z-ai/glm-4.5-air:nitro");
    assert_eq!(CODING_MODELS.exhausted, "z-ai/glm-4.5-air");

    assert_eq!(TokenLimits::KEYS, ["default"]);
    assert_eq!(TOKEN_LIMITS.default, 25_000);
    assert_eq!(TOKEN_LIMITS.entries(), [("default", 25_000)]);

    assert_eq!(EmbeddingModels::KEYS, ["default", "multilingual"]);
    assert_eq!(EMBEDDING_MODELS.default, "lfm2.5-embedding-350m");
    assert_eq!(EMBEDDING_MODELS.multilingual, EMBEDDING_MODELS.default);
    assert_eq!(EMBEDDING_DIMENSIONS.len(), 1);
    assert_eq!(EMBEDDING_DIMENSIONS[0].0, "lfm2.5-embedding-350m");
    assert_eq!(EMBEDDING_DIMENSIONS[0].1, 1024);
    assert_eq!(embedding_dimensions("lfm2.5-embedding-350m"), Some(1024));
    assert_eq!(embedding_dimensions("nope"), None);
}

#[test]
fn chat_selector_prefers_exhaustion_then_case_sensitive_tiers() {
    let default_is_exhausted = SELECT_CHAT_MODEL_DEFAULT_IS_EXHAUSTED;
    assert!(!default_is_exhausted, "source default");
    for tier in [None, Some("free"), Some("premium"), Some("pro")] {
        assert_eq!(select_chat_model(tier, true), MODELS.exhausted);
        assert_eq!(select_chat_model(tier, false), MODELS.free);
    }
    assert_eq!(select_chat_model(Some("pro"), false), MODELS.pro);
    assert_eq!(select_chat_model(Some("premium"), false), MODELS.premium);
    for tier in [
        Some("Free"),
        Some("PRO"),
        Some("Premium"),
        Some(""),
        Some(" pro"),
        Some("pro "),
        Some("enterprise"),
        Some("exhausted"),
        Some("deepseek/deepseek-v4-pro"),
        Some("𝔭𝔯𝔬"),
    ] {
        assert_eq!(select_chat_model(tier, false), MODELS.free, "{tier:?}");
    }
}

#[test]
fn chat_selector_models_absent_and_non_string_tiers_as_free() {
    for plan in [
        PlanTierValue::Missing,
        PlanTierValue::NonString,
        PlanTierValue::CodeUnits(&[0xd800]),
        PlanTierValue::CodeUnits(&[0xdc00]),
        PlanTierValue::CodeUnits(&[0xd83d, 0xde00]),
    ] {
        assert_eq!(select_chat_model_value(plan, false), MODELS.free);
        assert_eq!(select_chat_model_value(plan, true), MODELS.exhausted);
    }
    assert_eq!(
        select_chat_model_value(PlanTierValue::CodeUnits(&[0x70, 0x72, 0x6f]), false),
        MODELS.pro
    );
    let premium_units = "premium".encode_utf16().collect::<Vec<_>>();
    assert_eq!(
        select_chat_model_value(PlanTierValue::CodeUnits(&premium_units), false),
        MODELS.premium
    );
}

#[test]
fn background_selector_matches_source() {
    assert_eq!(
        get_background_summary_model(Some("pro")),
        BACKGROUND_MODELS.pro
    );
    assert_eq!(
        get_background_summary_model(Some("premium")),
        BACKGROUND_MODELS.premium
    );
    for tier in [
        None,
        Some("free"),
        Some("Free"),
        Some("PRO"),
        Some(""),
        Some("pro "),
        Some(" premium"),
        Some("enterprise"),
        Some("𝔭𝔯𝔬"),
    ] {
        assert_eq!(
            get_background_summary_model(tier),
            BACKGROUND_MODELS.free,
            "{tier:?}"
        );
    }
    assert_eq!(
        get_background_summary_model_units(&[0xd800]),
        BACKGROUND_MODELS.free
    );
}

#[test]
fn provider_restriction_covers_own_entries_only() {
    assert_eq!(
        MODEL_PROVIDER_RESTRICTION_KEYS,
        ["deepseek/deepseek-v4-pro"]
    );
    assert_eq!(MODEL_PROVIDER_RESTRICTIONS.len(), 1);
    let (key, restriction) = MODEL_PROVIDER_RESTRICTIONS[0];
    assert_eq!(key, "deepseek/deepseek-v4-pro");
    assert_eq!(restriction.only, &["deepseek"][..]);
    let found = get_provider_restriction("deepseek/deepseek-v4-pro").expect("own entry");
    assert_eq!(found, &restriction);
    for model in [
        "",
        "deepseek/deepseek-v4.1-flash",
        "DEEPSEEK/DEEPSEEK-V4-PRO",
        "deepseek/deepseek-v4-pro ",
        " deepseek/deepseek-v4-pro",
        "deepseek/deepseek-v4-pro/",
        "Meta/muse-spark-1.3-contributor",
    ] {
        assert_eq!(get_provider_restriction(model), None, "{model:?}");
    }
    // Documented typed-boundary divergence: the source object lookup returns
    // inherited Object.prototype members, which do not satisfy the declared
    // `{ only: readonly string[] } | undefined` contract. The typed port
    // rejects them.
    for model in [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toLocaleString",
    ] {
        assert_eq!(get_provider_restriction(model), None, "{model:?}");
        assert_eq!(
            get_provider_restriction_units(&model.encode_utf16().collect::<Vec<_>>()),
            None
        );
    }
    assert_eq!(get_provider_restriction_units(&[0xd800]), None);
}

#[test]
fn scalars_keep_exact_values_and_binary64_bits() {
    assert_eq!(MINIMAX_MODEL, "MiniMax-M2.7-highspeed");
    assert_eq!(MINIMAX_BASE_URL, "https://api.minimax.io/anthropic");
    assert_eq!(MINIMAX_COST_PER_M_INPUT, 0.6);
    assert_eq!(
        MINIMAX_COST_PER_M_INPUT.to_bits(),
        MINIMAX_COST_PER_M_INPUT_BITS
    );
    assert_eq!(MINIMAX_COST_PER_M_INPUT_BITS, 0x3fe3_3333_3333_3333);
    assert_eq!(MINIMAX_COST_PER_M_OUTPUT, 2.4);
    assert_eq!(
        MINIMAX_COST_PER_M_OUTPUT.to_bits(),
        MINIMAX_COST_PER_M_OUTPUT_BITS
    );
    assert_eq!(MINIMAX_COST_PER_M_OUTPUT_BITS, 0x4003_3333_3333_3333);
    assert_eq!(DEFAULT_TIMEOUT_MS, 8_000);
    assert_eq!(TOKEN_LIMITS.default, 25_000);
}

#[test]
fn serialization_matches_source_shape() {
    assert_eq!(to_json_string(), EXPECTED_JSON);
    assert_eq!(MODELS.get("free"), Some(MODELS.free));
    assert_eq!(MODELS.get("nope"), None);
    assert_eq!(CODING_MODELS.get("pro"), Some(CODING_MODELS.pro));
    let background = BACKGROUND_MODELS.to_json_string();
    assert!(background.starts_with(r#"{"free":"meta/muse-spark-1.2-contributor","#));
    assert!(background.ends_with(r#""pro":"deepseek/deepseek-v4.1-flash"}"#));
    assert_eq!(restriction_json(), r#"{"only":["deepseek"]}"#);
}

fn restriction_json() -> String {
    MODEL_PROVIDER_RESTRICTIONS[0].1.to_json_string()
}

#[test]
fn export_surface_matches_source() {
    assert_eq!(EXPORTS.len(), 16);
    assert_eq!(
        EXPORTS,
        [
            "MODELS",
            "selectChatModel",
            "BACKGROUND_MODELS",
            "getBackgroundSummaryModel",
            "BACKGROUND_MODEL_FALLBACK",
            "MODEL_PROVIDER_RESTRICTIONS",
            "getProviderRestriction",
            "TOKEN_LIMITS",
            "CODING_MODELS",
            "MINIMAX_MODEL",
            "MINIMAX_BASE_URL",
            "MINIMAX_COST_PER_M_INPUT",
            "MINIMAX_COST_PER_M_OUTPUT",
            "DEFAULT_TIMEOUT_MS",
            "EMBEDDING_MODELS",
            "EMBEDDING_DIMENSIONS",
        ]
    );
}

fn hash(bytes: &[u8]) -> String {
    digest::sha256_hex(bytes)
}

fn read(path: &Path) -> Vec<u8> {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert!(!bytes.is_empty(), "empty file: {}", path.display());
    bytes
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("missing string {key}"))
}

fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("code units")
        .iter()
        .map(|unit| u16::try_from(unit.as_u64().expect("unit")).expect("u16"))
        .collect()
}

fn source_root() -> PathBuf {
    match std::env::var_os("DIMA_AI_CONSTANTS_SOURCE_ROOT") {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    }
}

fn verify_native_hashes(metadata: &Value, root: &Path, _workspace: &Path) {
    assert_eq!(string(metadata, "sourceSha256"), SOURCE_SHA);
    assert_eq!(string(&metadata["pins"], "package"), PACKAGE_SHA);
    assert_eq!(string(&metadata["pins"], "lock"), LOCK_SHA);
    assert_eq!(string(&metadata["pins"], "toolchain"), TOOLCHAIN_SHA);
    assert_eq!(string(&metadata["pins"], "node"), NODE_SHA);
    assert_eq!(string(&metadata["pins"], "typescript"), TYPESCRIPT_SHA);
    assert_eq!(
        string(&metadata["pins"], "typescriptPackage"),
        TYPESCRIPT_PACKAGE_SHA
    );

    let hashes = metadata["nativeHashes"].as_object().expect("native hashes");
    assert_eq!(hashes.len(), NATIVE_FILES.len());
    for (file, compiled) in NATIVE_FILES {
        let recorded = hashes
            .get(*file)
            .unwrap_or_else(|| panic!("missing {file}"));
        assert_eq!(
            hash(compiled),
            recorded.as_str().unwrap(),
            "compile-time {file}"
        );
        assert_eq!(
            hash(&read(&root.join(*file))),
            recorded.as_str().unwrap(),
            "runtime {file}"
        );
    }

    assert_eq!(
        hash(&read(&root.join("src/utils/ai/constants.ts"))),
        SOURCE_SHA
    );
    assert_eq!(hash(&read(&root.join("package.json"))), PACKAGE_SHA);
    assert_eq!(hash(&read(&root.join("package-lock.json"))), LOCK_SHA);
    assert_eq!(
        hash(&read(&root.join("rust-toolchain.toml"))),
        TOOLCHAIN_SHA
    );

    for (variable, expected) in [
        ("DIMA_AI_CONSTANTS_NODE_BINARY", NODE_SHA),
        (
            "DIMA_AI_CONSTANTS_TYPESCRIPT_IMPLEMENTATION",
            TYPESCRIPT_SHA,
        ),
        (
            "DIMA_AI_CONSTANTS_TYPESCRIPT_PACKAGE",
            TYPESCRIPT_PACKAGE_SHA,
        ),
    ] {
        if let Some(value) = std::env::var_os(variable) {
            let path = PathBuf::from(value);
            assert!(path.is_absolute(), "{variable} must be absolute");
            assert_eq!(hash(&read(&path)), expected, "{variable}");
        }
    }
}

#[test]
#[ignore = "external pinned actual-source corpus required"]
fn replay_actual_source_oracle() {
    let root = source_root();
    let workspace = root
        .parent()
        .expect("dimabot root has a workspace parent")
        .to_path_buf();
    let dir = PathBuf::from(
        std::env::var_os("DIMA_AI_CONSTANTS_REFERENCE_DIR")
            .expect("external source oracle directory is required"),
    );
    assert!(dir.is_absolute(), "absolute oracle directory required");
    let dir = dir
        .canonicalize()
        .expect("existing oracle directory required");
    assert!(
        !dir.starts_with(&workspace),
        "oracle directory must be external to the checkout"
    );
    let raw = read(&dir.join("ai_constants_reference.json"));
    let pin = std::env::var("DIMA_AI_CONSTANTS_REFERENCE_SHA256")
        .expect("independently supplied fixture SHA-256");
    assert_eq!(pin.len(), 64);
    assert_eq!(hash(&raw), pin, "source fixture SHA-256");
    let fixture: Value = serde_json::from_slice(&raw).expect("valid oracle JSON");
    let metadata = &fixture["metadata"];
    assert_eq!(metadata["schema"].as_u64(), Some(1));
    assert_eq!(string(metadata, "node"), "v24.22.1");
    assert_eq!(string(metadata, "v8"), "13.6.233.17-node.58");
    assert_eq!(string(metadata, "icu"), "78.3");
    assert_eq!(string(metadata, "unicode"), "17.0");
    assert_eq!(string(metadata, "typescript"), "5.9.3");
    assert_eq!(string(metadata, "source"), "src/utils/ai/constants.ts");
    assert_eq!(metadata["statements"].as_u64(), Some(16));
    assert_eq!(metadata["imports"], serde_json::json!([]));
    assert_eq!(metadata["exports"], serde_json::json!(EXPORTS));
    assert_eq!(
        metadata["functionLengths"],
        serde_json::json!({"selectChatModel": 1, "getBackgroundSummaryModel": 1, "getProviderRestriction": 1})
    );
    verify_native_hashes(metadata, &root, &workspace);

    let tables_json = string(&fixture, "tablesJson");
    assert_eq!(tables_json, to_json_string(), "serialized table surface");

    let tables = &fixture["tables"];
    assert_eq!(tables["MODELS"]["keys"], serde_json::json!(Models::KEYS));
    assert_eq!(
        tables["MODELS"]["values"],
        serde_json::json!([MODELS.free, MODELS.exhausted, MODELS.premium, MODELS.pro])
    );
    assert_eq!(
        tables["BACKGROUND_MODELS"]["keys"],
        serde_json::json!(BackgroundModels::KEYS)
    );
    assert_eq!(
        tables["BACKGROUND_MODELS"]["values"],
        serde_json::json!([
            BACKGROUND_MODELS.free,
            BACKGROUND_MODELS.premium,
            BACKGROUND_MODELS.pro
        ])
    );
    assert_eq!(
        tables["CODING_MODELS"]["keys"],
        serde_json::json!(CodingModels::KEYS)
    );
    assert_eq!(
        tables["CODING_MODELS"]["values"],
        serde_json::json!([
            CODING_MODELS.pro,
            CODING_MODELS.premium,
            CODING_MODELS.free,
            CODING_MODELS.exhausted
        ])
    );
    assert_eq!(
        tables["TOKEN_LIMITS"]["keys"],
        serde_json::json!(TokenLimits::KEYS)
    );
    assert_eq!(
        tables["TOKEN_LIMITS"]["values"],
        serde_json::json!([25_000])
    );
    assert_eq!(
        string(&tables["TOKEN_LIMITS"]["bits"], "default"),
        format!("{:016x}", f64::from(TOKEN_LIMITS.default).to_bits())
    );
    assert_eq!(
        tables["EMBEDDING_MODELS"]["keys"],
        serde_json::json!(EmbeddingModels::KEYS)
    );
    assert_eq!(
        tables["EMBEDDING_MODELS"]["values"],
        serde_json::json!([EMBEDDING_MODELS.default, EMBEDDING_MODELS.multilingual])
    );
    assert_eq!(
        tables["EMBEDDING_DIMENSIONS"]["keys"],
        serde_json::json!(["lfm2.5-embedding-350m"])
    );
    assert_eq!(
        tables["EMBEDDING_DIMENSIONS"]["values"],
        serde_json::json!([1024])
    );
    assert_eq!(
        string(
            &tables["EMBEDDING_DIMENSIONS"]["bits"],
            "lfm2.5-embedding-350m"
        ),
        format!("{:016x}", f64::from(1024u32).to_bits())
    );
    assert_eq!(
        tables["MODEL_PROVIDER_RESTRICTIONS"]["keys"],
        serde_json::json!(MODEL_PROVIDER_RESTRICTION_KEYS)
    );
    assert_eq!(
        tables["MODEL_PROVIDER_RESTRICTIONS"]["only"]["deepseek/deepseek-v4-pro"],
        serde_json::json!(["deepseek"])
    );

    let scalars = &fixture["scalars"];
    assert_eq!(string(scalars, "MINIMAX_MODEL"), MINIMAX_MODEL);
    assert_eq!(string(scalars, "MINIMAX_BASE_URL"), MINIMAX_BASE_URL);
    assert_eq!(
        scalars["MINIMAX_COST_PER_M_INPUT"].as_f64(),
        Some(MINIMAX_COST_PER_M_INPUT)
    );
    assert_eq!(
        string(scalars, "MINIMAX_COST_PER_M_INPUT_BITS"),
        format!("{:016x}", MINIMAX_COST_PER_M_INPUT_BITS)
    );
    assert_eq!(
        scalars["MINIMAX_COST_PER_M_OUTPUT"].as_f64(),
        Some(MINIMAX_COST_PER_M_OUTPUT)
    );
    assert_eq!(
        string(scalars, "MINIMAX_COST_PER_M_OUTPUT_BITS"),
        format!("{:016x}", MINIMAX_COST_PER_M_OUTPUT_BITS)
    );
    assert_eq!(scalars["DEFAULT_TIMEOUT_MS"].as_u64(), Some(8_000));
    assert_eq!(
        string(scalars, "DEFAULT_TIMEOUT_MS_BITS"),
        format!("{:016x}", f64::from(DEFAULT_TIMEOUT_MS).to_bits())
    );
    assert_eq!(
        string(scalars, "BACKGROUND_MODEL_FALLBACK"),
        BACKGROUND_MODEL_FALLBACK
    );

    let mut replayed = 0usize;
    for case in fixture["selectChatModel"].as_array().expect("select cases") {
        let input = &case["input"];
        let mode = string(case, "mode");
        let plan_input = match string(input, "kind") {
            "undefined" | "null" | "missing" => PlanInput::Missing,
            "string" | "units" => PlanInput::Units(units(&input["units"])),
            _ => PlanInput::NonString,
        };
        let plan = plan_input.value();
        let expected = string(case, "expected");
        let actual = match mode {
            "default" => select_chat_model_value(plan, SELECT_CHAT_MODEL_DEFAULT_IS_EXHAUSTED),
            "false" => select_chat_model_value(plan, false),
            "true" => select_chat_model_value(plan, true),
            other => panic!("unknown mode {other}"),
        };
        assert_eq!(actual, expected, "selectChatModel {input:?} {mode}");
        replayed += 1;
    }

    for case in fixture["getBackgroundSummaryModel"]
        .as_array()
        .expect("background cases")
    {
        let input = &case["input"];
        let expected = string(case, "expected");
        let actual = match string(input, "kind") {
            "undefined" => get_background_summary_model(None),
            "null" => get_background_summary_model(None),
            _ => get_background_summary_model_units(&units(&input["units"])),
        };
        assert_eq!(actual, expected, "getBackgroundSummaryModel {input:?}");
        replayed += 1;
    }

    for case in fixture["getProviderRestriction"]
        .as_array()
        .expect("provider cases")
    {
        let input = &case["input"];
        let key = units(&input["units"]);
        let kind = string(case, "resultKind");
        let actual = get_provider_restriction_units(&key);
        match kind {
            "restriction" => {
                let restriction = actual.expect("own entry");
                assert_eq!(
                    serde_json::json!(restriction.only),
                    case["only"],
                    "{}",
                    string(case, "id")
                );
                assert_eq!(
                    get_provider_restriction(&String::from_utf16(&key).unwrap()),
                    Some(restriction)
                );
                assert!(case["hasOwn"].as_bool().unwrap());
            }
            "undefined" => {
                assert_eq!(actual, None, "{}", string(case, "id"));
                assert!(!case["hasOwn"].as_bool().unwrap());
            }
            "function" | "object" => {
                // Recorded source-only prototype return; the typed boundary
                // returns None and the divergence is explicit, not silent.
                assert_eq!(actual, None, "{}", string(case, "id"));
                assert!(!case["hasOwn"].as_bool().unwrap());
            }
            other => panic!("unknown provider result kind {other}"),
        }
        replayed += 1;
    }

    let boundaries = fixture["boundaries"].as_array().expect("boundaries");
    let ids = boundaries
        .iter()
        .map(|boundary| string(boundary, "id"))
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "prototype-chain",
            "runtime-mutability",
            "non-boolean-exhausted",
            "lone-surrogate-keys"
        ]
    );
    assert_eq!(
        metadata["total"].as_u64().unwrap() as usize,
        replayed,
        "every recorded case replayed"
    );
    assert!(replayed >= 100, "incomplete corpus");
}

enum PlanInput {
    Missing,
    Units(Vec<u16>),
    NonString,
}

impl PlanInput {
    fn value(&self) -> PlanTierValue<'_> {
        match self {
            PlanInput::Missing => PlanTierValue::Missing,
            PlanInput::Units(units) => PlanTierValue::CodeUnits(units.as_slice()),
            PlanInput::NonString => PlanTierValue::NonString,
        }
    }
}
