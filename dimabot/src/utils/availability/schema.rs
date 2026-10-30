//! Availability plugin for command and redemption-reward documents.
//!
//! This is the native counterpart of `src/utils/availability/schema.ts`.
//! Query hooks and document-save hooks are different on purpose:
//! an ordinary update installs a new state whenever the enabled field is
//! present, including a same-value write. A save of an existing document
//! installs a state only when that field's value actually changes. A new
//! insert does not. `WriteOrigin::Internal` is a call flag, not a document
//! property, so a payload key cannot opt out of the ordinary hook.
//!
//! `driver_update` performs the hook and `$set` sugar. The concrete
//! repository separately casts known query paths and strips unknown fields.
use mongodb::bson::{Bson, DateTime, Document};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub const FIXED_STATE_KEYS: [&str; 5] =
    ["token", "previousEnabled", "restoreAt", "pending", "nextAt"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteOrigin {
    Ordinary,
    Internal,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AvailabilityState {
    pub token: String,
    pub previous_enabled: bool,
    pub restore_at: Option<DateTime>,
    pub pending: bool,
    pub next_at: DateTime,
}

impl AvailabilityState {
    pub fn to_document(&self) -> Document {
        let mut document = Document::new();
        document.insert("token", self.token.as_str());
        document.insert("previousEnabled", self.previous_enabled);
        document.insert(
            "restoreAt",
            self.restore_at.map(Bson::DateTime).unwrap_or(Bson::Null),
        );
        document.insert("pending", self.pending);
        document.insert("nextAt", self.next_at);
        document
    }
}

/// Live calls use UUID v4 and `DateTime::now`. A fixed queue is only for tests.
#[derive(Clone, Debug)]
pub struct AvailabilityClock {
    now: Option<DateTime>,
    tokens: Arc<Mutex<VecDeque<String>>>,
}

impl AvailabilityClock {
    pub fn live() -> Self {
        Self {
            now: None,
            tokens: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn fixed(now: DateTime, tokens: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            now: Some(now),
            tokens: Arc::new(Mutex::new(tokens.into_iter().map(Into::into).collect())),
        }
    }

    pub fn now(&self) -> DateTime {
        self.now.unwrap_or_else(DateTime::now)
    }

    pub fn next_token(&self) -> String {
        let mut tokens = self.tokens.lock().expect("availability token queue lock");
        tokens
            .pop_front()
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    }

    pub fn state(&self, previous_enabled: bool, restore_at: Option<DateTime>) -> AvailabilityState {
        AvailabilityState {
            token: self.next_token(),
            previous_enabled,
            restore_at,
            pending: true,
            next_at: self.now(),
        }
    }
}

/// `availabilityState` with a real UUID v4 and the current time.
/// `restore_at: None` stores JSON null, matching the source default argument.
pub fn availability_state(
    previous_enabled: bool,
    restore_at: Option<DateTime>,
) -> AvailabilityState {
    AvailabilityClock::live().state(previous_enabled, restore_at)
}

#[derive(Clone, Debug, PartialEq)]
pub enum QueryUpdate {
    Absent,
    Pipeline(Vec<Bson>),
    Document(Document),
}

impl QueryUpdate {
    pub fn from_bson(value: Option<Bson>) -> Result<Self, AvailabilityWriteError> {
        match value {
            None | Some(Bson::Null) => Ok(Self::Absent),
            Some(Bson::Array(values)) => Ok(Self::Pipeline(values)),
            Some(Bson::Document(document)) => Ok(Self::Document(document)),
            Some(_) => Err(AvailabilityWriteError::UnsupportedUpdate(
                "query update must be absent, null, a document, or a pipeline array",
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DriverUpdate {
    Skipped,
    Document(Document),
    Pipeline(Vec<Document>),
}

#[derive(Debug)]
pub enum AvailabilityWriteError {
    Persistence(crate::schemas::PersistenceError),
    UnsupportedUpdate(&'static str),
}

impl std::fmt::Display for AvailabilityWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Persistence(error) => error.fmt(formatter),
            Self::UnsupportedUpdate(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for AvailabilityWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Persistence(error) => Some(error),
            Self::UnsupportedUpdate(_) => None,
        }
    }
}

impl From<crate::schemas::PersistenceError> for AvailabilityWriteError {
    fn from(error: crate::schemas::PersistenceError) -> Self {
        Self::Persistence(error)
    }
}

impl From<crate::schemas::ValidationErrors> for AvailabilityWriteError {
    fn from(error: crate::schemas::ValidationErrors) -> Self {
        Self::Persistence(error.into())
    }
}

impl From<mongodb::error::Error> for AvailabilityWriteError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Persistence(error.into())
    }
}

/// JavaScript `Boolean(value)` for the BSON values the hook receives.
/// `Decimal128` and other non-numeric BSON values are truthy; there is no
/// numeric Decimal128 parse.
pub fn js_boolean(value: &Bson) -> bool {
    match value {
        Bson::Null | Bson::Undefined => false,
        Bson::Boolean(value) => *value,
        Bson::String(value) => !value.is_empty(),
        Bson::Int32(value) => *value != 0,
        Bson::Int64(value) => *value != 0,
        Bson::Double(value) => *value != 0.0 && !value.is_nan(),
        _ => true,
    }
}

pub fn availability_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("availability") else {
        return false;
    };
    if rest.is_empty() || rest.starts_with('.') {
        return true;
    }
    match rest.strip_prefix("Lease") {
        Some(rest) => rest.is_empty() || rest.starts_with('.'),
        None => false,
    }
}

/// Exact `pre('updateOne' | 'findOneAndUpdate' | 'updateMany')` mutation.
/// Pipelines and absent updates are returned unchanged. Internal origin
/// returns the document unchanged. This does not apply `$set` sugar.
pub fn prepare_availability_update(
    update: QueryUpdate,
    enabled_field: &str,
    origin: WriteOrigin,
    clock: &AvailabilityClock,
) -> Result<QueryUpdate, AvailabilityWriteError> {
    let QueryUpdate::Document(mut document) = update else {
        return Ok(update);
    };
    if origin == WriteOrigin::Internal {
        return Ok(QueryUpdate::Document(document));
    }
    strip_availability(&mut document)?;
    // Resolve the flag before borrowing `document` again to install `$set`.
    let enabled = supplied_enabled(&document, enabled_field)?.map(js_boolean);
    if let Some(enabled) = enabled {
        let state = clock.state(enabled, None).to_document();
        match document.get_mut("$set") {
            Some(Bson::Document(set)) => {
                set.insert("availability", state);
            }
            Some(_) => {
                return Err(AvailabilityWriteError::UnsupportedUpdate(
                    "$set must be a document before availability can be installed",
                ));
            }
            None => {
                let mut set = Document::new();
                set.insert("availability", state);
                document.insert("$set", set);
            }
        }
    }
    Ok(QueryUpdate::Document(document))
}

/// Hook output followed by Mongoose's non-operator `$set` merge.
/// An empty document or empty pipeline becomes [`DriverUpdate::Skipped`],
/// matching the query thunk's empty-update acknowledgement.
pub fn driver_update(
    update: QueryUpdate,
    enabled_field: &str,
    origin: WriteOrigin,
    clock: &AvailabilityClock,
) -> Result<DriverUpdate, AvailabilityWriteError> {
    match prepare_availability_update(update, enabled_field, origin, clock)? {
        QueryUpdate::Absent => Ok(DriverUpdate::Skipped),
        QueryUpdate::Pipeline(stages) if stages.is_empty() => Ok(DriverUpdate::Skipped),
        QueryUpdate::Pipeline(stages) => {
            let mut documents = Vec::with_capacity(stages.len());
            for stage in stages {
                match stage {
                    Bson::Document(document) => documents.push(document),
                    _ => {
                        return Err(AvailabilityWriteError::UnsupportedUpdate(
                            "update pipeline stages must be documents",
                        ));
                    }
                }
            }
            Ok(DriverUpdate::Pipeline(documents))
        }
        QueryUpdate::Document(document) => {
            let normalized = normalize_update_operators(document)?;
            if normalized.is_empty() {
                Ok(DriverUpdate::Skipped)
            } else {
                Ok(DriverUpdate::Document(normalized))
            }
        }
    }
}

/// Move non-operator keys into `$set`, preserving operator containers.
pub fn normalize_update_operators(update: Document) -> Result<Document, AvailabilityWriteError> {
    let mut operators = Document::new();
    let mut extra = Document::new();
    let mut existing_set = None;
    for (key, value) in update {
        if is_update_operator(&key) {
            if key == "$set" {
                existing_set = Some(value);
            } else {
                operators.insert(key, value);
            }
        } else {
            extra.insert(key, value);
        }
    }
    let mut set = match existing_set {
        Some(Bson::Document(document)) => document,
        Some(_) => {
            return Err(AvailabilityWriteError::UnsupportedUpdate(
                "$set must be a document",
            ));
        }
        None => Document::new(),
    };
    for (key, value) in extra {
        set.insert(key, value);
    }
    if !set.is_empty() {
        operators.insert("$set", set);
    }
    Ok(operators)
}

/// Existing-document save hook. `assigned` is the cast value that would be
/// stored. Missing stored values are a change when the caller assigned one.
/// New documents never replace availability.
pub fn enabled_save_replaces(is_new: bool, stored: Option<&Bson>, assigned: Option<&Bson>) -> bool {
    if is_new {
        return false;
    }
    let Some(assigned) = assigned else {
        return false;
    };
    match stored {
        None => true,
        Some(stored) => !same_enabled(stored, assigned),
    }
}

fn same_enabled(stored: &Bson, assigned: &Bson) -> bool {
    if stored == assigned {
        return true;
    }
    match (cast_boolean(stored), cast_boolean(assigned)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Private schema boolean cast. Null is retained. Failure means "not the same".
fn cast_boolean(value: &Bson) -> Option<Bson> {
    if matches!(value, Bson::Null) {
        return Some(Bson::Null);
    }
    match value {
        Bson::Boolean(value) => Some(Bson::Boolean(*value)),
        Bson::String(text) => match text.as_str() {
            "true" | "1" | "yes" => Some(Bson::Boolean(true)),
            "false" | "0" | "no" => Some(Bson::Boolean(false)),
            _ => None,
        },
        Bson::Int32(1) | Bson::Int64(1) => Some(Bson::Boolean(true)),
        Bson::Int32(0) | Bson::Int64(0) => Some(Bson::Boolean(false)),
        Bson::Double(value) if *value == 1.0 => Some(Bson::Boolean(true)),
        Bson::Double(value) if *value == 0.0 => Some(Bson::Boolean(false)),
        _ => None,
    }
}

fn is_update_operator(key: &str) -> bool {
    matches!(
        key,
        "$currentDate"
            | "$inc"
            | "$min"
            | "$max"
            | "$mul"
            | "$rename"
            | "$set"
            | "$setOnInsert"
            | "$unset"
            | "$addToSet"
            | "$pop"
            | "$pull"
            | "$push"
            | "$pullAll"
            | "$bit"
    )
}

fn strip_availability(update: &mut Document) -> Result<(), AvailabilityWriteError> {
    strip_container(update)?;
    for key in ["$set", "$unset", "$setOnInsert"] {
        match update.get_mut(key) {
            None => {}
            Some(Bson::Document(container)) => strip_container(container)?,
            Some(Bson::Null) => {}
            Some(_) => {
                return Err(AvailabilityWriteError::UnsupportedUpdate(
                    "availability strip containers must be documents",
                ));
            }
        }
    }
    Ok(())
}

fn strip_container(container: &mut Document) -> Result<(), AvailabilityWriteError> {
    let keys = container
        .keys()
        .filter(|key| availability_key(key))
        .cloned()
        .collect::<Vec<_>>();
    for key in keys {
        container.remove(&key);
    }
    Ok(())
}

fn supplied_enabled<'a>(
    update: &'a Document,
    enabled_field: &str,
) -> Result<Option<&'a Bson>, AvailabilityWriteError> {
    let from_set = match update.get("$set") {
        None | Some(Bson::Null) => None,
        Some(Bson::Document(set)) => match set.get(enabled_field) {
            None | Some(Bson::Undefined) | Some(Bson::Null) => None,
            Some(value) => Some(value),
        },
        Some(_) => {
            return Err(AvailabilityWriteError::UnsupportedUpdate(
                "$set must be a document when reading the enabled field",
            ));
        }
    };
    if let Some(value) = from_set {
        return Ok(Some(value));
    }
    Ok(match update.get(enabled_field) {
        None | Some(Bson::Undefined) => None,
        Some(value) => Some(value),
    })
}
