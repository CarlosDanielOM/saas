#![cfg(all(feature = "credential-crypto", feature = "jwt"))]

use dima_rust::utils::{
    credential_crypto::{CredentialCipher, CredentialCryptoError, StoredCredential},
    jwt::{
        ActivationTokenService, email_auth_secret, sign_activation_token_at,
        verify_activation_token_at,
    },
};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/credential_activation_cases.json")).unwrap()
}

#[test]
fn credential_codec_matches_the_source_fixture() {
    let data = fixture();
    let cipher = CredentialCipher::new("fixture").unwrap();
    let iv = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    for case in data["credentialCases"].as_array().unwrap() {
        let encrypted = cipher
            .encrypt_with_iv(case["text"].as_str().unwrap(), iv)
            .unwrap();
        assert_eq!(serde_json::to_value(&encrypted).unwrap(), case["envelope"]);
        assert_eq!(
            serde_json::to_value(cipher.decrypt(Some(&encrypted)).unwrap()).unwrap(),
            case["decoded"]
        );
    }
}

#[test]
fn activation_signing_and_verification_match_source() {
    let data = fixture();
    let secret = data["fixtureSecret"].as_str().unwrap().as_bytes();
    let now = data["fixedNow"].as_u64().unwrap();
    for case in data["signCases"].as_array().unwrap() {
        let token = sign_activation_token_at(
            secret,
            case["userId"].as_str().unwrap(),
            case["login"].as_str().unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(token, case["token"]);
    }
    for case in data["verifyCases"].as_array().unwrap() {
        let result = verify_activation_token_at(secret, case["token"].as_str().unwrap(), now);
        let value = result
            .map(|verified| json!({"userId":verified.user_id,"login":verified.login}))
            .unwrap_or(Value::Null);
        assert_eq!(value, case["expected"], "{}", case["name"]);
    }
}

// Each configuration runs in a fresh, isolated child test process. No unsafe
// environment mutation and no shared-test-process environment race is needed.
#[test]
fn environment_initialization_matches_the_declared_contract() {
    use std::process::Command;
    let data = fixture();
    for kind in ["initialize", "secretCases"] {
        for (index, case) in data[kind].as_array().unwrap().iter().enumerate() {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "child_environment_probe",
                    "--ignored",
                    "--nocapture",
                ])
                .env_remove("SECRET_KEY")
                .env_remove("EMAIL_AUTH_JWT_SECRET")
                .env(
                    "CREDENTIAL_ACTIVATION_ENV_CASE",
                    json!({"kind":kind,"case":case,"fixedNow":data["fixedNow"]}).to_string(),
                );
            let field = if kind == "initialize" {
                "key"
            } else {
                "secret"
            };
            if let Some(secret) = case[field].as_str() {
                command.env(
                    if kind == "initialize" {
                        "SECRET_KEY"
                    } else {
                        "EMAIL_AUTH_JWT_SECRET"
                    },
                    secret,
                );
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{kind} case {index}: {}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
    }
}

#[test]
#[ignore = "only run by environment_initialization_matches_the_declared_contract"]
fn child_environment_probe() {
    let Ok(input) = std::env::var("CREDENTIAL_ACTIVATION_ENV_CASE") else {
        return;
    };
    let data: Value = serde_json::from_str(&input).unwrap();
    let case = &data["case"];
    if data["kind"] == "initialize" {
        let cipher = CredentialCipher::from_env();
        assert_eq!(cipher.is_ok(), case["nativeReady"].as_bool().unwrap());
        match cipher {
            Ok(cipher) => {
                assert_eq!(format!("{cipher:?}"), "CredentialCipher(<redacted>)");
                let credential = cipher.encrypt("fixture-token").unwrap();
                assert_eq!(
                    cipher.decrypt(Some(&credential)).unwrap().as_deref(),
                    Some("fixture-token")
                );
            }
            Err(error) => {
                if case["key"].is_null() || case["key"] == "" {
                    assert_eq!(error, CredentialCryptoError::MissingKey);
                } else {
                    assert_eq!(error, CredentialCryptoError::InvalidKeyLength);
                }
                assert!(!error.to_string().contains("fixture"));
            }
        }
    } else {
        let secret = email_auth_secret();
        assert_eq!(secret.is_ok(), case["nativeReady"].as_bool().unwrap());
        let service = ActivationTokenService::from_env();
        assert_eq!(service.is_ok(), secret.is_ok());
        if let Ok(secret) = secret {
            let expected = sign_activation_token_at(
                secret.as_bytes(),
                "fixture-user",
                "cdom201",
                data["fixedNow"].as_u64().unwrap(),
            )
            .unwrap();
            assert_eq!(expected, case["token"]);
            let service = service.unwrap();
            assert_eq!(format!("{service:?}"), "ActivationTokenService(<redacted>)");
            let token = service.sign("fixture-user", "cdom201").unwrap();
            let verified = service.verify(&token).unwrap();
            assert_eq!(verified.user_id, "fixture-user");
            assert_eq!(verified.login, "cdom201");
        }
    }
}

/// Same claims, payload lengths, warmup/iterations and sample count as the
/// source oracle's --benchmark. Encrypt includes fresh OS entropy each time.
#[test]
#[ignore = "explicit isolated release comparison only"]
fn benchmark_credentials_and_activation() {
    use std::{hint::black_box, time::Instant};
    let data = fixture();
    let cipher = CredentialCipher::new("fixture").unwrap();
    let secret = data["fixtureSecret"].as_str().unwrap().as_bytes();
    let now = data["fixedNow"].as_u64().unwrap();
    let mut runs = Vec::new();
    for workload in data["benchmarkInputs"].as_array().unwrap() {
        let text = workload["text"].as_str().unwrap();
        let envelope: StoredCredential =
            serde_json::from_value(workload["envelope"].clone()).unwrap();
        let user = workload["userId"].as_str().unwrap();
        let login = workload["login"].as_str().unwrap();
        let token = workload["token"].as_str().unwrap();
        let iterations = workload["iterations"].as_u64().unwrap() as usize;
        for operation in ["encryptEntropy", "decrypt", "sign", "verify"] {
            let run = || -> usize {
                match operation {
                    "encryptEntropy" => black_box(cipher.encrypt(black_box(text)).unwrap())
                        .content
                        .unwrap()
                        .len(),
                    "decrypt" => black_box(cipher.decrypt(Some(black_box(&envelope))).unwrap())
                        .unwrap()
                        .len(),
                    "sign" => black_box(
                        sign_activation_token_at(
                            black_box(secret),
                            black_box(user),
                            black_box(login),
                            now,
                        )
                        .unwrap(),
                    )
                    .len(),
                    "verify" => black_box(
                        verify_activation_token_at(black_box(secret), black_box(token), now)
                            .unwrap(),
                    )
                    .user_id
                    .len(),
                    _ => unreachable!(),
                }
            };
            for _ in 0..100 {
                black_box(run());
            }
            let mut samples = Vec::new();
            let mut sink = 0;
            for _ in 0..7 {
                let start = Instant::now();
                for _ in 0..iterations {
                    sink += black_box(run());
                }
                samples.push(start.elapsed().as_nanos() as f64 / iterations as f64);
            }
            let mut sorted = samples.clone();
            sorted.sort_by(f64::total_cmp);
            runs.push(json!({"workload":workload["name"],"operation":operation,"iterations":iterations,"samplesNsPerOp":samples,"medianNsPerOp":sorted[3],"sink":sink}));
        }
    }
    let report = json!({"implementation":"rust-native-credential-activation","profile":"release","samples":7,"entropy":"real OS getrandom::fill for encrypt each iteration","clock":"fixed NumericDate in sign/verify facade","runs":runs});
    if let Ok(path) = std::env::var("CREDENTIAL_ACTIVATION_BENCHMARK_OUTPUT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    }
    println!("CREDENTIAL_ACTIVATION_BENCHMARK={report}");
}
