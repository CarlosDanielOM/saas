//! MongoDB `astvariables` store.
//!
//! Ports `loadScopedVariable` / `saveScopedVariable` from
//! `dimabot/src/handlers/special_parser.handler.ts`. The collection and the
//! write concern come from [`crate::schemas::ast_variables::schema`]; this
//! module does not edit that schema and does not install indexes.
//!
//! # Read and write filters are not the same
//!
//! A save uses `userId` when it is non-empty and otherwise `userLogin`. A load
//! uses `userLogin` when the normalized login is non-empty and otherwise
//! `userId`. Channel save therefore filters on `userLogin: ""` and channel load
//! filters on `userId: ""`. `$setOnInsert` writes both empty strings, so a
//! document created by one side is found by the other.
//!
//! A user save addressed at someone else stores `userId = "login:{login}"`.
//! A user delete addressed at someone else stores `userId = ""` and filters on
//! the login. A user load addressed at someone else also filters on the login.
//!
//! # Failures
//!
//! The TypeScript helpers log and swallow store errors: a failed read is `""`
//! and a failed write does not abort the caller. [`MongoAstVariableStore`]
//! does the same (`eprintln` of the channel, scope, identity, variable name,
//! and error — never the variable value). [`super::AstVariableStore`] is still
//! a `Result`, so an in-memory fake can fail closed and the host surfaces that
//! as [`super::AstRuntimeError`].
//!
//! # Writes
//!
//! Deletion is a tombstone: the same upsert with value `""`. An empty global
//! value is present, so a later read must not fall through to a legacy
//! document. `SchemaRepository::upsert_equality` rejects dotted paths, so the
//! update is `find_one_and_update` with `variables.<name>` on the native
//! collection. The driver does not run mongoose middleware; `updatedAt`,
//! `createdAt`, and `__v` are written here because the legacy sort is
//! `updatedAt: -1, _id: -1`.

use mongodb::{
    Collection,
    bson::{Bson, DateTime, Document, doc},
    error::{ErrorKind, WriteFailure},
};

use super::{
    AST_VARIABLE_SCOPE_NAME, AST_VARIABLE_SCOPE_TYPE, AstRuntimeError, AstScope, AstVariableStore,
    BoxFuture, normalize_user_login,
};

/// Identity passed to [`plan_variable_read`] / [`plan_variable_upsert`].
///
/// `skipped` is the source's early return: a user operation with no `userId`
/// and no target login does not touch MongoDB. A load then yields `""`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopedIdentity {
    pub user_id: String,
    pub user_login: String,
    pub skipped: bool,
}

/// Exact-document filter, plus the legacy filter when the scope is global.
#[derive(Clone, Debug, PartialEq)]
pub struct VariableReadPlan {
    pub filter: Document,
    pub legacy_filter: Option<Document>,
}

/// Upsert filter and update. `login_fallback_filter` is the one retry used
/// when MongoDB returns duplicate-key code 11000 and both `userId` and
/// `userLogin` were set. The retry uses the same `update`.
#[derive(Clone, Debug, PartialEq)]
pub struct VariableWritePlan {
    pub filter: Document,
    pub update: Document,
    pub login_fallback_filter: Option<Document>,
}

/// User load identity. The login is the raw scope login unless a target was
/// selected; [`plan_variable_read`] normalizes it.
pub fn resolve_user_load(scope: &AstScope, target_user_login: Option<&str>) -> ScopedIdentity {
    let normalized_target = normalize_user_login(target_user_login.unwrap_or(""));
    if scope.user_id.is_empty() && normalized_target.is_empty() {
        return skipped_identity();
    }
    if normalized_target.is_empty() {
        ScopedIdentity {
            user_id: scope.user_id.clone(),
            user_login: scope.user_login.clone(),
            skipped: false,
        }
    } else {
        ScopedIdentity {
            user_id: String::new(),
            user_login: normalized_target,
            skipped: false,
        }
    }
}

/// User save identity. Another login is stored under `login:{normalized}`.
pub fn resolve_user_save(scope: &AstScope, target_user_login: Option<&str>) -> ScopedIdentity {
    let normalized_target = normalize_user_login(target_user_login.unwrap_or(""));
    if scope.user_id.is_empty() && normalized_target.is_empty() {
        return skipped_identity();
    }
    let own_login = normalize_user_login(&scope.user_login);
    let other_user = !normalized_target.is_empty() && normalized_target != own_login;
    let user_id = if other_user {
        format!("login:{normalized_target}")
    } else {
        scope.user_id.clone()
    };
    let user_login = if normalized_target.is_empty() {
        scope.user_login.clone()
    } else {
        normalized_target
    };
    ScopedIdentity {
        user_id,
        user_login,
        skipped: false,
    }
}

/// User delete identity. A target clears `userId` so the write matches the
/// login index, not the `login:` prefix used by save.
pub fn resolve_user_delete(scope: &AstScope, target_user_login: Option<&str>) -> ScopedIdentity {
    let normalized_target = normalize_user_login(target_user_login.unwrap_or(""));
    if scope.user_id.is_empty() && normalized_target.is_empty() {
        return skipped_identity();
    }
    if normalized_target.is_empty() {
        ScopedIdentity {
            user_id: scope.user_id.clone(),
            user_login: scope.user_login.clone(),
            skipped: false,
        }
    } else {
        ScopedIdentity {
            user_id: String::new(),
            user_login: normalized_target,
            skipped: false,
        }
    }
}

/// Build the find filter. A non-empty normalized login wins over `user_id`.
/// Global scope also gets the legacy fallback filter.
pub fn plan_variable_read(
    channel_id: &str,
    scope_type: &str,
    scope_name: &str,
    name: &str,
    user_id: &str,
    user_login: &str,
) -> VariableReadPlan {
    let mut filter = doc! {
        "channelID": channel_id,
        "scopeType": scope_type,
        "scopeName": scope_name,
    };
    let normalized = normalize_user_login(user_login);
    if !normalized.is_empty() {
        filter.insert("userLogin", normalized);
    } else {
        filter.insert("userId", user_id);
    }
    let legacy_filter = (scope_type == AST_VARIABLE_SCOPE_TYPE
        && scope_name == AST_VARIABLE_SCOPE_NAME)
        .then(|| {
            let mut legacy = filter.clone();
            legacy.insert("scopeType", doc! { "$ne": AST_VARIABLE_SCOPE_TYPE });
            legacy.insert("scopeName", doc! { "$exists": true });
            legacy.insert(format!("variables.{name}"), doc! { "$exists": true });
            legacy
        });
    VariableReadPlan {
        filter,
        legacy_filter,
    }
}

/// Build the upsert. `now` is the `updatedAt` / `createdAt` the caller chose;
/// this function does not read the clock.
///
/// The dotted key is intentional and unescaped, matching
/// `` `variables.${variableName}` ``.
pub fn plan_variable_upsert(
    channel_id: &str,
    scope_type: &str,
    scope_name: &str,
    name: &str,
    value: &str,
    user_id: &str,
    user_login: &str,
    now: DateTime,
) -> VariableWritePlan {
    let normalized = normalize_user_login(user_login);
    let mut filter = doc! {
        "channelID": channel_id,
        "scopeType": scope_type,
        "scopeName": scope_name,
    };
    if !user_id.is_empty() {
        filter.insert("userId", user_id);
    } else {
        filter.insert("userLogin", normalized.as_str());
    }
    let mut set = Document::new();
    set.insert(format!("variables.{name}"), value);
    set.insert("updatedAt", now);
    let mut on_insert = doc! {
        "channelID": channel_id,
        "scopeType": scope_type,
        "scopeName": scope_name,
        "userId": user_id,
        "userLogin": normalized.as_str(),
        "__v": 0_i32,
    };
    on_insert.insert("createdAt", now);
    let mut update = Document::new();
    update.insert("$set", set);
    update.insert("$setOnInsert", on_insert);
    let login_fallback_filter = (!user_id.is_empty() && !normalized.is_empty()).then(|| {
        doc! {
            "channelID": channel_id,
            "scopeType": scope_type,
            "scopeName": scope_name,
            "userLogin": normalized.as_str(),
        }
    });
    VariableWritePlan {
        filter,
        update,
        login_fallback_filter,
    }
}

fn skipped_identity() -> ScopedIdentity {
    ScopedIdentity {
        user_id: String::new(),
        user_login: String::new(),
        skipped: true,
    }
}

/// Present value, including a tombstone `""`. `None` means the key is absent
/// and a global read may fall through. A non-string BSON value is kept via
/// `Display` so a present key is not treated as missing.
pub fn stored_variable(document: &Document, name: &str) -> Option<String> {
    let variables = document.get_document("variables").ok()?;
    match variables.get(name) {
        None => None,
        Some(Bson::String(value)) => Some(value.clone()),
        Some(Bson::Null) => Some(String::new()),
        Some(other) => Some(other.to_string()),
    }
}

/// MongoDB `astvariables` collection. `new` and `with_database` do not connect.
#[derive(Clone, Debug, Default)]
pub struct MongoAstVariableStore {
    database_name: Option<String>,
}

impl MongoAstVariableStore {
    pub fn new() -> Self {
        Self {
            database_name: None,
        }
    }

    /// Use this database instead of the URI's default database.
    pub fn with_database(mut self, name: impl Into<String>) -> Self {
        self.database_name = Some(name.into());
        self
    }

    async fn collection(&self) -> Result<Collection<Document>, String> {
        let client = crate::utils::mongo::get_mongo_client()
            .await
            .map_err(|error| error.to_string())?;
        let database = match &self.database_name {
            Some(name) => client.database(name),
            None => client.default_database().ok_or_else(|| {
                "MongoDB URI has no default database; call MongoAstVariableStore::with_database"
                    .to_owned()
            })?,
        };
        Ok(crate::schemas::ast_variables::schema().native_collection(&database))
    }

    async fn load_scoped(
        &self,
        channel_id: &str,
        scope_type: &str,
        scope_name: &str,
        name: &str,
        user_id: &str,
        user_login: &str,
    ) -> String {
        let plan = plan_variable_read(channel_id, scope_type, scope_name, name, user_id, user_login);
        let collection = match self.collection().await {
            Ok(collection) => collection,
            Err(error) => {
                log_load(channel_id, scope_type, scope_name, user_id, user_login, name, &error);
                return String::new();
            }
        };
        let document = match collection
            .find_one(plan.filter)
            .projection(doc! { "variables": 1 })
            .await
        {
            Ok(document) => document,
            Err(error) => {
                log_load(
                    channel_id,
                    scope_type,
                    scope_name,
                    user_id,
                    user_login,
                    name,
                    &error.to_string(),
                );
                return String::new();
            }
        };
        if let Some(document) = document {
            if let Some(value) = stored_variable(&document, name) {
                return value;
            }
        }
        let Some(legacy_filter) = plan.legacy_filter else {
            return String::new();
        };
        match collection
            .find_one(legacy_filter)
            .sort(doc! { "updatedAt": -1, "_id": -1 })
            .projection(doc! { "variables": 1 })
            .await
        {
            Ok(Some(document)) => stored_variable(&document, name).unwrap_or_default(),
            Ok(None) => String::new(),
            Err(error) => {
                log_load(
                    channel_id,
                    scope_type,
                    scope_name,
                    user_id,
                    user_login,
                    name,
                    &error.to_string(),
                );
                String::new()
            }
        }
    }

    async fn save_scoped(
        &self,
        channel_id: &str,
        scope_type: &str,
        scope_name: &str,
        name: &str,
        value: &str,
        user_id: &str,
        user_login: &str,
    ) {
        let plan = plan_variable_upsert(
            channel_id,
            scope_type,
            scope_name,
            name,
            value,
            user_id,
            user_login,
            DateTime::now(),
        );
        let collection = match self.collection().await {
            Ok(collection) => collection,
            Err(error) => {
                log_save(
                    channel_id,
                    scope_type,
                    scope_name,
                    user_id,
                    user_login,
                    name,
                    &error,
                    false,
                );
                return;
            }
        };
        match collection
            .find_one_and_update(plan.filter, plan.update.clone())
            .upsert(true)
            .await
        {
            Ok(_) => {}
            Err(error) if duplicate_key(&error) => {
                let Some(fallback) = plan.login_fallback_filter else {
                    log_save(
                        channel_id,
                        scope_type,
                        scope_name,
                        user_id,
                        user_login,
                        name,
                        &error.to_string(),
                        false,
                    );
                    return;
                };
                if let Err(error) = collection
                    .find_one_and_update(fallback, plan.update)
                    .upsert(true)
                    .await
                {
                    log_save(
                        channel_id,
                        scope_type,
                        scope_name,
                        user_id,
                        user_login,
                        name,
                        &error.to_string(),
                        true,
                    );
                }
            }
            Err(error) => {
                log_save(
                    channel_id,
                    scope_type,
                    scope_name,
                    user_id,
                    user_login,
                    name,
                    &error.to_string(),
                    false,
                );
            }
        }
    }
}

impl AstVariableStore for MongoAstVariableStore {
    fn load_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>> {
        Box::pin(async move {
            Ok(self
                .load_scoped(
                    &scope.channel_id,
                    AST_VARIABLE_SCOPE_TYPE,
                    AST_VARIABLE_SCOPE_NAME,
                    name,
                    "",
                    "",
                )
                .await)
        })
    }

    fn save_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        value: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            self.save_scoped(
                &scope.channel_id,
                AST_VARIABLE_SCOPE_TYPE,
                AST_VARIABLE_SCOPE_NAME,
                name,
                value,
                "",
                "",
            )
            .await;
            Ok(())
        })
    }

    fn delete_channel_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            self.save_scoped(
                &scope.channel_id,
                AST_VARIABLE_SCOPE_TYPE,
                AST_VARIABLE_SCOPE_NAME,
                name,
                "",
                "",
                "",
            )
            .await;
            Ok(())
        })
    }

    fn load_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<String, AstRuntimeError>> {
        Box::pin(async move {
            let identity = resolve_user_load(scope, target_user_login);
            if identity.skipped {
                eprintln!(
                    "AST user-scoped variable read skipped: missing userId channelID={} scopeType={AST_VARIABLE_SCOPE_TYPE} scopeName={AST_VARIABLE_SCOPE_NAME} variableName={name}",
                    scope.channel_id,
                );
                return Ok(String::new());
            }
            Ok(self
                .load_scoped(
                    &scope.channel_id,
                    AST_VARIABLE_SCOPE_TYPE,
                    AST_VARIABLE_SCOPE_NAME,
                    name,
                    &identity.user_id,
                    &identity.user_login,
                )
                .await)
        })
    }

    fn save_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        value: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            let identity = resolve_user_save(scope, target_user_login);
            if identity.skipped {
                return Ok(());
            }
            self.save_scoped(
                &scope.channel_id,
                AST_VARIABLE_SCOPE_TYPE,
                AST_VARIABLE_SCOPE_NAME,
                name,
                value,
                &identity.user_id,
                &identity.user_login,
            )
            .await;
            Ok(())
        })
    }

    fn delete_user_variable<'a>(
        &'a self,
        scope: &'a AstScope,
        name: &'a str,
        target_user_login: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), AstRuntimeError>> {
        Box::pin(async move {
            let identity = resolve_user_delete(scope, target_user_login);
            if identity.skipped {
                return Ok(());
            }
            self.save_scoped(
                &scope.channel_id,
                AST_VARIABLE_SCOPE_TYPE,
                AST_VARIABLE_SCOPE_NAME,
                name,
                "",
                &identity.user_id,
                &identity.user_login,
            )
            .await;
            Ok(())
        })
    }
}

fn duplicate_key(error: &mongodb::error::Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write)) if write.code == 11000 => true,
        ErrorKind::Command(command) if command.code == 11000 => true,
        ErrorKind::BulkWrite(bulk) => {
            !bulk.write_errors.is_empty()
                && bulk.write_concern_errors.is_empty()
                && bulk.write_errors.values().all(|write| write.code == 11000)
        }
        _ => false,
    }
}

fn log_load(
    channel_id: &str,
    scope_type: &str,
    scope_name: &str,
    user_id: &str,
    user_login: &str,
    name: &str,
    error: &str,
) {
    eprintln!(
        "Error loading AST scoped variable: channelID={channel_id} scopeType={scope_type} scopeName={scope_name} userId={user_id} userLogin={user_login} variableName={name} error={error}"
    );
}

fn log_save(
    channel_id: &str,
    scope_type: &str,
    scope_name: &str,
    user_id: &str,
    user_login: &str,
    name: &str,
    error: &str,
    fallback: bool,
) {
    let label = if fallback {
        "Error saving AST scoped variable (fallback)"
    } else {
        "Error saving AST scoped variable"
    };
    eprintln!(
        "{label}: channelID={channel_id} scopeType={scope_type} scopeName={scope_name} userId={user_id} userLogin={user_login} variableName={name} error={error}"
    );
}
