#![cfg(feature = "widgets-runtime")]
//! Overlay-link checks for the widget and roulette channel services.
//!
//! The ports replace their provisional token policy with the canonical
//! `utils::overlay_token` module. These checks keep the consumer contract honest:
//!
//! * the source `fail(code, message, status)` triples survive the
//!   `OverlayTokenError` -> `WidgetServiceError` / `ServiceError` conversion;
//! * the source contract lines the ports rely on are still present in
//!   `src/utils/overlay-token.ts`, `src/widgets/service.ts` and
//!   `src/roulette/service.ts`;
//! * the widget channel gate and the roulette token-shape gate both run before
//!   any storage access;
//! * the concrete `MongoOverlayTokenStore` adapters, wired through
//!   `MongoWidgetRepository` / `MongoRouletteRepository`, use the existing
//!   `load_widget` / `load_channel` initializer as their guard, bump `revision`
//!   only on a replacing save, keep the `_id + tokenHash` existence probe, and
//!   upgrade a hash-only legacy link after a successful authorization.
//!
//! The plain `#[tokio::test]` functions below are ordering checks: they stop at
//! the source validation step and never contact a server. Their client points at
//! loopback port 1 so an accidental read fails loudly rather than hanging.
//!
//! The `#[ignore]` suites drive the real repositories and codec against a
//! lead-owned disposable database. They never use production services, data,
//! credentials, queues or networks:
//!
//! ```text
//! WIDGETS_ROULETTE_TOKEN_TEST_MONGO_URI=mongodb://127.0.0.1:27017
//! WIDGETS_ROULETTE_TOKEN_TEST_MONGO_DATABASE=widgets_roulette_token_fixture_<unique>
//! WIDGETS_ROULETTE_TOKEN_TEST_MONGO_ACK=disposable
//! ```
//!
//! `..._DATABASE` must start with `widgets_roulette_token_fixture_`; each suite
//! appends its own suffix, asserts the derived database is empty before use and
//! runs `dropDatabase` on exactly that database afterwards.
//!
//! This target only compiles once the central `widgets-runtime` feature, the
//! `roulette_runtime` / `widgets_runtime` module declarations and the
//! `overlay-token` feature from the handoff note are applied. Until then the
//! crate-level `cfg` makes this file empty.

use std::sync::Arc;

use dima_rust::roulette_runtime::{
    model::RouletteError,
    service::{MongoRouletteRepository, RouletteService, ServiceError},
};
use dima_rust::utils::{
    credential_crypto::{CredentialCipher, CredentialCryptoError},
    lossless_json::{JsonValue, parse_json},
    overlay_token::{
        INVALID_REQUEST, INVALID_TOKEN, LINK_CONFLICT_REPLACE, LINK_CONFLICT_RETRY, LINK_INVALID,
        NativeOverlayTokenCodec, OverlayTokenError, OverlayTokenView, RECOVERY_REQUIRED,
        sha256_hex, token_shape,
    },
};
use dima_rust::widgets_runtime::service::{
    MongoWidgetRepository, PollFuture, PollGateway, WidgetService, WidgetServiceError,
};
use mongodb::{
    Client, Database,
    bson::{Bson, Document, doc},
    error::Error as MongoError,
    options::ClientOptions,
};
use serde_json::Value;

type TestResult = Result<(), Box<dyn std::error::Error>>;

const ACK: &str = "WIDGETS_ROULETTE_TOKEN_TEST_MONGO_ACK";
const ACK_VALUE: &str = "disposable";
const URI: &str = "WIDGETS_ROULETTE_TOKEN_TEST_MONGO_URI";
const DATABASE: &str = "WIDGETS_ROULETTE_TOKEN_TEST_MONGO_DATABASE";
const PREFIX: &str = "widgets_roulette_token_fixture_";
const TEST_KEY: &str = "0123456789abcdef0123456789abcdef";

/// The source regex accepts exactly 43 ASCII `\w`/`-` code units.
fn shape_table() -> [(String, bool); 8] {
    let full = "A".repeat(43);
    [
        (full.clone(), true),
        (format!("{}-", "A".repeat(42)), true),
        (format!("{}_", "A".repeat(42)), true),
        ("0123456789012345678901234567890123456789012".to_owned(), true),
        ("a".repeat(43), true),
        (format!("{}+", "A".repeat(42)), false),
        (format!("{}.", "A".repeat(42)), false),
        (String::new(), false),
    ]
}

fn body(text: &str) -> JsonValue {
    parse_json(text).expect("request body")
}

fn cipher() -> CredentialCipher {
    CredentialCipher::new(TEST_KEY).expect("fixture cipher")
}

fn codec() -> Arc<NativeOverlayTokenCodec> {
    Arc::new(NativeOverlayTokenCodec::new(cipher()))
}

/// The token tests never launch a poll. Any call is a wiring mistake.
struct UnusedPolls;

impl PollGateway for UnusedPolls {
    fn get_poll<'a>(
        &'a self,
        _channel: &'a str,
        _poll_id: Option<&'a str>,
        _cache: bool,
    ) -> PollFuture<'a> {
        Box::pin(async {
            Err(WidgetServiceError::Storage(
                "token tests never read polls".to_owned(),
            ))
        })
    }

    fn create_poll<'a>(
        &'a self,
        _channel: &'a str,
        _title: &'a str,
        _choices: &'a Value,
        _duration: &'a Value,
        _cache: bool,
        _points: f64,
    ) -> PollFuture<'a> {
        Box::pin(async {
            Err(WidgetServiceError::Storage(
                "token tests never create polls".to_owned(),
            ))
        })
    }
}

/// A client that is never connected. Only used by the ordering checks, where no
/// repository call may run.
async fn unreachable_database() -> Result<Database, Box<dyn std::error::Error>> {
    let options = ClientOptions::parse(
        "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100&connectTimeoutMS=100",
    )
    .await?;
    let client = Client::with_options(options)?;
    Ok(client.database("widgets_roulette_token_unreachable"))
}

async fn widget_service() -> Result<WidgetService, Box<dyn std::error::Error>> {
    let database = unreachable_database().await?;
    Ok(WidgetService::with_adapters(
        Arc::new(MongoWidgetRepository::new(&database)),
        Arc::new(UnusedPolls),
        codec(),
        None,
    ))
}

async fn roulette_service() -> Result<RouletteService, Box<dyn std::error::Error>> {
    let database = unreachable_database().await?;
    Ok(RouletteService::with_adapters(
        Arc::new(MongoRouletteRepository::new(&database)),
        codec(),
    ))
}

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

fn source(name: &str) -> Option<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    std::fs::read_to_string(path).ok()
}

/// The TypeScript source is still the behaviour reference for these ports. Each
/// marker is a clause the native code depends on; changing it is a contract
/// change, not a refactor. A missing file is skipped so the check does not block
/// the later TypeScript retirement.
#[test]
fn ported_contract_clauses_still_exist_in_the_source() {
    if let Some(text) = source("src/utils/overlay-token.ts") {
        for marker in [
            "export const overlayTokenHash",
            "overlayTokenHash(token) !== doc.tokenHash",
            "return { token, exists: !!doc.tokenHash, version: doc.tokenHash ?? null };",
            "if (!body.rotate && doc.tokenHash) {",
            "return fail('overlay_link_conflict', 'The overlay link changed; reload before trying again', 409);",
        ] {
            assert!(text.contains(marker), "overlay-token.ts lost: {marker}");
        }
    }
    if let Some(text) = source("src/widgets/service.ts") {
        for marker in [
            "await requirePremium(id); return readOverlayToken(overlayTokenStore(id));",
            "if (!/^[0-9]{1,30}$/.test(id) || typeof token !== 'string' || !/^[\\w-]{43}$/.test(token)) return false;",
            "WidgetChannel.exists({ _id: id, tokenHash: hash(token) })",
            "...(replace ? { $inc: { revision: 1 } } : {})",
            "Recovery must not interrupt an existing OBS source.",
        ] {
            assert!(text.contains(marker), "widgets/service.ts lost: {marker}");
        }
    }
    if let Some(text) = source("src/roulette/service.ts") {
        for marker in [
            "export async function overlayTokenState(id: string) { return readOverlayToken(overlayTokenStore(id)); }",
            "RouletteChannel.exists({ _id: channel(id), tokenHash: hash(token) })",
            "...(replace ? { $inc: { revision: 1 } } : {})",
            "Recovery must not interrupt an existing OBS source.",
        ] {
            assert!(text.contains(marker), "roulette/service.ts lost: {marker}");
        }
    }
}

#[test]
fn token_shape_table_matches_the_source_regex() {
    for (token, allowed) in shape_table() {
        assert_eq!(token_shape(&token), allowed, "{token:?}");
    }
    assert!(token_shape(&"z".repeat(43)));
    assert!(!token_shape(&"z".repeat(44)));
    assert!(!token_shape(&format!("{}é", "z".repeat(41))));
}

/// `OverlayTokenError` must arrive at the callers as the source `fail()` triple,
/// and crypto/storage failures must stay storage failures.
#[test]
fn overlay_errors_keep_the_source_code_message_and_status() {
    let cases = [
        (INVALID_REQUEST, "invalid", "Invalid overlay link request", 400),
        (INVALID_TOKEN, "invalid", "Invalid overlay token", 400),
        (LINK_INVALID, "overlay_link_invalid", "This link is no longer active", 409),
        (
            RECOVERY_REQUIRED,
            "overlay_link_recovery_required",
            "Save the existing OBS link before retrieving it",
            409,
        ),
        (
            LINK_CONFLICT_REPLACE,
            "overlay_link_conflict",
            "The overlay link changed; reload before replacing it",
            409,
        ),
        (
            LINK_CONFLICT_RETRY,
            "overlay_link_conflict",
            "The overlay link changed; reload before trying again",
            409,
        ),
    ];
    for (rejection, code, message, status) in cases {
        let widget = WidgetServiceError::from(OverlayTokenError::Rejected(rejection));
        match widget {
            WidgetServiceError::Domain(error) => {
                assert_eq!(error.code, code);
                assert_eq!(error.message, message);
                assert_eq!(error.status, status);
            }
            other => panic!("widget mapping produced {other:?}"),
        }
        let roulette = ServiceError::from(OverlayTokenError::Rejected(rejection));
        match roulette {
            ServiceError::Domain(error) => {
                assert_eq!(error, RouletteError::new(code, message, status));
            }
            other => panic!("roulette mapping produced {other:?}"),
        }
    }

    match WidgetServiceError::from(OverlayTokenError::Crypto(CredentialCryptoError::MissingKey)) {
        WidgetServiceError::Storage(text) => assert_eq!(text, "Credential key is missing"),
        other => panic!("crypto mapping produced {other:?}"),
    }
    match WidgetServiceError::from(OverlayTokenError::Store(MongoError::custom("boom"))) {
        WidgetServiceError::Storage(text) => assert!(text.contains("boom"), "{text}"),
        other => panic!("store mapping produced {other:?}"),
    }
    match ServiceError::from(OverlayTokenError::Crypto(CredentialCryptoError::MissingKey)) {
        ServiceError::Storage(text) => assert_eq!(text, "Credential key is missing"),
        other => panic!("crypto mapping produced {other:?}"),
    }
    match ServiceError::from(OverlayTokenError::Store(MongoError::custom("boom"))) {
        ServiceError::Storage(text) => assert!(text.contains("boom"), "{text}"),
        other => panic!("store mapping produced {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Ordering checks (no server contacted)
// ---------------------------------------------------------------------------

/// `hasPremium` validates the channel before its `users` query, so a non-digit
/// widget channel fails `invalid` without storage access.
#[tokio::test]
async fn widget_premium_gate_validates_the_channel_first() -> TestResult {
    let service = widget_service().await?;
    for channel in ["abc", "", "1234567890123456789012345678901", "12x"] {
        let error = service.overlay_token_state(channel).await.expect_err("invalid channel");
        match error {
            WidgetServiceError::Domain(error) => {
                assert_eq!(error.code, "invalid");
                assert_eq!(error.status, 400);
                assert_eq!(error.message, "Invalid channel ID");
            }
            other => panic!("expected the channel error, got {other:?}"),
        }
    }
    // The OBS gate returns false for a bad channel or token shape instead of a
    // 400, matching `authorizeOverlay`. Neither branch touches storage.
    assert!(!service.authorize_overlay("abc", Some(&"A".repeat(43))).await?);
    assert!(!service.authorize_overlay("12345", Some("short")).await?);
    assert!(!service.authorize_overlay("12345", None).await?);
    Ok(())
}

/// `authorizeOverlay` shape-checks the token before `channel(id)` and before the
/// existence query, so a bad token is `false` without touching storage.
#[tokio::test]
async fn roulette_authorization_rejects_bad_shape_before_storage() -> TestResult {
    let service = roulette_service().await?;
    assert!(!service.authorize_overlay("channel", None).await?);
    assert!(!service.authorize_overlay("channel", Some("short")).await?);
    assert!(!service.authorize_overlay("channel", Some(&"A".repeat(44))).await?);
    // A valid token but an invalid channel reaches `channel(id)` and fails.
    let error = service
        .authorize_overlay("   ", Some(&"A".repeat(43)))
        .await
        .expect_err("blank channel");
    match error {
        ServiceError::Domain(error) => {
            assert_eq!(error.code, "invalid");
            assert_eq!(error.status, 400);
            assert_eq!(error.message, "channel must contain 1–100 characters");
        }
        other => panic!("expected the channel error, got {other:?}"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Disposable MongoDB fixtures
// ---------------------------------------------------------------------------

struct DisposableDb {
    database: Database,
}

impl DisposableDb {
    async fn open(suite: &str) -> Result<Self, Box<dyn std::error::Error>> {
        assert_eq!(
            std::env::var(ACK).as_deref().ok(),
            Some(ACK_VALUE),
            "{ACK} must be {ACK_VALUE}; refusing to touch an unlabelled database"
        );
        let uri = std::env::var(URI).map_err(|_| format!("{URI} is required"))?;
        let base = std::env::var(DATABASE).map_err(|_| format!("{DATABASE} is required"))?;
        assert!(
            base.starts_with(PREFIX),
            "{DATABASE} must start with {PREFIX}"
        );
        let options = ClientOptions::parse(uri).await?;
        let client = Client::with_options(options)?;
        let name = format!("{base}_{suite}");
        let database = client.database(&name);
        let existing = database.list_collection_names().await?;
        assert!(
            existing.is_empty(),
            "fixture database {name} must be empty, found {existing:?}"
        );
        Ok(Self { database })
    }

    async fn drop(self) -> Result<(), Box<dyn std::error::Error>> {
        self.database.run_command(doc! { "dropDatabase": 1 }).await?;
        Ok(())
    }

    fn widget_service(&self) -> WidgetService {
        WidgetService::with_adapters(
            Arc::new(MongoWidgetRepository::new(&self.database)),
            Arc::new(UnusedPolls),
            codec(),
            None,
        )
    }

    fn roulette_service(&self) -> RouletteService {
        RouletteService::with_adapters(
            Arc::new(MongoRouletteRepository::new(&self.database)),
            codec(),
        )
    }
}

async fn revision(document: &Document) -> i64 {
    document
        .get("revision")
        .and_then(Bson::as_i64)
        .expect("numeric revision")
}

async fn channel_document(database: &Database, collection: &str, id: &str) -> Document {
    database
        .collection(collection)
        .find_one(doc! { "_id": id })
        .await
        .expect("channel read")
        .expect("channel document")
}

async fn add_premium_user(database: &Database, channel: &str, tier: &str) {
    database
        .collection::<Document>("users")
        .insert_one(doc! {
            "accounts": [{ "type": "twitch", "id": channel }],
            "plan_tier": tier,
        })
        .await
        .expect("users fixture");
}

fn token_hash(document: &Document) -> Option<&str> {
    document.get("tokenHash").and_then(Bson::as_str)
}

/// `overlayToken` must be the `{iv, content}` envelope; the store hides it from
/// the default projection, so this reads it explicitly.
fn envelope(document: &Document) -> Option<&Document> {
    match document.get("overlayToken") {
        Some(Bson::Document(envelope)) => Some(envelope),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Widgets: `widget_channels` with the premium gate and revision bump
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB; see the module contract"]
async fn widgets_token_lifecycle_is_guarded_and_bumps_revision() -> TestResult {
    let fixture = DisposableDb::open("widgets_lifecycle").await?;
    let service = fixture.widget_service();
    let channel = "123456";
    add_premium_user(&fixture.database, channel, "premium").await;

    // The guard reuses `load_widget`: the first token read creates revision 0.
    let initial = service.overlay_token_state(channel).await?;
    assert_eq!(
        initial,
        OverlayTokenView { token: None, exists: false, version: None }
    );
    let created_document = channel_document(&fixture.database, "widget_channels", channel).await;
    assert_eq!(revision(&created_document).await, 0);
    assert_eq!(token_hash(&created_document), None);

    // Creation replaces the link and bumps the revision once.
    let created = service.update_overlay_token(channel, &body("{}")).await?;
    let token = created.token.clone().expect("created token");
    assert!(created.exists);
    assert_eq!(created.version.as_deref(), Some(sha256_hex(&token).as_str()));
    let stored = channel_document(&fixture.database, "widget_channels", channel).await;
    assert_eq!(revision(&stored).await, 1);
    assert_eq!(token_hash(&stored), Some(sha256_hex(&token).as_str()));
    assert!(envelope(&stored).is_some());

    // Creation is idempotent: the same token, no second revision bump.
    let again = service.update_overlay_token(channel, &body("{}")).await?;
    assert_eq!(again.token.as_deref(), Some(token.as_str()));
    assert_eq!(
        revision(&channel_document(&fixture.database, "widget_channels", channel).await).await,
        1
    );

    // Rotation requires the current version and bumps the revision.
    let rotate = format!("{{\"rotate\":true,\"version\":\"{}\"}}", sha256_hex(&token));
    let rotated = service.update_overlay_token(channel, &body(&rotate)).await?;
    let rotated_token = rotated.token.clone().expect("rotated token");
    assert_ne!(rotated_token, token);
    assert_eq!(
        revision(&channel_document(&fixture.database, "widget_channels", channel).await).await,
        2
    );

    // A stale version conflicts with the source text and writes nothing.
    let stale = format!("{{\"rotate\":true,\"version\":\"{}\"}}", sha256_hex(&token));
    match service.update_overlay_token(channel, &body(&stale)).await {
        Err(WidgetServiceError::Domain(error)) => {
            assert_eq!(error.code, "overlay_link_conflict");
            assert_eq!(error.message, "The overlay link changed; reload before replacing it");
            assert_eq!(error.status, 409);
        }
        other => panic!("expected the stale-version conflict, got {other:?}"),
    }
    assert_eq!(
        revision(&channel_document(&fixture.database, "widget_channels", channel).await).await,
        2
    );

    // The current OBS token authorizes; `remember` does not bump the revision.
    assert!(service.authorize_overlay(channel, Some(&rotated_token)).await?);
    assert_eq!(
        revision(&channel_document(&fixture.database, "widget_channels", channel).await).await,
        2
    );

    // The existence probe is `_id + tokenHash`: another channel never matches and
    // authorizing does not create its document.
    assert!(!service.authorize_overlay("654321", Some(&rotated_token)).await?);
    assert!(
        fixture
            .database
            .collection::<Document>("widget_channels")
            .find_one(doc! { "_id": "654321" })
            .await?
            .is_none()
    );

    fixture.drop().await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB; see the module contract"]
async fn widgets_authorize_upgrades_a_hash_only_link_without_a_revision_bump() -> TestResult {
    let fixture = DisposableDb::open("widgets_recovery").await?;
    let service = fixture.widget_service();
    let channel = "246810";
    add_premium_user(&fixture.database, channel, "pro").await;

    let created = service.update_overlay_token(channel, &body("{}")).await?;
    let token = created.token.clone().expect("created token");
    let hash = sha256_hex(&token);

    // Simulate the legacy hash-only row: the digest is present, the envelope is
    // gone. The source reports `exists` with no readable token.
    fixture
        .database
        .collection::<Document>("widget_channels")
        .update_one(doc! { "_id": channel }, doc! { "$unset": { "overlayToken": "" } })
        .await?;
    let state = service.overlay_token_state(channel).await?;
    assert!(state.exists);
    assert_eq!(state.token, None);
    assert_eq!(state.version.as_deref(), Some(hash.as_str()));

    // `updateOverlayToken` without a token asks the user to save again.
    match service.update_overlay_token(channel, &body("{}")).await {
        Err(WidgetServiceError::Domain(error)) => {
            assert_eq!(error.code, "overlay_link_recovery_required");
            assert_eq!(error.status, 409);
            assert_eq!(error.message, "Save the existing OBS link before retrieving it");
        }
        other => panic!("expected the recovery requirement, got {other:?}"),
    }

    // A successful OBS authorization restores the envelope best-effort.
    assert!(service.authorize_overlay(channel, Some(&token)).await?);
    let restored = channel_document(&fixture.database, "widget_channels", channel).await;
    assert_eq!(token_hash(&restored), Some(hash.as_str()));
    assert!(envelope(&restored).is_some());
    assert_eq!(revision(&restored).await, 1);

    fixture.drop().await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB; see the module contract"]
async fn widgets_premium_gate_precedes_channel_creation() -> TestResult {
    let fixture = DisposableDb::open("widgets_premium").await?;
    let service = fixture.widget_service();
    let collection = fixture.database.collection::<Document>("widget_channels");

    // No entitlement row at all.
    for channel in ["111", "222"] {
        match service.overlay_token_state(channel).await {
            Err(WidgetServiceError::Domain(error)) => {
                assert_eq!(error.code, "premium_required");
                assert_eq!(error.message, "Widgets Alpha requires Premium");
                assert_eq!(error.status, 403);
            }
            other => panic!("expected the premium gate, got {other:?}"),
        }
    }
    assert_eq!(collection.count_documents(doc! {}).await?, 0);

    // A free-tier row is still not premium, and the token write is gated too.
    add_premium_user(&fixture.database, "333", "free").await;
    for error in [
        service.overlay_token_state("333").await.expect_err("state gate"),
        service
            .update_overlay_token("333", &body("{}"))
            .await
            .expect_err("update gate"),
    ] {
        match error {
            WidgetServiceError::Domain(error) => assert_eq!(error.code, "premium_required"),
            other => panic!("expected the premium gate, got {other:?}"),
        }
    }
    assert_eq!(collection.count_documents(doc! {}).await?, 0);

    fixture.drop().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Roulette: `roulette_channels` without a premium gate, channel access kept
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires a lead-owned disposable MongoDB; see the module contract"]
async fn roulette_token_lifecycle_is_guarded_and_bumps_revision() -> TestResult {
    let fixture = DisposableDb::open("roulette_lifecycle").await?;
    let service = fixture.roulette_service();
    // `channel(id)` is `text(..., 'channel', 100)`, so a non-numeric alias is a
    // valid roulette channel and no premium row is consulted.
    let channel = "roulette-test-channel";

    let initial = service.overlay_token_state(channel).await?;
    assert_eq!(
        initial,
        OverlayTokenView { token: None, exists: false, version: None }
    );
    let created_document = channel_document(&fixture.database, "roulette_channels", channel).await;
    assert_eq!(revision(&created_document).await, 0);
    assert_eq!(token_hash(&created_document), None);
    assert_eq!(
        created_document.get("actions").and_then(Bson::as_array).map(Vec::len),
        Some(0)
    );
    assert!(matches!(created_document.get("actionDueAt"), Some(Bson::Null)));

    let created = service.update_overlay_token(channel, &body("{}")).await?;
    let token = created.token.clone().expect("created token");
    assert_eq!(
        revision(&channel_document(&fixture.database, "roulette_channels", channel).await).await,
        1
    );

    // Idempotent creation keeps the token and the revision.
    let again = service.update_overlay_token(channel, &body("{}")).await?;
    assert_eq!(again.token.as_deref(), Some(token.as_str()));
    assert_eq!(
        revision(&channel_document(&fixture.database, "roulette_channels", channel).await).await,
        1
    );

    let rotated = service.rotate_token(channel).await?;
    assert_ne!(rotated, token);
    assert_eq!(
        revision(&channel_document(&fixture.database, "roulette_channels", channel).await).await,
        2
    );

    // Authorization keeps the shape check, then the `_id + tokenHash` probe, then
    // a best-effort `remember` that does not bump the revision.
    assert!(service.authorize_overlay(channel, Some(&rotated)).await?);
    assert_eq!(
        revision(&channel_document(&fixture.database, "roulette_channels", channel).await).await,
        2
    );
    assert!(!service.authorize_overlay(channel, Some(&"b".repeat(43))).await?);

    // Another channel never matches and is never created by the probe.
    assert!(!service.authorize_overlay("roulette-other", Some(&rotated)).await?);
    assert!(
        fixture
            .database
            .collection::<Document>("roulette_channels")
            .find_one(doc! { "_id": "roulette-other" })
            .await?
            .is_none()
    );

    // A hash-only legacy row is upgraded by `remember`, not by `manage`.
    fixture
        .database
        .collection::<Document>("roulette_channels")
        .update_one(doc! { "_id": channel }, doc! { "$unset": { "overlayToken": "" } })
        .await?;
    let state = service.overlay_token_state(channel).await?;
    assert!(state.exists);
    assert_eq!(state.token, None);
    assert!(service.authorize_overlay(channel, Some(&rotated)).await?);
    let restored = channel_document(&fixture.database, "roulette_channels", channel).await;
    assert!(envelope(&restored).is_some());
    assert_eq!(revision(&restored).await, 2);

    fixture.drop().await?;
    Ok(())
}
