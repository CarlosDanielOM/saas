//! Fish favorites: explicit Mongo ownership and a plain-string BSON boundary.
use super::{Field, FieldDefault as D, FieldType as T, SchemaDefinition, SchemaIndex};
use crate::tts_services::fish_tts::FISH_VOICES;
use crate::utils::{js_string::JsString, js_unicode, lossless_json::JsonValue};
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
};
use std::{collections::HashSet, fmt, sync::OnceLock};

pub const MAX_FISH_VOICE_FAVORITES: usize = 20;
const INVALID: &str =
    "Nickname must use 1–40 letters, numbers, or underscores and start with a letter.";

pub fn schema() -> &'static SchemaDefinition {
    static VALUE: OnceLock<SchemaDefinition> = OnceLock::new();
    VALUE.get_or_init(|| SchemaDefinition {
        model: "channel_fish_voice_favorites",
        collection: "channel_fish_voice_favorites",
        string_id: false,
        version_key: true,
        write_concern_journaled: false,
        timestamps: None,
        save_clock_field: None,
        indexes: vec![SchemaIndex::new(doc! {"channelID": 1}).unique()],
        fields: vec![
            Field::new("channelID", T::String).required(),
            Field::new(
                "favorites",
                T::Array(Box::new(T::Subdocument {
                    fields: vec![
                        Field::new("id", T::String).required(),
                        Field::new("name", T::String).required(),
                        Field::new("alias", T::String).required(),
                    ],
                    generate_id: false,
                })),
            )
            .default(D::Array),
        ],
    })
}

/// Install the unique channel index explicitly on a caller-owned database.
/// Constructing or using this module never installs indexes implicitly.
pub async fn install_indexes(database: &Database) -> mongodb::error::Result<()> {
    schema().install_indexes(database).await
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Favorite {
    pub id: JsString,
    pub name: JsString,
    pub alias: JsString,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FavoriteAliasError {
    pub status: f64,
    pub code: JsString,
    pub message: JsString,
}
impl FavoriteAliasError {
    pub fn new(status: f64, code: JsString, message: JsString) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    /// The source class inherits Error.name without overriding it.
    pub fn name(&self) -> &'static str {
        "Error"
    }
}
impl fmt::Display for FavoriteAliasError {
    /// Rust formatting requires UTF-8; unpaired UTF-16 units are replaced.
    /// The public message field retains its original lossless code units.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message.to_utf8_lossy())
    }
}
impl std::error::Error for FavoriteAliasError {}
#[derive(Debug)]
pub enum FavoritesError {
    Alias(FavoriteAliasError),
    Full,
    Conflict,
    Mongo(mongodb::error::Error),
    BsonBoundary(&'static str),
}
impl fmt::Display for FavoritesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Alias(e) => e.fmt(f),
            Self::Full => f.write_str("favorites_full"),
            Self::Conflict => f.write_str("favorites_conflict"),
            Self::Mongo(e) => e.fmt(f),
            Self::BsonBoundary(e) => write!(f, "unsupported favorites BSON: {e}"),
        }
    }
}
impl std::error::Error for FavoritesError {}
impl From<mongodb::error::Error> for FavoritesError {
    fn from(e: mongodb::error::Error) -> Self {
        Self::Mongo(e)
    }
}
impl From<FavoriteAliasError> for FavoritesError {
    fn from(e: FavoriteAliasError) -> Self {
        Self::Alias(e)
    }
}
fn alias_error(status: u16, code: &'static str, message: &'static str) -> FavoriteAliasError {
    FavoriteAliasError::new(
        f64::from(status),
        JsString::from_static(code),
        JsString::from_static(message),
    )
}
fn reserved(alias: &str) -> bool {
    FISH_VOICES.iter().any(|(name, _)| *name == alias)
}

pub fn normalize_favorite_alias(value: &JsonValue) -> Result<String, FavoriteAliasError> {
    let JsonValue::String(value) = value else {
        return Err(alias_error(400, "invalid_alias", INVALID));
    };
    let lower = js_unicode::lowercase(&value.trim()).into_owned();
    let Some(alias) = lower.as_str() else {
        return Err(alias_error(400, "invalid_alias", INVALID));
    };
    let bytes = alias.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 40
        || !bytes[0].is_ascii_lowercase()
        || !bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
    {
        return Err(alias_error(400, "invalid_alias", INVALID));
    }
    if reserved(alias) {
        return Err(alias_error(
            409,
            "alias_taken",
            "That nickname is reserved for a built-in voice.",
        ));
    }
    Ok(alias.to_owned())
}

pub fn make_favorite_alias(name: &JsString, used: &[JsString]) -> String {
    let normalized = js_unicode::normalize_nfkd(name);
    let filtered = if normalized
        .code_units()
        .any(|u| (0x0300..=0x036f).contains(&u))
    {
        std::borrow::Cow::Owned(JsString::from_units(
            normalized
                .code_units()
                .filter(|u| !(0x0300..=0x036f).contains(u))
                .collect(),
        ))
    } else {
        std::borrow::Cow::Borrowed(normalized.as_ref())
    };
    let lower = js_unicode::lowercase(filtered.as_ref());
    let mut base = String::new();
    let mut separator = false;
    for u in lower.code_units() {
        if (u >= b'a' as u16 && u <= b'z' as u16) || (u >= b'0' as u16 && u <= b'9' as u16) {
            if separator && !base.is_empty() {
                base.push('_');
            }
            separator = false;
            base.push(u as u8 as char);
        } else {
            separator = true;
        }
    }
    base.truncate(base.len().min(40));
    if base.is_empty() {
        base.push_str("voice");
    }
    let used: HashSet<JsString> = used
        .iter()
        .cloned()
        .chain(FISH_VOICES.iter().map(|(name, _)| JsString::from(*name)))
        .collect();
    let mut alias = base.clone();
    let mut suffix = 2usize;
    while used.contains(&JsString::from(alias.as_str())) {
        alias = format!("{base}_{suffix}");
        suffix += 1;
    }
    alias
}

fn parse_favorites(document: Option<Document>) -> Result<Vec<Favorite>, FavoritesError> {
    let Some(mut document) = document else {
        return Ok(vec![]);
    };
    let values = match document.remove("favorites") {
        None | Some(Bson::Null) => return Ok(vec![]),
        Some(Bson::Array(values)) => values,
        _ => return Err(FavoritesError::BsonBoundary("favorites is not an array")),
    };
    values
        .into_iter()
        .map(|value| {
            let Bson::Document(mut value) = value else {
                return Err(FavoritesError::BsonBoundary("favorite is not a document"));
            };
            let mut field = |key| match value.remove(key) {
                Some(Bson::String(text)) => Ok(JsString::from(text)),
                _ => Err(FavoritesError::BsonBoundary(
                    "favorite fields must be strings",
                )),
            };
            Ok(Favorite {
                id: field("id")?,
                name: field("name")?,
                alias: field("alias")?,
            })
        })
        .collect()
}
/// Database operations are constructed by the same core used by Mongo and by
/// source-policy replay. The adapter owns only driver/middleware details.
#[doc(hidden)]
#[derive(Clone, Debug)]
pub enum FavoritesOperation {
    Find(Document),
    Update {
        filter: Document,
        update: Document,
        options: Option<Document>,
    },
    FindAndUpdate {
        filter: Document,
        update: Document,
        options: Document,
    },
    SettingsUpdate {
        filter: Document,
        update: Document,
    },
}
#[doc(hidden)]
pub trait FavoritesRepository: Sync {
    fn execute(
        &self,
        op: FavoritesOperation,
    ) -> impl std::future::Future<Output = Result<Option<Document>, FavoritesError>> + Send;
}
struct MongoFavorites<'a>(&'a Database);
impl FavoritesRepository for MongoFavorites<'_> {
    async fn execute(&self, op: FavoritesOperation) -> Result<Option<Document>, FavoritesError> {
        let collection = schema().native_collection(self.0);
        match op {
            FavoritesOperation::Find(filter) => Ok(collection.find_one(filter).await?),
            FavoritesOperation::Update {
                filter,
                mut update,
                options,
            } => {
                let upsert = options
                    .as_ref()
                    .and_then(|o| o.get_bool("upsert").ok())
                    .unwrap_or(false);
                // Mongoose adds its version key to an upsert's insertion fields.
                if upsert {
                    update
                        .get_document_mut("$setOnInsert")
                        .expect("insert document")
                        .insert("__v", 0);
                }
                collection.update_one(filter, update).upsert(upsert).await?;
                Ok(None)
            }
            FavoritesOperation::FindAndUpdate {
                filter,
                update,
                options,
            } => {
                let after = options.get_bool("new").unwrap_or(false);
                let return_document = if after {
                    mongodb::options::ReturnDocument::After
                } else {
                    mongodb::options::ReturnDocument::Before
                };
                let filters = options.get_array("arrayFilters").ok().map(|values| {
                    values
                        .iter()
                        .map(|v| v.as_document().expect("array filter document").clone())
                        .collect::<Vec<_>>()
                });
                let mut action = collection
                    .find_one_and_update(filter, update)
                    .return_document(return_document);
                if let Some(filters) = filters {
                    action = action.array_filters(filters);
                }
                Ok(action.await?)
            }
            FavoritesOperation::SettingsUpdate { filter, mut update } => {
                // Source Mongoose timestamp middleware adds updatedAt for this
                // non-upsert update; createdAt's setOnInsert cannot be applied.
                update
                    .get_document_mut("$set")
                    .expect("settings set")
                    .insert("updatedAt", DateTime::now());
                super::channel_tts_settings::schema()
                    .native_collection(self.0)
                    .update_one(filter, update)
                    .await?;
                Ok(None)
            }
        }
    }
}

#[doc(hidden)]
pub async fn get_with<R: FavoritesRepository>(
    repo: &R,
    channel: &JsString,
) -> Result<Vec<Favorite>, FavoritesError> {
    parse_favorites(
        repo.execute(FavoritesOperation::Find(
            doc! {"channelID": channel.to_utf8_lossy()},
        ))
        .await?,
    )
}
#[doc(hidden)]
pub async fn add_with<R: FavoritesRepository>(
    repo: &R,
    channel: &JsString,
    id: &JsString,
    name: &JsString,
) -> Result<Favorite, FavoritesError> {
    let channel_bson = channel.to_utf8_lossy();
    let id_bson = id.to_utf8_lossy();
    repo.execute(FavoritesOperation::Update {
        filter: doc! {"channelID": &channel_bson},
        update: doc! {"$setOnInsert": {"channelID": &channel_bson, "favorites": []}},
        options: Some(doc! {"upsert": true}),
    })
    .await?;
    for _ in 0..=MAX_FISH_VOICE_FAVORITES {
        let favorites = get_with(repo, channel).await?;
        if let Some(existing) = favorites.iter().find(|v| v.id == *id) {
            return Ok(existing.clone());
        }
        if favorites.len() >= MAX_FISH_VOICE_FAVORITES {
            return Err(FavoritesError::Full);
        }
        let alias = make_favorite_alias(
            name,
            &favorites
                .iter()
                .map(|v| v.alias.clone())
                .collect::<Vec<_>>(),
        );
        let favorite = Favorite {
            id: id.clone(),
            name: name.clone(),
            alias: JsString::from(alias.as_str()),
        };
        let updated = repo.execute(FavoritesOperation::FindAndUpdate {
            filter: doc! {"channelID": &channel_bson, "favorites.id": {"$ne": &id_bson}, "favorites.alias": {"$ne": &alias}, "$expr": {"$lt": [{"$size": "$favorites"}, MAX_FISH_VOICE_FAVORITES as i32]}},
            update: doc! {"$push": {"favorites": {"id": &id_bson, "name": name.to_utf8_lossy(), "alias": &alias}}}, options: doc! {"new":true},
        }).await?;
        if updated.is_some() {
            return Ok(favorite);
        }
    }
    Err(FavoritesError::Conflict)
}
#[doc(hidden)]
pub async fn remove_with<R: FavoritesRepository>(
    repo: &R,
    channel: &JsString,
    id: &JsString,
) -> Result<(), FavoritesError> {
    repo.execute(FavoritesOperation::Update {
        filter: doc! {"channelID": channel.to_utf8_lossy()},
        update: doc! {"$pull": {"favorites": {"id": id.to_utf8_lossy()}}},
        options: None,
    })
    .await?;
    Ok(())
}
#[doc(hidden)]
pub async fn rename_with<R: FavoritesRepository>(
    repo: &R,
    channel: &JsString,
    id: &JsString,
    value: &JsonValue,
) -> Result<Favorite, FavoritesError> {
    let alias = normalize_favorite_alias(value)?;
    let favorites = get_with(repo, channel).await?;
    let missing = || {
        alias_error(
            404,
            "favorite_not_found",
            "Favorite voice not found on this account.",
        )
    };
    let existing = favorites.iter().find(|v| v.id == *id).ok_or_else(missing)?;
    if existing.alias == JsString::from(alias.as_str()) {
        return Ok(existing.clone());
    }
    let channel_bson = channel.to_utf8_lossy();
    let id_bson = id.to_utf8_lossy();
    repo.execute(FavoritesOperation::SettingsUpdate { filter: doc! {"channelID": &channel_bson, "voices.cloneDefault": existing.alias.to_utf8_lossy()}, update: doc! {"$set": {"voices.cloneDefault": &id_bson}} }).await?;
    let updated = repo.execute(FavoritesOperation::FindAndUpdate { filter: doc! {"channelID": &channel_bson, "favorites.id": &id_bson, "favorites.alias": {"$ne": &alias}}, update: doc! {"$set": {"favorites.$[target].alias": &alias}}, options: doc! {"arrayFilters": [{"target.id": &id_bson}], "new": true} }).await?;
    if let Some(updated) = updated {
        return parse_favorites(Some(updated))?
            .into_iter()
            .find(|v| v.id == *id)
            .ok_or_else(|| FavoritesError::BsonBoundary("updated favorite missing"));
    }
    let current = get_with(repo, channel).await?;
    let now = current
        .into_iter()
        .find(|v| v.id == *id)
        .ok_or_else(missing)?;
    if now.alias == JsString::from(alias.as_str()) {
        return Ok(now);
    }
    Err(alias_error(
        409,
        "alias_taken",
        "That nickname is already used by another favorite voice.",
    )
    .into())
}
pub async fn get_fish_voice_favorites(
    db: &Database,
    channel: &JsString,
) -> Result<Vec<Favorite>, FavoritesError> {
    get_with(&MongoFavorites(db), channel).await
}
pub async fn add_fish_voice_favorite(
    db: &Database,
    channel: &JsString,
    id: &JsString,
    name: &JsString,
) -> Result<Favorite, FavoritesError> {
    add_with(&MongoFavorites(db), channel, id, name).await
}
pub async fn remove_fish_voice_favorite(
    db: &Database,
    channel: &JsString,
    id: &JsString,
) -> Result<(), FavoritesError> {
    remove_with(&MongoFavorites(db), channel, id).await
}
pub async fn rename_fish_voice_favorite(
    db: &Database,
    channel: &JsString,
    id: &JsString,
    value: &JsonValue,
) -> Result<Favorite, FavoritesError> {
    rename_with(&MongoFavorites(db), channel, id, value).await
}
