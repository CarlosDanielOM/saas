//! `commands`: a channel's chat commands and keyword triggers (the bot reads them on every chat
//! message).
//!
//! Reference: `dimabot/src/schemas/commands.schema.ts` (model `Commands`) plus the availability
//! fields and hooks (`crate::availability`). No timestamps option (a hand-written `createdAt` and
//! the creation day in `date`), `__v`. `blocks`, `availability` and `availabilityLease` are
//! `select: false`. Writes go through this module ([`prepare_update`],
//! [`prepare_find_one_and_update`], [`prepare_save`], [`NewCommand::prepare`]).
//!
//! Domain content stays raw until its package types it: the block tree ([`CommandBlocks`],
//! engine), the tag permission expression ([`PermissionExpression`], permissions), the response
//! table ([`CommandResponses`]) and the per-action permissions ([`CommandPermissions`]).
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.
//! `permissions` (`Mixed`) is read as raw BSON ([`CommandPermissions`]): a client may store any
//! value there.

use crate::availability::{self, AvailabilityLease, AvailabilityState, Writer};
use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::defaults::{empty, yes, zero};
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::loaded::LoadedForSave;
use crate::private::Private;
use crate::shape::ReadNeed;
use crate::timer_commands::{CREATION_DATE, CreationDate};
use crate::validation::Rule;
use crate::values::{Nullable, StringMap};
use crate::writes::{find_and_update_unchecked, save_with_hooks, update_unchecked};
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_core::Random;
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::number::JsNumber;
use dima_store::mongo::save::{Change, PreparedSave};
use dima_store::mongo::schema::{DefaultValue as D, Field, MapOf, Schema, ValueType};
use dima_store::mongo::update::{PreparedFindAndModify, PreparedUpdate, Returned, UpdateOptions};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "commands";

/// The enabled field the availability hook watches.
const ENABLED: &str = "enabled";

str_enum! {
    /// `activation`.
    pub enum Activation {
        /// `!cmd` (the default).
        Command = "command",
        /// A keyword anywhere in a message.
        Keyword = "keyword",
    }
}

str_enum! {
    /// `keywordSettings.matchMode`.
    pub enum MatchMode {
        /// At the start of the message (the default).
        Start = "start",
        /// Anywhere.
        Anywhere = "anywhere",
        /// The whole message.
        Exact = "exact",
    }
}

str_enum! {
    /// `authoring`.
    pub enum Authoring {
        /// Plain text (the default).
        Text = "text",
        /// The paid block editor: `message` is compiled from `blocks`.
        Blocks = "blocks",
    }
}

static KEYWORD_SETTINGS: Schema =
    Schema::subdocument(&[Field::string("matchMode").default(D::Str("start"))]).no_id();

static SCHEMA: Schema = Schema::new(&[
    Field::string("name"),
    Field::string("cmd"),
    Field::string("activation").default(D::Str("command")),
    Field::subdocument("keywordSettings", &KEYWORD_SETTINGS),
    Field::string("func"),
    Field::string("message").default(D::Str("")),
    Field::string("authoring").default(D::Str("text")),
    Field::mixed("blocks").default(D::Null),
    Field::mixed_array("responses").default(D::EmptyArray),
    Field::map("variables", MapOf::Values(ValueType::String)).default(D::EmptyDocument),
    Field::string("type").default(D::Str("command")),
    Field::string("platform").default(D::Str("twitch")),
    Field::boolean("reserved").default(D::Bool(false)),
    Field::string("description").default(D::Str("No description provided.")),
    Field::number("cooldown").default(D::Int(20)),
    Field::number("count").default(D::Int(0)),
    Field::string("userLevelName").default(D::Str("everyone")),
    Field::number("userLevel").default(D::Int(0)),
    Field::mixed("permissionExpression").default(D::Null),
    // `{ type: Object, default: {} }`: Mongoose turns the literal into a function.
    Field::mixed("permissions").default_fn(D::EmptyDocument),
    Field::boolean("enabled").default(D::Bool(true)),
    Field::boolean("paused").default(D::Bool(false)),
    Field::string("channel"),
    Field::string("channelID"),
    Field::boolean("premiumRequired").default(D::Bool(false)),
    Field::number("premiumLevelRequired").default(D::Int(0)),
    Field::date("createdAt").default_fn(D::Now),
    Field::nested("date", CREATION_DATE),
    availability::STATE_FIELD,
    availability::LEASE_FIELD,
]);

/// The `select: false` paths.
pub const HIDDEN: &[&str] = &["blocks", "availability", "availabilityLease"];

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[IndexSpec::on(&[("availability.nextAt", 1)]).sparse()];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::one_of("activation", Activation::STRINGS),
    Rule::one_of("keywordSettings.matchMode", MatchMode::STRINGS),
    Rule::one_of("authoring", Authoring::STRINGS),
    Rule::required("channelID"),
];

/// The private paths: their read type fields are [`crate::Private`].
pub const PRIVATE: &[&str] = &["blocks", "availability", "availabilityLease"];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::not_null("activation"),
    ReadNeed::not_null("keywordSettings.matchMode"),
    ReadNeed::not_null("message"),
    ReadNeed::not_null("authoring"),
    ReadNeed::not_null("responses"),
    ReadNeed::not_null("type"),
    ReadNeed::not_null("platform"),
    ReadNeed::not_null("reserved"),
    ReadNeed::not_null("cooldown"),
    ReadNeed::not_null("count"),
    ReadNeed::not_null("userLevelName"),
    ReadNeed::not_null("userLevel"),
    ReadNeed::not_null("enabled"),
    ReadNeed::not_null("paused"),
    ReadNeed::value("channelID"),
    ReadNeed::not_null("premiumRequired"),
    ReadNeed::not_null("premiumLevelRequired"),
];

/// The registry entry. Every write goes through this module (the availability hook).
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "Commands",
    source: "dimabot/src/schemas/commands.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: HIDDEN,
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::UpdatesAndSave,
    private: PRIVATE,
    decode: decode_boxed::<Command>,
};

/// A stored command, defaults filled in as a hydrated Mongoose document shows them. The hidden
/// paths are `None` unless the read selected them.
#[derive(Clone, Debug, Deserialize)]
pub struct Command {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// Display name.
    #[serde(default)]
    pub name: Option<String>,
    /// The trigger (`!hola`, or the keyword).
    #[serde(default)]
    pub cmd: Option<String>,
    /// How it is triggered.
    #[serde(default = "command")]
    pub activation: Open<Activation>,
    /// Keyword matching (keyword commands only).
    #[serde(default, rename = "keywordSettings")]
    pub keyword_settings: Option<KeywordSettings>,
    /// The built-in function it runs (`custom` for plain replies).
    #[serde(default)]
    pub func: Option<String>,
    /// The reply text (compiled from `blocks` for block commands).
    #[serde(default = "empty")]
    pub message: String,
    /// How the reply was written.
    #[serde(default = "text")]
    pub authoring: Open<Authoring>,
    /// The block tree (`select: false`: `None` when not selected, and when stored as `null`, the
    /// default).
    #[serde(default)]
    pub blocks: Option<Private<CommandBlocks>>,
    /// Response table of built-in functions (roulette outcomes, size ranges...).
    #[serde(default)]
    pub responses: CommandResponses,
    /// Command variables.
    #[serde(default)]
    pub variables: StringMap,
    /// `command` or `countable`.
    #[serde(default = "command_type", rename = "type")]
    pub kind: String,
    /// Platform.
    #[serde(default = "twitch")]
    pub platform: String,
    /// A built-in command the user may not delete.
    #[serde(default)]
    pub reserved: bool,
    /// Description (`null` in some old documents).
    #[serde(default = "no_description")]
    pub description: Option<String>,
    /// Cooldown in seconds.
    #[serde(default = "twenty")]
    pub cooldown: JsNumber,
    /// Uses so far.
    #[serde(default = "zero")]
    pub count: JsNumber,
    /// Legacy level name.
    #[serde(default = "everyone", rename = "userLevelName")]
    pub user_level_name: String,
    /// Legacy numeric level.
    #[serde(default = "zero", rename = "userLevel")]
    pub user_level: JsNumber,
    /// Tag-mode permission expression (`None`: numeric level mode).
    #[serde(default, rename = "permissionExpression")]
    pub permission_expression: Option<PermissionExpression>,
    /// Per-action permission levels of built-in commands (missing on most documents).
    #[serde(default)]
    pub permissions: CommandPermissions,
    /// Enabled.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Paused.
    #[serde(default)]
    pub paused: bool,
    /// The channel login.
    #[serde(default)]
    pub channel: Option<String>,
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// Needs a paid plan.
    #[serde(default, rename = "premiumRequired")]
    pub premium_required: bool,
    /// The plan level needed.
    #[serde(default = "zero", rename = "premiumLevelRequired")]
    pub premium_level_required: JsNumber,
    /// Creation time (`default: Date.now`, not applied on read).
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// The creation day.
    #[serde(default)]
    pub date: CreationDate,
    /// Scheduled availability (`select: false`).
    #[serde(default)]
    pub availability: Option<Private<AvailabilityState>>,
    /// Availability synchronisation lease (`select: false`).
    #[serde(default, rename = "availabilityLease")]
    pub availability_lease: Option<Private<AvailabilityLease>>,
}

fn command() -> Open<Activation> {
    Open::Known(Activation::Command)
}

fn text() -> Open<Authoring> {
    Open::Known(Authoring::Text)
}

fn command_type() -> String {
    "command".to_owned()
}

fn twitch() -> String {
    "twitch".to_owned()
}

fn no_description() -> Option<String> {
    Some("No description provided.".to_owned())
}

fn twenty() -> JsNumber {
    JsNumber(20.0)
}

fn everyone() -> String {
    "everyone".to_owned()
}

/// `keywordSettings`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct KeywordSettings {
    /// Where the keyword must appear.
    #[serde(default = "start", rename = "matchMode")]
    pub match_mode: Open<MatchMode>,
}

fn start() -> Open<MatchMode> {
    Open::Known(MatchMode::Start)
}

/// The stored block tree (`{v, root}`), kept as stored until the engine package types it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CommandBlocks(pub Bson);

/// A tag-mode permission expression, kept as stored until the permissions package types it (a
/// present but invalid value must fail closed there).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct PermissionExpression(pub Bson);

/// The response table (objects whose shape depends on the function), kept as stored.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CommandResponses(pub Vec<Bson>);

/// Per-action permission levels (`{play: 7, skip: 7}`), kept as stored. The path is `Mixed`
/// (`type: Object`), so any value may be stored there; missing reads as the default `{}`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CommandPermissions(pub Bson);

impl Default for CommandPermissions {
    fn default() -> Self {
        Self(Bson::Document(Document::new()))
    }
}

/// A new command (`new CommandsSchema({...})` in `command_mutations.service.ts`). Unset fields
/// take the schema defaults.
#[derive(Clone, Debug, Serialize)]
pub struct NewCommand {
    /// The channel id.
    #[serde(rename = "channelID")]
    pub channel_id: String,
    /// The channel login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The trigger.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
    /// How it is triggered (default `command`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation: Option<Activation>,
    /// Keyword matching (`{matchMode}`).
    #[serde(rename = "keywordSettings", skip_serializing_if = "Option::is_none")]
    pub keyword_match_mode: Option<NewKeywordSettings>,
    /// The function it runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub func: Option<String>,
    /// The reply text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// How the reply was written (default `text`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoring: Option<Authoring>,
    /// The block tree (the reference passes `null` for text commands; `select: false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Private<Bson>>,
    /// Response table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responses: Option<Vec<Bson>>,
    /// `command` or `countable` (default `command`).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Built-in (default `false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved: Option<bool>,
    /// Description (the restore path passes a stored `null` through: 49 commands have it).
    #[serde(skip_serializing_if = "Nullable::is_unset")]
    pub description: Nullable<String>,
    /// Cooldown in seconds (default 20).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown: Option<JsNumber>,
    /// Enabled (default `true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Legacy level name.
    #[serde(rename = "userLevelName", skip_serializing_if = "Option::is_none")]
    pub user_level_name: Option<String>,
    /// Legacy numeric level.
    #[serde(rename = "userLevel", skip_serializing_if = "Option::is_none")]
    pub user_level: Option<JsNumber>,
    /// Tag-mode permission expression (the reference passes `null` in level mode).
    #[serde(
        rename = "permissionExpression",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_expression: Option<Bson>,
}

/// `keywordSettings` of a new command.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct NewKeywordSettings {
    /// Where the keyword must appear.
    #[serde(rename = "matchMode")]
    pub match_mode: MatchMode,
}

impl NewCommand {
    /// A command of `channel_id` with every other field defaulted.
    pub fn new(channel_id: impl Into<String>) -> Self {
        Self {
            channel_id: channel_id.into(),
            channel: None,
            name: None,
            cmd: None,
            activation: None,
            keyword_match_mode: None,
            func: None,
            message: None,
            authoring: None,
            blocks: None,
            responses: None,
            kind: None,
            reserved: None,
            description: Nullable::Unset,
            cooldown: None,
            enabled: None,
            user_level_name: None,
            user_level: None,
            permission_expression: None,
        }
    }

    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends (the save hook does not run for new documents).
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}

/// `Model.updateOne` / `updateMany` with the availability hook (unless `writer` is internal).
pub fn prepare_update(
    filter: &Document,
    mut update: Document,
    options: UpdateOptions,
    writer: Writer,
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedUpdate, ModelError> {
    if writer == Writer::Client {
        availability::guard_update(&mut update, ENABLED, ctx.now_ms(), random)?;
    }
    update_unchecked(&INFO, filter, update.into(), options, ctx)
}

/// `Model.findOneAndUpdate` with the availability hook (unless `writer` is internal).
pub fn prepare_find_one_and_update(
    filter: &Document,
    mut update: Document,
    options: UpdateOptions,
    returned: Returned,
    writer: Writer,
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedFindAndModify, ModelError> {
    if writer == Writer::Client {
        availability::guard_update(&mut update, ENABLED, ctx.now_ms(), random)?;
    }
    find_and_update_unchecked(&INFO, filter, update.into(), options, returned, ctx)
}

/// `doc.save()` of a loaded command (read without projection) after `changes`, with the save hook.
pub fn prepare_save(
    loaded: &LoadedForSave,
    changes: &[Change],
    ctx: &mut WriteContext,
    random: &dyn Random,
) -> Result<PreparedSave, ModelError> {
    save_with_hooks(
        &INFO,
        loaded,
        changes,
        |loaded, changes, ctx| {
            Ok(availability::guard_save(
                loaded,
                changes,
                ENABLED,
                ctx.now_ms(),
                random,
            )?)
        },
        ctx,
    )
}
