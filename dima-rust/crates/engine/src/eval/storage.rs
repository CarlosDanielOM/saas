//! Variable storage (`getValueFromStorage`, `saveValueToStorage`, `deleteValueFromStorage` and
//! friends): plain variables in the run, `#`/`##` in the cache, `*`/`**` in the database through
//! the host, with the run's read memo for database variables.
//!
//! Key shapes are the reference's (Dragonfly key names are contract for carried data):
//! `{platform}:{channel}:variable:{name}` and, per viewer, `…:id:{userId}` / `…:login:{login}`.

use super::EvalError;
use super::coerce::resolve_array_index;
use super::run::{Kept, Run, host_call};
use crate::host::HostFuture;
use crate::syntax::{ArrayAccessor, AstNode, VariableStorage};
use crate::value::Value;
use dima_text::{to_lower, trim};

/// Cache variables live a day (`EXPIRE key 86400`).
const CACHE_TTL_SECONDS: u64 = 86_400;

/// `stripVarPrefix`.
fn strip(name: &str, storage: VariableStorage) -> &str {
    match storage {
        VariableStorage::DbUser => name.strip_prefix("**").unwrap_or(name),
        VariableStorage::Db if !name.starts_with("**") => name.strip_prefix('*').unwrap_or(name),
        VariableStorage::CacheUser => name.strip_prefix("##").unwrap_or(name),
        VariableStorage::Cache if !name.starts_with("##") => name.strip_prefix('#').unwrap_or(name),
        _ => name,
    }
}

/// `normalizeUserLogin`: trimmed, leading `@`s removed, lowercase.
fn normalize_login(login: &str) -> String {
    to_lower(trim(login).trim_start_matches('@'))
}

/// `JSON.parse` of a stored value as a list (`getArrayFromStorage`): a JSON list's items, any
/// other JSON value as one item of its text, nothing for invalid JSON. An object `String()`
/// cannot convert is nothing too: the reference converts it inside its `try`.
fn parse_list(raw: &str) -> Vec<Value> {
    match Value::parse_json(raw) {
        Some(Value::List(items)) => items,
        Some(other) => match other.into_text() {
            Ok(text) => vec![Value::Text(text)],
            Err(_) => Vec::new(),
        },
        None => Vec::new(),
    }
}

impl Run<'_> {
    fn cache_base(&self, name: &str) -> String {
        format!(
            "{}:{}:variable:{name}",
            self.context.platform, self.context.broadcaster_id
        )
    }

    /// `walkCacheKeys`' keys: one for `#`, the viewer's candidates for `##`.
    fn cache_keys(
        &self,
        name: &str,
        storage: VariableStorage,
        target: Option<&str>,
    ) -> Vec<String> {
        let base = self.cache_base(strip(name, storage));
        if storage != VariableStorage::CacheUser {
            return vec![base];
        }
        self.user_scopes(target)
            .into_iter()
            .map(|scope| format!("{base}:{scope}"))
            .collect()
    }

    /// `getCacheUserScopeCandidates`.
    fn user_scopes(&self, target: Option<&str>) -> Vec<String> {
        let current = normalize_login(&self.context.user_login);
        let requested = normalize_login(target.unwrap_or_default());
        if !requested.is_empty() && requested != current {
            return vec![format!("login:{requested}")];
        }
        let mut scopes = Vec::new();
        if !self.context.user_id.is_empty() {
            scopes.push(format!("id:{}", self.context.user_id));
        }
        if !current.is_empty() {
            let login = format!("login:{current}");
            if !scopes.contains(&login) {
                scopes.push(login);
            }
        }
        if scopes.is_empty() {
            scopes.push("id:unknown".into());
        }
        scopes
    }

    /// `getUserVariableCacheKey`: the memo key of a viewer variable.
    fn user_memo_key(&self, name: &str, target: Option<&str>) -> String {
        let login = match target.filter(|t| !t.is_empty()) {
            Some(target) => normalize_login(target),
            None => normalize_login(&self.context.user_login),
        };
        if login.is_empty() {
            let id = if self.context.user_id.is_empty() {
                "unknown"
            } else {
                self.context.user_id.as_str()
            };
            format!("id:{id}:{name}")
        } else {
            format!("login:{login}:{name}")
        }
    }

    /// `getValueFromStorage`.
    pub(super) async fn read_value(
        &mut self,
        name: &str,
        storage: VariableStorage,
        target: Option<&str>,
    ) -> Result<String, EvalError> {
        let stripped = strip(name, storage);
        match storage {
            VariableStorage::Memory => {
                if let Some(value) = self.state.variables.get(stripped) {
                    return Ok(value.clone());
                }
                if let Some(items) = self.state.arrays.get(stripped) {
                    let items: Vec<Value> = items
                        .iter()
                        .map(|item| Value::text(item.as_str()))
                        .collect();
                    return Ok(Value::list_to_json(&items));
                }
                Ok(String::new())
            }
            VariableStorage::Cache | VariableStorage::CacheUser => {
                for key in self.cache_keys(name, storage, target) {
                    if let Some(found) = host_call!(self, self.host.cache_get(&key))? {
                        return Ok(found);
                    }
                }
                Ok(String::new())
            }
            VariableStorage::Db => {
                if let Some(value) = self.state.command_variables.get(stripped) {
                    return Ok(value.clone());
                }
                let loaded = host_call!(self, self.host.load_channel_variable(stripped))?;
                if loaded.is_empty() {
                    return Ok(String::new());
                }
                self.put(Kept::ChannelMemo, stripped.to_owned(), loaded.clone())?;
                Ok(loaded)
            }
            VariableStorage::DbUser => {
                let memo = self.user_memo_key(stripped, target);
                if let Some(value) = self.state.user_command_variables.get(&memo) {
                    return Ok(value.clone());
                }
                let loaded = host_call!(self, self.host.load_user_variable(stripped, target))?;
                if loaded.is_empty() {
                    return Ok(String::new());
                }
                self.put(Kept::UserMemo, memo, loaded.clone())?;
                Ok(loaded)
            }
        }
    }

    /// `getArrayFromStorage` (the `responses` list is handled by the callers).
    pub(super) async fn read_list(
        &mut self,
        name: &str,
        storage: VariableStorage,
        target: Option<&str>,
    ) -> Result<Vec<Value>, EvalError> {
        if name == "responses" && storage == VariableStorage::Memory {
            return Ok(self
                .state
                .command_responses
                .iter()
                .map(|r| Value::text(r.as_str()))
                .collect());
        }
        let raw = self.read_value(name, storage, target).await?;
        if raw.is_empty() {
            return Ok(Vec::new());
        }
        self.charge_bytes(raw.len())?;
        Ok(parse_list(&raw))
    }

    /// `checkKeyExists` (and `checkArrayKeyExists`).
    pub(super) async fn key_exists(
        &mut self,
        name: &str,
        storage: VariableStorage,
        target: Option<&str>,
    ) -> Result<bool, EvalError> {
        let stripped = strip(name, storage);
        match storage {
            VariableStorage::Memory => Ok(self.state.variables.contains_key(stripped)
                || self.state.arrays.contains_key(stripped)),
            VariableStorage::Cache | VariableStorage::CacheUser => {
                for key in self.cache_keys(name, storage, target) {
                    if host_call!(self, self.host.cache_exists(&key))? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            VariableStorage::Db | VariableStorage::DbUser => {
                Ok(!self.read_value(name, storage, target).await?.is_empty()
                    || self.memo_has(name, storage, target))
            }
        }
    }

    /// Whether a database variable is in the run's memo (a stored empty text counts as set).
    fn memo_has(&self, name: &str, storage: VariableStorage, target: Option<&str>) -> bool {
        let stripped = strip(name, storage);
        match storage {
            VariableStorage::Db => self.state.command_variables.contains_key(stripped),
            VariableStorage::DbUser => self
                .state
                .user_command_variables
                .contains_key(&self.user_memo_key(stripped, target)),
            _ => false,
        }
    }

    /// `saveValueToStorage`. Database variables are written only on Premium and Pro.
    pub(super) async fn save_value(
        &mut self,
        name: &str,
        storage: VariableStorage,
        value: String,
        target: Option<&str>,
    ) -> Result<(), EvalError> {
        self.check_size(value.len())?;
        let stripped = strip(name, storage);
        if matches!(storage, VariableStorage::Db | VariableStorage::DbUser)
            && !self.context.user_plan.writes_db_variables()
        {
            return Ok(());
        }
        match storage {
            VariableStorage::Memory => self.put(Kept::Variables, stripped.to_owned(), value)?,
            VariableStorage::Cache | VariableStorage::CacheUser => {
                for key in self.cache_keys(name, storage, target) {
                    host_call!(self, self.host.cache_set(&key, &value))?;
                    host_call!(self, self.host.cache_expire(&key, CACHE_TTL_SECONDS))?;
                }
            }
            VariableStorage::Db => {
                // The memo is written after the save, as the reference does; whether it fits
                // is known before.
                self.can_put(Kept::ChannelMemo, stripped, &value)?;
                host_call!(self, self.host.save_channel_variable(stripped, &value))?;
                self.put(Kept::ChannelMemo, stripped.to_owned(), value)?;
            }
            VariableStorage::DbUser => {
                let memo = self.user_memo_key(stripped, target);
                self.can_put(Kept::UserMemo, &memo, &value)?;
                host_call!(self, self.host.save_user_variable(stripped, &value, target))?;
                self.put(Kept::UserMemo, memo, value)?;
            }
        }
        Ok(())
    }

    pub(super) async fn save_responses(&mut self) -> Result<(), EvalError> {
        host_call!(
            self,
            self.host.save_responses(&self.state.command_responses)
        )?;
        Ok(())
    }

    /// `deleteValueFromStorage`. Each case runs as its own future, so the recursion through a
    /// list index (`%del(list[%del(…)])`) keeps a small stack frame per level.
    pub(super) fn delete_value<'s>(
        &'s mut self,
        name: &'s str,
        storage: VariableStorage,
        accessor: Option<&'s ArrayAccessor>,
        target: Option<&'s str>,
    ) -> HostFuture<'s, Result<(), EvalError>> {
        let stripped = strip(name, storage);
        match (storage, accessor) {
            (VariableStorage::Memory, None | Some(ArrayAccessor::Clear)) => {
                self.forget(Kept::Variables, stripped);
                self.state.arrays.remove(stripped);
                Box::pin(async { Ok(()) })
            }
            (VariableStorage::Memory, Some(ArrayAccessor::Remove { index })) => {
                Box::pin(self.delete_memory_item(stripped, index))
            }
            (
                VariableStorage::Cache | VariableStorage::CacheUser,
                None | Some(ArrayAccessor::Clear),
            ) => Box::pin(self.delete_cache_keys(name, storage, target)),
            (
                VariableStorage::Cache | VariableStorage::CacheUser,
                Some(ArrayAccessor::Remove { index }),
            ) => Box::pin(self.delete_cache_item(name, storage, index, target)),
            (VariableStorage::Db | VariableStorage::DbUser, None) => {
                Box::pin(self.delete_db_variable(stripped, storage, target))
            }
            (
                VariableStorage::Db | VariableStorage::DbUser,
                Some(ArrayAccessor::Clear | ArrayAccessor::Remove { .. }),
            ) => Box::pin(self.delete_db_item(name, storage, accessor, target)),
            _ => Box::pin(async { Ok(()) }),
        }
    }

    async fn delete_memory_item(&mut self, name: &str, index: &AstNode) -> Result<(), EvalError> {
        let mut list = match self.state.variables.get(name) {
            Some(raw) if !raw.is_empty() => match Value::parse_json(raw) {
                Some(Value::List(items)) => items,
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        let index = self.child(index).await?;
        if let Some(at) = resolve_array_index(&index, list.len())? {
            list.remove(at);
            let json = self.write_json(&list)?;
            self.put(Kept::Variables, name.to_owned(), json)?;
        }
        Ok(())
    }

    async fn delete_cache_keys(
        &mut self,
        name: &str,
        storage: VariableStorage,
        target: Option<&str>,
    ) -> Result<(), EvalError> {
        for key in self.cache_keys(name, storage, target) {
            host_call!(self, self.host.cache_delete(&key))?;
        }
        Ok(())
    }

    async fn delete_cache_item(
        &mut self,
        name: &str,
        storage: VariableStorage,
        index: &AstNode,
        target: Option<&str>,
    ) -> Result<(), EvalError> {
        let index = self.child(index).await?;
        for key in self.cache_keys(name, storage, target) {
            let Some(raw) =
                host_call!(self, self.host.cache_get(&key))?.filter(|raw| !raw.is_empty())
            else {
                continue;
            };
            self.charge_bytes(raw.len())?;
            let Some(Value::List(mut list)) = Value::parse_json(&raw) else {
                continue;
            };
            // The reference resolves the index inside its per-key `try`: a conversion that
            // throws skips the key.
            let Ok(Some(at)) = resolve_array_index(&index, list.len()) else {
                continue;
            };
            list.remove(at);
            let json = self.write_json(&list)?;
            // The reference ignores failures from here on (`catch {}`).
            if host_call!(self, self.host.cache_set(&key, &json)).is_ok() {
                let _ = host_call!(self, self.host.cache_expire(&key, CACHE_TTL_SECONDS));
            }
        }
        Ok(())
    }

    async fn delete_db_variable(
        &mut self,
        name: &str,
        storage: VariableStorage,
        target: Option<&str>,
    ) -> Result<(), EvalError> {
        if storage == VariableStorage::Db {
            host_call!(self, self.host.delete_channel_variable(name))?;
            self.forget(Kept::ChannelMemo, name);
        } else {
            host_call!(self, self.host.delete_user_variable(name, target))?;
            let memo = self.user_memo_key(name, target);
            self.forget(Kept::UserMemo, &memo);
        }
        Ok(())
    }

    async fn delete_db_item(
        &mut self,
        name: &str,
        storage: VariableStorage,
        accessor: Option<&ArrayAccessor>,
        target: Option<&str>,
    ) -> Result<(), EvalError> {
        let current = self.read_value(name, storage, target).await?;
        if current.is_empty() {
            return Ok(());
        }
        // Everything from parsing to saving is inside the reference's `try { } catch {}`.
        let level = self.frames.watch_depth();
        match self
            .rewrite_db_list(name, storage, accessor, target, &current)
            .await
        {
            Err(EvalError::Limit(kind)) => Err(EvalError::Limit(kind)),
            Err(_) => {
                self.frames.abandon_from(level);
                Ok(())
            }
            Ok(()) => Ok(()),
        }
    }

    async fn rewrite_db_list(
        &mut self,
        name: &str,
        storage: VariableStorage,
        accessor: Option<&ArrayAccessor>,
        target: Option<&str>,
        current: &str,
    ) -> Result<(), EvalError> {
        self.charge_bytes(current.len())?;
        let Some(Value::List(mut list)) = Value::parse_json(current) else {
            return Ok(());
        };
        match accessor {
            Some(ArrayAccessor::Remove { index }) => {
                let index = self.child(index).await?;
                // A conversion that throws here is caught with the rest (`delete_db_item`).
                if let Some(at) = resolve_array_index(&index, list.len())? {
                    list.remove(at);
                }
            }
            _ => list.clear(),
        }
        let json = self.write_json(&list)?;
        self.save_value(name, storage, json, target).await
    }
}
