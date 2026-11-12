//! Asserts every golden vector written by `tests/vectors/generate.mjs` (real Node, production
//! packages). The JWT round trip has a second step: `jwt_rust_signed_tokens_for_node` writes the
//! tokens Rust signs to a file and has `node … --verify-rust <file>` check them with
//! `jsonwebtoken` (see the script's header). That step needs `node` and the production
//! `node_modules`: from `DIMABOT_NODE_MODULES`, this checkout's `dimabot/node_modules`, or the
//! main checkout's when this is a git worktree. Without them it is skipped with a message on
//! stderr; set `DIMA_REQUIRE_NODE=1` to make a skip a failure.
// Test helpers outside `#[test]` functions: a malformed vector file should fail loudly.
#![allow(clippy::panic)]

use dima_core::crypto::cipher::{CipherError, CredentialCipher, StoredCredential};
use dima_core::crypto::digest::{constant_time_eq, hmac_sha256, md5, sha1, sha256};
use dima_core::crypto::encoding::{
    decode_base64_lenient, decode_hex_lenient, encode_base64, encode_base64url, encode_hex,
    latin1_to_string,
};
use dima_core::crypto::jwt::{
    self, Algorithm, HMAC_ALGORITHMS, JwtError, SignOptions, Timespan, VerifyOptions,
};
use dima_core::crypto::keys;
use dima_core::crypto::webhook::{self, PolarWebhook, WebhookHeaders};
use dima_core::env::{dotenv, read};
use dima_core::random::number_to_radix_string;
use dima_core::{SecretBytes, SecretString};
use serde_json::{Value, json};

fn load(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/vectors")
        .join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    // Node writes lone surrogates as escapes; JSON.parse in the reference would keep them, the
    // Rust edge turns them into U+FFFD (text rule 3), on both sides of each comparison.
    let bytes = dima_text::sanitize_lone_surrogates(&bytes);
    serde_json::from_slice(&bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
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

fn double(value: &Value) -> f64 {
    f64::from_bits(
        u64::from_str_radix(text(value), 16).unwrap_or_else(|_| panic!("bad bits {value}")),
    )
}

fn same(left: f64, right: f64) -> bool {
    left.to_bits() == right.to_bits() || (left.is_nan() && right.is_nan())
}

fn bytes_of(base64: &Value) -> Vec<u8> {
    decode_base64_lenient(text(base64))
}

/// Collects mismatches and fails once with all of them, with the vector count.
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

    fn eq<T: PartialEq + std::fmt::Debug>(
        &mut self,
        case: impl std::fmt::Display,
        actual: T,
        expected: T,
    ) {
        self.count += 1;
        if actual != expected {
            self.failures
                .push(format!("{case}: got {actual:?}, expected {expected:?}"));
        }
    }

    fn finish(self) {
        assert!(self.count > 0, "{}: no vectors", self.name);
        assert!(
            self.failures.is_empty(),
            "{}: {} of {} vectors failed:\n{}",
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
        println!("{}: {} vectors", self.name, self.count);
    }
}

// ---------------------------------------------------------------- environment

#[test]
fn env_idioms() {
    let file = load("env.json");
    let mut check = Check::new("env idioms");
    for row in rows(&file, "rows") {
        let idiom = text(&row["idiom"]);
        let x = row["input"].as_str();
        let case = format!("{idiom}({x:?})");
        if let Some(expected) = row.get("number") {
            let expected = double(expected);
            let actual = match idiom {
                "number" => read::number(x),
                "number_or" => read::number_or(x, 50.0),
                "number_or_else" => read::number_or_else(x, 7.0),
                "number_nullish" => read::number_nullish(x, 7.0),
                "max_number_or" => read::max_number_or(x, 60.0, 300.0),
                "max_number_or_else" => read::max_number_or_else(x, 1000.0, 60000.0),
                "max_floor_number_or_else" => read::max_floor_number_or_else(x, 2.0, 3.0),
                "clamp_number_or" => read::clamp_number_or(x, 1.0, 1000.0, 100.0),
                "clamp_number_or_reversed" => read::clamp_number_or(x, 0.0, 1.0, 0.25),
                "finite_max_nullish" => read::finite_max_nullish(x, 60000.0, 60000.0),
                "finite_max_or" => read::finite_max_or(x, 1000.0, 5000.0),
                "finite_number" => read::finite_number(x, 2.0),
                "parse_int_decimal" => read::parse_int_decimal(x),
                "timer_delay_ms" => read::timer_delay_ms(read::number_or(x, 1000.0)),
                "safe_integer_setting" => {
                    #[allow(clippy::cast_precision_loss)]
                    let value = read::safe_integer_setting("X", x, 1000.0, 250.0, 2_147_483_647.0)
                        .map_or(f64::NAN, |n| n as f64);
                    // The Rust value is an integer: JavaScript's -0 is 0 here.
                    check.eq(&case, value == expected || same(value, expected), true);
                    continue;
                }
                other => panic!("unknown numeric idiom {other}"),
            };
            check.eq(
                format!("{case} = {actual} (expected {expected})"),
                same(actual, expected),
                true,
            );
            continue;
        }
        if let Some(error) = row.get("error") {
            let actual = match idiom {
                "safe_integer_setting" => {
                    read::safe_integer_setting("X", x, 1000.0, 250.0, 2_147_483_647.0)
                        .err()
                        .map(|error| error.to_string())
                }
                other => panic!("unexpected error for {other}"),
            };
            check.eq(&case, actual.as_deref(), Some(text(error)));
            continue;
        }
        let expected = &row["value"];
        let actual = match idiom {
            "is_true" => json!(read::is_true(x)),
            "not_false" => json!(read::not_false(x)),
            "not_false_ignore_case" => json!(read::not_false_ignore_case(x)),
            "truthy" => json!(read::truthy(x)),
            "string_or" => json!(read::string_or(x, "def")),
            "string_nullish" => json!(read::string_nullish(x, "def")),
            "non_empty" => json!(read::non_empty(x)),
            "trimmed" => json!(read::trimmed(x)),
            "trimmed_or" => json!(read::trimmed_or(x, "def")),
            "or_undefined_text" => json!(read::or_undefined_text(x)),
            "strip_trailing_slashes" => json!(read::strip_trailing_slashes(x.unwrap_or(""))),
            "strip_one_trailing_slash" => json!(read::strip_one_trailing_slash(x.unwrap_or(""))),
            "comma_list" => json!(read::comma_list(x, "a.com,www.a.com")),
            // Compared as JavaScript writes the value: a JSON number is a double there (`-0`,
            // `1e3` and 2^53 + 1 are 0, 1000 and 2^53), while serde_json keeps the literal.
            "json_value" => read::json_value(x).map_or(Value::Null, |value| {
                json!({ "value": serde_json::from_str::<Value>(&dima_text::to_js_json(&value)).unwrap_or_default() })
            }),
            other => panic!("unknown idiom {other}"),
        };
        check.eq(&case, &actual, expected);
    }
    check.finish();
}

#[test]
fn dotenv_parser() {
    let file = load("dotenv.json");
    let mut check = Check::new("dotenv");
    for (index, sample) in rows(&file, "samples").iter().enumerate() {
        let mut actual = dotenv::parse(text(&sample["text"]));
        let mut expected: Vec<(String, String)> = sample["parsed"]
            .as_array()
            .unwrap_or_else(|| panic!("parsed"))
            .iter()
            .map(|pair| (text(&pair[0]).to_owned(), text(&pair[1]).to_owned()))
            .collect();
        // JavaScript lists integer keys first; the pairs are the same either way.
        actual.sort();
        expected.sort();
        for pair in expected.iter().filter(|pair| !actual.contains(pair)) {
            check
                .failures
                .push(format!("sample {index}: missing {pair:?}"));
        }
        for pair in actual.iter().filter(|pair| !expected.contains(pair)) {
            check
                .failures
                .push(format!("sample {index}: unexpected {pair:?}"));
        }
        check.eq(format!("sample {index} size"), actual.len(), expected.len());
    }
    check.finish();
}

// ---------------------------------------------------------------- cipher

#[test]
fn credential_cipher() {
    let file = load("cipher.json");
    let mut check = Check::new("cipher");
    for row in rows(&file, "keys") {
        let secret = text(&row["secret"]);
        let expected = row.get("error").map(text);
        let actual = CredentialCipher::new(secret)
            .err()
            .map(|error| error.to_string());
        check.eq(format!("key {secret:?}"), actual.as_deref(), expected);
    }
    let cipher =
        CredentialCipher::new(text(&file["key"])).unwrap_or_else(|error| panic!("{error}"));
    // Rust encrypting with Node's IVs is checked by the cipher's unit tests (`encrypt_with_iv`
    // exists only with the `test-util` feature); here, Node encrypts and Rust decrypts.
    for row in rows(&file, "encrypt") {
        let plaintext = text(&row["text"]);
        let expected: StoredCredential =
            serde_json::from_value(row["stored"].clone()).unwrap_or_else(|error| panic!("{error}"));
        let back = cipher
            .decrypt(&expected)
            .unwrap_or_else(|error| panic!("{error}"));
        check.eq(
            format!("decrypt {plaintext:?}"),
            back,
            (!plaintext.is_empty()).then(|| plaintext.to_owned()),
        );
        // A fresh IV from the system generator round-trips too.
        let fresh = cipher
            .encrypt(plaintext, &dima_core::SystemRandom)
            .unwrap_or_else(|error| panic!("{error}"));
        check.eq(
            format!("round trip {plaintext:?}"),
            cipher
                .decrypt(&fresh)
                .unwrap_or_else(|error| panic!("{error}")),
            (!plaintext.is_empty()).then(|| plaintext.to_owned()),
        );
    }
    for (index, row) in rows(&file, "decrypt").iter().enumerate() {
        let cipher =
            CredentialCipher::new(text(&row["key"])).unwrap_or_else(|error| panic!("{error}"));
        let stored = &row["stored"];
        let actual = cipher.decrypt_fields(stored["iv"].as_str(), stored["content"].as_str());
        let expected = match row.get("error") {
            Some(error) => {
                check.eq(
                    format!("decrypt error {index}"),
                    text(error),
                    "Invalid initialization vector",
                );
                Err(CipherError::InvalidIv)
            }
            None => Ok(row["ok"].as_str().map(str::to_owned)),
        };
        check.eq(format!("decrypt {index}"), actual, expected);
    }
    check.finish();
}

// ---------------------------------------------------------------- digests and encodings

#[test]
fn digests_and_encodings() {
    let file = load("digest.json");
    let mut check = Check::new("digest");
    for row in rows(&file, "digests") {
        let input = text(&row["input"]);
        let outputs = [
            (
                "sha256",
                sha256(input).hex(),
                sha256(input).base64(),
                sha256(input).base64url(),
            ),
            (
                "sha1",
                sha1(input).hex(),
                sha1(input).base64(),
                sha1(input).base64url(),
            ),
            (
                "md5",
                md5(input).hex(),
                md5(input).base64(),
                md5(input).base64url(),
            ),
        ];
        for (alg, hex, base64, base64url) in outputs {
            check.eq(
                format!("{alg} hex {input:?}"),
                hex.as_str(),
                text(&row[format!("{alg}_hex")]),
            );
            check.eq(
                format!("{alg} base64 {input:?}"),
                base64.as_str(),
                text(&row[format!("{alg}_base64")]),
            );
            check.eq(
                format!("{alg} base64url {input:?}"),
                base64url.as_str(),
                text(&row[format!("{alg}_base64url")]),
            );
        }
    }
    for row in rows(&file, "hmacs") {
        let key = SecretBytes::from_text(text(&row["key"]));
        let mac = hmac_sha256(&key, text(&row["input"]));
        check.eq(
            format!("hmac {}", row["input"]),
            mac.hex().as_str(),
            text(&row["hex"]),
        );
        check.eq(
            format!("hmac64 {}", row["input"]),
            mac.base64url().as_str(),
            text(&row["base64url"]),
        );
    }
    for row in rows(&file, "base64") {
        let input = text(&row["input"]);
        let decoded = encode_hex(&decode_base64_lenient(input));
        check.eq(
            format!("base64 {input:?}"),
            decoded.as_str(),
            text(&row["hex"]),
        );
        check.eq(
            format!("base64url {input:?}"),
            decoded.as_str(),
            text(&row["url_hex"]),
        );
    }
    for row in rows(&file, "hex") {
        let input = text(&row["input"]);
        check.eq(
            format!("hex {input:?}"),
            encode_hex(&decode_hex_lenient(input)).as_str(),
            text(&row["hex"]),
        );
    }
    for row in rows(&file, "encode") {
        let bytes: Vec<u8> =
            serde_json::from_value(row["bytes"].clone()).unwrap_or_else(|error| panic!("{error}"));
        check.eq(
            format!("base64 {bytes:?}"),
            encode_base64(&bytes).as_str(),
            text(&row["base64"]),
        );
        check.eq(
            format!("base64url {bytes:?}"),
            encode_base64url(&bytes).as_str(),
            text(&row["base64url"]),
        );
        check.eq(
            format!("hex {bytes:?}"),
            encode_hex(&bytes).as_str(),
            text(&row["hex"]),
        );
        check.eq(
            format!("latin1 {bytes:?}"),
            latin1_to_string(&bytes).as_str(),
            text(&row["latin1"]),
        );
    }
    check.eq("constant time", constant_time_eq(b"a", b"a"), true);
    check.finish();
}

// ---------------------------------------------------------------- lookup keys

#[test]
fn lookup_keys() {
    let file = load("keys.json");
    let mut check = Check::new("keys");
    let secret_key = SecretString::from(text(&file["secret_key"]));
    for row in rows(&file, "token_hash") {
        let input = text(&row["input"]);
        check.eq(
            format!("token_hash {input:?}"),
            keys::token_hash(input).as_str(),
            text(&row["hex"]),
        );
        check.eq(
            format!("sha256_base64url {input:?}"),
            keys::sha256_base64url(input).as_str(),
            text(&row["base64url"]),
        );
    }
    for row in rows(&file, "rate_limit") {
        let actual = keys::rate_limit_key(text(&row["scope"]), text(&row["subject"]));
        check.eq(
            format!("rate_limit {}", row["subject"]),
            actual.as_str(),
            text(&row["key"]),
        );
    }
    for row in rows(&file, "billing") {
        let actual = keys::billing_context_cache_key(text(&row["customer"]));
        check.eq(
            format!("billing {}", row["customer"]),
            actual.as_str(),
            text(&row["key"]),
        );
    }
    for row in rows(&file, "credit_gift") {
        let actual = keys::credit_gift_id(text(&row["user"]), text(&row["request"]));
        check.eq(
            format!("credit_gift {}", row["request"]),
            actual.as_str(),
            text(&row["id"]),
        );
    }
    for row in rows(&file, "json_sha256") {
        let json = text(&row["json"]);
        let value: Value = serde_json::from_str(json).unwrap_or_else(|error| panic!("{error}"));
        check.eq(
            format!("json {json}"),
            dima_text::to_js_json(&value).as_str(),
            json,
        );
        check.eq(
            format!("json_sha256 {json}"),
            keys::json_sha256_hex(&value).as_str(),
            text(&row["hex"]),
        );
    }
    for row in rows(&file, "object_id") {
        let identity = text(&row["identity"]);
        check.eq(
            format!("object_id {identity}"),
            keys::object_id_hex_from_sha256(identity).as_str(),
            text(&row["hex"]),
        );
    }
    for row in rows(&file, "qdrant") {
        let id = keys::qdrant_point_id(
            text(&row["ns"]),
            text(&row["entity"]),
            double(&row["timestamp"]),
        );
        check.eq(
            format!("qdrant {row}"),
            Some(u64::from(id)),
            row["id"].as_u64(),
        );
    }
    for row in rows(&file, "overlay") {
        let channel = text(&row["channel"]);
        let actual = keys::dimafx_overlay_token(&secret_key, channel)
            .unwrap_or_else(|error| panic!("{error}"));
        check.eq(
            format!("overlay {channel:?}"),
            actual.as_str(),
            text(&row["token"]),
        );
    }
    for row in rows(&file, "authorize") {
        let actual =
            keys::authorize_dimafx_overlay(&secret_key, text(&row["channel"]), text(&row["token"]));
        check.eq(
            format!("authorize {}", row["channel"]),
            actual.ok(),
            row["ok"].as_bool(),
        );
    }
    for row in rows(&file, "trace") {
        let actual = keys::verify_trace_signature(
            &secret_key,
            text(&row["traceparent"]),
            text(&row["signature"]),
        );
        // The reference throws for a non-ASCII signature of the right length; Rust answers false.
        let expected = row["ok"].as_bool().unwrap_or(false);
        check.eq(format!("trace {}", row["signature"]), actual, expected);
    }
    check.finish();
}

#[test]
fn radix_text() {
    let file = load("radix.json");
    let mut check = Check::new("radix");
    for row in rows(&file, "rows") {
        let x = double(&row["x"]);
        for (radix, key) in [(36, "base36"), (16, "base16"), (2, "base2")] {
            check.eq(
                format!("{x:e}.toString({radix})"),
                number_to_radix_string(x, radix).as_str(),
                text(&row[key]),
            );
        }
    }
    check.finish();
}

// ---------------------------------------------------------------- JWT

fn key_of(spec: &Value) -> SecretBytes {
    match spec.get("base64") {
        Some(base64) => SecretBytes::new(bytes_of(base64)),
        None => SecretBytes::from_text(text(&spec["text"])),
    }
}

fn timespan(value: &Value) -> Option<Timespan<'_>> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(Timespan::Text(text)),
        Value::Number(n) => Some(Timespan::Seconds(
            n.as_i64().unwrap_or_else(|| panic!("timespan {n}")),
        )),
        other => panic!("timespan {other}"),
    }
}

fn algorithm(name: &str) -> Algorithm {
    match name {
        "HS256" => Algorithm::Hs256,
        "HS384" => Algorithm::Hs384,
        "HS512" => Algorithm::Hs512,
        other => panic!("algorithm {other}"),
    }
}

fn sign_options(options: &Value) -> SignOptions<'_> {
    SignOptions {
        algorithm: options["algorithm"]
            .as_str()
            .map_or(Algorithm::Hs256, algorithm),
        expires_in: timespan(&options["expiresIn"]),
        not_before: timespan(&options["notBefore"]),
        audience: options["audience"].as_str(),
        issuer: options["issuer"].as_str(),
        subject: options["subject"].as_str(),
        jwtid: options["jwtid"].as_str(),
        keyid: options["keyid"].as_str(),
        no_timestamp: options["noTimestamp"].as_bool().unwrap_or(false),
    }
}

/// Holds the borrowed lists a `VerifyOptions` points at.
struct VerifyLists<'a> {
    algorithms: Vec<Algorithm>,
    audience: Vec<&'a str>,
    issuer: Vec<&'a str>,
}

fn string_list(value: &Value) -> Vec<&str> {
    match value {
        Value::Null => Vec::new(),
        Value::String(text) => vec![text.as_str()],
        Value::Array(items) => items.iter().map(text).collect(),
        other => panic!("list {other}"),
    }
}

fn verify_lists(options: &Value) -> VerifyLists<'_> {
    VerifyLists {
        algorithms: match options["algorithms"].as_array() {
            Some(names) => names.iter().map(|name| algorithm(text(name))).collect(),
            None => HMAC_ALGORITHMS.to_vec(),
        },
        audience: string_list(&options["audience"]),
        issuer: string_list(&options["issuer"]),
    }
}

fn verify_options<'a>(options: &'a Value, lists: &'a VerifyLists<'a>) -> VerifyOptions<'a> {
    VerifyOptions {
        audience: &lists.audience,
        issuer: &lists.issuer,
        subject: options["subject"].as_str(),
        jwtid: options["jwtid"].as_str(),
        nonce: options["nonce"].as_str(),
        max_age: timespan(&options["maxAge"]),
        clock_tolerance_secs: options["clockTolerance"].as_f64().unwrap_or(0.0),
        ignore_expiration: options["ignoreExpiration"].as_bool().unwrap_or(false),
        ignore_not_before: options["ignoreNotBefore"].as_bool().unwrap_or(false),
        ..VerifyOptions::new(&lists.algorithms)
    }
}

fn now_of(row: &Value) -> i64 {
    row["now_ms"].as_i64().unwrap_or_else(|| panic!("now_ms"))
}

#[test]
fn jwt_vectors() {
    let file = load("jwt.json");
    let mut check = Check::new("jwt");
    for row in rows(&file, "ms") {
        let input = text(&row["input"]);
        check.eq(
            format!("ms({input:?})"),
            jwt::ms(input).map(f64::to_bits),
            row["ms"].as_str().map(|_| double(&row["ms"]).to_bits()),
        );
    }
    for row in rows(&file, "sign") {
        let name = text(&row["name"]);
        let payload = row["payload"]
            .as_object()
            .unwrap_or_else(|| panic!("payload"));
        let actual = jwt::sign(
            payload,
            &key_of(&row["key"]),
            &sign_options(&row["options"]),
            now_of(row),
        );
        match (row.get("ok"), row.get("error")) {
            (Some(token), _) => check.eq(name, actual.as_deref().ok(), Some(text(token))),
            (_, Some(error)) => check.eq(
                name,
                actual.err().map(|error| error.to_string()).as_deref(),
                Some(text(error)),
            ),
            _ => panic!("sign row {name}"),
        }
    }
    for row in rows(&file, "verify") {
        let name = text(&row["name"]);
        let lists = verify_lists(&row["options"]);
        let options = verify_options(&row["options"], &lists);
        let actual = jwt::verify(
            text(&row["token"]),
            &key_of(&row["key"]),
            &options,
            now_of(row),
        );
        match (row.get("ok"), row.get("error")) {
            (Some(payload), _) => check.eq(name, actual.as_ref().ok(), Some(payload)),
            (_, Some(_)) if row["error_name"] == "SyntaxError" => {
                check.eq(name, actual.err(), Some(JwtError::PayloadSyntax));
            }
            (_, Some(error)) => check.eq(
                name,
                actual.err().map(|error| error.to_string()).as_deref(),
                Some(text(error)),
            ),
            _ => panic!("verify row {name}"),
        }
    }
    for row in rows(&file, "extension_keys") {
        let secret = text(&row["secret"]);
        let actual: Vec<String> = jwt::twitch_extension_keys(secret)
            .iter()
            .map(|key| encode_hex(key.expose()))
            .collect();
        let expected: Vec<String> = string_list(&row["keys"])
            .into_iter()
            .map(str::to_owned)
            .collect();
        check.eq(format!("extension keys {secret:?}"), actual, expected);
    }
    for (index, row) in rows(&file, "extension").iter().enumerate() {
        let keys = jwt::twitch_extension_keys(text(&row["secret"]));
        let actual = jwt::verify_twitch_extension_jwt(text(&row["token"]), &keys, now_of(row));
        // `null` and a thrown error both end in 401 in the reference's middleware.
        let expected = row.get("ok").filter(|value| !value.is_null()).cloned();
        check.eq(format!("extension {index}"), actual, expected);
    }
    check.finish();
}

/// The `node_modules` holding the production `jsonwebtoken`, if any.
fn dimabot_node_modules() -> Option<std::path::PathBuf> {
    let has_jwt = |dir: &std::path::Path| dir.join("jsonwebtoken/package.json").is_file();
    if let Some(dir) = std::env::var_os("DIMABOT_NODE_MODULES") {
        return Some(std::path::PathBuf::from(dir)).filter(|dir| has_jwt(dir));
    }
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    // crates/core -> dima-rust -> the repository.
    let here = manifest.join("../../../dimabot/node_modules");
    if has_jwt(&here) {
        return Some(here);
    }
    // A git worktree has no node_modules of its own: use the main checkout's.
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(manifest)
        .output()
        .ok()?;
    let common = String::from_utf8(output.stdout).ok()?;
    let main = std::path::Path::new(common.trim())
        .parent()?
        .join("dimabot/node_modules");
    Some(main).filter(|dir| has_jwt(dir))
}

/// Runs `generate.mjs --verify-rust <rows>`: `Some(exit success, output)`, or `None` when Node or
/// the modules are not available.
fn node_verify(rows: &[Value], name: &str) -> Option<(bool, String)> {
    let modules = dimabot_node_modules()?;
    let path = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(rows).unwrap_or_default(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/generate.mjs");
    let output = std::process::Command::new("node")
        .arg(script)
        .arg("--verify-rust")
        .arg(&path)
        .env("DIMABOT_NODE_MODULES", modules)
        .output()
        .ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Some((output.status.success(), text))
}

/// Step two of the round trip: tokens signed here, checked by `jsonwebtoken.verify` in Node.
#[test]
fn jwt_rust_signed_tokens_for_node() {
    let file = load("jwt.json");
    let now = 1_762_819_200_000;
    let mut out = Vec::new();
    for row in rows(&file, "sign")
        .iter()
        .filter(|row| row.get("ok").is_some())
    {
        let options = &row["options"];
        let key = key_of(&row["key"]);
        let payload = row["payload"]
            .as_object()
            .unwrap_or_else(|| panic!("payload"));
        let token = jwt::sign(payload, &key, &sign_options(options), now)
            .unwrap_or_else(|error| panic!("{error}"));
        let algorithms_json =
            json!({ "algorithms": [options["algorithm"].as_str().unwrap_or("HS256")] });
        let lists = verify_lists(&algorithms_json);
        let verified = jwt::verify(
            &token,
            &key,
            &VerifyOptions {
                ignore_expiration: true,
                ignore_not_before: true,
                ..VerifyOptions::new(&lists.algorithms)
            },
            now,
        )
        .unwrap_or_else(|error| panic!("{}: {error}", text(&row["name"])));
        let mut node_row = json!({
            "name": row["name"],
            "token": token,
            "options": { "algorithms": lists.algorithms.iter().map(|alg| alg.name()).collect::<Vec<_>>(), "ignoreExpiration": true, "ignoreNotBefore": true },
            "now_ms": now,
            "payload": verified,
        });
        match row["key"].get("base64") {
            Some(base64) => node_row["key_base64"] = base64.clone(),
            None => node_row["key"] = row["key"]["text"].clone(),
        }
        out.push(node_row);
    }
    // Rust-only shapes: every unit `ms` reads, kid, nbf text, HS384/HS512 with claims.
    let extra = [
        (
            "weeks-and-kid",
            json!({"n": 1}),
            SignOptions {
                expires_in: Some(Timespan::Text("3 weeks")),
                keyid: Some("k-2"),
                not_before: Some(Timespan::Text("90s")),
                ..SignOptions::default()
            },
        ),
        (
            "hs384-claims",
            json!({"x": "ü"}),
            SignOptions {
                algorithm: Algorithm::Hs384,
                issuer: Some("dima"),
                subject: Some("s"),
                jwtid: Some("j"),
                expires_in: Some(Timespan::Text("2.5 hrs")),
                ..SignOptions::default()
            },
        ),
        (
            "hs512-aud",
            json!({"10": 1, "a": [1, 2]}),
            SignOptions {
                algorithm: Algorithm::Hs512,
                audience: Some("asset-preview"),
                expires_in: Some(Timespan::Seconds(30)),
                ..SignOptions::default()
            },
        ),
    ];
    for (name, payload, options) in extra {
        let key = SecretBytes::from_text("rust-only-test-key");
        let payload = payload.as_object().cloned().unwrap_or_default();
        let token =
            jwt::sign(&payload, &key, &options, now).unwrap_or_else(|error| panic!("{error}"));
        let algorithms = [options.algorithm];
        let verified = jwt::verify(
            &token,
            &key,
            &VerifyOptions {
                ignore_expiration: true,
                ignore_not_before: true,
                ..VerifyOptions::new(&algorithms)
            },
            now,
        )
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        out.push(json!({
            "name": name, "token": token, "key": "rust-only-test-key", "now_ms": now, "payload": verified,
            "options": { "algorithms": [options.algorithm.name()], "ignoreExpiration": true, "ignoreNotBefore": true },
        }));
    }
    let Some((ok, report)) = node_verify(&out, "dima-core-rust-signed.json") else {
        assert!(
            std::env::var_os("DIMA_REQUIRE_NODE").is_none_or(|value| value.is_empty()),
            "DIMA_REQUIRE_NODE is set but node or dimabot/node_modules is unavailable"
        );
        eprintln!(
            "SKIPPED: {} Rust-signed tokens not checked by Node (node or the production \
             jsonwebtoken in dimabot/node_modules not found; set DIMABOT_NODE_MODULES)",
            out.len()
        );
        return;
    };
    println!("{report}");
    assert!(ok, "jsonwebtoken rejected Rust-signed tokens:\n{report}");
    assert!(
        report.contains(&format!("{0}/{0} Rust-signed tokens accepted", out.len())),
        "unexpected Node output:\n{report}"
    );
    // Negative control: the check must be able to fail. A token whose payload Rust reports
    // differently, and one with a broken signature, are both mismatches for Node.
    let mut tampered = vec![out[0].clone(), out[0].clone()];
    tampered[0]["payload"]["tampered"] = json!(true);
    let token = text(&tampered[1]["token"]).to_owned();
    tampered[1]["token"] = json!(format!("{token}x"));
    let (ok, report) = node_verify(&tampered, "dima-core-rust-signed-tampered.json")
        .unwrap_or_else(|| panic!("node ran once but not twice"));
    assert!(!ok, "Node accepted tampered rows:\n{report}");
    assert_eq!(report.matches("MISMATCH").count(), 2, "{report}");
}

// ---------------------------------------------------------------- webhooks

#[test]
fn webhook_vectors() {
    let file = load("webhook.json");
    let mut check = Check::new("webhook");
    for row in rows(&file, "eventsub_sign") {
        let secret = SecretBytes::from_text(text(&row["secret"]));
        let actual = webhook::eventsub_signature(
            &secret,
            text(&row["id"]),
            text(&row["timestamp"]),
            &bytes_of(&row["body"]),
        );
        check.eq(
            format!("eventsub sign {}", row["body"]),
            actual.as_str(),
            text(&row["signature"]),
        );
    }
    for row in rows(&file, "eventsub_verify") {
        let secret = SecretBytes::from_text(text(&row["secret"]));
        let actual = webhook::verify_eventsub_signature(
            &secret,
            text(&row["id"]),
            text(&row["timestamp"]),
            &bytes_of(&row["body"]),
            text(&row["signature"]),
        );
        // A thrown RangeError in the reference (non-ASCII header) is a rejection here.
        check.eq(
            format!("eventsub verify {}", row["signature"]),
            actual,
            row["ok"].as_bool().unwrap_or(false),
        );
    }
    let hook = PolarWebhook::new(text(&file["polar_secret"])).unwrap_or_else(|| panic!("secret"));
    for row in rows(&file, "polar_sign") {
        let ts = row["timestamp"]
            .as_i64()
            .unwrap_or_else(|| panic!("timestamp"));
        let actual = hook.sign(text(&row["id"]), ts, &bytes_of(&row["body"]));
        check.eq(
            format!("polar sign {}", row["id"]),
            actual.as_str(),
            text(&row["signature"]),
        );
    }
    for row in rows(&file, "polar_verify") {
        let name = text(&row["name"]);
        let body = bytes_of(&row["body"]);
        let headers = WebhookHeaders {
            id: row["id"].as_str(),
            timestamp: row["timestamp"].as_str(),
            signature: row["signature"].as_str(),
        };
        let actual = hook.verify(&body, headers, now_of(row));
        match (row.get("ok"), row.get("error")) {
            (Some(_), _) => check.eq(name, actual, Ok(())),
            (_, Some(_)) if row["error_name"] == "SyntaxError" => {
                // Verified; the reference then fails in JSON.parse (500, not 403).
                check.eq(name, actual, Ok(()));
                check.eq(
                    format!("{name} body"),
                    serde_json::from_slice::<Value>(&body).is_err(),
                    true,
                );
            }
            (_, Some(error)) => check.eq(
                name,
                actual.err().map(|error| error.to_string()).as_deref(),
                Some(text(error)),
            ),
            _ => panic!("polar row {name}"),
        }
    }
    check.finish();
}
