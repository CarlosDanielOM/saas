//! Media library naming, quota and authorization (`media_library.service.ts`).
//! No display-name length limit exists in the reference. S3 identities retain exact bytes for
//! safe inputs; unsafe path components and keys over S3's 1024-byte limit are refused rather
//! than normalized. In particular the reference's unchecked extension/key concatenation is
//! not reproduced for separators, dot segments, URL delimiters or controls.
//! Search retains literal metacharacter escaping and accent classes. Its user-text limit is
//! 80 Unicode scalars under MIGRATION.md section 4, instead of 80 UTF-16 units: an emoji at
//! the boundary is kept whole. This text never feeds a stored identity or a monetary count.
//! Generated expressions contain only literal characters, fixed classes and separated whitespace
//! runs: no user quantifier, alternation, capture or backreference can enter the expression.
//! Local adapter: dima-text exposes NFC but no NFD helper, so accent decomposition uses
//! unicode-normalization here; a shared NFD helper would let that dependency move to text.
//! Callers supply the API origin, clock, randomness, Mongo store, deadline and global access
//! decision. Store calls and the injected access decision share the supplied deadline.
use bson::{Bson, doc};
pub use dima_billing::plans::{PlanTier, tier_of as normalize_plan_tier};
use dima_core::{Clock, Random};
pub use dima_model::channel_extension_items::MediaType;
pub use dima_model::media_assets::{AssetScope, MarketplaceStatus};
use dima_model::{admins, user_media_library_items};
use dima_store::mongo::MongoStore;
use futures_util::{TryStreamExt, future::BoxFuture};
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

pub const MEDIA_NAME_REGEX: &str = "^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$";
pub const DOMDIMABOT_SITE_OWNER_USER_ID: &str = "system:domdimabot";
pub const DOMDIMABOT_SITE_OWNER_CHANNEL_ID: &str = "domdimabot";
pub const DOMDIMABOT_SITE_OWNER_CHANNEL_NAME: &str = "DomDimaBot";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid media path component or deadline")]
    Invalid,
    #[error("media operation deadline exceeded")]
    Timeout,
    #[error(transparent)]
    Store(#[from] mongodb::error::Error),
    #[error(transparent)]
    Random(#[from] dima_core::RandomError),
    #[error("global access decision unavailable")]
    Access,
}
pub fn get_plan_upload_limit_bytes(tier: PlanTier) -> u64 {
    (match tier {
        PlanTier::Free => 5,
        PlanTier::Premium => 25,
        PlanTier::Pro => 100,
    }) * 1024
        * 1024
}
pub fn get_plan_storage_quota_bytes(tier: PlanTier) -> u64 {
    match tier {
        PlanTier::Free => 0,
        PlanTier::Premium => 250 * 1024 * 1024,
        PlanTier::Pro => 1024 * 1024 * 1024,
    }
}
pub fn get_media_quota_charge_bytes(scope: AssetScope, bytes: f64) -> f64 {
    if scope == AssetScope::Private {
        if bytes.is_nan() {
            bytes
        } else {
            bytes.max(0.0)
        }
    } else {
        0.0
    }
}
pub fn is_valid_media_display_name(name: &str) -> bool {
    let mut chars = name.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let mut underscore = false;
    for c in chars {
        if c == '_' && !underscore {
            underscore = true;
        } else if c.is_ascii_alphanumeric() {
            underscore = false;
        } else {
            return false;
        }
    }
    !underscore
}
pub fn infer_media_type_from_mime_type(mime: &str) -> Option<MediaType> {
    if mime == "image/gif" {
        Some(MediaType::Gif)
    } else if mime.starts_with("video/") {
        Some(MediaType::Video)
    } else if mime.starts_with("audio/") {
        Some(MediaType::Audio)
    } else if mime.starts_with("image/") {
        Some(MediaType::Image)
    } else {
        None
    }
}
/// POSIX path.extname, as on the reference host; backslash is not a POSIX separator.
pub fn get_file_extension(file: &str, mime: &str) -> String {
    let base = file.rsplit('/').find(|s| !s.is_empty()).unwrap_or("");
    if base != ".."
        && let Some((head, ext)) = base.rsplit_once('.')
        && !head.is_empty()
        && !ext.is_empty()
    {
        let ext = dima_text::to_lower(ext);
        return match ext.as_str() {
            "jpeg" => "jpg".into(),
            "svg+xml" => "svg".into(),
            "quicktime" => "mov".into(),
            _ => ext,
        };
    }
    let fallback = match mime {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/x-wav" => "wav",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "image/jpeg" => "jpg",
        "image/svg+xml" => "svg",
        "video/quicktime" => "mov",
        _ => "",
    };
    if !fallback.is_empty() {
        return fallback.into();
    }
    let ext: String = dima_text::to_lower(mime.split('/').nth(1).unwrap_or(""))
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if ext.is_empty() { "bin".into() } else { ext }
}
fn component(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '?' | '#' | '%'))
}
pub fn build_stored_media_file_name(
    name: &str,
    extension: &str,
    random: &dyn Random,
    clock: &dyn Clock,
) -> Result<String, Error> {
    if !is_valid_media_display_name(name) || !component(extension) {
        return Err(Error::Invalid);
    }
    let file = format!(
        "{}-{name}-{}.{extension}",
        random.hex_token(6)?,
        clock.now_ms()
    );
    if file.len() > 1024 {
        return Err(Error::Invalid);
    }
    Ok(file)
}
pub fn build_media_s3_key(
    scope: AssetScope,
    media_type: MediaType,
    channel: &str,
    file: &str,
) -> Result<String, Error> {
    if !component(file) || (scope != AssetScope::Public && !component(channel)) {
        return Err(Error::Invalid);
    }
    use dima_model::StrEnum;
    let key = if scope == AssetScope::Public {
        format!("library/{}/{file}", media_type.as_str())
    } else {
        format!("{channel}/triggers/{file}")
    };
    if key.len() > 1024 {
        return Err(Error::Invalid);
    }
    Ok(key)
}
pub fn build_media_playback_url(api_url: &str, media_id: bson::oid::ObjectId) -> String {
    format!("{api_url}/media/{media_id}")
}
pub fn get_default_media_scope(tier: PlanTier, requested: Option<&str>) -> AssetScope {
    if tier == PlanTier::Free || requested == Some("public") {
        AssetScope::Public
    } else {
        AssetScope::Private
    }
}
pub fn get_initial_marketplace_status(scope: AssetScope) -> MarketplaceStatus {
    if scope == AssetScope::Public {
        MarketplaceStatus::Published
    } else {
        MarketplaceStatus::NotListed
    }
}
pub fn build_media_asset_search_pattern(input: &str) -> String {
    let cut = dima_text::truncate_chars(dima_text::trim(input), 80);
    let folded: String = cut
        .nfd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();
    folded
        .split(|c| c == '_' || dima_text::is_js_whitespace(c))
        .filter(|s| !s.is_empty())
        .map(|word| {
            let mut out = String::new();
            for c in word.chars() {
                let class = match c.to_ascii_lowercase() {
                    'a' => "[aáàâäãå]",
                    'e' => "[eéèêë]",
                    'i' => "[iíìîï]",
                    'o' => "[oóòôöõ]",
                    'u' => "[uúùûü]",
                    'n' => "[nñ]",
                    _ => "",
                };
                if !class.is_empty() {
                    out.push_str(class);
                } else {
                    if ".*+?^${}()|[]\\".contains(c) {
                        out.push('\\');
                    }
                    out.push(c);
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("[\\s_]+")
}
/// An adapter for admin middleware, deliberately not a dependency on the API layer.
pub trait GlobalChannelOwnerAccess: Send + Sync {
    fn has_access<'a>(
        &'a self,
        requester: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<bool, Error>>;
}
async fn bounded<T>(
    deadline: Duration,
    future: impl std::future::Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    if deadline.is_zero() {
        return Err(Error::Invalid);
    }
    tokio::time::timeout(deadline, future)
        .await
        .map_err(|_| Error::Timeout)?
}
pub async fn get_channel_quota_usage_bytes(
    store: &MongoStore,
    channel: &str,
    deadline: Duration,
) -> Result<f64, Error> {
    if channel.is_empty() || channel.len() > 256 {
        return Err(Error::Invalid);
    }
    bounded(deadline, async {
        let mut rows = store.documents(user_media_library_items::COLLECTION).aggregate(vec![
            doc! {"$match":{"channelID":channel,"assetScope":"private","isActive":true,"deletedAt":Bson::Null}},
            doc! {"$group":{"_id":Bson::Null,"total":{"$sum":"$quotaBytesCharged"}}}
        ]).await?;
        let row = rows.try_next().await?;
        Ok(row.and_then(|r| r.get("total").and_then(|b| match b { Bson::Double(n) => Some(*n), Bson::Int32(n) => Some(f64::from(*n)), Bson::Int64(n) => Some(*n as f64), _ => None })).unwrap_or(0.0))
    }).await
}
pub async fn has_trigger_permission(
    store: &MongoStore,
    access: &dyn GlobalChannelOwnerAccess,
    requester: &str,
    channel: &str,
    required: &[String],
    deadline: Duration,
) -> Result<bool, Error> {
    if requester.is_empty() || channel.is_empty() || requester.len() > 256 || channel.len() > 256 {
        return Err(Error::Invalid);
    }
    if requester == channel {
        return Ok(true);
    }
    if required.len() > 128 || required.iter().any(|s| s.len() > 256) {
        return Err(Error::Invalid);
    }
    bounded(deadline, async {
        if access.has_access(requester, channel).await? { return Ok(true); }
        let permissions: Vec<&str> = ["*", "triggers:all"].into_iter().chain(required.iter().map(String::as_str)).collect();
        Ok(store.documents(admins::COLLECTION).find_one(doc! {"channelID":channel,"adminID":requester,"actived":true,"permissions":{"$in":permissions}}).projection(doc! {"_id":1}).await?.is_some())
    }).await
}
