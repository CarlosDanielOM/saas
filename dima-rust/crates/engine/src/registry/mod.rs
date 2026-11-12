//! The function registry: every `$(name …)` the reference registers, with its metadata and how
//! it runs.
//!
//! Metadata (`FunctionMetadata`: description, syntax, category, examples, minimum user level,
//! keywords, aliases, deprecation, destructive flag, plan tier, surfaces) is the reference's,
//! recorded from its registration code (`catalog.json`, checked against
//! `tests/fixtures/ast_registry_cases.json`). Each name is either a [`Builtin`] the engine runs
//! itself or a [`HostFunction`] the host runs.
//!
//! The registry also does what `registerFunction` does for callers that add functions (the
//! reference's own tests register `say` and `noop`): a later registration under the same name
//! replaces the handler, and keeps the earlier metadata when it brings none.

use crate::host::HostFunction;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

/// Which consumer a function matters for (`AstFunctionSurface`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    /// The chat AI executing it as a tool.
    Action,
    /// Command and reward text written by the streamer.
    Authoring,
}

/// `FunctionMetadata`, field for field. Absent optional fields stay absent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    /// What it does.
    pub description: String,
    /// Call syntax without `$()`.
    pub syntax: String,
    /// Category for grouping and search.
    pub category: String,
    /// Usage examples without `$()`.
    pub examples: Vec<String>,
    /// The level an AI caller needs (default 1); streamer-authored text is not gated by it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub min_user_level: Option<f64>,
    /// Search keywords (English and Spanish).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub keywords: Option<Vec<String>>,
    /// Other names of the same function.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub aliases: Option<Vec<String>>,
    /// The canonical name, when this name is an alias.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub alias_of: Option<String>,
    /// The recommended replacement, when deprecated.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deprecated: Option<String>,
    /// A destructive action that deserves double-checking.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub destructive: Option<bool>,
    /// The plan the function (or part of it) needs.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub plan_tier: Option<crate::context::Plan>,
    /// Which consumers it matters for (both when absent).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub surfaces: Option<Vec<Surface>>,
}

impl Metadata {
    /// The level an AI caller needs: `minUserLevel ?? 1`.
    pub fn required_level(&self) -> f64 {
        self.min_user_level.unwrap_or(1.0)
    }
}

/// Functions the engine runs itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Builtin {
    /// `$(upper …)`.
    Upper,
    /// `$(lower …)`.
    Lower,
    /// `$(title …)`.
    Title,
    /// `$(capitalize …)`.
    Capitalize,
    /// `$(trim …)`.
    Trim,
    /// `$(length …)`: characters, an emoji counting one.
    Length,
    /// `$(slice start [end] …)`: by character.
    Slice,
    /// `$(replace search replacement …)`.
    Replace,
    /// `$(user [ignore symbols|numbers])`.
    User,
    /// `$(touser [name])`.
    ToUser,
    /// `$(random [max])`.
    Random,
    /// `$(count [increment])`.
    Count,
    /// `$(scount)`.
    Scount,
    /// `$(bits)`.
    Bits,
    /// `$(break)`.
    Break,
    /// `$(continue)`.
    Continue,
    /// `$(delay seconds)`: validated here, the pause itself is [`crate::host::Host::sleep`].
    Delay,
    /// `$(timer seconds body…)`: the body is never evaluated here; the host schedules it.
    Timer,
    /// `$(ad.time)` and `$(ad)`.
    AdTime,
    /// `$(ban.time)`.
    BanTime,
    /// `$(twitch.modiversary)`.
    Modiversary,
    /// `$(twitch.streak)`.
    WatchStreak,
    /// `$(raid.channel)`.
    RaidChannel,
    /// `$(raid.login)`.
    RaidLogin,
    /// `$(raid.viewers)`.
    RaidViewers,
    /// `$(cheer.amount)`.
    CheerAmount,
    /// `$(cheer.message)`.
    CheerMessage,
    /// `$(sub.tier)`.
    SubTier,
    /// `$(sub.months)`.
    SubMonths,
    /// `$(gifted.user)`.
    GiftedUser,
    /// `$(hypetrain.progress)`.
    HypeTrainProgress,
    /// `$(hypetrain.level)`.
    HypeTrainLevel,
    /// `$(hypetrain.end)`.
    HypeTrainEnd,
    /// `$(shoutout.channel)`.
    ShoutoutChannel,
    /// `$(reward.input)` and `$(redemption.input)`.
    RewardInput,
}

impl Builtin {
    /// Whether the builtin needs the host at all (only to sleep or to schedule).
    pub fn uses_host(self) -> bool {
        matches!(self, Self::Delay | Self::Timer)
    }
}

/// How a function runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FunctionKind {
    /// In the engine.
    Builtin(Builtin),
    /// In the host.
    Host(HostFunction),
}

/// A registered function.
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionSpec {
    /// The name as called.
    pub name: String,
    /// How it runs.
    pub kind: FunctionKind,
    /// Its metadata, when registered with one.
    pub metadata: Option<Metadata>,
}

/// The engine-side names, as the reference registers them.
fn builtin(name: &str) -> Option<Builtin> {
    Some(match name {
        "upper" => Builtin::Upper,
        "lower" => Builtin::Lower,
        "title" => Builtin::Title,
        "capitalize" => Builtin::Capitalize,
        "trim" => Builtin::Trim,
        "length" => Builtin::Length,
        "slice" => Builtin::Slice,
        "replace" => Builtin::Replace,
        "user" => Builtin::User,
        "touser" => Builtin::ToUser,
        "random" => Builtin::Random,
        "count" => Builtin::Count,
        "scount" => Builtin::Scount,
        "bits" => Builtin::Bits,
        "break" => Builtin::Break,
        "continue" => Builtin::Continue,
        "delay" => Builtin::Delay,
        "timer" => Builtin::Timer,
        "ad" | "ad.time" => Builtin::AdTime,
        "ban.time" => Builtin::BanTime,
        "twitch.modiversary" => Builtin::Modiversary,
        "twitch.streak" => Builtin::WatchStreak,
        "raid.channel" => Builtin::RaidChannel,
        "raid.login" => Builtin::RaidLogin,
        "raid.viewers" => Builtin::RaidViewers,
        "cheer.amount" => Builtin::CheerAmount,
        "cheer.message" => Builtin::CheerMessage,
        "sub.tier" => Builtin::SubTier,
        "sub.months" => Builtin::SubMonths,
        "gifted.user" => Builtin::GiftedUser,
        "hypetrain.progress" => Builtin::HypeTrainProgress,
        "hypetrain.level" => Builtin::HypeTrainLevel,
        "hypetrain.end" => Builtin::HypeTrainEnd,
        "shoutout.channel" => Builtin::ShoutoutChannel,
        "reward.input" | "redemption.input" => Builtin::RewardInput,
        _ => return None,
    })
}

#[derive(Deserialize)]
struct CatalogEntry {
    name: String,
    metadata: Option<Metadata>,
}

/// The reference's registry, read once from the embedded catalog.
static STANDARD: LazyLock<Arc<Registry>> = LazyLock::new(|| {
    let entries: Vec<CatalogEntry> =
        serde_json::from_str(include_str!("catalog.json")).unwrap_or_default();
    let mut registry = Registry::empty();
    for entry in entries {
        let kind = builtin(&entry.name)
            .map(FunctionKind::Builtin)
            .or_else(|| HostFunction::from_name(&entry.name).map(FunctionKind::Host));
        if let Some(kind) = kind {
            registry.register(entry.name, kind, entry.metadata);
        }
    }
    Arc::new(registry)
});

/// Names to functions, in registration order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Registry {
    functions: Vec<FunctionSpec>,
    by_name: HashMap<String, usize>,
}

impl Registry {
    /// A registry with no functions: every call is `[Unknown function: …]`.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Every function `registerAllFunctions` registers, shared.
    pub fn standard() -> Arc<Self> {
        STANDARD.clone()
    }

    /// `registerFunction(name, handler, metadata)`: a new name is appended; an existing name
    /// keeps its position, takes the new kind, and keeps its metadata when `metadata` is `None`.
    pub fn register(
        &mut self,
        name: impl Into<String>,
        kind: FunctionKind,
        metadata: Option<Metadata>,
    ) {
        let name = name.into();
        if let Some(spec) = self
            .by_name
            .get(&name)
            .copied()
            .and_then(|at| self.functions.get_mut(at))
        {
            spec.kind = kind;
            if metadata.is_some() {
                spec.metadata = metadata;
            }
            return;
        }
        self.by_name.insert(name.clone(), self.functions.len());
        self.functions.push(FunctionSpec {
            name,
            kind,
            metadata,
        });
    }

    /// The function registered as `name` (exact, case-sensitive).
    pub fn get(&self, name: &str) -> Option<&FunctionSpec> {
        self.by_name
            .get(name)
            .and_then(|at| self.functions.get(*at))
    }

    /// Every function in registration order (`getAllRegisteredFunctions`).
    pub fn iter(&self) -> impl Iterator<Item = &FunctionSpec> {
        self.functions.iter()
    }

    /// How many functions are registered.
    pub fn len(&self) -> usize {
        self.functions.len()
    }

    /// Whether none is.
    pub fn is_empty(&self) -> bool {
        self.functions.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_registry_classifies_every_reference_name() {
        let registry = Registry::standard();
        assert_eq!(registry.len(), 136);
        let host = registry
            .iter()
            .filter(|spec| matches!(spec.kind, FunctionKind::Host(_)))
            .count();
        assert_eq!(host, HostFunction::ALL.len());
        for function in HostFunction::ALL {
            let name = function.name().unwrap_or_default();
            assert_eq!(
                registry.get(name).map(|spec| spec.kind),
                Some(FunctionKind::Host(*function))
            );
        }
        assert_eq!(
            registry.get("upper").map(|s| s.kind),
            Some(FunctionKind::Builtin(Builtin::Upper))
        );
        assert_eq!(
            registry
                .get("ban")
                .and_then(|s| s.metadata.as_ref())
                .map(Metadata::required_level),
            Some(7.0)
        );
    }

    #[test]
    fn register_keeps_metadata_without_new_metadata() {
        let mut registry = Registry::empty();
        let metadata = Metadata {
            category: "x".into(),
            ..Metadata::default()
        };
        registry.register(
            "say",
            FunctionKind::Host(HostFunction::Custom),
            Some(metadata.clone()),
        );
        registry.register("other", FunctionKind::Host(HostFunction::Custom), None);
        registry.register("say", FunctionKind::Builtin(Builtin::Upper), None);
        assert_eq!(
            registry.get("say").and_then(|s| s.metadata.clone()),
            Some(metadata)
        );
        assert_eq!(
            registry.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["say", "other"]
        );
    }
}
