#![cfg(feature = "overlay-token")]
//! Source-parity and private adapter checks for `src/utils/overlay_token.rs`.
//!
//! The plain `#[test]` functions need no service, environment value or network.
//! They cover the pure boundaries, the request validation, the state machine,
//! compare-and-set retries and the error branches.
//!
//! The oracle replay is `#[ignore]`d because it needs the externally written
//! fixture (`DIMA_OVERLAY_TOKEN_FIXTURE_DIR` / `..._SHA256`), which is generated
//! from the actual TypeScript source by
//! `tests/fixtures/overlay_token_reference.cjs`.
//!
//! The `#[ignore]` MongoDB suites drive the concrete adapter against a
//! lead-owned disposable database and never contact a production service,
//! database, queue or credential:
//!
//! ```text
//! OVERLAY_TOKEN_TEST_MONGO_URI=mongodb://127.0.0.1:27017
//! OVERLAY_TOKEN_TEST_MONGO_DATABASE=rust_overlay_token_fixture_<unique>
//! OVERLAY_TOKEN_TEST_MONGO_ACK=disposable
//! ```
//!
//! `..._DATABASE` must start with `rust_overlay_token_fixture_`; each suite
//! appends its own suffix, asserts the derived database is empty before use and
//! drops exactly that database afterwards.
//!
//! This target is not declared until the central `utils/mod.rs` and `Cargo.toml`
//! patches in `migration-notes/overlay-token-handoff.md` are applied. Enabling
//! the feature without both makes this target fail to compile.

#[path = "support/overlay_token_support.rs"]
mod support;

use dima_rust::utils::{
    credential_crypto::{CredentialCipher, CredentialCryptoError, StoredCredential},
    lossless_json::{JsonValue, parse_json},
    overlay_token::{
        EnsureOverlayTokenDocument, INVALID_REQUEST, INVALID_TOKEN, LINK_CONFLICT_REPLACE,
        LINK_CONFLICT_RETRY, LINK_INVALID, MAX_ATTEMPTS, MongoOverlayTokenStore,
        NativeOverlayTokenCodec, OverlayTokenCodec, OverlayTokenDocument, OverlayTokenError,
        OverlayTokenStore, OverlayTokenView, RECOVERY_REQUIRED, StoreFuture, TOKEN_LENGTH,
        base64url, is_linked, manage_overlay_token, read_overlay_token, remember_overlay_token,
        sha256_hex, token_shape, token_state,
    },
};
use mongodb::{
    bson::{Bson, Document, doc},
    error::Error as MongoError,
    options::ClientOptions,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

fn unit_cipher() -> CredentialCipher {
    CredentialCipher::new("overlay-token-unit-secret").expect("unit cipher")
}

fn unit_codec() -> NativeOverlayTokenCodec {
    NativeOverlayTokenCodec::new(unit_cipher())
}

fn store_failure(message: &str) -> OverlayTokenError {
    OverlayTokenError::Store(MongoError::custom(message.to_owned()))
}

fn body(value: Value) -> JsonValue {
    parse_json(&value.to_string()).expect("request JSON")
}

fn token(seed: char) -> String {
    seed.to_string().repeat(TOKEN_LENGTH)
}

fn sealed(cipher: &CredentialCipher, value: &str) -> StoredCredential {
    // Fixed IV so the pure tests are deterministic and decryptable.
    let mut iv = [0_u8; 16];
    for (index, byte) in iv.iter_mut().enumerate() {
        *byte = (index as u8).wrapping_mul(17).wrapping_add(3);
    }
    cipher.encrypt_with_iv(value, iv).expect("envelope")
}

fn linked(cipher: &CredentialCipher, value: &str) -> OverlayTokenDocument {
    OverlayTokenDocument {
        token_hash: Some(sha256_hex(value)),
        overlay_token: Some(sealed(cipher, value)),
    }
}

#[derive(Clone, Debug)]
struct SaveCall {
    expected_hash: Option<String>,
    token_hash: String,
    replace: bool,
    envelope: StoredCredential,
}

struct TestStore {
    document: Mutex<OverlayTokenDocument>,
    saves: Mutex<Vec<SaveCall>>,
    plan: Mutex<VecDeque<bool>>,
    reads: AtomicUsize,
    fail_read: bool,
    fail_save: bool,
}

impl TestStore {
    fn new(document: OverlayTokenDocument) -> Self {
        Self {
            document: Mutex::new(document),
            saves: Mutex::new(Vec::new()),
            plan: Mutex::new(VecDeque::new()),
            reads: AtomicUsize::new(0),
            fail_read: false,
            fail_save: false,
        }
    }

    fn with_plan(document: OverlayTokenDocument, plan: impl IntoIterator<Item = bool>) -> Self {
        let store = Self::new(document);
        *store.plan.lock().expect("plan") = plan.into_iter().collect();
        store
    }

    fn failing_read(document: OverlayTokenDocument) -> Self {
        Self {
            fail_read: true,
            ..Self::new(document)
        }
    }

    fn failing_save(document: OverlayTokenDocument) -> Self {
        Self {
            fail_save: true,
            ..Self::new(document)
        }
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn saves(&self) -> Vec<SaveCall> {
        self.saves.lock().expect("saves").clone()
    }

    fn document(&self) -> OverlayTokenDocument {
        self.document.lock().expect("document").clone()
    }
}

impl OverlayTokenStore for TestStore {
    fn read(&self) -> StoreFuture<'_, OverlayTokenDocument> {
        Box::pin(async move {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.fail_read {
                return Err(store_failure("injected read failure"));
            }
            Ok(self.document.lock().expect("document").clone())
        })
    }

    fn save(
        &self,
        expected_hash: Option<String>,
        token_hash: String,
        overlay_token: StoredCredential,
        replace: bool,
    ) -> StoreFuture<'_, bool> {
        Box::pin(async move {
            self.saves.lock().expect("saves").push(SaveCall {
                expected_hash: expected_hash.clone(),
                token_hash: token_hash.clone(),
                replace,
                envelope: overlay_token.clone(),
            });
            if self.fail_save {
                return Err(store_failure("injected save failure"));
            }
            let saved = {
                let mut plan = self.plan.lock().expect("plan");
                plan.pop_front().unwrap_or(true)
            };
            if saved {
                *self.document.lock().expect("document") = OverlayTokenDocument {
                    token_hash: Some(token_hash),
                    overlay_token: Some(overlay_token),
                };
            }
            Ok(saved)
        })
    }
}

/// Codec whose failure switches are used to prove that entropy/encryption
/// failures are not converted into request rejections.
struct FailingCodec {
    inner: NativeOverlayTokenCodec,
    fail_token: bool,
    fail_encrypt: bool,
    fail_decrypt: bool,
}

impl OverlayTokenCodec for FailingCodec {
    fn hash(&self, token: &str) -> String {
        self.inner.hash(token)
    }

    fn encrypt(&self, token: &str) -> Result<StoredCredential, CredentialCryptoError> {
        if self.fail_encrypt {
            return Err(CredentialCryptoError::EntropyUnavailable);
        }
        self.inner.encrypt(token)
    }

    fn decrypt(
        &self,
        envelope: Option<&StoredCredential>,
    ) -> Result<Option<String>, CredentialCryptoError> {
        if self.fail_decrypt {
            return Err(CredentialCryptoError::CounterExhausted);
        }
        self.inner.decrypt(envelope)
    }

    fn random_token(&self) -> Result<String, CredentialCryptoError> {
        if self.fail_token {
            return Err(CredentialCryptoError::EntropyUnavailable);
        }
        self.inner.random_token()
    }
}

// ---------------------------------------------------------------------------
// Pure boundaries
// ---------------------------------------------------------------------------

#[test]
fn hash_shape_and_base64url_match_the_source() {
    assert_eq!(TOKEN_LENGTH, 43);
    assert_eq!(
        sha256_hex("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_hex(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );

    assert_eq!(base64url(&[]), "");
    assert_eq!(base64url(b"f"), "Zg");
    assert_eq!(base64url(b"fo"), "Zm8");
    assert_eq!(base64url(b"foo"), "Zm9v");
    assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
    assert_eq!(base64url(&[0_u8; 32]).len(), TOKEN_LENGTH);

    assert!(token_shape(&token('A')));
    assert!(token_shape(&format!("{}_", "a".repeat(42))));
    assert!(token_shape(&format!("{}-", "a".repeat(42))));
    assert!(!token_shape(&"a".repeat(42)));
    assert!(!token_shape(&"a".repeat(44)));
    assert!(!token_shape(&format!("{}+", "a".repeat(42))));
    assert!(!token_shape(&format!("{}é", "a".repeat(42))));
}

#[test]
fn token_state_preserves_javascript_truthiness_and_swallows_decrypt_errors() {
    let cipher = unit_cipher();
    let codec = unit_codec();
    let value = token('A');
    let hash = sha256_hex(&value);

    let state = token_state(&codec, &linked(&cipher, &value));
    assert_eq!(state.token.as_deref(), Some(value.as_str()));
    assert!(state.exists);
    assert_eq!(state.version.as_deref(), Some(hash.as_str()));

    // A stored token without a hash is not a link, even if it decrypts.
    let unlinked = OverlayTokenDocument {
        token_hash: None,
        overlay_token: linked(&cipher, &value).overlay_token,
    };
    let state = token_state(&codec, &unlinked);
    assert!(state.token.is_none());
    assert!(!state.exists);
    assert!(state.version.is_none());

    // A hash mismatch drops the plaintext but keeps the stored version.
    let mismatched = OverlayTokenDocument {
        token_hash: Some(sha256_hex(&token('B'))),
        overlay_token: linked(&cipher, &value).overlay_token,
    };
    let state = token_state(&codec, &mismatched);
    assert!(state.token.is_none());
    assert!(state.exists);
    assert_eq!(state.version, Some(sha256_hex(&token('B'))));

    // `!!''` is false, but `'' ?? null` is still the reported version.
    let empty = OverlayTokenDocument {
        token_hash: Some(String::new()),
        overlay_token: None,
    };
    let state = token_state(&codec, &empty);
    assert!(state.token.is_none());
    assert!(!state.exists);
    assert_eq!(state.version.as_deref(), Some(""));
    assert!(!is_linked(&Some(String::new())));
    assert!(is_linked(&Some(hash)));

    // An unreadable envelope is swallowed by `state`, so the link can be saved
    // again. A hash-only document is the same recovery shape.
    for document in [
        OverlayTokenDocument {
            token_hash: Some(sha256_hex(&value)),
            overlay_token: Some(StoredCredential {
                iv: Some("zz".into()),
                content: Some("00".into()),
            }),
        },
        OverlayTokenDocument {
            token_hash: Some(sha256_hex(&value)),
            overlay_token: None,
        },
    ] {
        let state = token_state(&codec, &document);
        assert!(state.token.is_none());
        assert!(state.exists);
    }

    // An empty envelope is also unreadable, not an empty token.
    let state = token_state(
        &codec,
        &OverlayTokenDocument {
            token_hash: Some(sha256_hex("")),
            overlay_token: Some(StoredCredential {
                iv: Some(String::new()),
                content: Some(String::new()),
            }),
        },
    );
    assert!(state.token.is_none());
    assert!(state.exists);
}

#[tokio::test]
async fn request_validation_precedes_any_storage_read() {
    let store = TestStore::new(OverlayTokenDocument {
        token_hash: None,
        overlay_token: None,
    });
    let codec = unit_codec();
    let rejected = |error: OverlayTokenError| error.rejection().copied();

    for (input, expected) in [
        (body(json!(null)), Some(INVALID_REQUEST)),
        (body(json!([])), Some(INVALID_REQUEST)),
        (body(json!("rotate")), Some(INVALID_REQUEST)),
        (body(json!(7)), Some(INVALID_REQUEST)),
        (
            body(json!({"rotate": false, "extra": 1})),
            Some(INVALID_REQUEST),
        ),
        (body(json!({"rotate": "yes"})), Some(INVALID_REQUEST)),
        (body(json!({"rotate": null})), Some(INVALID_REQUEST)),
        (
            body(json!({"rotate": true, "token": token('A')})),
            Some(INVALID_REQUEST),
        ),
        (body(json!({"token": 42})), Some(INVALID_TOKEN)),
        (body(json!({"token": null})), Some(INVALID_TOKEN)),
        (body(json!({"token": "a".repeat(42)})), Some(INVALID_TOKEN)),
        (body(json!({"token": "a".repeat(44)})), Some(INVALID_TOKEN)),
        (
            body(json!({"token": format!("{}+", "a".repeat(42))})),
            Some(INVALID_TOKEN),
        ),
    ] {
        let error = manage_overlay_token(&store, &codec, &input)
            .await
            .expect_err("validation must reject");
        assert_eq!(rejected(error), expected, "{input:?}");
    }
    assert_eq!(store.reads(), 0, "validation must precede the store read");
    assert!(store.saves().is_empty());
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

#[tokio::test]
async fn creation_is_idempotent_and_replacement_requires_a_live_link() {
    let codec = unit_codec();
    let store = TestStore::new(OverlayTokenDocument {
        token_hash: None,
        overlay_token: None,
    });

    let first = manage_overlay_token(&store, &codec, &body(json!({})))
        .await
        .expect("create");
    let value = first.token.clone().expect("token");
    let hash = sha256_hex(&value);
    assert!(token_shape(&value));
    assert!(first.exists);
    assert_eq!(first.version.as_deref(), Some(hash.as_str()));
    let saves = store.saves();
    assert_eq!(saves.len(), 1);
    assert_eq!(saves[0].expected_hash, None);
    assert!(saves[0].replace);
    assert_eq!(saves[0].token_hash, sha256_hex(&value));
    assert_eq!(
        unit_cipher()
            .decrypt(Some(&saves[0].envelope))
            .expect("decrypt"),
        Some(value.clone())
    );

    let second = manage_overlay_token(&store, &codec, &body(json!({})))
        .await
        .expect("idempotent");
    assert_eq!(second.token.as_deref(), Some(value.as_str()));
    assert_eq!(store.saves().len(), 1, "idempotent creation must not write");
    assert_eq!(store.reads(), 2);

    // Replacement reuses the confirmed link, does not bump anything at the
    // state-machine level and accepts an ignored version field.
    let before = store.saves().len();
    let replaced = manage_overlay_token(
        &store,
        &codec,
        &body(json!({"token": value.clone(), "version": "0".repeat(64)})),
    )
    .await
    .expect("replace");
    assert_eq!(replaced.token.as_deref(), Some(value.as_str()));
    let saves = store.saves();
    assert_eq!(saves.len(), before + 1);
    assert_eq!(saves.last().expect("save").expected_hash, Some(sha256_hex(&value)));
    assert!(!saves.last().expect("save").replace);

    let error = manage_overlay_token(&store, &codec, &body(json!({"token": token('B')})))
        .await
        .expect_err("stale token");
    assert_eq!(error.rejection(), Some(&LINK_INVALID));

    let unlinked = TestStore::new(OverlayTokenDocument {
        token_hash: None,
        overlay_token: None,
    });
    let error = manage_overlay_token(&unlinked, &codec, &body(json!({"token": value})))
        .await
        .expect_err("unlinked document");
    assert_eq!(error.rejection(), Some(&LINK_INVALID));
    assert!(unlinked.saves().is_empty());
}

#[tokio::test]
async fn empty_string_hash_is_unlinked_but_keeps_its_version() {
    let codec = unit_codec();
    let store = TestStore::new(OverlayTokenDocument {
        token_hash: Some(String::new()),
        overlay_token: None,
    });

    let read = read_overlay_token(&store, &codec).await.expect("read");
    assert!(read.token.is_none());
    assert!(!read.exists);
    assert_eq!(read.version.as_deref(), Some(""));

    // Creation treats the empty hash as unlinked and compares against `''`,
    // which is what `doc.tokenHash ?? null` sends to the store.
    let created = manage_overlay_token(&store, &codec, &body(json!({})))
        .await
        .expect("create");
    assert!(created.exists);
    let saves = store.saves();
    assert_eq!(saves[0].expected_hash.as_deref(), Some(""));
    assert!(saves[0].replace);

    // The same value is accepted by an explicit rotation.
    let rotating = TestStore::new(OverlayTokenDocument {
        token_hash: Some(String::new()),
        overlay_token: None,
    });
    let rotated = manage_overlay_token(
        &rotating,
        &codec,
        &body(json!({"rotate": true, "version": ""})),
    )
    .await
    .expect("rotate from empty version");
    assert!(rotated.token.is_some());
    assert_eq!(rotating.saves()[0].expected_hash.as_deref(), Some(""));
}

#[tokio::test]
async fn rotation_requires_the_confirmed_version() {
    let cipher = unit_cipher();
    let codec = unit_codec();
    let value = token('A');
    let hash = sha256_hex(&value);

    for (document, input) in [
        (linked(&cipher, &value), json!({"rotate": true})),
        (linked(&cipher, &value), json!({"rotate": true, "version": null})),
        (linked(&cipher, &value), json!({"rotate": true, "version": "0".repeat(64)})),
        (linked(&cipher, &value), json!({"rotate": true, "version": 7})),
    ] {
        let store = TestStore::new(document);
        let error = manage_overlay_token(&store, &codec, &body(input.clone()))
            .await
            .expect_err("conflict");
        assert_eq!(error.rejection(), Some(&LINK_CONFLICT_REPLACE), "{input}");
        assert!(store.saves().is_empty());
    }

    // A null version is the confirmed "no link yet" state.
    let empty = TestStore::new(OverlayTokenDocument {
        token_hash: None,
        overlay_token: None,
    });
    let created = manage_overlay_token(
        &empty,
        &codec,
        &body(json!({"rotate": true, "version": null})),
    )
    .await
    .expect("rotate empty link");
    assert!(created.exists);
    assert_eq!(empty.saves()[0].expected_hash, None);

    // The current version rotates to a new token.
    let store = TestStore::new(linked(&cipher, &value));
    let rotated = manage_overlay_token(
        &store,
        &codec,
        &body(json!({"rotate": true, "version": hash.clone()})),
    )
    .await
    .expect("rotate");
    assert_ne!(rotated.token.as_deref(), Some(value.as_str()));
    assert_eq!(store.saves()[0].expected_hash, Some(hash));
    assert!(store.saves()[0].replace);
}

#[tokio::test]
async fn hash_only_link_requires_recovery_and_remember_upgrades_it() {
    let cipher = unit_cipher();
    let codec = unit_codec();
    let value = token('A');
    let hash = sha256_hex(&value);
    let document = OverlayTokenDocument {
        token_hash: Some(hash.clone()),
        overlay_token: None,
    };

    let store = TestStore::new(document.clone());
    let error = manage_overlay_token(&store, &codec, &body(json!({})))
        .await
        .expect_err("recovery");
    assert_eq!(error.rejection(), Some(&RECOVERY_REQUIRED));
    assert!(store.saves().is_empty());

    // A rotation is allowed without recovery because it replaces the link.
    let rotating = TestStore::new(document.clone());
    assert!(manage_overlay_token(
        &rotating,
        &codec,
        &body(json!({"rotate": true, "version": hash.clone()})),
    )
    .await
    .is_ok());

    let recovering = TestStore::new(document);
    remember_overlay_token(&recovering, &codec, &value)
        .await
        .expect("remember");
    let saves = recovering.saves();
    assert_eq!(saves.len(), 1);
    assert_eq!(saves[0].expected_hash, Some(hash.clone()));
    assert!(!saves[0].replace);
    let recovered = manage_overlay_token(&recovering, &codec, &body(json!({})))
        .await
        .expect("read after recovery");
    assert_eq!(recovered.token.as_deref(), Some(value.as_str()));

    // Remember is a no-op for a readable link, a hash mismatch and a lost CAS,
    // and it propagates a storage failure.
    let readable = TestStore::new(linked(&cipher, &value));
    remember_overlay_token(&readable, &codec, &value)
        .await
        .expect("no-op");
    assert!(readable.saves().is_empty());

    let mismatched = TestStore::new(linked(&cipher, &token('B')));
    remember_overlay_token(&mismatched, &codec, &value)
        .await
        .expect("no-op");
    assert!(mismatched.saves().is_empty());

    let lost = TestStore::with_plan(
        OverlayTokenDocument {
            token_hash: Some(hash.clone()),
            overlay_token: None,
        },
        [false],
    );
    remember_overlay_token(&lost, &codec, &value)
        .await
        .expect("a lost CAS is ignored by remember");
    assert_eq!(lost.saves().len(), 1);

    let failing = TestStore::failing_save(OverlayTokenDocument {
        token_hash: Some(hash),
        overlay_token: None,
    });
    let error = remember_overlay_token(&failing, &codec, &value)
        .await
        .expect_err("save failure");
    assert!(matches!(error, OverlayTokenError::Store(_)), "{error:?}");

    // An empty token has a real hash and the empty envelope; the source stores
    // it without consuming entropy.
    let empty_store = TestStore::new(OverlayTokenDocument {
        token_hash: Some(sha256_hex("")),
        overlay_token: None,
    });
    remember_overlay_token(&empty_store, &codec, "")
        .await
        .expect("empty token");
    let saves = empty_store.saves();
    assert_eq!(saves.len(), 1);
    assert_eq!(
        saves[0].envelope,
        StoredCredential {
            iv: Some(String::new()),
            content: Some(String::new()),
        }
    );
}

#[tokio::test]
async fn compare_and_set_retries_and_exhaustion_match_the_source() {
    let codec = unit_codec();
    let empty = || OverlayTokenDocument {
        token_hash: None,
        overlay_token: None,
    };

    let retried = TestStore::with_plan(empty(), [false, true]);
    let view = manage_overlay_token(&retried, &codec, &body(json!({})))
        .await
        .expect("second attempt");
    assert!(view.token.is_some());
    assert_eq!(retried.reads(), 2);
    let saves = retried.saves();
    assert_eq!(saves.len(), 2);
    assert_ne!(saves[0].token_hash, saves[1].token_hash, "a retry draws a new token");
    assert_eq!(saves[1].token_hash, view.version.clone().expect("version"));

    let exhausted = TestStore::with_plan(empty(), [false; MAX_ATTEMPTS]);
    let error = manage_overlay_token(&exhausted, &codec, &body(json!({})))
        .await
        .expect_err("exhausted");
    assert_eq!(error.rejection(), Some(&LINK_CONFLICT_RETRY));
    assert_eq!(exhausted.reads(), MAX_ATTEMPTS);
    assert_eq!(exhausted.saves().len(), MAX_ATTEMPTS);

    let cipher = unit_cipher();
    let value = token('A');
    let hash = sha256_hex(&value);

    let rotated_conflict = TestStore::with_plan(linked(&cipher, &value), [false]);
    let error = manage_overlay_token(
        &rotated_conflict,
        &codec,
        &body(json!({"rotate": true, "version": hash.clone()})),
    )
    .await
    .expect_err("rotation conflict");
    assert_eq!(error.rejection(), Some(&LINK_CONFLICT_REPLACE));
    assert_eq!(rotated_conflict.reads(), 1);
    assert_eq!(rotated_conflict.saves().len(), 1);

    let replacement_retried = TestStore::with_plan(linked(&cipher, &value), [false, true]);
    let view = manage_overlay_token(
        &replacement_retried,
        &codec,
        &body(json!({"token": value.clone()})),
    )
    .await
    .expect("replacement retry");
    assert_eq!(view.token.as_deref(), Some(value.as_str()));
    assert_eq!(replacement_retried.saves().len(), 2);
    assert!(!replacement_retried.saves()[1].replace);

    let replacement_exhausted = TestStore::with_plan(linked(&cipher, &value), [false; MAX_ATTEMPTS]);
    let error = manage_overlay_token(
        &replacement_exhausted,
        &codec,
        &body(json!({"token": value})),
    )
    .await
    .expect_err("replacement exhausted");
    assert_eq!(error.rejection(), Some(&LINK_CONFLICT_RETRY));
    assert_eq!(replacement_exhausted.saves().len(), MAX_ATTEMPTS);
}

#[tokio::test]
async fn crypto_failures_are_not_request_rejections() {
    let value = token('A');
    let empty = || OverlayTokenDocument {
        token_hash: None,
        overlay_token: None,
    };

    let codec = FailingCodec {
        inner: unit_codec(),
        fail_token: true,
        fail_encrypt: false,
        fail_decrypt: false,
    };
    let store = TestStore::new(empty());
    let error = manage_overlay_token(&store, &codec, &body(json!({})))
        .await
        .expect_err("entropy");
    match error {
        OverlayTokenError::Crypto(CredentialCryptoError::EntropyUnavailable) => {}
        other => panic!("expected entropy failure, got {other:?}"),
    }
    assert!(store.saves().is_empty());

    let codec = FailingCodec {
        inner: unit_codec(),
        fail_token: false,
        fail_encrypt: true,
        fail_decrypt: false,
    };
    let store = TestStore::new(empty());
    let error = manage_overlay_token(&store, &codec, &body(json!({})))
        .await
        .expect_err("encrypt");
    assert!(matches!(error, OverlayTokenError::Crypto(_)), "{error:?}");
    assert!(store.saves().is_empty());

    // `state()` swallows decryption failures.
    let cipher = unit_cipher();
    let codec = FailingCodec {
        inner: unit_codec(),
        fail_token: false,
        fail_encrypt: false,
        fail_decrypt: true,
    };
    let state = token_state(
        &codec,
        &OverlayTokenDocument {
            token_hash: Some(sha256_hex(&value)),
            overlay_token: Some(sealed(&cipher, &value)),
        },
    );
    assert!(state.token.is_none());
    assert!(state.exists);
}

// ---------------------------------------------------------------------------
// External source oracle
// ---------------------------------------------------------------------------

fn hex_bytes(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "hex length");
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex text"), 16).expect("hex pair")
        })
        .collect()
}

fn fixture_document(value: &Value) -> OverlayTokenDocument {
    let token_hash = match value.get("tokenHash") {
        None | Some(Value::Null) => None,
        Some(Value::String(hash)) => Some(hash.clone()),
        other => panic!("unsupported tokenHash {other:?}"),
    };
    let overlay_token = match value.get("overlayToken") {
        None | Some(Value::Null) => None,
        Some(Value::Object(envelope)) => Some(StoredCredential {
            iv: envelope.get("iv").and_then(Value::as_str).map(str::to_owned),
            content: envelope
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        other => panic!("unsupported overlayToken {other:?}"),
    };
    OverlayTokenDocument {
        token_hash,
        overlay_token,
    }
}

fn json_option(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

struct ScriptedCodec {
    cipher: CredentialCipher,
    entropy: Mutex<Vec<(usize, Vec<u8>)>>,
}

impl ScriptedCodec {
    fn new(cipher: &CredentialCipher, recorded: &Value) -> Self {
        let entropy = recorded
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .map(|entry| {
                        let size = entry["size"].as_u64().expect("entropy size") as usize;
                        let bytes = hex_bytes(entry["hex"].as_str().expect("entropy hex"));
                        assert_eq!(bytes.len(), size);
                        (size, bytes)
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            cipher: cipher.clone(),
            entropy: Mutex::new(entropy),
        }
    }

    /// Next recorded draw of the requested size. The source draws more IVs than
    /// the native port needs because it encrypts twice per write, so draws are
    /// consumed per size rather than in one global order.
    fn next(&self, size: usize) -> Vec<u8> {
        let mut entropy = self.entropy.lock().expect("entropy");
        let index = entropy
            .iter()
            .position(|(entry_size, _)| *entry_size == size)
            .unwrap_or_else(|| panic!("no recorded {size}-byte entropy draw"));
        entropy.remove(index).1
    }
}

impl OverlayTokenCodec for ScriptedCodec {
    fn hash(&self, token: &str) -> String {
        sha256_hex(token)
    }

    fn encrypt(&self, token: &str) -> Result<StoredCredential, CredentialCryptoError> {
        let iv = self.next(16);
        let mut array = [0_u8; 16];
        array.copy_from_slice(&iv);
        self.cipher.encrypt_with_iv(token, array)
    }

    fn decrypt(
        &self,
        envelope: Option<&StoredCredential>,
    ) -> Result<Option<String>, CredentialCryptoError> {
        self.cipher.decrypt(envelope)
    }

    fn random_token(&self) -> Result<String, CredentialCryptoError> {
        Ok(base64url(&self.next(32)))
    }
}

fn fixture_store(document: OverlayTokenDocument, plan: &Value) -> TestStore {
    let saves = plan
        .get("saves")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| value.as_bool().expect("save outcome"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let store = TestStore::with_plan(document, saves);
    match plan.get("failure").and_then(Value::as_str) {
        None => store,
        Some("read") => TestStore {
            fail_read: true,
            ..store
        },
        Some("save") => TestStore {
            fail_save: true,
            ..store
        },
        Some(other) => panic!("unsupported failure {other}"),
    }
}

fn assert_view(view: &OverlayTokenView, recorded: &Value) {
    assert_eq!(view.token, json_option(&recorded["token"]), "token");
    assert_eq!(view.exists, recorded["exists"].as_bool().expect("exists"), "exists");
    assert_eq!(view.version, json_option(&recorded["version"]), "version");
    if let Some(token) = &view.token {
        assert_eq!(view.version.as_deref(), Some(sha256_hex(token).as_str()));
        assert!(view.exists);
    }
}

fn assert_save(native: &SaveCall, recorded: &Value, label: &str) {
    assert_eq!(
        native.expected_hash,
        json_option(&recorded["expectedHash"]),
        "{label}: expectedHash"
    );
    assert_eq!(
        native.token_hash,
        recorded["hash"].as_str().expect("hash"),
        "{label}: hash"
    );
    assert_eq!(
        native.replace,
        recorded["replace"].as_bool().expect("replace"),
        "{label}: replace"
    );
    assert_eq!(
        native.envelope.iv,
        json_option(&recorded["envelope"]["iv"]),
        "{label}: iv"
    );
    assert_eq!(
        native.envelope.content,
        json_option(&recorded["envelope"]["content"]),
        "{label}: content"
    );
}

fn assert_final_document(document: &OverlayTokenDocument, recorded: &Value, label: &str) {
    assert_eq!(
        document.token_hash,
        json_option(&recorded["tokenHash"]),
        "{label}: final tokenHash"
    );
    match (&document.overlay_token, &recorded["overlayToken"]) {
        (None, Value::Null) => {}
        (Some(envelope), Value::Object(_)) => {
            assert_eq!(envelope.iv, json_option(&recorded["overlayToken"]["iv"]), "{label}: final iv");
            assert_eq!(
                envelope.content,
                json_option(&recorded["overlayToken"]["content"]),
                "{label}: final content"
            );
        }
        (actual, expected) => panic!("{label}: final envelope {actual:?} vs {expected}"),
    }
}

#[tokio::test]
#[ignore = "requires the external source oracle fixture (DIMA_OVERLAY_TOKEN_FIXTURE_*)"]
async fn source_oracle_replays_the_typescript_state_machine() {
    let fixture = support::fixture();
    assert_eq!(fixture["schema"].as_u64(), Some(1));
    let names = support::fixture_case_names(&fixture);
    assert!(
        names.len() >= 58,
        "oracle inventory must not shrink: {}",
        names.len()
    );

    let constants = &fixture["constants"];
    let secret = constants["secretKey"].as_str().expect("secretKey");
    assert_eq!(constants["maxAttempts"].as_u64(), Some(MAX_ATTEMPTS as u64));
    assert_eq!(constants["tokenLength"].as_u64(), Some(TOKEN_LENGTH as u64));
    assert_eq!(constants["messages"]["linkInvalid"].as_str(), Some("This link is no longer active"));
    assert_eq!(
        constants["messages"]["recoveryRequired"].as_str(),
        Some("Save the existing OBS link before retrieving it")
    );
    let cipher = CredentialCipher::new(secret).expect("fixture cipher");

    let codec_cases = fixture["codecCases"].as_array().expect("codecCases");
    assert!(codec_cases.len() >= 2);
    for case in codec_cases {
        let name = case["name"].as_str().expect("codec name");
        let token = case["token"].as_str().expect("codec token");
        let iv = hex_bytes(case["iv"].as_str().expect("codec iv"));
        let mut array = [0_u8; 16];
        array.copy_from_slice(&iv);
        assert_eq!(sha256_hex(token), case["hash"].as_str().expect("codec hash"), "{name}");
        let envelope = cipher.encrypt_with_iv(token, array).expect("encrypt");
        assert_eq!(
            envelope.iv.as_deref(),
            case["envelope"]["iv"].as_str(),
            "{name}: iv"
        );
        assert_eq!(
            envelope.content.as_deref(),
            case["envelope"]["content"].as_str(),
            "{name}: content"
        );
        assert_eq!(
            cipher.decrypt(Some(&envelope)).expect("decrypt").as_deref(),
            Some(token),
            "{name}: roundtrip"
        );
    }

    let mut seen = BTreeSet::new();
    for case in fixture["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("case name");
        assert!(seen.insert(name.to_owned()), "duplicate case {name}");
        let kind = case["kind"].as_str().expect("kind");
        let store = fixture_store(fixture_document(&case["doc"]), &case["plan"]);
        let codec = ScriptedCodec::new(&cipher, &case["observed"]["entropy"]);
        let result: Result<Option<OverlayTokenView>, OverlayTokenError> = match kind {
            "read" => read_overlay_token(&store, &codec).await.map(Some),
            "manage" => {
                let input = parse_json(&case["input"].to_string()).expect("case input");
                manage_overlay_token(&store, &codec, &input).await.map(Some)
            }
            "remember" => remember_overlay_token(
                &store,
                &codec,
                case["input"]["token"].as_str().expect("remember token"),
            )
            .await
            .map(|()| None),
            other => panic!("{name}: unsupported case kind {other}"),
        };

        let expect = &case["expect"];
        if expect["ok"].as_bool() == Some(true) {
            let value = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
            if kind == "remember" {
                assert!(value.is_none(), "{name}: remember returns void");
                assert!(expect["value"].is_null(), "{name}: remember returns void");
            } else {
                assert_view(&value.expect("view"), &expect["value"]);
            }
        } else {
            let error = result.err().unwrap_or_else(|| panic!("{name}: expected an error"));
            match expect["kind"].as_str().expect("expect kind") {
                "rejection" => {
                    let rejection = error
                        .rejection()
                        .unwrap_or_else(|| panic!("{name}: expected a rejection, got {error:?}"));
                    assert_eq!(rejection.code, expect["code"].as_str().expect("code"), "{name}: code");
                    assert_eq!(
                        rejection.status,
                        expect["status"].as_u64().expect("status") as u16,
                        "{name}: status"
                    );
                    assert_eq!(
                        rejection.message,
                        expect["message"].as_str().expect("message"),
                        "{name}: message"
                    );
                }
                "store" => match &error {
                    OverlayTokenError::Store(error) => assert!(
                        error.to_string().contains(expect["message"].as_str().expect("message")),
                        "{name}: {error}"
                    ),
                    other => panic!("{name}: expected a store error, got {other:?}"),
                },
                other => panic!("{name}: unsupported expect kind {other}"),
            }
        }

        assert_eq!(
            store.reads(),
            case["observed"]["reads"].as_u64().expect("reads") as usize,
            "{name}: read count"
        );
        let recorded_saves = case["observed"]["saves"].as_array().expect("saves");
        let saves = store.saves();
        assert_eq!(saves.len(), recorded_saves.len(), "{name}: save count");
        for (index, (native, recorded)) in saves.iter().zip(recorded_saves).enumerate() {
            assert_save(native, recorded, &format!("{name}[{index}]"));
        }
        assert_final_document(&store.document(), &case["observed"]["finalDocument"], name);
    }
    assert_eq!(seen.len(), names.len());
    assert!(!support::cases_of(&fixture, "manage").is_empty());
    assert!(!support::cases_of(&fixture, "read").is_empty());
    assert!(!support::cases_of(&fixture, "remember").is_empty());
}

// ---------------------------------------------------------------------------
// Disposable MongoDB suites
// ---------------------------------------------------------------------------

/// Guard used only to prove the reusable adapter runs the owner's
/// create-if-missing step before reading.
struct CreatingGuard {
    collection: mongodb::Collection<Document>,
    id: String,
    calls: AtomicUsize,
}

impl EnsureOverlayTokenDocument for CreatingGuard {
    fn ensure<'a>(
        &'a self,
        _collection: &'a mongodb::Collection<Document>,
        _id: &'a str,
    ) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.collection
                .update_one(
                    doc! { "_id": &self.id },
                    doc! { "$setOnInsert": { "tokenHash": Bson::Null, "revision": 0_i32 } },
                )
                .upsert(true)
                .await?;
            Ok(())
        })
    }
}

fn mongo_cipher() -> CredentialCipher {
    CredentialCipher::new("overlay-token-mongo-secret").expect("mongo cipher")
}

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB (OVERLAY_TOKEN_TEST_MONGO_*)"]
async fn compare_and_set_creation_rotation_and_recovery() -> support::TestResult {
    let fixture = support::disposable_database("cas").await?;
    let database = &fixture.database;
    let collection = database.collection("overlay_token_fixture");
    let codec = NativeOverlayTokenCodec::new(mongo_cipher());

    let store = MongoOverlayTokenStore::new(collection.clone(), "channel-a").incrementing_revision();
    assert!(
        database.list_collection_names().await?.is_empty(),
        "construction must not touch the database"
    );

    collection
        .insert_one(doc! { "_id": "channel-a", "revision": 0_i32, "tokenHash": Bson::Null })
        .await?;
    let first = manage_overlay_token(&store, &codec, &body(json!({}))).await?;
    let token_a = first.token.clone().expect("created token");
    let hash_a = sha256_hex(&token_a);
    assert_eq!(token_a.len(), TOKEN_LENGTH);
    assert!(first.exists);
    assert_eq!(first.version.as_deref(), Some(hash_a.as_str()));

    let document = collection
        .find_one(doc! { "_id": "channel-a" })
        .await?
        .expect("channel-a");
    assert_eq!(document.get_i32("revision")?, 1, "creation replaces and bumps");
    assert_eq!(document.get_str("tokenHash")?, hash_a);
    assert!(document.get_document("overlayToken").is_ok());

    // Idempotent creation: same token, no second write.
    let second = manage_overlay_token(&store, &codec, &body(json!({}))).await?;
    assert_eq!(second.token.as_deref(), Some(token_a.as_str()));
    let document = collection
        .find_one(doc! { "_id": "channel-a" })
        .await?
        .expect("channel-a");
    assert_eq!(document.get_i32("revision")?, 1);

    // A stale rotation conflicts and leaves the document untouched.
    let error = manage_overlay_token(
        &store,
        &codec,
        &body(json!({"rotate": true, "version": "0".repeat(64)})),
    )
    .await
    .expect_err("stale rotation");
    assert_eq!(error.code(), Some("overlay_link_conflict"));
    assert_eq!(error.status(), Some(409));
    let document = collection
        .find_one(doc! { "_id": "channel-a" })
        .await?
        .expect("channel-a");
    assert_eq!(document.get_str("tokenHash")?, hash_a);

    // The confirmed version rotates and bumps.
    let rotated = manage_overlay_token(
        &store,
        &codec,
        &body(json!({"rotate": true, "version": hash_a})),
    )
    .await?;
    let token_b = rotated.token.clone().expect("rotated token");
    let hash_b = sha256_hex(&token_b);
    assert_ne!(token_a, token_b);
    let document = collection
        .find_one(doc! { "_id": "channel-a" })
        .await?
        .expect("channel-a");
    assert_eq!(document.get_i32("revision")?, 2);

    // Replacement is a CAS without a revision bump.
    let replaced = manage_overlay_token(&store, &codec, &body(json!({"token": token_b}))).await?;
    assert_eq!(replaced.token.as_deref(), Some(token_b.as_str()));
    let document = collection
        .find_one(doc! { "_id": "channel-a" })
        .await?
        .expect("channel-a");
    assert_eq!(document.get_i32("revision")?, 2);

    let error = manage_overlay_token(&store, &codec, &body(json!({"token": token_a}))).await;
    assert_eq!(
        error.expect_err("stale replacement").code(),
        Some("overlay_link_invalid")
    );

    // A lost envelope requires an explicit save, then reads work again.
    collection
        .update_one(doc! { "_id": "channel-a" }, doc! { "$unset": { "overlayToken": "" } })
        .await?;
    let state = read_overlay_token(&store, &codec).await?;
    assert!(state.exists);
    assert!(state.token.is_none());
    assert_eq!(state.version.as_deref(), Some(hash_b.as_str()));
    let error = manage_overlay_token(&store, &codec, &body(json!({}))).await;
    assert_eq!(error.expect_err("recovery").rejection(), Some(&RECOVERY_REQUIRED));

    remember_overlay_token(&store, &codec, &token_b).await?;
    let document = collection
        .find_one(doc! { "_id": "channel-a" })
        .await?
        .expect("channel-a");
    assert_eq!(document.get_i32("revision")?, 2, "remember never bumps");
    assert!(document.get_document("overlayToken").is_ok());
    let recovered = manage_overlay_token(&store, &codec, &body(json!({}))).await?;
    assert_eq!(recovered.token.as_deref(), Some(token_b.as_str()));

    // A missing tokenHash field is unlinked; the CAS filter still matches it.
    collection.insert_one(doc! { "_id": "channel-b" }).await?;
    let store_b =
        MongoOverlayTokenStore::new(collection.clone(), "channel-b").incrementing_revision();
    let created = manage_overlay_token(&store_b, &codec, &body(json!({}))).await?;
    assert!(created.token.is_some());
    let document = collection
        .find_one(doc! { "_id": "channel-b" })
        .await?
        .expect("channel-b");
    assert_eq!(document.get_i32("revision")?, 1);

    // Two concurrent creations converge on one token: the loser re-reads the
    // winner's link and returns it.
    collection
        .insert_one(doc! { "_id": "channel-c", "revision": 0_i32, "tokenHash": Bson::Null })
        .await?;
    let left = MongoOverlayTokenStore::new(collection.clone(), "channel-c").incrementing_revision();
    let right = MongoOverlayTokenStore::new(collection.clone(), "channel-c").incrementing_revision();
    let (left, right) = tokio::join!(
        manage_overlay_token(&left, &codec, &body(json!({}))),
        manage_overlay_token(&right, &codec, &body(json!({}))),
    );
    let left = left?;
    let right = right?;
    assert_eq!(left.token, right.token);
    let document = collection
        .find_one(doc! { "_id": "channel-c" })
        .await?
        .expect("channel-c");
    assert_eq!(document.get_i32("revision")?, 1);

    fixture.drop_database().await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB (OVERLAY_TOKEN_TEST_MONGO_*)"]
async fn scoping_shapes_and_the_optional_guard() -> support::TestResult {
    let fixture = support::disposable_database("scope").await?;
    let database = &fixture.database;
    let collection = database.collection("overlay_token_fixture");
    let codec = NativeOverlayTokenCodec::new(mongo_cipher());

    // Two channels, two stores: a store only sees and writes its own document.
    for id in ["channel-a", "channel-b"] {
        collection
            .insert_one(doc! { "_id": id, "revision": 0_i32, "tokenHash": Bson::Null })
            .await?;
    }
    let store_a = MongoOverlayTokenStore::new(collection.clone(), "channel-a").incrementing_revision();
    let store_b = MongoOverlayTokenStore::new(collection.clone(), "channel-b").incrementing_revision();
    let token_a = manage_overlay_token(&store_a, &codec, &body(json!({})))
        .await?
        .token
        .expect("channel-a token");
    let token_b = manage_overlay_token(&store_b, &codec, &body(json!({})))
        .await?
        .token
        .expect("channel-b token");
    assert_ne!(token_a, token_b);
    assert_eq!(
        read_overlay_token(&store_a, &codec).await?.token.as_deref(),
        Some(token_a.as_str())
    );
    assert_eq!(
        read_overlay_token(&store_b, &codec).await?.token.as_deref(),
        Some(token_b.as_str())
    );

    // A stale expected version loses the CAS and writes nothing.
    let stale = sha256_hex("stale");
    let envelope = unit_cipher()
        .encrypt_with_iv(&token('Z'), [9_u8; 16])
        .expect("envelope");
    assert!(!store_a
        .save(Some(stale), sha256_hex(&token('Z')), envelope.clone(), false)
        .await?);
    assert_eq!(
        read_overlay_token(&store_a, &codec).await?.token.as_deref(),
        Some(token_a.as_str())
    );

    // A missing document is not created by save.
    let missing = MongoOverlayTokenStore::new(collection.clone(), "channel-missing");
    assert!(!missing
        .save(None, sha256_hex(&token('Z')), envelope, true)
        .await?);
    assert!(collection.find_one(doc! { "_id": "channel-missing" }).await?.is_none());

    // A pet-style store (no revision bump) leaves an existing revision alone.
    collection
        .insert_one(doc! { "_id": "pet-owner", "revision": 7_i32, "tokenHash": Bson::Null })
        .await?;
    let pet = MongoOverlayTokenStore::new(collection.clone(), "pet-owner");
    manage_overlay_token(&pet, &codec, &body(json!({}))).await?;
    let document = collection
        .find_one(doc! { "_id": "pet-owner" })
        .await?
        .expect("pet-owner");
    assert_eq!(document.get_i32("revision")?, 7);

    // Strict document shapes are storage errors, not silent defaults.
    collection
        .insert_one(doc! { "_id": "bad-hash", "tokenHash": 42_i32 })
        .await?;
    let error = MongoOverlayTokenStore::new(collection.clone(), "bad-hash")
        .read()
        .await
        .expect_err("bad hash");
    assert!(error.to_string().contains("Invalid overlay token hash"), "{error}");
    collection
        .insert_one(doc! { "_id": "bad-envelope", "tokenHash": Bson::Null, "overlayToken": "text" })
        .await?;
    let error = MongoOverlayTokenStore::new(collection.clone(), "bad-envelope")
        .read()
        .await
        .expect_err("bad envelope");
    assert!(
        error.to_string().contains("Invalid overlay token envelope"),
        "{error}"
    );
    let error = MongoOverlayTokenStore::new(collection.clone(), "absent")
        .read()
        .await
        .expect_err("missing document");
    assert!(error.to_string().contains("disappeared during read"), "{error}");

    // The optional guard runs before the read and may create the document.
    let guard = Arc::new(CreatingGuard {
        collection: collection.clone(),
        id: "guarded".to_owned(),
        calls: AtomicUsize::new(0),
    });
    let guarded =
        MongoOverlayTokenStore::new(collection.clone(), "guarded").ensuring(guard.clone());
    let state = read_overlay_token(&guarded, &codec).await?;
    assert!(state.token.is_none());
    assert!(!state.exists);
    assert!(guard.calls.load(Ordering::SeqCst) >= 1);
    let created = manage_overlay_token(&guarded, &codec, &body(json!({}))).await?;
    assert!(created.token.is_some());

    fixture.drop_database().await;
    Ok(())
}

#[tokio::test]
#[ignore = "requires loopback only; no service, database or credential"]
async fn store_failures_keep_the_driver_error() -> support::TestResult {
    // No server is started or contacted. Port 1 on loopback with a short server
    // selection deadline yields the driver's own operation error deterministically.
    let options = ClientOptions::parse(
        "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100&connectTimeoutMS=100",
    )
    .await?;
    let client = mongodb::Client::with_options(options)?;
    let database = client.database("rust_overlay_token_fixture_errors");
    let store = MongoOverlayTokenStore::new(database.collection("overlay_token_fixture"), "channel-a");

    for error in [
        store.read().await.expect_err("read"),
        store
            .save(
                None,
                sha256_hex("token"),
                StoredCredential {
                    iv: Some(String::new()),
                    content: Some(String::new()),
                },
                true,
            )
            .await
            .expect_err("save"),
    ] {
        match error {
            OverlayTokenError::Store(error) => assert!(!error.to_string().is_empty()),
            other => panic!("expected the typed store error, got {other:?}"),
        }
    }
    Ok(())
}
