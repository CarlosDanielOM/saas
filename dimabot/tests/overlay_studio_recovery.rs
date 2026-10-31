//! Source-oracle checks for Overlay Studio validation, optimistic persistence,
//! and asset-validated recovery. The memory studio and asset repositories are
//! disposable test doubles for the same seams used by the Mongo/GridFS
//! production adapters; no database or network resource is touched.

#![cfg(feature = "overlays-runtime")]

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use dima_rust::{
    media_assets::library::{
        AssetError, AssetFuture, AssetLibrary, AssetReadStream, AssetRecordRepository,
        FfprobeInspector, GridFsRangeRepository,
    },
    overlays::{
        recover::{copy_id, recover_copies},
        store::{
            change, load, public_state, validate_state, OverlayError, StudioFuture,
            StudioPersistence, StudioState,
        },
    },
    utils::lossless_json::{parse_json, JsonValue},
};
use mongodb::bson::{doc, oid::ObjectId, Bson, Document};
use serde_json::{json, Value};

const RECOVERY: &str = "12345678-1234-abcd-1234-123456789012";
const IMAGE_ASSET: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
const VIDEO_ASSET: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";
const MISSING_ASSET: &str = "cccccccccccccccccccccccc";

// ---------------------------------------------------------------------------
// Disposable studio persistence.

#[derive(Default)]
struct Memory {
    accounts: HashSet<String>,
    studios: Mutex<HashMap<String, Document>>,
    writes: AtomicUsize,
    race: AtomicBool,
}

impl Memory {
    fn with_account(channel: &str) -> Self {
        let mut memory = Self::default();
        memory.accounts.insert(channel.to_owned());
        memory
    }
    fn revision(&self, channel: &str) -> f64 {
        self.studios
            .lock()
            .expect("studio lock")
            .get(channel)
            .map(revision_of)
            .unwrap_or_default()
    }
    fn studio(&self, channel: &str) -> Option<Document> {
        self.studios.lock().expect("studio lock").get(channel).cloned()
    }
}

fn revision_of(document: &Document) -> f64 {
    match document.get("revision") {
        Some(Bson::Int32(value)) => f64::from(*value),
        Some(Bson::Int64(value)) => *value as f64,
        Some(Bson::Double(value)) => *value,
        _ => 0.0,
    }
}

fn unavailable_overlay() -> OverlayError {
    OverlayError { message: "Unable to load overlay".into(), status: 500 }
}

impl StudioPersistence for Memory {
    fn require_account<'a>(&'a self, channel: &'a str) -> StudioFuture<'a, Result<(), OverlayError>> {
        Box::pin(async move {
            if self.accounts.contains(channel) {
                Ok(())
            } else {
                Err(OverlayError { message: "Overlay account unavailable".into(), status: 403 })
            }
        })
    }

    fn find_studio<'a>(
        &'a self,
        channel: &'a str,
    ) -> StudioFuture<'a, Result<Option<Document>, OverlayError>> {
        let result = self
            .studios
            .lock()
            .map_err(|_| unavailable_overlay())
            .map(|studios| studios.get(channel).cloned());
        Box::pin(async move { result })
    }

    fn insert_studio<'a>(&'a self, document: Document) -> StudioFuture<'a, Result<(), OverlayError>> {
        let result: Result<(), OverlayError> = (move || {
            let id = document.get_str("_id").map_err(|_| unavailable_overlay())?.to_owned();
            self.studios
                .lock()
                .map_err(|_| unavailable_overlay())?
                .entry(id)
                .or_insert(document);
            Ok(())
        })();
        Box::pin(async move { result })
    }

    fn compare_and_set<'a>(
        &'a self,
        channel: &'a str,
        revision: f64,
        scenes: Vec<Bson>,
        designs: Vec<Bson>,
    ) -> StudioFuture<'a, Result<bool, OverlayError>> {
        let result: Result<bool, OverlayError> = (move || {
            let mut studios = self.studios.lock().map_err(|_| unavailable_overlay())?;
            if self.race.swap(false, Ordering::SeqCst) {
                if let Some(document) = studios.get_mut(channel) {
                    document.insert("revision", Bson::Double(revision + 2.0));
                }
            }
            let Some(document) = studios.get_mut(channel) else { return Ok(false) };
            if revision_of(document) != revision {
                return Ok(false);
            }
            document.insert("scenes", Bson::Array(scenes));
            document.insert("designs", Bson::Array(designs));
            document.insert("revision", Bson::Double(revision + 1.0));
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        })();
        Box::pin(async move { result })
    }

    fn find_public<'a>(
        &'a self,
        public_id: &'a str,
    ) -> StudioFuture<'a, Result<Option<Document>, OverlayError>> {
        let result = self
            .studios
            .lock()
            .map_err(|_| unavailable_overlay())
            .map(|studios| {
                studios
                    .values()
                    .find(|document| {
                        document
                            .get_array("scenes")
                            .ok()
                            .into_iter()
                            .flatten()
                            .filter_map(Bson::as_document)
                            .any(|scene| scene.get_str("publicId").ok() == Some(public_id))
                    })
                    .cloned()
            });
        Box::pin(async move { result })
    }
}

// ---------------------------------------------------------------------------
// Disposable library records and an unused ranged reader.

struct Records {
    library: Mutex<Document>,
}

impl AssetRecordRepository for Records {
    fn find_user<'a>(
        &'a self,
        owner: &'a str,
    ) -> AssetFuture<'a, Result<Option<Document>, AssetError>> {
        Box::pin(async move { Ok(Some(doc! { "_id": owner, "plan_tier": "free" })) })
    }

    fn find<'a>(&'a self, _owner: &'a str) -> AssetFuture<'a, Result<Option<Document>, AssetError>> {
        let library = self.library.lock().expect("library lock").clone();
        Box::pin(async move { Ok(Some(library)) })
    }

    fn update<'a>(
        &'a self,
        _filter: Document,
        _update: Document,
        _upsert: bool,
    ) -> AssetFuture<'a, Result<u64, AssetError>> {
        Box::pin(async { Ok(0) })
    }
}

struct Ranges;

fn unavailable_asset() -> AssetError {
    AssetError { code: "unavailable", status: 500 }
}

impl GridFsRangeRepository for Ranges {
    fn length<'a>(&'a self, _id: ObjectId) -> AssetFuture<'a, Result<u64, AssetError>> {
        Box::pin(async { Err(unavailable_asset()) })
    }
    fn read_window<'a>(
        &'a self,
        _id: ObjectId,
        _start: u64,
        _end: u64,
    ) -> AssetFuture<'a, Result<Vec<u8>, AssetError>> {
        Box::pin(async { Err(unavailable_asset()) })
    }
    fn upload<'a>(
        &'a self,
        _id: ObjectId,
        _owner: &'a str,
        _name: &'a str,
        _mime: &'a str,
        _path: &'a Path,
    ) -> AssetFuture<'a, Result<(), AssetError>> {
        Box::pin(async { Err(unavailable_asset()) })
    }
    fn remove<'a>(&'a self, _id: ObjectId) -> AssetFuture<'a, Result<(), AssetError>> {
        Box::pin(async { Err(unavailable_asset()) })
    }
    fn open<'a>(
        &'a self,
        _id: ObjectId,
    ) -> AssetFuture<'a, Result<AssetReadStream, AssetError>> {
        Box::pin(async { Err(unavailable_asset()) })
    }
}

fn library(owner: &str, assets: &[(&str, &str)]) -> AssetLibrary {
    let assets: Vec<Bson> = assets
        .iter()
        .map(|(id, kind)| {
            Bson::Document(doc! {
                "id": *id,
                "kind": *kind,
                "state": "ready",
                "bytes": 1_i64,
            })
        })
        .collect();
    let records = Records {
        library: Mutex::new(doc! { "_id": owner, "usedBytes": 0_i64, "assets": Bson::Array(assets) }),
    };
    AssetLibrary::with_repositories(
        Arc::new(FfprobeInspector),
        Arc::new(records),
        Arc::new(Ranges),
    )
}

// ---------------------------------------------------------------------------
// Fixtures built from the TypeScript shapes.

fn as_json(value: Value) -> JsonValue {
    parse_json(&value.to_string()).expect("fixture JSON")
}

fn layout(widgets: Value) -> Value {
    json!({ "duration": 5, "widgets": widgets })
}

fn design(id: &str, name: &str, widget: Value) -> Value {
    json!({
        "id": id,
        "name": name,
        "width": 800,
        "height": 240,
        "events": {
            "sub": layout(widget.clone()),
            "bits": layout(widget.clone()),
            "follow": layout(widget.clone()),
            "raid": layout(widget),
        },
    })
}

fn scene(id: &str, name: &str, widgets: Value) -> Value {
    json!({
        "id": id,
        "name": name,
        "width": 1920,
        "height": 1080,
        "waitFor": ["tts"],
        "widgets": widgets,
    })
}

fn state(scenes: Value, designs: Value) -> JsonValue {
    as_json(json!({ "scenes": scenes, "designs": designs }))
}

fn valid_state() -> JsonValue {
    state(json!([scene("s", "Scene", json!([]))]), json!([design("d", "Design", json!([]))]))
}

fn state_with_scene_widget(widget: Value) -> JsonValue {
    state(
        json!([scene("s", "Scene", json!([widget]))]),
        json!([design("d", "Design", json!([]))]),
    )
}

fn state_with_design_widget(widget: Value) -> JsonValue {
    state(
        json!([scene("s", "Scene", json!([]))]),
        json!([design("d", "Design", widget)]),
    )
}

fn base_widget(id: &str, kind: &str) -> Value {
    json!({
        "id": id,
        "kind": kind,
        "x": 0,
        "y": 0,
        "width": 100,
        "height": 100,
        "visible": true,
        "locked": false,
    })
}

fn with(mut widget: Value, key: &str, value: Value) -> Value {
    widget.as_object_mut().expect("object").insert(key.into(), value);
    widget
}

fn asset_widget(kind: &str, asset: &str) -> Value {
    with(base_widget("asset-widget", kind), "assetId", json!(asset))
}

fn design_with_variants(variants: Value) -> JsonValue {
    let mut value = design("d", "Design", json!([]));
    value.as_object_mut().expect("object").insert("variants".into(), variants);
    state(json!([scene("s", "Scene", json!([]))]), json!([value]))
}

fn recovery_input(design_widget: Value) -> JsonValue {
    as_json(json!({
        "recoveryId": RECOVERY,
        "scenes": [scene("local-scene", "Local", json!([]))],
        "designs": [design("local-design", "Local design", design_widget)],
    }))
}

fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    value.get(key).unwrap_or_else(|| panic!("missing {key}"))
}

fn array<'a>(value: &'a JsonValue) -> &'a [JsonValue] {
    match value {
        JsonValue::Array(items) => items,
        _ => panic!("expected array"),
    }
}

fn text<'a>(value: &'a JsonValue) -> &'a str {
    match value {
        JsonValue::String(text) => text.as_str().expect("UTF-8 fixture"),
        _ => panic!("expected string"),
    }
}

fn validation_error(input: &JsonValue) -> OverlayError {
    validate_state(input, &StudioState::empty()).expect_err("invalid fixture")
}

// ---------------------------------------------------------------------------
// Validation parity.

#[test]
fn validation_rebuilds_only_source_fields() {
    let widget = with(
        with(
            with(base_widget("shape-1", "shape"), "borderWidth", json!(2)),
            "borderColor",
            json!("#aBcD09"),
        ),
        "unknown",
        json!("drop me"),
    );
    let widget = with(
        widget,
        "shadow",
        json!({ "color": "#000000", "blur": 1, "x": -1, "y": 2 }),
    );
    let mut input = json!({
        "scenes": [scene("s", "Scene", json!([widget]))],
        "designs": [design("d", "Design", json!([]))],
    });
    input["scenes"][0]["waitFor"] = json!(["tts", "tts", "bits"]);

    let (scenes, designs) = validate_state(&as_json(input), &StudioState::empty()).expect("valid");
    let widgets = array(field(&scenes[0], "widgets"));
    assert_eq!(array(field(&scenes[0], "waitFor")).len(), 2);
    assert!(widgets[0].get("unknown").is_none());
    assert_eq!(field(&widgets[0], "borderWidth"), &JsonValue::Number(2.0));
    assert_eq!(text(field(&widgets[0], "borderColor")), "#aBcD09");
    assert_eq!(field(field(&widgets[0], "shadow"), "x"), &JsonValue::Number(-1.0));
    assert_eq!(text(field(&scenes[0], "publicId")).len(), 48);
    assert_eq!(field(&designs[0], "revision"), &JsonValue::Number(1.0));
}

#[test]
fn module_config_motion_and_keyframes_are_rebuilt_without_unrecognized_fields() {
    let configured = with(
        with(
            with(base_widget("poll-1", "poll"), "configVersion", json!(1)),
            "interactionDesign",
            json!("compact"),
        ),
        "config",
        json!({ "interactionDesign": "card" }),
    );
    let animated = with(
        with(
            base_widget("text-1", "text"),
            "motion",
            json!({
                "enter": "fade",
                "exit": "zoom",
                "loop": "pulse",
                "delay": 0.5,
                "enterDuration": 0.5,
                "exitDuration": 0.5,
                "loopDuration": 1,
                "extra": "drop",
            }),
        ),
        "keyframes",
        json!({
            "enter": {
                "tracks": [{
                    "property": "opacity",
                    "extra": "drop",
                    "points": [
                        { "offset": 0, "value": 0, "easing": "linear", "extra": "drop" },
                        { "offset": 1, "value": 1, "easing": "linear" },
                    ],
                }],
            },
        }),
    );
    let input = state(
        json!([scene("s", "Scene", json!([configured]))]),
        json!([design("d", "Design", animated)]),
    );
    let (scenes, designs) = validate_state(&input, &StudioState::empty()).expect("valid");
    let configured = &array(field(&scenes[0], "widgets"))[0];
    assert_eq!(field(configured, "configVersion"), &JsonValue::Number(1.0));
    assert_eq!(text(field(configured, "interactionDesign")), "compact");
    assert_eq!(text(field(field(configured, "config"), "interactionDesign")), "card");

    let layouts = field(&designs[0], "events");
    let animated = &array(field(field(layouts, "sub"), "widgets"))[0];
    let motion = field(animated, "motion");
    assert_eq!(text(field(motion, "enter")), "fade");
    assert!(motion.get("extra").is_none());
    let tracks = array(field(field(animated, "keyframes"), "enter").get("tracks").expect("tracks"));
    assert!(tracks[0].get("extra").is_none());
    assert!(array(field(&tracks[0], "points"))[0].get("extra").is_none());
}

#[test]
fn validation_rejects_source_invalid_inputs() {
    let cases: Vec<(JsonValue, &str)> = vec![
        (state_with_scene_widget(with(base_widget("w", "shape"), "x", json!(-16001))), "Invalid dimension or duration"),
        (state_with_scene_widget(with(base_widget("w", "animation"), "x", json!(0))), "Invalid widget module configuration"),
        (state_with_scene_widget(with(base_widget("w", "shape"), "showTtsText", json!(true))), "Spoken text settings require a TTS widget"),
        (state_with_scene_widget(with(base_widget("w", "trigger"), "triggerIds", json!(["A".repeat(24)]))), "Invalid trigger selection"),
        (state_with_scene_widget(with(base_widget("w", "trigger"), "triggerIds", json!([IMAGE_ASSET, IMAGE_ASSET]))), "Duplicate trigger selection"),
        (state_with_scene_widget(with(base_widget("w", "shape"), "triggerIds", json!([IMAGE_ASSET]))), "Trigger filters require a trigger widget"),
        (state_with_design_widget(with(base_widget("w", "trigger"), "triggerPlacement", json!({"mode":"fixed","margin":1}))), "Trigger placement requires a trigger widget"),
        (state_with_design_widget(with(base_widget("w", "image"), "assetId", json!(IMAGE_ASSET.to_uppercase()))), "Invalid design asset"),
        (state_with_design_widget(with(base_widget("w", "image"), "mediaUrl", json!("http://example.test/a.png"))), "Media requires an HTTPS URL"),
        (state_with_design_widget(with(base_widget("w", "image"), "mediaUrl", json!("https://user:secret@example.test/a.png"))), "Media requires an HTTPS URL"),
        (state_with_design_widget(with(base_widget("w", "shape"), "fontSize", json!(7))), "Invalid dimension or duration"),
        (state_with_design_widget(with(base_widget("w", "shape"), "fontFamily", json!("comic"))), "Invalid object style"),
        (state_with_design_widget(with(base_widget("w", "shape"), "shadow", json!({"color":"red","blur":1,"x":0,"y":0}))), "Invalid color"),
        (state_with_design_widget(with(base_widget("w", "text"), "text", json!("$(nope)"))), "Unsupported alert function: nope"),
    ];
    for (input, message) in cases {
        assert_eq!(validation_error(&input), OverlayError { message: message.into(), status: 400 });
    }

    let duplicate_widgets = state(
        json!([scene("s", "Scene", json!([base_widget("w", "shape"), base_widget("w", "text")]))]),
        json!([design("d", "Design", json!([]))]),
    );
    assert_eq!(validation_error(&duplicate_widgets).message, "Duplicate ID");

    let missing_design = as_json(json!({
        "scenes": [scene("s", "Scene", json!([with(
            with(base_widget("w", "alert"), "designId", json!("missing")),
            "events",
            json!(["sub"]),
        )]))],
        "designs": [design("d", "Design", json!([]))],
    }));
    assert_eq!(validation_error(&missing_design).message, "Alert design is missing");

    let duplicate_scene = as_json(json!({
        "scenes": [scene("s", "One", json!([])), scene("s", "Two", json!([]))],
        "designs": [design("d", "Design", json!([]))],
    }));
    assert_eq!(validation_error(&duplicate_scene).message, "Duplicate ID");

    let empty = as_json(json!({ "scenes": [], "designs": [design("d", "Design", json!([]))] }));
    assert_eq!(validation_error(&empty).message, "Keep at least one overlay and alert design");

    let mut missing_event = design("d", "Design", json!([]));
    missing_event
        .as_object_mut()
        .expect("object")
        .get_mut("events")
        .expect("events")
        .as_object_mut()
        .expect("events object")
        .remove("raid");
    assert_eq!(
        validation_error(&state(json!([scene("s", "Scene", json!([]))]), json!([missing_event]))).message,
        "Expected an object"
    );
}

#[test]
fn variants_follow_source_rules() {
    let sub = |tier: Value| {
        json!([{
            "id": "v",
            "name": "Sub",
            "enabled": true,
            "tier": tier,
            "layout": layout(json!([])),
        }])
    };
    assert!(validate_state(&design_with_variants(json!({"sub": sub(json!("1000"))})), &StudioState::empty()).is_ok());
    assert_eq!(
        validation_error(&design_with_variants(json!({"sub": sub(json!("1500"))}))).message,
        "Choose a subscription tier"
    );

    let bits = json!([{
        "id": "v",
        "name": "Bits",
        "enabled": true,
        "ruleId": "rule-1",
        "layout": layout(json!([])),
    }]);
    assert!(validate_state(&design_with_variants(json!({"bits": bits})), &StudioState::empty()).is_ok());
    let duplicate_rules = json!([
        {"id":"v1","name":"One","enabled":true,"ruleId":"rule","layout":layout(json!([]))},
        {"id":"v2","name":"Two","enabled":true,"ruleId":"rule","layout":layout(json!([]))},
    ]);
    assert_eq!(
        validation_error(&design_with_variants(json!({"bits": duplicate_rules}))).message,
        "A Bits rule can only have one look per design"
    );

    let raid = |min: Value, max: Value| {
        json!([{
            "id": "v",
            "name": "Raid",
            "enabled": true,
            "min": min,
            "max": max,
            "layout": layout(json!([])),
        }])
    };
    assert!(validate_state(&design_with_variants(json!({"raid": raid(json!(1), json!(5))})), &StudioState::empty()).is_ok());
    assert_eq!(
        validation_error(&design_with_variants(json!({"raid": raid(json!(1.5), json!(5))}))).message,
        "Use a whole amount"
    );
    assert_eq!(
        validation_error(&design_with_variants(json!({"raid": raid(json!(5), json!(1))}))).message,
        "Invalid amount range"
    );
    assert_eq!(
        validation_error(&design_with_variants(json!({"unknown": json!([])}))).message,
        "Invalid variant event"
    );
}

// ---------------------------------------------------------------------------
// Optimistic persistence.

#[tokio::test]
async fn starter_draft_is_created_once() {
    let memory = Memory::with_account("chan");
    let first = load(&memory, "chan").await.expect("first load");
    assert_eq!(first.revision, 0.0);
    assert_eq!(first.scenes.len(), 1);
    assert_eq!(first.designs.len(), 1);
    assert_eq!(text(field(&first.scenes[0], "publicId")).len(), 48);
    assert_eq!(text(field(&first.scenes[0], "name")), "My overlay");
    assert_eq!(text(field(&first.designs[0], "name")), "My alerts");

    let second = load(&memory, "chan").await.expect("second load");
    assert_eq!(second, first);
}

#[tokio::test]
async fn missing_account_is_forbidden() {
    let memory = Memory::default();
    let error = load(&memory, "chan").await.expect_err("account required");
    assert_eq!(error.status, 403);
    assert_eq!(error.message, "Overlay account unavailable");
}

#[tokio::test]
async fn change_increments_the_revision_and_persists_the_validated_draft() {
    let memory = Memory::with_account("chan");
    load(&memory, "chan").await.expect("initialize");
    let input = valid_state();
    let result = change(&memory, "chan", 0.0, |state: &mut StudioState| {
        let (scenes, designs) = validate_state(&input, state).expect("valid draft");
        state.scenes = scenes;
        state.designs = designs;
        Ok::<(), OverlayError>(())
    })
    .await
    .expect("changed");
    assert_eq!(result.revision, 1.0);
    assert_eq!(text(field(&result.scenes[0], "id")), "s");
    assert_eq!(memory.revision("chan"), 1.0);
    assert_eq!(memory.writes.load(Ordering::SeqCst), 1);
    let stored = load(&memory, "chan").await.expect("reload");
    assert_eq!(stored.scenes, result.scenes);
    assert_eq!(stored.designs, result.designs);
}

#[tokio::test]
async fn stale_revision_and_failed_operations_do_not_write() {
    let memory = Memory::with_account("chan");
    load(&memory, "chan").await.expect("initialize");
    let stale = change(&memory, "chan", 9.0, |_: &mut StudioState| Ok::<(), OverlayError>(()))
        .await
        .expect_err("stale");
    assert_eq!(stale.status, 409);
    let failed = change(&memory, "chan", 0.0, |_: &mut StudioState| {
        Err::<(), OverlayError>(OverlayError { message: "operation failed".into(), status: 400 })
    })
    .await
    .expect_err("operation");
    assert_eq!(failed.message, "operation failed");
    assert_eq!(memory.writes.load(Ordering::SeqCst), 0);
    assert_eq!(memory.revision("chan"), 0.0);
}

#[tokio::test]
async fn a_concurrent_revision_change_becomes_a_conflict() {
    let memory = Memory::with_account("chan");
    load(&memory, "chan").await.expect("initialize");
    memory.race.store(true, Ordering::SeqCst);
    let conflict = change(&memory, "chan", 0.0, |_: &mut StudioState| Ok::<(), OverlayError>(()))
        .await
        .expect_err("conflict");
    assert_eq!(conflict.status, 409);
    assert_eq!(conflict.message, "The draft changed. Reload before saving.");
    assert_eq!(memory.writes.load(Ordering::SeqCst), 0);
    assert_eq!(memory.revision("chan"), 2.0);
}

#[tokio::test]
async fn public_state_requires_a_published_scene() {
    let memory = Memory::with_account("chan");
    let state = load(&memory, "chan").await.expect("load");
    let public_id = text(field(&state.scenes[0], "publicId")).to_owned();
    let error = public_state(&memory, &public_id).await.expect_err("unpublished");
    assert_eq!(error.status, 404);
    assert_eq!(error.message, "This overlay has not been published");
    let invalid = public_state(&memory, &"A".repeat(48)).await.expect_err("invalid ID");
    assert_eq!(invalid.status, 404);
}

// ---------------------------------------------------------------------------
// Recovery.

#[tokio::test]
async fn recovery_appends_copies_and_is_idempotent() {
    let memory = Memory::with_account("chan");
    let library = library("chan", &[]);
    let starter = load(&memory, "chan").await.expect("initialize");
    let input = recovery_input(json!([]));
    let recovered = recover_copies(&memory, &library, "chan", &input).await.expect("recovery");
    assert_eq!(recovered.revision, 1.0);
    assert_eq!(recovered.scenes.len(), 2);
    assert_eq!(recovered.designs.len(), 2);
    let scene_copy = copy_id(RECOVERY, "scene", "local-scene");
    let design_copy = copy_id(RECOVERY, "design", "local-design");
    assert_eq!(text(field(&recovered.scenes[1], "id")), scene_copy.as_str());
    assert_eq!(text(field(&recovered.designs[1], "id")), design_copy.as_str());
    assert!(text(field(&recovered.designs[1], "name")).ends_with(" (recovered)"));
    assert_ne!(text(field(&recovered.scenes[1], "publicId")), text(field(&starter.scenes[0], "publicId")));
    assert_eq!(field(&recovered.designs[0], "revision"), &JsonValue::Number(2.0));

    let retried = recover_copies(&memory, &library, "chan", &input).await.expect("retry");
    assert_eq!(retried, recovered);
    assert_eq!(memory.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn recovery_rejects_an_asset_kind_mismatch_without_writing() {
    let memory = Memory::with_account("chan");
    let library = library("chan", &[(IMAGE_ASSET, "video")]);
    load(&memory, "chan").await.expect("initialize");
    let failure = recover_copies(&memory, &library, "chan", &recovery_input(asset_widget("image", IMAGE_ASSET)))
        .await
        .expect_err("kind mismatch");
    assert_eq!(failure.status(), 400);
    assert_eq!(failure.asset_code(), Some("asset_kind_mismatch"));
    assert_eq!(memory.writes.load(Ordering::SeqCst), 0);
    assert_eq!(memory.revision("chan"), 0.0);
    assert_eq!(memory.studio("chan").expect("studio").get_array("scenes").expect("scenes").len(), 1);
}

#[tokio::test]
async fn recovery_reports_a_missing_asset_without_writing() {
    let memory = Memory::with_account("chan");
    let library = library("chan", &[]);
    load(&memory, "chan").await.expect("initialize");
    let failure = recover_copies(&memory, &library, "chan", &recovery_input(asset_widget("image", MISSING_ASSET)))
        .await
        .expect_err("missing");
    assert_eq!(failure.status(), 404);
    assert_eq!(failure.asset_code(), Some("not_found"));
    assert_eq!(memory.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn recovery_accepts_matching_asset_kinds() {
    let memory = Memory::with_account("chan");
    let library = library(
        "chan",
        &[(IMAGE_ASSET, "image"), (VIDEO_ASSET, "video")],
    );
    load(&memory, "chan").await.expect("initialize");
    let widget = with(
        with(base_widget("video-widget", "video"), "assetId", json!(VIDEO_ASSET)),
        "name",
        json!("clip"),
    );
    let recovered = recover_copies(&memory, &library, "chan", &recovery_input(widget))
        .await
        .expect("matching assets");
    assert_eq!(recovered.scenes.len(), 2);
    assert_eq!(memory.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn recovery_rejects_a_full_draft_before_copying() {
    let memory = Memory::with_account("chan");
    let library = library("chan", &[]);
    let scenes: Vec<Bson> = (0..25)
        .map(|index| Bson::Document(doc! { "id": format!("scene-{index}") }))
        .collect();
    memory.studios.lock().expect("studio lock").insert(
        "chan".into(),
        doc! {
            "_id": "chan",
            "schemaVersion": 1_i32,
            "revision": 0_i32,
            "scenes": Bson::Array(scenes),
            "designs": Bson::Array(vec![Bson::Document(doc! { "id": "design-0" })]),
        },
    );
    let failure = recover_copies(&memory, &library, "chan", &recovery_input(json!([])))
        .await
        .expect_err("capacity");
    assert_eq!(failure.status(), 409);
    assert!(failure.message().contains("not enough room for recovery copies"));
    assert_eq!(memory.writes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn recovery_rejects_malformed_requests() {
    let memory = Memory::with_account("chan");
    let library = library("chan", &[]);
    let mut uppercase = recovery_input(json!([]));
    if let JsonValue::Object(fields) = &mut uppercase {
        if let Some((_, value)) = fields.iter_mut().find(|(name, _)| name.as_str() == Some("recoveryId")) {
            *value = JsonValue::String("12345678-1234-ABCD-1234-123456789012".into());
        }
    }
    let failure = recover_copies(&memory, &library, "chan", &uppercase)
        .await
        .expect_err("uppercase");
    assert_eq!(failure.status(), 400);
    assert_eq!(failure.message(), "Invalid recovery request");

    let mut missing = recovery_input(json!([]));
    if let JsonValue::Object(fields) = &mut missing {
        fields.retain(|(name, _)| name.as_str() != Some("recoveryId"));
    }
    let failure = recover_copies(&memory, &library, "chan", &missing)
        .await
        .expect_err("missing ID");
    assert_eq!(failure.message(), "Invalid text");
}
