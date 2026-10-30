//! Shared write path for the command and redemption-reward availability plugin.
//!
//! Tracked saves apply availability hooks to changes since loading; queries
//! prepare their hook output and schema casts before writing with the driver.
//! Inserts do not install availability.
use super::{
    FieldType, FlatInsertError, PersistenceError, SchemaDefinition, SchemaIndex, SchemaRepository,
};
use crate::utils::availability::{
    AvailabilityClock, AvailabilityWriteError, DriverUpdate, QueryUpdate, WriteOrigin,
    driver_update,
};
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
    options::ReturnDocument,
    results::UpdateResult,
};
use std::ops::Deref;

pub fn availability_fields() -> Vec<super::Field> {
    use super::{Field, FieldType as T};
    vec![
        Field::new(
            "availability",
            T::Subdocument {
                fields: vec![
                    Field::new("token", T::String),
                    Field::new("previousEnabled", T::Boolean),
                    Field::new("restoreAt", T::Date),
                    Field::new("pending", T::Boolean),
                    Field::new("nextAt", T::Date),
                ],
                generate_id: false,
            },
        )
        .hidden(),
        Field::new(
            "availabilityLease",
            T::Subdocument {
                fields: vec![Field::new("token", T::String), Field::new("until", T::Date)],
                generate_id: false,
            },
        )
        .hidden(),
    ]
}

pub fn availability_index() -> SchemaIndex {
    SchemaIndex::new(doc! {"availability.nextAt": 1}).sparse()
}

#[derive(Clone, Debug)]
pub struct UpdateOutcome {
    pub wrote: bool,
    pub result: Option<UpdateResult>,
}

/// A document and the exact snapshot from which its modifications are measured.
#[derive(Clone, Debug)]
pub struct TrackedDocument {
    pub document: Document,
    original: Document,
    appends: Document,
}

impl TrackedDocument {
    fn loaded(document: Document) -> Self {
        Self {
            original: document.clone(),
            document,
            appends: Document::new(),
        }
    }

    /// Record a deliberate array append. Direct edits to `document` use a
    /// version-fenced replacement, even when the new array has the old prefix.
    pub fn append_array(&mut self, field: &str, value: Bson) -> Result<(), AvailabilityWriteError> {
        let values = self.document.get_array_mut(field).map_err(|_| {
            AvailabilityWriteError::UnsupportedUpdate("append requires a loaded array")
        })?;
        values.push(value.clone());
        match self
            .appends
            .entry(field.to_owned())
            .or_insert_with(|| Bson::Array(Vec::new()))
        {
            Bson::Array(values) => values.push(value),
            _ => unreachable!(),
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct CommandRewardRepository {
    schema: &'static SchemaDefinition,
    collection: Collection<Document>,
    enabled_field: &'static str,
    clock: AvailabilityClock,
}

impl CommandRewardRepository {
    pub(crate) fn new(
        schema: &'static SchemaDefinition,
        enabled_field: &'static str,
        database: &Database,
        clock: AvailabilityClock,
    ) -> Self {
        Self {
            collection: schema.native_collection(database),
            schema,
            enabled_field,
            clock,
        }
    }

    pub fn schema(&self) -> &'static SchemaDefinition {
        self.schema
    }

    pub fn collection(&self) -> &Collection<Document> {
        &self.collection
    }

    pub fn clock(&self) -> &AvailabilityClock {
        &self.clock
    }

    pub fn enabled_field(&self) -> &'static str {
        self.enabled_field
    }

    pub async fn install_indexes(&self, database: &Database) -> mongodb::error::Result<()> {
        self.schema.install_indexes(database).await
    }

    pub async fn insert(
        &self,
        input: Document,
        now: DateTime,
    ) -> Result<Document, AvailabilityWriteError> {
        Ok(self.repository().insert(input, now).await?)
    }

    pub async fn update_one(
        &self,
        filter: Document,
        update: QueryUpdate,
    ) -> Result<UpdateOutcome, AvailabilityWriteError> {
        self.update_one_origin(filter, update, WriteOrigin::Ordinary)
            .await
    }

    pub async fn update_one_internal(
        &self,
        filter: Document,
        update: QueryUpdate,
    ) -> Result<UpdateOutcome, AvailabilityWriteError> {
        self.update_one_origin(filter, update, WriteOrigin::Internal)
            .await
    }

    pub async fn update_many(
        &self,
        filter: Document,
        update: QueryUpdate,
    ) -> Result<UpdateOutcome, AvailabilityWriteError> {
        self.write_many(filter, update, WriteOrigin::Ordinary).await
    }

    pub async fn update_many_internal(
        &self,
        filter: Document,
        update: QueryUpdate,
    ) -> Result<UpdateOutcome, AvailabilityWriteError> {
        self.write_many(filter, update, WriteOrigin::Internal).await
    }

    pub async fn find_one_and_update(
        &self,
        filter: Document,
        update: QueryUpdate,
    ) -> Result<Option<Document>, AvailabilityWriteError> {
        self.find_and_update(filter, update, WriteOrigin::Ordinary, false)
            .await
    }

    pub async fn find_one_and_update_internal(
        &self,
        filter: Document,
        update: QueryUpdate,
    ) -> Result<Option<Document>, AvailabilityWriteError> {
        self.find_and_update(filter, update, WriteOrigin::Internal, true)
            .await
    }

    pub async fn find_one(
        &self,
        filter: Document,
    ) -> Result<Option<Document>, AvailabilityWriteError> {
        Ok(self
            .collection
            .find_one(self.cast_filter(filter)?)
            .projection(self.schema.default_projection())
            .await?)
    }

    pub async fn find_one_with_hidden(
        &self,
        filter: Document,
    ) -> Result<Option<Document>, AvailabilityWriteError> {
        Ok(self.collection.find_one(self.cast_filter(filter)?).await?)
    }

    /// Load only the requested hidden top-level fields, retaining normal exclusions.
    pub async fn load(
        &self,
        filter: Document,
        hidden: &[&str],
    ) -> Result<Option<TrackedDocument>, AvailabilityWriteError> {
        let projection = self.projection(hidden)?;
        Ok(self
            .collection
            .find_one(self.cast_filter(filter)?)
            .projection(projection)
            .await?
            .map(TrackedDocument::loaded))
    }

    fn projection(&self, hidden: &[&str]) -> Result<Document, AvailabilityWriteError> {
        let mut projection = self.schema.default_projection();
        for name in hidden {
            if !self
                .schema
                .fields
                .iter()
                .any(|field| field.hidden && field.name == *name)
            {
                return Err(AvailabilityWriteError::UnsupportedUpdate(
                    "unknown hidden field",
                ));
            }
            projection.remove(*name);
        }
        Ok(projection)
    }

    /// Persist only changes from the loaded snapshot, preserving concurrent
    /// updates to fields the caller did not modify.
    pub async fn save(
        &self,
        tracked: &mut TrackedDocument,
        now: DateTime,
    ) -> Result<Document, AvailabilityWriteError> {
        let id = tracked
            .original
            .get("_id")
            .cloned()
            .ok_or(PersistenceError::MissingId)?;
        let output = self
            .schema
            .prepare_save_against(&tracked.document, &tracked.original, now)?;
        let mut set = Document::new();
        let mut unset = Document::new();
        let mut push = Document::new();
        let mut array_change = false;
        let mut array_replacement = false;
        for field in &self.schema.fields {
            if field.immutable {
                continue;
            }
            let before = tracked.original.get(field.name);
            let after = output.get(field.name);
            // Absent projection fields are not modifications unless explicitly assigned.
            if !tracked.document.contains_key(field.name) && before.is_none() {
                continue;
            }
            let intended = if tracked.document.contains_key(field.name) {
                after
            } else {
                None
            };
            if before == intended {
                continue;
            }
            if matches!(field.kind, FieldType::Array(_) | FieldType::ArrayElement(_)) {
                array_change = true;
                if let (Some(Bson::Array(before)), Some(Bson::Array(after)), Ok(appended)) =
                    (before, intended, tracked.appends.get_array(field.name))
                    && after.len() == before.len() + appended.len()
                    && after.starts_with(before)
                    && &after[before.len()..] == appended.as_slice()
                {
                    push.insert(field.name, doc! {"$each": appended.clone()});
                    continue;
                }
                array_replacement = true;
            }
            match intended {
                Some(value) => {
                    set.insert(field.name, value.clone());
                }
                None => {
                    unset.insert(field.name, 1);
                }
            }
        }
        let mut local_availability = None;
        if set.contains_key(self.enabled_field) || unset.contains_key(self.enabled_field) {
            let enabled = set.get(self.enabled_field).unwrap_or(&Bson::Null);
            let state = self
                .clock
                .state(crate::utils::availability::js_boolean(enabled), None)
                .to_document();
            set.insert("availability", state.clone());
            local_availability = Some(state);
        }
        let mut update = Document::new();
        if !set.is_empty() {
            update.insert("$set", set);
        }
        if !unset.is_empty() {
            update.insert("$unset", unset);
        }
        if !push.is_empty() {
            update.insert("$push", push);
        }
        let mut filter = doc! {"_id": id};
        if array_change {
            if array_replacement && let Some(version) = tracked.original.get("__v") {
                filter.insert("__v", version.clone());
            }
            update.insert("$inc", doc! {"__v": 1});
        }
        if !update.is_empty() {
            let result = self.collection.update_one(filter, update).await?;
            if result.matched_count == 0 {
                return Err(PersistenceError::NotFound.into());
            }
        }
        let mut local = output;
        for field in &self.schema.fields {
            if !tracked.document.contains_key(field.name) {
                local.remove(field.name);
            }
        }
        if let Some(state) = local_availability {
            local.insert("availability", state);
        }
        if array_change {
            let version = tracked.original.get_i32("__v").unwrap_or(0) + 1;
            local.insert("__v", version);
        }
        tracked.document = local.clone();
        tracked.original = local.clone();
        tracked.appends.clear();
        Ok(local)
    }

    /// Find-and-update with explicit select-false fields, as used by command edits.
    pub async fn find_one_and_update_select(
        &self,
        filter: Document,
        update: QueryUpdate,
        hidden: &[&str],
    ) -> Result<Option<Document>, AvailabilityWriteError> {
        let projection = self.projection(hidden)?;
        let filter = self.cast_filter(filter)?;
        match self.prepare(update, WriteOrigin::Ordinary)? {
            DriverUpdate::Skipped => Ok(self
                .collection
                .find_one(filter)
                .projection(projection)
                .await?),
            DriverUpdate::Document(update) => Ok(self
                .collection
                .find_one_and_update(filter, update)
                .return_document(ReturnDocument::After)
                .projection(projection)
                .await?),
            DriverUpdate::Pipeline(update) => Ok(self
                .collection
                .find_one_and_update(filter, update)
                .return_document(ReturnDocument::After)
                .projection(projection)
                .await?),
        }
    }

    /// Equality upsert for reward creation, including schema defaults and version.
    pub async fn upsert_with_defaults(
        &self,
        filter: Document,
        update: QueryUpdate,
        now: DateTime,
    ) -> Result<Document, AvailabilityWriteError> {
        let DriverUpdate::Document(mut update) = self.prepare(update, WriteOrigin::Ordinary)?
        else {
            return Err(AvailabilityWriteError::UnsupportedUpdate(
                "upsert requires a document update",
            ));
        };
        let set = match update.remove("$set") {
            Some(Bson::Document(value)) => value,
            _ => Document::new(),
        };
        let insert = match update.remove("$setOnInsert") {
            Some(Bson::Document(value)) => value,
            _ => Document::new(),
        };
        if !update.is_empty() {
            return Err(AvailabilityWriteError::UnsupportedUpdate(
                "upsert supports set and setOnInsert",
            ));
        }
        let (filter, update) = self
            .schema
            .prepare_equality_upsert(&filter, &insert, &set, now)
            .map_err(|error| match error {
                FlatInsertError::Cast(error) => AvailabilityWriteError::from(error),
                FlatInsertError::Unsupported(message) => {
                    AvailabilityWriteError::UnsupportedUpdate(message)
                }
            })?;
        self.collection
            .find_one_and_update(filter, update)
            .upsert(true)
            .return_document(ReturnDocument::After)
            .projection(self.schema.default_projection())
            .await?
            .ok_or(PersistenceError::NotFound.into())
    }

    fn repository(&self) -> SchemaRepository {
        SchemaRepository {
            schema: self.schema,
            collection: self.collection.clone(),
        }
    }

    async fn update_one_origin(
        &self,
        filter: Document,
        update: QueryUpdate,
        origin: WriteOrigin,
    ) -> Result<UpdateOutcome, AvailabilityWriteError> {
        let filter = self.cast_filter(filter)?;
        match self.prepare(update, origin)? {
            DriverUpdate::Skipped => Ok(UpdateOutcome {
                wrote: false,
                result: None,
            }),
            DriverUpdate::Document(update) => Ok(UpdateOutcome {
                wrote: true,
                result: Some(self.collection.update_one(filter, update).await?),
            }),
            DriverUpdate::Pipeline(update) => Ok(UpdateOutcome {
                wrote: true,
                result: Some(self.collection.update_one(filter, update).await?),
            }),
        }
    }

    async fn write_many(
        &self,
        filter: Document,
        update: QueryUpdate,
        origin: WriteOrigin,
    ) -> Result<UpdateOutcome, AvailabilityWriteError> {
        let filter = self.cast_filter(filter)?;
        match self.prepare(update, origin)? {
            DriverUpdate::Skipped => Ok(UpdateOutcome {
                wrote: false,
                result: None,
            }),
            DriverUpdate::Document(update) => Ok(UpdateOutcome {
                wrote: true,
                result: Some(self.collection.update_many(filter, update).await?),
            }),
            DriverUpdate::Pipeline(update) => Ok(UpdateOutcome {
                wrote: true,
                result: Some(self.collection.update_many(filter, update).await?),
            }),
        }
    }

    async fn find_and_update(
        &self,
        filter: Document,
        update: QueryUpdate,
        origin: WriteOrigin,
        include_hidden: bool,
    ) -> Result<Option<Document>, AvailabilityWriteError> {
        let filter = self.cast_filter(filter)?;
        let projection = if include_hidden {
            None
        } else {
            Some(self.schema.default_projection())
        };
        let found = match self.prepare(update, origin)? {
            DriverUpdate::Skipped => {
                let mut action = self.collection.find_one(filter);
                if let Some(projection) = projection {
                    action = action.projection(projection);
                }
                action.await?
            }
            DriverUpdate::Document(update) => {
                let mut action = self
                    .collection
                    .find_one_and_update(filter, update)
                    .return_document(ReturnDocument::After);
                if let Some(projection) = projection {
                    action = action.projection(projection);
                }
                action.await?
            }
            DriverUpdate::Pipeline(update) => {
                let mut action = self
                    .collection
                    .find_one_and_update(filter, update)
                    .return_document(ReturnDocument::After);
                if let Some(projection) = projection {
                    action = action.projection(projection);
                }
                action.await?
            }
        };
        Ok(found)
    }

    fn prepare(
        &self,
        update: QueryUpdate,
        origin: WriteOrigin,
    ) -> Result<DriverUpdate, AvailabilityWriteError> {
        let update = driver_update(update, self.enabled_field, origin, &self.clock)?;
        let DriverUpdate::Document(update) = update else {
            return Ok(update);
        };
        let mut result = Document::new();
        for (operator, values) in update {
            if !matches!(
                operator.as_str(),
                "$set" | "$setOnInsert" | "$unset" | "$inc" | "$min" | "$max" | "$mul"
            ) {
                return Err(AvailabilityWriteError::UnsupportedUpdate(
                    "unsupported update operator",
                ));
            }
            let Bson::Document(values) = values else {
                return Err(AvailabilityWriteError::UnsupportedUpdate(
                    "update operator must contain a document",
                ));
            };
            let mut casted = Document::new();
            for (path, value) in values {
                let candidate = if operator == "$unset" {
                    Bson::Null
                } else {
                    value.clone()
                };
                if let Some(cast) =
                    self.schema
                        .cast_update_path(&path, candidate, self.clock.now())?
                {
                    casted.insert(path, if operator == "$unset" { value } else { cast });
                }
            }
            if !casted.is_empty() {
                result.insert(operator, casted);
            }
        }
        if result.is_empty() {
            Ok(DriverUpdate::Skipped)
        } else {
            Ok(DriverUpdate::Document(result))
        }
    }

    fn cast_filter(&self, filter: Document) -> Result<Document, AvailabilityWriteError> {
        let mut output = Document::new();
        for (path, value) in filter {
            if matches!(path.as_str(), "$or" | "$and" | "$nor") {
                let Bson::Array(clauses) = value else {
                    return Err(AvailabilityWriteError::UnsupportedUpdate(
                        "logical filter must be an array",
                    ));
                };
                let mut result = Vec::new();
                for clause in clauses {
                    let Bson::Document(clause) = clause else {
                        return Err(AvailabilityWriteError::UnsupportedUpdate(
                            "logical filter clause must be a document",
                        ));
                    };
                    result.push(Bson::Document(self.cast_filter(clause)?));
                }
                output.insert(path, result);
            } else if let Bson::Document(operators) = &value {
                if operators.keys().any(|key| key.starts_with('$')) {
                    let mut result = Document::new();
                    for (op, operand) in operators {
                        let cast = match op.as_str() {
                            "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte" => self
                                .schema
                                .cast_update_path(&path, operand.clone(), self.clock.now())?
                                .unwrap_or_else(|| operand.clone()),
                            "$in" | "$nin" => {
                                if let Bson::Array(items) = operand {
                                    let mut casted = Vec::new();
                                    for item in items {
                                        casted.push(
                                            self.schema
                                                .cast_update_path(
                                                    &path,
                                                    item.clone(),
                                                    self.clock.now(),
                                                )?
                                                .unwrap_or_else(|| item.clone()),
                                        );
                                    }
                                    Bson::Array(casted)
                                } else {
                                    operand.clone()
                                }
                            }
                            _ => operand.clone(),
                        };
                        result.insert(op, cast);
                    }
                    output.insert(path, result);
                } else {
                    let cast = self
                        .schema
                        .cast_update_path(&path, value.clone(), self.clock.now())?
                        .unwrap_or(value);
                    output.insert(path, cast);
                }
            } else {
                let cast = self
                    .schema
                    .cast_update_path(&path, value.clone(), self.clock.now())?
                    .unwrap_or(value);
                output.insert(path, cast);
            }
        }
        Ok(output)
    }
}

macro_rules! typed_repository {
    ($name:ident, $field:literal) => {
        #[derive(Clone)]
        pub struct $name(CommandRewardRepository);

        impl $name {
            pub const ENABLED_FIELD: &'static str = $field;

            pub(crate) fn new(
                schema: &'static SchemaDefinition,
                database: &Database,
                clock: AvailabilityClock,
            ) -> Self {
                Self(CommandRewardRepository::new(
                    schema,
                    Self::ENABLED_FIELD,
                    database,
                    clock,
                ))
            }
        }

        impl Deref for $name {
            type Target = CommandRewardRepository;

            fn deref(&self) -> &Self::Target {
                &self.0
            }
        }
    };
}

typed_repository!(CommandsRepository, "enabled");
typed_repository!(RedemptionRewardRepository, "isEnabled");
