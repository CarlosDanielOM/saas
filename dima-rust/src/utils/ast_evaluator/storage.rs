use super::{
    Context, EvalError, EvalStats, Host, HostRequest, JsString, JsValue,
    value::{js_string, json_parse, json_stringify},
};
use crate::utils::ast_syntax::VariableStorage;
use std::{collections::HashMap, rc::Rc};

pub(crate) fn strip(name: &str, storage: VariableStorage) -> &str {
    use VariableStorage::*;
    match storage {
        DbUser => name.strip_prefix("**").unwrap_or(name),
        Db if !name.starts_with("**") => name.strip_prefix('*').unwrap_or(name),
        CacheUser => name.strip_prefix("##").unwrap_or(name),
        Cache if !name.starts_with("##") => name.strip_prefix('#').unwrap_or(name),
        _ => name,
    }
}
fn normalize(s: &JsString) -> JsString {
    let s = s.trim();
    let start = s.units().iter().take_while(|c| **c == 64).count();
    JsString::from_units(s.units()[start..].to_vec()).lower()
}
pub(crate) fn cache_keys(
    name: &str,
    storage: VariableStorage,
    ctx: &Context,
    target: &Option<JsString>,
) -> Vec<JsString> {
    let c = ctx.borrow();
    let base = JsString::from(format!(
        "{}:{}:variable:{}",
        c.platform,
        c.broadcaster_id,
        strip(name, storage)
    ));
    if storage != VariableStorage::CacheUser {
        return vec![base];
    }
    let current = normalize(&c.user_login.clone().into());
    let requested = normalize(&target.clone().unwrap_or_default());
    let mut scopes = Vec::new();
    if !requested.is_empty() && requested != current {
        let mut s = JsString::from("login:");
        s.push(&requested);
        scopes.push(s);
    } else {
        if !c.user_id.is_empty() {
            scopes.push(format!("id:{}", c.user_id).into());
        }
        if !current.is_empty() {
            let mut s = JsString::from("login:");
            s.push(&current);
            if !scopes.contains(&s) {
                scopes.push(s);
            }
        }
        if scopes.is_empty() {
            scopes.push("id:unknown".into());
        }
    }
    scopes
        .into_iter()
        .map(|scope| {
            let mut key = base.clone();
            key.push(&":".into());
            key.push(&scope);
            key
        })
        .collect()
}
fn user_key(name: &str, ctx: &Context, target: &Option<JsString>) -> JsString {
    let c = ctx.borrow();
    let login = normalize(
        &target
            .as_ref()
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| c.user_login.clone().into()),
    );
    if login.is_empty() {
        format!(
            "id:{}:{name}",
            if c.user_id.is_empty() {
                "unknown"
            } else {
                &c.user_id
            }
        )
        .into()
    } else {
        let mut key = JsString::from("login:");
        key.push(&login);
        key.push(&format!(":{name}").into());
        key
    }
}
pub(crate) async fn call<H: Host>(
    host: &mut H,
    stats: &mut EvalStats,
    request: HostRequest,
    ctx: &Context,
) -> Result<JsValue, EvalError> {
    stats.host_calls = stats.host_calls.saturating_add(1);
    stats.host_futures = stats.host_futures.saturating_add(1);
    host.execute(request, ctx.clone()).await
}
pub(crate) async fn read<H: Host>(
    host: &mut H,
    stats: &mut EvalStats,
    name: &str,
    storage: VariableStorage,
    ctx: &Context,
    target: &Option<JsString>,
) -> Result<JsString, EvalError> {
    use VariableStorage::*;
    let original_name = name;
    let name = strip(name, storage);
    match storage {
        Memory => {
            let c = ctx.borrow();
            if let Some(v) = c
                .variables
                .borrow()
                .get(name)
                .filter(|v| !matches!(v, JsValue::Undefined))
            {
                return Ok(js_string(v));
            }
            if let Some(a) = c
                .arrays
                .borrow()
                .get(name)
                .filter(|v| super::value::js_truthy(v))
            {
                return Ok(json_stringify(a)?.unwrap_or_default());
            }
            Ok(JsString::default())
        }
        Cache | CacheUser => {
            for key in cache_keys(original_name, storage, ctx, target) {
                let value = call(host, stats, HostRequest::CacheGet { key }, ctx).await?;
                if !value.is_nullish() {
                    return Ok(js_string(&value));
                }
            }
            Ok(JsString::default())
        }
        Db | DbUser => {
            let key = (storage == DbUser).then(|| user_key(name, ctx, target));
            let cached = if let Some(key) = &key {
                ctx.borrow()
                    .user_command_variables
                    .borrow()
                    .get(key)
                    .cloned()
            } else {
                ctx.borrow().command_variables.borrow().get(name).cloned()
            };
            if let Some(value) = cached {
                return Ok(value);
            }
            let request = if storage == DbUser {
                HostRequest::LoadUserVariable {
                    name: name.into(),
                    target_user_login: target.clone(),
                }
            } else {
                HostRequest::LoadChannelVariable { name: name.into() }
            };
            let value = call(host, stats, request, ctx).await?;
            if !value.is_nullish() && !value.is_empty_string() {
                let value = js_string(&value);
                if let Some(key) = key {
                    ctx.borrow()
                        .user_command_variables
                        .borrow_mut()
                        .insert(key, value.clone());
                } else {
                    ctx.borrow()
                        .command_variables
                        .borrow_mut()
                        .insert(name.into(), value.clone());
                }
                Ok(value)
            } else {
                Ok(JsString::default())
            }
        }
    }
}
pub(crate) async fn exists<H: Host>(
    host: &mut H,
    stats: &mut EvalStats,
    name: &str,
    storage: VariableStorage,
    ctx: &Context,
    target: &Option<JsString>,
) -> Result<bool, EvalError> {
    use VariableStorage::*;
    let original_name = name;
    let name = strip(name, storage);
    match storage {
        Memory => {
            let c = ctx.borrow();
            Ok(c.variables.borrow().contains_key(name) || c.arrays.borrow().contains_key(name))
        }
        Cache | CacheUser => {
            for key in cache_keys(original_name, storage, ctx, target) {
                if matches!(
                    call(host, stats, HostRequest::CacheExists { key }, ctx).await?,
                    JsValue::Number(1.0)
                ) {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Db | DbUser => {
            let cached = if storage == DbUser {
                let key = user_key(name, ctx, target);
                ctx.borrow()
                    .user_command_variables
                    .borrow()
                    .contains_key(&key)
            } else {
                ctx.borrow().command_variables.borrow().contains_key(name)
            };
            if cached {
                return Ok(true);
            }
            Ok(!read(host, stats, original_name, storage, ctx, target)
                .await?
                .is_empty())
        }
    }
}
pub(crate) async fn save<H: Host>(
    host: &mut H,
    stats: &mut EvalStats,
    name: &str,
    storage: VariableStorage,
    value: JsString,
    ctx: &Context,
    target: &Option<JsString>,
) -> Result<(), EvalError> {
    use VariableStorage::*;
    let original_name = name;
    let name = strip(name, storage);
    if matches!(storage, Db | DbUser)
        && !matches!(ctx.borrow().user_plan.as_str(), "premium" | "pro")
    {
        return Ok(());
    }
    match storage {
        Memory => {
            ctx.borrow()
                .variables
                .borrow_mut()
                .insert(name.into(), JsValue::String(value));
        }
        Cache | CacheUser => {
            for key in cache_keys(original_name, storage, ctx, target) {
                call(
                    host,
                    stats,
                    HostRequest::CacheSet {
                        key: key.clone(),
                        value: value.clone(),
                    },
                    ctx,
                )
                .await?;
                call(
                    host,
                    stats,
                    HostRequest::CacheExpire {
                        key,
                        seconds: 86400,
                    },
                    ctx,
                )
                .await?;
            }
        }
        Db => {
            call(
                host,
                stats,
                HostRequest::SaveChannelVariable {
                    name: name.into(),
                    value: value.clone(),
                },
                ctx,
            )
            .await?;
            ctx.borrow()
                .command_variables
                .borrow_mut()
                .insert(name.into(), value);
        }
        DbUser => {
            call(
                host,
                stats,
                HostRequest::SaveUserVariable {
                    name: name.into(),
                    value: value.clone(),
                    target_user_login: target.clone(),
                },
                ctx,
            )
            .await?;
            let key = user_key(name, ctx, target);
            ctx.borrow()
                .user_command_variables
                .borrow_mut()
                .insert(key, value);
        }
    }
    Ok(())
}
pub(crate) async fn delete<H: Host>(
    host: &mut H,
    stats: &mut EvalStats,
    name: &str,
    storage: VariableStorage,
    ctx: &Context,
    target: &Option<JsString>,
) -> Result<(), EvalError> {
    use VariableStorage::*;
    let original_name = name;
    let name = strip(name, storage);
    match storage {
        Memory => {
            let c = ctx.borrow();
            c.variables.borrow_mut().remove(name);
            c.arrays.borrow_mut().remove(name);
        }
        Cache | CacheUser => {
            for key in cache_keys(original_name, storage, ctx, target) {
                call(host, stats, HostRequest::CacheDelete { key }, ctx).await?;
            }
        }
        Db => {
            call(
                host,
                stats,
                HostRequest::DeleteChannelVariable { name: name.into() },
                ctx,
            )
            .await?;
            ctx.borrow().command_variables.borrow_mut().remove(name);
        }
        DbUser => {
            call(
                host,
                stats,
                HostRequest::DeleteUserVariable {
                    name: name.into(),
                    target_user_login: target.clone(),
                },
                ctx,
            )
            .await?;
            let key = user_key(name, ctx, target);
            ctx.borrow()
                .user_command_variables
                .borrow_mut()
                .remove(&key);
        }
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct DecodeCache {
    values: HashMap<JsString, Rc<Vec<JsValue>>>,
    raw_units: usize,
}
impl DecodeCache {
    /// Only decoded data is memoized, never IO. Each caller receives a detached
    /// vector, so append/setIndex followed by a suppressed/failed save cannot
    /// poison the raw-value memo. Nested values retain JSON parse value semantics.
    pub fn array(&mut self, raw: &JsString, stats: &mut EvalStats) -> Vec<JsValue> {
        if raw.is_empty() {
            return Vec::new();
        }
        if let Some(v) = self.values.get(raw) {
            stats.array_cache_hits = stats.array_cache_hits.saturating_add(1);
            return deep_values(v);
        }
        stats.array_decodes = stats.array_decodes.saturating_add(1);
        let values = match json_parse(raw) {
            Ok(JsValue::Array(a)) => a.borrow().clone(),
            Ok(v) => vec![JsValue::String(js_string(&v))],
            Err(_) => Vec::new(),
        };
        // Memo eviction is an optimization only: large/new values still evaluate.
        const MAX_UNITS: usize = 1_048_576;
        if raw.len() <= MAX_UNITS {
            if self.values.len() >= 64 || self.raw_units.saturating_add(raw.len()) > MAX_UNITS {
                self.values.clear();
                self.raw_units = 0;
            }
            self.raw_units += raw.len();
            self.values.insert(raw.clone(), Rc::new(values.clone()));
        }
        deep_values(&values)
    }
}
// JSON.parse creates independent object/array identities on every read. Retain
// that property for host handlers receiving an element, too (not just writes).
fn deep_values(v: &[JsValue]) -> Vec<JsValue> {
    v.iter().map(deep_value).collect()
}
fn deep_value(v: &JsValue) -> JsValue {
    enum Copy {
        Value(JsValue),
        Array(usize),
        Object(Vec<JsString>),
    }
    let mut tasks = vec![Copy::Value(v.clone())];
    let mut values = Vec::new();
    while let Some(task) = tasks.pop() {
        match task {
            Copy::Value(JsValue::Array(a)) => {
                let a = a.borrow();
                tasks.push(Copy::Array(a.len()));
                tasks.extend(a.iter().rev().cloned().map(Copy::Value));
            }
            Copy::Value(JsValue::Object(o)) => {
                let o = o.borrow();
                tasks.push(Copy::Object(o.iter().map(|(k, _)| k.clone()).collect()));
                tasks.extend(o.iter().rev().map(|(_, v)| Copy::Value(v.clone())));
            }
            Copy::Value(v) => values.push(v),
            Copy::Array(n) => {
                let a = values.split_off(values.len() - n);
                values.push(JsValue::array(a));
            }
            Copy::Object(keys) => {
                let a = values.split_off(values.len() - keys.len());
                values.push(JsValue::object(keys.into_iter().zip(a).collect()));
            }
        }
    }
    values.pop().unwrap_or_default()
}
pub(crate) fn stringify_array(a: Vec<JsValue>) -> Result<JsString, EvalError> {
    Ok(json_stringify(&JsValue::array(a))?.unwrap_or_default())
}
