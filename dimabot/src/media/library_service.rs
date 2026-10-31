//! Pure quota and naming policies from `server/services/media_library.service.ts`.
//! Public media has no private quota charge; free accounts always select public.

use crate::schemas::media_asset::{MediaAssetMarketplaceStatus, MediaAssetScope, MediaAssetType};

/// Supported plan tiers; unknown source values normalize to free.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanTier { Free, Premium, Pro }

/// Normalize the source plan value.
pub fn normalize_plan_tier(value: Option<&str>) -> PlanTier {
    match value { Some("premium") => PlanTier::Premium, Some("pro") => PlanTier::Pro, _ => PlanTier::Free }
}
/// Per-file limit in binary bytes.
pub fn upload_limit_bytes(tier: PlanTier) -> u64 {
    (match tier { PlanTier::Free => 5, PlanTier::Premium => 25, PlanTier::Pro => 100 }) * 1024 * 1024
}
/// Media-library private quota (0 / 250 MiB / 1 GiB), separate from asset-library quotas.
pub fn storage_quota_bytes(tier: PlanTier) -> u64 {
    match tier { PlanTier::Free => 0, PlanTier::Premium => 250 * 1024 * 1024, PlanTier::Pro => 1024 * 1024 * 1024 }
}
/// Private objects charge their nonnegative size; public and system do not.
pub fn quota_charge_bytes(scope: MediaAssetScope, bytes: f64) -> f64 {
    if scope == MediaAssetScope::Private { if bytes.is_nan() { bytes } else { bytes.max(0.0) } } else { 0.0 }
}
/// Match the source's ASCII display-name regular expression.
pub fn valid_display_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else { return false };
    if !first.is_ascii_alphabetic() { return false; }
    let mut underscore = false;
    for b in bytes {
        if b == b'_' { if underscore { return false; } underscore = true; }
        else if b.is_ascii_alphanumeric() { underscore = false; }
        else { return false; }
    }
    !underscore
}
/// Infer the marketplace type from the supplied MIME string.
pub fn infer_media_type(mime: &str) -> Option<MediaAssetType> {
    if mime == "image/gif" { Some(MediaAssetType::Gif) }
    else if mime.starts_with("video/") { Some(MediaAssetType::Video) }
    else if mime.starts_with("audio/") { Some(MediaAssetType::Audio) }
    else if mime.starts_with("image/") { Some(MediaAssetType::Image) }
    else { None }
}
/// Select the source's default upload scope.
pub fn default_scope(tier: PlanTier, requested: Option<&str>) -> MediaAssetScope {
    if tier == PlanTier::Free || requested == Some("public") { MediaAssetScope::Public } else { MediaAssetScope::Private }
}
/// Marketplace status assigned to a new asset.
pub fn initial_marketplace_status(scope: MediaAssetScope) -> MediaAssetMarketplaceStatus {
    if scope == MediaAssetScope::Public { MediaAssetMarketplaceStatus::Published } else { MediaAssetMarketplaceStatus::NotListed }
}
/// Generate the S3 key used by the existing media service.
pub fn media_s3_key(scope: MediaAssetScope, media_type: MediaAssetType, channel: &str, file: &str) -> String {
    if scope == MediaAssetScope::Public { format!("library/{}/{file}", media_type.as_str()) }
    else { format!("{channel}/triggers/{file}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_plan_quotas() {
        assert_eq!(storage_quota_bytes(PlanTier::Free), 0);
        assert_eq!(upload_limit_bytes(PlanTier::Free), 5 * 1024 * 1024);
        assert_eq!(storage_quota_bytes(PlanTier::Premium), 250 * 1024 * 1024);
        assert_eq!(storage_quota_bytes(PlanTier::Pro), 1024 * 1024 * 1024);
    }
    #[test]
    fn source_charge_policy() {
        assert_eq!(quota_charge_bytes(MediaAssetScope::Public, 12.0), 0.0);
        assert_eq!(quota_charge_bytes(MediaAssetScope::Private, -1.0), 0.0);
        assert_eq!(quota_charge_bytes(MediaAssetScope::Private, 12.0), 12.0);
    }
    #[test]
    fn source_scope_policy() {
        assert_eq!(default_scope(PlanTier::Free, Some("private")), MediaAssetScope::Public);
        assert_eq!(default_scope(PlanTier::Pro, None), MediaAssetScope::Private);
    }
    #[test]
    fn source_names_and_mimes() {
        assert!(valid_display_name("Hello_123"));
        assert!(!valid_display_name("Hello__123"));
        assert!(!valid_display_name("1Hello"));
        assert_eq!(infer_media_type("image/gif"), Some(MediaAssetType::Gif));
        assert_eq!(infer_media_type("application/json"), None);
    }
}

/// Source display-name grammar (also implemented by `valid_display_name`).
pub const MEDIA_NAME_REGEX: &str = r"^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$";
/// System owner of the DomDimaBot library.
pub const DOMDIMABOT_SITE_OWNER_USER_ID: &str = "system:domdimabot";
/// System owner's channel ID.
pub const DOMDIMABOT_SITE_OWNER_CHANNEL_ID: &str = "domdimabot";
/// System owner's channel display name.
pub const DOMDIMABOT_SITE_OWNER_CHANNEL_NAME: &str = "DomDimaBot";

/// Normalize extensions using the source's aliases.
pub fn normalize_extension(extension: &str) -> &str {
    match extension { "jpeg" => "jpg", "svg+xml" => "svg", "quicktime" => "mov", _ => extension }
}

/// Infer an extension from the filename first and the MIME fallback second.
pub fn get_file_extension(file_name: &str, mime_type: &str) -> String {
    let name = file_name.rsplit('/').next().unwrap_or(file_name);
    if let Some(dot) = name.rfind('.') {
        if dot > 0 {
            let ext = name[dot + 1..].to_lowercase();
            if !ext.is_empty() { return normalize_extension(&ext).to_owned(); }
        }
    }
    if let Some(value) = match mime_type {
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/x-wav" => Some("wav"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "image/jpeg" => Some("jpg"),
        "image/svg+xml" => Some("svg"),
        "video/quicktime" => Some("mov"),
        _ => None,
    } { return value.to_owned(); }
    match mime_type.split('/').nth(1) {
        Some(value) => { let ext: String = value.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect(); if ext.is_empty() { "bin".to_owned() } else { ext } },
        None => "bin".to_owned(),
    }
}

/// Build a name using six random bytes and the supplied timestamp in milliseconds.
pub fn build_stored_media_file_name(display_name: &str, extension: &str, now_millis: u64) -> String {
    let id = uuid::Uuid::new_v4();
    let hash: String = id.as_bytes()[..6].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{hash}-{display_name}-{now_millis}.{extension}")
}

/// Build a playback URL using a caller-injected API base URL.
pub fn build_media_playback_url(api_url: &str, media_id: &str) -> String {
    format!("{api_url}/media/{media_id}")
}

/// Build the source's accent-tolerant MongoDB regex pattern.
pub fn build_media_asset_search_pattern(input: &str) -> String {
    build_media_asset_search_pattern_js(&input.into()).to_utf8_lossy()
}

/// Build the search pattern while retaining JavaScript UTF-16 code units.
pub fn build_media_asset_search_pattern_js(input: &crate::utils::js_string::JsString) -> crate::utils::js_string::JsString {
    use crate::utils::{js_compat, js_string::JsString};
    use unicode_normalization::UnicodeNormalization;
    let truncated = input.trim().slice(0, 80);
    let mut normalized = Vec::new();
    let mut valid = String::new();
    let flush = |valid: &mut String, normalized: &mut Vec<u16>| {
        for character in valid.nfd().filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch)) {
            let mut buffer = [0; 2];
            normalized.extend_from_slice(character.encode_utf16(&mut buffer));
        }
        valid.clear();
    };
    for character in char::decode_utf16(truncated.code_units()) {
        match character {
            Ok(character) => valid.push(character),
            Err(error) => { flush(&mut valid, &mut normalized); normalized.push(error.unpaired_surrogate()); }
        }
    }
    flush(&mut valid, &mut normalized);
    let mut output = Vec::new();
    let mut pending_separator = false;
    let mut word_started = false;
    for character in char::decode_utf16(normalized) {
        if let Ok(ch) = &character {
            if *ch == '_' || js_compat::is_whitespace(*ch) {
                if word_started { pending_separator = true; }
                continue;
            }
        }
        if pending_separator { output.extend("[\\s_]+".encode_utf16()); pending_separator = false; }
        word_started = true;
        match character {
            Err(error) => output.push(error.unpaired_surrogate()),
            Ok(ch) => {
                let class = match ch.to_ascii_lowercase() {
                    'a' => Some("[aáàâäãå]"), 'e' => Some("[eéèêë]"), 'i' => Some("[iíìîï]"),
                    'o' => Some("[oóòôöõ]"), 'u' => Some("[uúùûü]"), 'n' => Some("[nñ]"), _ => None,
                };
                if let Some(class) = class { output.extend(class.encode_utf16()); }
                else {
                    if ".*+?^${}()|[]\\".contains(ch) { output.push(b'\\' as u16); }
                    let mut buffer = [0; 2];
                    output.extend_from_slice(ch.encode_utf16(&mut buffer));
                }
            }
        }
    }
    JsString::from_units(output)
}

/// Native service for quota and channel-permission lookups.
#[derive(Clone)]
pub struct MediaLibraryService { database: mongodb::Database }
impl MediaLibraryService {
    /// Use an existing database; performs no I/O.
    pub fn new(database: mongodb::Database) -> Self { Self { database } }
    /// Sum active, nondeleted private charges for a channel.
    pub async fn get_channel_quota_usage_bytes(&self, channel_id: &str) -> mongodb::error::Result<f64> {
        use futures_util::TryStreamExt;
        use mongodb::bson::{Bson, doc};
        let mut cursor = crate::schemas::user_media_library_item::collection(&self.database).aggregate(vec![
            doc! { "$match": { "channelID": channel_id, "assetScope": "private", "isActive": true, "deletedAt": null } },
            doc! { "$group": { "_id": null, "total": { "$sum": "$quotaBytesCharged" } } },
        ]).await?;
        Ok(match cursor.try_next().await?.and_then(|row| row.get("total").cloned()) {
            Some(Bson::Double(value)) => value, Some(Bson::Int32(value)) => value as f64,
            Some(Bson::Int64(value)) => value as f64, _ => 0.0,
        })
    }
    /// Reuse the native admin schema and global-owner access helper.
    pub async fn has_trigger_permission(&self, requester_id: &str, channel_id: &str, required: &[String]) -> mongodb::error::Result<bool> {
        use mongodb::bson::doc;
        if requester_id == channel_id { return Ok(true); }
        let admins = crate::schemas::admin::schema().native_collection(&self.database);
        if crate::api_admin::has_global_channel_owner_access(&admins, Some(requester_id), Some(channel_id)).await? { return Ok(true); }
        let mut permissions = vec!["*".to_owned(), "triggers:all".to_owned()];
        permissions.extend_from_slice(required);
        Ok(admins.find_one(doc! { "channelID": channel_id, "adminID": requester_id, "actived": true, "permissions": { "$in": permissions } }).await?.is_some())
    }
}

#[cfg(test)]
mod extra_tests {
    use super::*;
    #[test]
    fn extensions_follow_source_fallbacks() {
        assert_eq!(get_file_extension("picture.JPEG", "image/png"), "jpg");
        assert_eq!(get_file_extension("file", "video/quicktime"), "mov");
        assert_eq!(get_file_extension("file", "image/svg+xml"), "svg");
        assert_eq!(get_file_extension("file", "audio/x-wav"), "wav");
        assert_eq!(get_file_extension("file", "application/x-foo"), "xfoo");
        assert_eq!(get_file_extension("file", "none"), "bin");
    }
    #[test]
    fn search_expands_accents_and_escapes_metacharacters() {
        assert_eq!(build_media_asset_search_pattern("país .*"), "p[aáàâäãå][iíìîï]s[\\s_]+\\.\\*");
    }
    #[test]
    fn search_keeps_an_unpaired_utf16_unit() {
        let input = crate::utils::js_string::JsString::from_units(vec![0xd800, b'_' as u16, b'x' as u16]);
        let pattern = build_media_asset_search_pattern_js(&input);
        let mut expected = vec![0xd800];
        expected.extend("[\\s_]+x".encode_utf16());
        assert_eq!(pattern.units(), expected);
    }
}
