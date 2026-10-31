//! Asset-validated recovery copies from `recover.ts`.
//! Copy IDs are stable across retries, capacity checks never replace a
//! published snapshot, and every asset reference in the resulting draft must
//! resolve to a ready asset of the expected kind before the write is committed.
//!
//! Concurrency is the source's own boundary: [`AssetLibrary::with_asset_library`]
//! serializes an owner only within one process/library instance, matching the
//! single-process TypeScript server. It is not a cross-process lock; the studio
//! revision compare-and-set remains the guard against concurrent writers.

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex},
};
use sha2::{Digest, Sha256};
use crate::{
    media_assets::library::{AssetError, AssetLibrary},
    utils::{
        js_string::JsString,
        lossless_json::{truthy, JsonValue},
    },
};
use super::{
    model::design_layouts,
    store::{
        change, js_string_value, load, object, string, validate_state, MongoStudioStore,
        OverlayError, StudioPersistence, StudioState,
    },
};
pub use super::store::{MAX_DESIGNS, MAX_SCENES};

/// Public message the source route renders for any asset failure.
pub const ASSET_FALLBACK_MESSAGE: &str =
    "The selected asset is unavailable or incompatible. Choose another asset.";

/// Validate the source's lowercase 36-character recovery identifier grammar.
pub fn valid_recovery_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
}

/// Produce a stable copy ID from the request, object kind and original ID.
pub fn copy_id(recovery_id: &str, kind: &str, id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(format!("{recovery_id}:{kind}:{id}").as_bytes()));
    format!("recovered-{}", &digest[..32])
}

/// Check that appending a recovery request stays inside both storage limits.
pub fn has_recovery_capacity(
    existing_scenes: usize,
    added_scenes: usize,
    existing_designs: usize,
    added_designs: usize,
) -> bool {
    existing_scenes.checked_add(added_scenes).is_some_and(|count| count <= MAX_SCENES)
        && existing_designs.checked_add(added_designs).is_some_and(|count| count <= MAX_DESIGNS)
}

/// A retry is already complete only when every requested copy exists.
pub fn already_recovered(
    recovery_id: &str,
    scenes: &[String],
    designs: &[String],
    current_scenes: &[String],
    current_designs: &[String],
) -> bool {
    scenes.iter().all(|id| current_scenes.contains(&copy_id(recovery_id, "scene", id)))
        && designs.iter().all(|id| current_designs.contains(&copy_id(recovery_id, "design", id)))
}

/// Invalid recovery data detected while building copies.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryError {
    /// Public diagnostic.
    pub message: String,
}
impl fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RecoveryError {}

/// A recovery failure that preserves the source's two error families.
#[derive(Clone, Debug, PartialEq)]
pub enum RecoveryFailure {
    /// Draft validation, capacity, revision conflict, or persistence failure.
    Overlay(OverlayError),
    /// The shared asset library rejected a referenced asset.
    Asset(AssetError),
}

impl RecoveryFailure {
    /// HTTP status the source route would use.
    pub fn status(&self) -> u16 {
        match self {
            Self::Overlay(value) => value.status,
            Self::Asset(value) => value.status,
        }
    }
    /// Public response message.
    pub fn message(&self) -> &str {
        match self {
            Self::Overlay(value) => &value.message,
            Self::Asset(_) => ASSET_FALLBACK_MESSAGE,
        }
    }
    /// Stable asset error code when this is an asset failure.
    pub fn asset_code(&self) -> Option<&'static str> {
        match self {
            Self::Asset(value) => Some(value.code),
            Self::Overlay(_) => None,
        }
    }
}
impl From<OverlayError> for RecoveryFailure {
    fn from(value: OverlayError) -> Self {
        Self::Overlay(value)
    }
}
impl From<AssetError> for RecoveryFailure {
    fn from(value: AssetError) -> Self {
        Self::Asset(value)
    }
}
impl fmt::Display for RecoveryFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for RecoveryFailure {}

fn invalid() -> RecoveryError {
    RecoveryError { message: "Invalid recovery request".into() }
}
fn invalid_request() -> OverlayError {
    OverlayError { message: "Invalid recovery request".into(), status: 400 }
}
fn capacity_error() -> OverlayError {
    OverlayError {
        message: "There is not enough room for recovery copies. Export your local draft before removing unused overlays or designs.".into(),
        status: 409,
    }
}

fn member<'a>(fields: &'a [(JsString, JsonValue)], key: &str) -> Option<&'a JsonValue> {
    fields.iter().rev().find(|(name, _)| name.as_str() == Some(key)).map(|(_, value)| value)
}
fn set(fields: &mut Vec<(JsString, JsonValue)>, key: &str, value: JsonValue) {
    if let Some((_, existing)) = fields.iter_mut().rev().find(|(name, _)| name.as_str() == Some(key)) {
        *existing = value;
    } else {
        fields.push((key.into(), value));
    }
}

/// Build recovery copies from already validated local scenes and designs.
/// Published scene data is preserved; widget design references target copies.
pub fn build_copies(
    recovery_id: &str,
    scenes: &[JsonValue],
    designs: &[JsonValue],
) -> Result<(Vec<JsonValue>, Vec<JsonValue>), RecoveryError> {
    if !valid_recovery_id(recovery_id) {
        return Err(invalid());
    }
    fn copy(recovery_id: &str, kind: &str, value: &JsonValue) -> Result<JsonValue, RecoveryError> {
        let JsonValue::Object(mut fields) = value.clone() else { return Err(invalid()) };
        let id = match member(&fields, "id") {
            Some(JsonValue::String(value)) => value.as_str().ok_or_else(invalid)?.to_owned(),
            _ => return Err(invalid()),
        };
        let name = match member(&fields, "name") {
            Some(JsonValue::String(value)) => value,
            _ => return Err(invalid()),
        };
        let mut units: Vec<_> = name.code_units().take(65).collect();
        units.extend(" (recovered)".encode_utf16());
        set(&mut fields, "id", JsonValue::String(copy_id(recovery_id, kind, &id).into()));
        set(&mut fields, "name", JsonValue::String(JsString::from_units(units)));
        if kind == "scene" {
            let Some(JsonValue::Array(widgets)) =
                fields.iter_mut().rev().find(|(name, _)| name.as_str() == Some("widgets")).map(|(_, value)| value)
            else {
                return Err(invalid());
            };
            for widget in widgets {
                if let JsonValue::Object(fields) = widget {
                    if let Some(JsonValue::String(id)) = member(fields, "designId") {
                        let id = id.as_str().ok_or_else(invalid)?.to_owned();
                        if !id.is_empty() {
                            set(fields, "designId", JsonValue::String(copy_id(recovery_id, "design", &id).into()));
                        }
                    }
                }
            }
        }
        Ok(JsonValue::Object(fields))
    }
    let scenes = scenes.iter().map(|item| copy(recovery_id, "scene", item)).collect::<Result<Vec<_>, _>>()?;
    let designs = designs.iter().map(|item| copy(recovery_id, "design", item)).collect::<Result<Vec<_>, _>>()?;
    Ok((scenes, designs))
}

// ---------------------------------------------------------------------------
// Asset references.

fn asset_reference(value: &JsonValue) -> Option<String> {
    value.get("assetId").filter(|value| truthy(value)).map(js_string_value)
}

fn widget_refs(container: &JsonValue, out: &mut Vec<(String, String)>) {
    let Some(JsonValue::Array(widgets)) = container.get("widgets") else { return };
    for widget in widgets {
        if let Some(asset_id) = asset_reference(widget) {
            out.push((asset_id, widget.get("kind").map(js_string_value).unwrap_or_default()));
        }
    }
}

fn layout_refs(layout: &JsonValue, out: &mut Vec<(String, String)>) {
    widget_refs(layout, out);
    if let Some(sound) = layout.get("sound") {
        if let Some(asset_id) = asset_reference(sound) {
            out.push((asset_id, "audio".into()));
        }
    }
}

fn design_refs(design: &JsonValue, out: &mut Vec<(String, String)>) {
    for layout in design_layouts(design) {
        layout_refs(layout, out);
    }
}

fn snapshot_refs(snapshot: &JsonValue, out: &mut Vec<(String, String)>) {
    widget_refs(snapshot, out);
    if let Some(JsonValue::Array(designs)) = snapshot.get("designs") {
        for design in designs {
            design_refs(design, out);
        }
    }
}

/// Collect every referenced asset in source `stateAssets` order: scene widgets,
/// design layouts, then each published snapshot's widgets and designs.
pub fn state_assets(scenes: &[JsonValue], designs: &[JsonValue]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for scene in scenes {
        widget_refs(scene, &mut out);
    }
    for design in designs {
        design_refs(design, &mut out);
    }
    for scene in scenes {
        if let Some(snapshot) = scene.get("published").filter(|value| truthy(value)) {
            snapshot_refs(snapshot, &mut out);
        }
    }
    out
}

/// Validate each referenced asset through the shared private library. Missing
/// assets remain `not_found` (404) and kind mismatches use the source's
/// `asset_kind_mismatch` (400); both surface as [`RecoveryFailure::Asset`].
pub async fn validate_assets(
    library: &AssetLibrary,
    owner: &str,
    scenes: &[JsonValue],
    designs: &[JsonValue],
) -> Result<(), AssetError> {
    let mut cache: HashMap<String, String> = HashMap::new();
    for (asset_id, kind) in state_assets(scenes, designs) {
        let resolved = match cache.get(&asset_id).cloned() {
            Some(kind) => kind,
            None => {
                let asset = library.find_asset(owner, &asset_id).await?;
                let id = asset.string("id").unwrap_or(&asset_id).to_owned();
                let resolved = asset.string("kind").unwrap_or_default().to_owned();
                cache.insert(id, resolved.clone());
                resolved
            }
        };
        if kind != resolved {
            return Err(AssetError { code: "asset_kind_mismatch", status: 400 });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Recovery operation.

fn ids_of(items: &[JsonValue]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| match item.get("id") {
            Some(JsonValue::String(value)) => value.as_str().map(str::to_owned),
            _ => None,
        })
        .collect()
}

async fn recover_locked(
    persistence: &dyn StudioPersistence,
    library: &AssetLibrary,
    channel: &str,
    recovery_id: &str,
    local_scenes: &[JsonValue],
    local_designs: &[JsonValue],
) -> Result<StudioState, RecoveryFailure> {
    let current = load(persistence, channel).await?;
    let local_scene_ids = ids_of(local_scenes);
    let local_design_ids = ids_of(local_designs);
    if already_recovered(
        recovery_id,
        &local_scene_ids,
        &local_design_ids,
        &ids_of(&current.scenes),
        &ids_of(&current.designs),
    ) {
        return Ok(current);
    }
    if !has_recovery_capacity(
        current.scenes.len(),
        local_scenes.len(),
        current.designs.len(),
        local_designs.len(),
    ) {
        return Err(RecoveryFailure::Overlay(capacity_error()));
    }
    let (scenes, designs) = build_copies(recovery_id, local_scenes, local_designs)
        .map_err(|failure| RecoveryFailure::Overlay(OverlayError { message: failure.message, status: 400 }))?;
    let mut combined_scenes = current.scenes.clone();
    combined_scenes.extend(scenes);
    let mut combined_designs = current.designs.clone();
    combined_designs.extend(designs);
    let combined = JsonValue::Object(vec![
        ("scenes".into(), JsonValue::Array(combined_scenes)),
        ("designs".into(), JsonValue::Array(combined_designs)),
    ]);
    // Validation and asset checks complete before the revision-guarded write.
    // The owner lock excludes this instance's reference updates; a concurrent
    // studio write changes the revision, so the later compare-and-set rejects
    // the stale assignment rather than persisting an unvalidated draft.
    let (validated_scenes, validated_designs) = validate_state(&combined, &current)?;
    validate_assets(library, channel, &validated_scenes, &validated_designs).await?;
    change(persistence, channel, current.revision, move |state| {
        state.scenes = validated_scenes;
        state.designs = validated_designs;
        Ok::<(), OverlayError>(())
    })
    .await
    .map_err(RecoveryFailure::Overlay)
}

/// Append copies of a local draft without replacing existing drafts or
/// snapshots. The owner-scoped asset library operation serializes recovery
/// against this instance's reference updates; retries are idempotent.
pub async fn recover_copies(
    persistence: &dyn StudioPersistence,
    library: &AssetLibrary,
    channel: &str,
    input: &JsonValue,
) -> Result<StudioState, RecoveryFailure> {
    let body = object(input)?;
    let recovery = string(member(body, "recoveryId").unwrap_or(&JsonValue::Null), 36)?;
    let Some(recovery_id) = recovery.as_str().filter(|value| valid_recovery_id(value)) else {
        return Err(RecoveryFailure::Overlay(invalid_request()));
    };
    let empty = StudioState::empty();
    let (local_scenes, local_designs) = validate_state(input, &empty)?;

    // `with_asset_library` is fixed to `AssetError`; retain the exact failure
    // family so overlay validation and asset errors keep their source status.
    let failure = Arc::new(Mutex::new(None::<RecoveryFailure>));
    let captured = Arc::clone(&failure);
    let result = library
        .with_asset_library(channel, || async move {
            match recover_locked(persistence, library, channel, recovery_id, &local_scenes, &local_designs).await {
                Ok(state) => Ok(state),
                Err(value) => {
                    let status = value.status();
                    if let Ok(mut slot) = captured.lock() {
                        *slot = Some(value);
                    }
                    Err(AssetError { code: "overlay_recovery_failed", status })
                }
            }
        })
        .await;
    match result {
        Ok(state) => Ok(state),
        Err(asset) => match failure.lock().ok().and_then(|mut slot| slot.take()) {
            Some(value) => Err(value),
            None => Err(RecoveryFailure::Asset(asset)),
        },
    }
}

impl MongoStudioStore {
    /// Recover asset-validated copies against the concrete Mongo draft and the
    /// shared private asset library.
    pub async fn recover_copies(
        &self,
        library: &AssetLibrary,
        channel: &str,
        input: &JsonValue,
    ) -> Result<StudioState, RecoveryFailure> {
        crate::overlays::recover::recover_copies(self.persistence(), library, channel, input).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::lossless_json::parse_json;

    fn json(text: &str) -> JsonValue {
        parse_json(text).expect("fixture JSON")
    }

    #[test]
    fn recovery_ids_match_the_source_grammar() {
        assert!(valid_recovery_id("12345678-1234-abcd-1234-123456789012"));
        assert!(!valid_recovery_id("12345678-1234-ABCD-1234-123456789012"));
    }

    #[test]
    fn retry_is_stable_and_scoped_by_kind() {
        let id = "12345678-1234-abcd-1234-123456789012";
        assert_ne!(copy_id(id, "scene", "1"), copy_id(id, "design", "1"));
        assert!(already_recovered(id, &["1".into()], &[], &[copy_id(id, "scene", "1")], &[]));
        assert!(!already_recovered(id, &["1".into()], &[], &[], &[]));
    }

    #[test]
    fn capacity_includes_existing_copies() {
        assert!(has_recovery_capacity(24, 1, 49, 1));
        assert!(!has_recovery_capacity(25, 1, 0, 0));
        assert!(!has_recovery_capacity(0, 0, 50, 1));
    }

    #[test]
    fn copied_scene_retargets_design_without_mutating_original() {
        let recovery = "12345678-1234-abcd-1234-123456789012";
        let scene = JsonValue::Object(vec![
            ("id".into(), JsonValue::String("s".into())),
            ("name".into(), JsonValue::String("Name".into())),
            (
                "widgets".into(),
                JsonValue::Array(vec![JsonValue::Object(vec![("designId".into(), JsonValue::String("d".into()))])]),
            ),
        ]);
        let (copies, _) = build_copies(recovery, &[scene.clone()], &[]).expect("valid source");
        assert_ne!(copies[0], scene);
        let JsonValue::Object(fields) = &copies[0] else { panic!("copy object") };
        assert_eq!(member(fields, "id"), Some(&JsonValue::String(copy_id(recovery, "scene", "s").into())));
    }

    #[test]
    fn asset_collection_matches_the_source_order_and_kinds() {
        let state = json(
            r#"{
                "scenes": [{
                    "widgets": [{"kind":"image","assetId":"aaaaaaaaaaaaaaaaaaaaaaaa"}],
                    "published": {
                        "widgets": [{"kind":"video","assetId":"bbbbbbbbbbbbbbbbbbbbbbbb"}],
                        "designs": [{"events":{"sub":{"widgets":[{"kind":"image","assetId":"cccccccccccccccccccccccc"}],"sound":{"assetId":"dddddddddddddddddddddddd"}}}}]
                    }
                }],
                "designs": [{"events":{"bits":{"widgets":[{"kind":"image","assetId":"eeeeeeeeeeeeeeeeeeeeeeee"}]}}}]
            }"#,
        );
        let JsonValue::Object(fields) = &state else { panic!("fixture object") };
        let Some(JsonValue::Array(scenes)) = member(fields, "scenes") else { panic!("scenes") };
        let Some(JsonValue::Array(designs)) = member(fields, "designs") else { panic!("designs") };
        assert_eq!(
            state_assets(scenes, designs),
            vec![
                ("aaaaaaaaaaaaaaaaaaaaaaaa".into(), "image".into()),
                ("eeeeeeeeeeeeeeeeeeeeeeee".into(), "image".into()),
                ("bbbbbbbbbbbbbbbbbbbbbbbb".into(), "video".into()),
                ("cccccccccccccccccccccccc".into(), "image".into()),
                ("dddddddddddddddddddddddd".into(), "audio".into()),
            ]
        );
    }
}
