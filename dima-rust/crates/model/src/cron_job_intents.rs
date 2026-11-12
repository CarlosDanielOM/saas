//! `cron_job_intents`: the durable record of every cron job accepted for a queue (acceptance,
//! dedupe, lease, outcome), the source of truth behind the Dragonfly job queues.
//!
//! Reference: `dimabot/src/schemas/cron_job_intent.schema.ts` (model `cron_job_intent`), written
//! only by `utils/durable_cron_jobs.ts`. Camel-case timestamps, no `__v`, no hooks; `jobID` and
//! `queueKey` are immutable. Unique `jobID`, sparse unique `automaticKey` and `activeKey`, and two
//! queue scans. The reference awaits `model.init()` before every acceptance and claim
//! (`durable_cron_jobs.ts:93,146`) and treats a duplicate key (11000) as "already accepted", so
//! the unique indexes are required before the first write ([`crate::startup_policy`]). The
//! sparse indexes depend on missing staying missing: `automaticKey` is left out when there is
//! none and `activeKey` is removed with `$unset`, never set to `null`. No TTL: accepted
//! automatic jobs and ambiguous outcomes are kept as evidence.
//!
//! `payload` (`Mixed`, the queue job) stays raw ([`CronJobPayload`]) until the cron package types
//! it. `token` is the lease fence (a UUID), not a credential.
//!
//! Intended difference (`crate::shape`): the write helpers refuse a value of the wrong BSON type,
//! and `null` or a removal where [`READ_NEEDS`] says the read type has none; the census of the
//! production copy shows none stored there, so Mongoose's acceptance of them is not reproduced.

use crate::collection::{CollectionInfo, Hooks};
use crate::decode::decode_boxed;
use crate::enums::{Open, StrEnum, str_enum};
use crate::error::ModelError;
use crate::index::IndexSpec;
use crate::shape::ReadNeed;
use crate::validation::Rule;
use bson::oid::ObjectId;
use bson::{Bson, Document};
use dima_store::mongo::WriteContext;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::id::IdType;
use dima_store::mongo::insert::PreparedInsert;
use dima_store::mongo::schema::{Field, Schema, Timestamps};
use mongodb::options::{Acknowledgment, WriteConcern};
use serde::{Deserialize, Serialize};

/// The collection name.
pub const COLLECTION: &str = "cron_job_intents";

str_enum! {
    /// `status`.
    pub enum IntentStatus {
        /// Accepted, waiting to be published and claimed.
        Queued = "queued",
        /// Claimed under a lease.
        Processing = "processing",
        /// Done.
        Completed = "completed",
        /// Failed for good.
        Dead = "dead",
        /// The lease expired mid-work: never replayed automatically.
        Uncertain = "uncertain",
        /// Accepted by the legacy transport before this record existed.
        LegacyAccepted = "legacy_accepted",
    }
}

/// The schema, field by field as `cron_job_intent.schema.ts` declares it.
pub static SCHEMA: Schema = Schema::new(&[
    Field::string("jobID").immutable(),
    Field::string("queueKey").immutable(),
    Field::mixed("payload"),
    Field::string("status"),
    Field::string("automaticKey"),
    Field::string("activeKey"),
    Field::date("dedupeUntil"),
    Field::date("dueAt"),
    Field::date("nextPublishAt"),
    Field::string("owner"),
    Field::string("token"),
    Field::date("leaseUntil"),
    Field::string("reason"),
])
.timestamps(Timestamps::CAMEL)
.no_version_key();

/// The declared indexes.
pub const INDEXES: &[IndexSpec] = &[
    IndexSpec::on(&[("jobID", 1)]).unique(),
    IndexSpec::on(&[("automaticKey", 1)]).unique().sparse(),
    IndexSpec::on(&[("activeKey", 1)]).unique().sparse(),
    IndexSpec::on(&[
        ("queueKey", 1),
        ("status", 1),
        ("nextPublishAt", 1),
        ("_id", 1),
    ]),
    IndexSpec::on(&[
        ("queueKey", 1),
        ("status", 1),
        ("leaseUntil", 1),
        ("_id", 1),
    ]),
];

/// The validators, in schema path order.
pub const RULES: &[Rule] = &[
    Rule::required("jobID"),
    Rule::required("queueKey"),
    Rule::required("payload"),
    Rule::required("status"),
    Rule::one_of("status", IntentStatus::STRINGS),
    Rule::required("dedupeUntil"),
    Rule::required("dueAt"),
    Rule::required("nextPublishAt"),
];

/// What the read type cannot decode (`crate::shape`): the write helpers refuse it.
pub const READ_NEEDS: &[ReadNeed] = &[
    ReadNeed::value("jobID"),
    ReadNeed::value("queueKey"),
    ReadNeed::present("payload"),
    ReadNeed::value("status"),
    ReadNeed::value("dedupeUntil"),
    ReadNeed::value("dueAt"),
    ReadNeed::value("nextPublishAt"),
];

/// The registry entry.
pub static INFO: CollectionInfo = CollectionInfo {
    name: COLLECTION,
    model: "cron_job_intent",
    source: "dimabot/src/schemas/cron_job_intent.schema.ts",
    schema: &SCHEMA,
    id_type: IdType::ObjectId,
    hidden: &[],
    indexes: INDEXES,
    rules: RULES,
    read_needs: READ_NEEDS,
    hooks: Hooks::None,
    initialised_at_startup: true,
    private: &[],
    decode: decode_boxed::<CronJobIntent>,
};

/// A stored intent.
#[derive(Clone, Debug, Deserialize)]
pub struct CronJobIntent {
    /// `_id`.
    #[serde(rename = "_id")]
    pub id: ObjectId,
    /// The job's id (unique).
    #[serde(rename = "jobID")]
    pub job_id: String,
    /// The Dragonfly queue.
    #[serde(rename = "queueKey")]
    pub queue_key: String,
    /// The canonical job, as stored.
    pub payload: CronJobPayload,
    /// Where it is.
    pub status: Open<IntentStatus>,
    /// The permanent acceptance key of an automatic job (missing for the others).
    #[serde(default, rename = "automaticKey")]
    pub automatic_key: Option<String>,
    /// The dedupe key while it holds one (removed when an expired terminal dedupe is reused).
    #[serde(default, rename = "activeKey")]
    pub active_key: Option<String>,
    /// End of the dedupe window.
    #[serde(rename = "dedupeUntil")]
    pub dedupe_until: JsDate,
    /// When it may run.
    #[serde(rename = "dueAt")]
    pub due_at: JsDate,
    /// When the recovery loop publishes it again.
    #[serde(rename = "nextPublishAt")]
    pub next_publish_at: JsDate,
    /// The claiming process (while processing).
    #[serde(default)]
    pub owner: Option<String>,
    /// The lease fence (while processing).
    #[serde(default)]
    pub token: Option<String>,
    /// Lease expiry (while processing).
    #[serde(default, rename = "leaseUntil")]
    pub lease_until: Option<JsDate>,
    /// Why it ended as it did.
    #[serde(default)]
    pub reason: Option<String>,
    /// Creation time.
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<JsDate>,
    /// Last update time.
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<JsDate>,
}

/// A queue job (`CronQueueJob`), kept as stored until the cron package types it.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct CronJobPayload(pub Bson);

/// `{w: 1, j: true}`: the write concern of every intent write (`WRITE` in
/// `durable_cron_jobs.ts`).
pub fn intent_write_concern() -> WriteConcern {
    WriteConcern::builder()
        .w(Acknowledgment::Nodes(1))
        .journal(true)
        .build()
}

/// A newly accepted job (`model.create([...], {w: 1, j: true})` in `durable_cron_jobs.ts:114`).
#[derive(Clone, Debug, Serialize)]
pub struct NewCronJobIntent {
    /// The job's id.
    #[serde(rename = "jobID")]
    pub job_id: String,
    /// The queue.
    #[serde(rename = "queueKey")]
    pub queue_key: String,
    /// The job.
    pub payload: Document,
    /// `queued`, or `legacy_accepted` for an automatic job the legacy transport accepted.
    pub status: IntentStatus,
    /// The automatic acceptance key (left out when there is none).
    #[serde(rename = "automaticKey", skip_serializing_if = "Option::is_none")]
    pub automatic_key: Option<String>,
    /// The dedupe key.
    #[serde(rename = "activeKey")]
    pub active_key: String,
    /// End of the dedupe window.
    #[serde(rename = "dedupeUntil")]
    pub dedupe_until: JsDate,
    /// When it may run.
    #[serde(rename = "dueAt")]
    pub due_at: JsDate,
    /// When to publish it (the same instant as `dueAt` on acceptance).
    #[serde(rename = "nextPublishAt")]
    pub next_publish_at: JsDate,
}

impl NewCronJobIntent {
    /// The values given to the constructor (before defaults).
    pub fn to_document(&self) -> Result<Document, ModelError> {
        Ok(bson::serialize_to_document(self)?)
    }

    /// The insert Mongoose sends; run it with [`intent_write_concern`]. A duplicate key means
    /// the job was already accepted.
    pub fn prepare(&self, ctx: &mut WriteContext) -> Result<PreparedInsert, ModelError> {
        INFO.prepare_create(&self.to_document()?, ctx)
    }
}
