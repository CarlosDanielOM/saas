//! Shared AI constants: a direct, zero-dependency port of
//! `dimabot/src/utils/ai/constants.ts` (source SHA-256
//! `7505c5481b8681c83ec57c8b89b856250bdd3970586810e900075d06fb5eb0f4`).
//!
//! The TypeScript module imports nothing, so this port needs no crate or
//! third-party dependency: `std` is used only by the documented serialization
//! helpers. Ordinary selector calls borrow `'static` values and allocate
//! nothing.
//!
//! # Contract
//!
//! * Tables keep their source declaration order; [`Models::entries`],
//!   [`Models::KEYS`] and the sibling `keys`/`entries` helpers expose it.
//! * Selectors are total, case-sensitive, and return borrowed `'static`
//!   values. Missing, empty, unknown, or differently-cased plan tiers fall
//!   back to the free tier exactly as the `===` comparisons in the source do.
//! * [`select_chat_model`] checks exhaustion first, then `pro`, then
//!   `premium`, then falls back to `free`.
//! * [`get_background_summary_model`] checks `pro`, then `premium`, then falls
//!   back to `free`.
//! * [`MINIMAX_COST_PER_M_INPUT`] and [`MINIMAX_COST_PER_M_OUTPUT`] are the
//!   exact binary64 literals from the source. The companion `*_BITS`
//!   constants expose the IEEE-754 bit pattern so a serialized value can be
//!   checked bit-for-bit.
//!
//! # Boundaries (recorded, not hidden)
//!
//! `MODEL_PROVIDER_RESTRICTIONS` is a plain JavaScript object literal, so the
//! source lookup `MODEL_PROVIDER_RESTRICTIONS[model]` walks the prototype
//! chain. For `"__proto__"`, `"constructor"`, `"toString"`,
//! `"hasOwnProperty"`, and the other `Object.prototype` members, the
//! TypeScript function returns an inherited object or function that does not
//! satisfy the declared `{ only: readonly string[] } | undefined` type.
//! [`get_provider_restriction`] applies own-entry semantics and returns
//! `None` for every key that is not a declared entry; see
//! `migration-notes/ai-constants-handoff.md` for the recorded divergence.
//!
//! The source tables are not frozen at runtime (`as const` and `Readonly` are
//! compile-time only), but no source path mutates them. This port exposes
//! immutable statics; runtime mutation is outside the migrated contract.

/// Models used for interactive chat, keyed by plan tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Models {
    pub free: &'static str,
    pub exhausted: &'static str,
    pub premium: &'static str,
    pub pro: &'static str,
}

/// `MODELS` from the source, in declaration order.
pub const MODELS: Models = Models {
    free: "deepseek/deepseek-v4.1-flash",
    exhausted: "meta/muse-spark-1.3-contributor",
    premium: "deepseek/deepseek-v4.1-flash",
    pro: "deepseek/deepseek-v4.1-flash",
};

impl Models {
    /// Keys of `MODELS` in source order.
    pub const KEYS: [&str; 4] = ["free", "exhausted", "premium", "pro"];

    /// Key/value pairs of `MODELS` in source order.
    pub const fn entries(&self) -> [(&'static str, &'static str); 4] {
        [
            ("free", self.free),
            ("exhausted", self.exhausted),
            ("premium", self.premium),
            ("pro", self.pro),
        ]
    }

    /// Own-key lookup with `undefined` represented as `None`.
    pub fn get(&self, key: &str) -> Option<&'static str> {
        self.entries()
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    }

    /// Append the source-shaped JSON object, keys in declaration order.
    pub fn write_json(&self, out: &mut String) {
        out.push('{');
        for (index, (key, value)) in self.entries().iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            write_json_string(key, out);
            out.push(':');
            write_json_string(value, out);
        }
        out.push('}');
    }

    /// Serialize to the source-shaped JSON object.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
}

/// `isExhausted = false` default of `selectChatModel`.
pub const SELECT_CHAT_MODEL_DEFAULT_IS_EXHAUSTED: bool = false;

/// A `streamer.plan_tier` value as JavaScript observes it.
///
/// `Missing` covers a `null`/`undefined` streamer and an absent property;
/// `NonString` covers every non-string value. Both are outside the declared
/// `plan_tier?: string` type but reach the same strict-equality branches, so
/// the typed boundary can still model them exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanTierValue<'a> {
    Missing,
    String(&'a str),
    CodeUnits(&'a [u16]),
    NonString,
}

/// `selectChatModel` over the declared `plan_tier?: string` input.
pub fn select_chat_model(plan_tier: Option<&str>, is_exhausted: bool) -> &'static str {
    select_chat_model_value(
        plan_tier.map_or(PlanTierValue::Missing, PlanTierValue::String),
        is_exhausted,
    )
}

/// `selectChatModel` over arbitrary JavaScript `plan_tier` values.
pub fn select_chat_model_value(plan_tier: PlanTierValue<'_>, is_exhausted: bool) -> &'static str {
    if is_exhausted {
        return MODELS.exhausted;
    }
    match plan_tier {
        PlanTierValue::String("pro") => MODELS.pro,
        PlanTierValue::String("premium") => MODELS.premium,
        PlanTierValue::CodeUnits(units) => {
            if units_eq(units, "pro") {
                MODELS.pro
            } else if units_eq(units, "premium") {
                MODELS.premium
            } else {
                MODELS.free
            }
        }
        _ => MODELS.free,
    }
}

/// Background LLM models for stream summaries and maintenance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackgroundModels {
    pub free: &'static str,
    pub premium: &'static str,
    pub pro: &'static str,
}

/// `BACKGROUND_MODELS` from the source, in declaration order.
pub const BACKGROUND_MODELS: BackgroundModels = BackgroundModels {
    free: "meta/muse-spark-1.2-contributor",
    premium: "deepseek/deepseek-v4.1-flash",
    pro: "deepseek/deepseek-v4.1-flash",
};

impl BackgroundModels {
    /// Keys of `BACKGROUND_MODELS` in source order.
    pub const KEYS: [&str; 3] = ["free", "premium", "pro"];

    /// Key/value pairs of `BACKGROUND_MODELS` in source order.
    pub const fn entries(&self) -> [(&'static str, &'static str); 3] {
        [
            ("free", self.free),
            ("premium", self.premium),
            ("pro", self.pro),
        ]
    }

    /// Own-key lookup with `undefined` represented as `None`.
    pub fn get(&self, key: &str) -> Option<&'static str> {
        self.entries()
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    }

    /// Append the source-shaped JSON object, keys in declaration order.
    pub fn write_json(&self, out: &mut String) {
        out.push('{');
        for (index, (key, value)) in self.entries().iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            write_json_string(key, out);
            out.push(':');
            write_json_string(value, out);
        }
        out.push('}');
    }

    /// Serialize to the source-shaped JSON object.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
}

/// Fallback model for background summary requests.
pub const BACKGROUND_MODEL_FALLBACK: &str = "deepseek/deepseek-v4.1-flash";

/// `getBackgroundSummaryModel` over the declared `planTier: string | undefined`.
pub fn get_background_summary_model(plan_tier: Option<&str>) -> &'static str {
    match plan_tier {
        Some(tier) if str_units_eq(tier, "pro") => BACKGROUND_MODELS.pro,
        Some(tier) if str_units_eq(tier, "premium") => BACKGROUND_MODELS.premium,
        _ => BACKGROUND_MODELS.free,
    }
}

/// `getBackgroundSummaryModel` over arbitrary JavaScript UTF-16 strings.
pub fn get_background_summary_model_units(plan_tier: &[u16]) -> &'static str {
    if units_eq(plan_tier, "pro") {
        BACKGROUND_MODELS.pro
    } else if units_eq(plan_tier, "premium") {
        BACKGROUND_MODELS.premium
    } else {
        BACKGROUND_MODELS.free
    }
}

/// Per-model upstream provider restriction, as built by consumers into
/// `body.provider = { only: [...restriction.only] }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderRestriction {
    pub only: &'static [&'static str],
}

/// `MODEL_PROVIDER_RESTRICTIONS` entries in source order.
pub const MODEL_PROVIDER_RESTRICTIONS: &[(&str, ProviderRestriction)] = &[(
    "deepseek/deepseek-v4-pro",
    ProviderRestriction {
        only: &["deepseek"],
    },
)];

/// Own keys of `MODEL_PROVIDER_RESTRICTIONS` in source order.
pub const MODEL_PROVIDER_RESTRICTION_KEYS: [&str; 1] = ["deepseek/deepseek-v4-pro"];

/// Append the source-shaped JSON object, keys in declaration order.
pub fn write_provider_restrictions_json(out: &mut String) {
    out.push('{');
    for (index, (model, restriction)) in MODEL_PROVIDER_RESTRICTIONS.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json_string(model, out);
        out.push(':');
        restriction.write_json(out);
    }
    out.push('}');
}

impl ProviderRestriction {
    /// Append `{"only":[...]}`, preserving the declared provider list order.
    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"only\":[");
        for (index, provider) in self.only.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            write_json_string(provider, out);
        }
        out.push_str("]}");
    }

    /// Serialize to the source-shaped `{ only: [...] }` object.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
}

/// `getProviderRestriction` over the declared `model: string` input.
///
/// Own-entry semantics only: inherited `Object.prototype` members return
/// `None`, matching the declared return type rather than the raw JavaScript
/// prototype lookup.
pub fn get_provider_restriction(model: &str) -> Option<&'static ProviderRestriction> {
    MODEL_PROVIDER_RESTRICTIONS
        .iter()
        .find(|(key, _)| *key == model)
        .map(|(_, restriction)| restriction)
}

/// `getProviderRestriction` over arbitrary JavaScript UTF-16 strings.
///
/// A UTF-16 string that cannot be decoded as Rust UTF-8 (for example one with
/// a lone surrogate) can never equal an ASCII table key, so it resolves to
/// `None` exactly as the source lookup resolves to `undefined`.
pub fn get_provider_restriction_units(model: &[u16]) -> Option<&'static ProviderRestriction> {
    MODEL_PROVIDER_RESTRICTIONS
        .iter()
        .find(|(key, _)| units_eq(model, key))
        .map(|(_, restriction)| restriction)
}

/// Token limits used across AI modules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenLimits {
    pub default: u32,
}

/// `TOKEN_LIMITS` from the source.
pub const TOKEN_LIMITS: TokenLimits = TokenLimits { default: 25_000 };

impl TokenLimits {
    /// Keys of `TOKEN_LIMITS` in source order.
    pub const KEYS: [&str; 1] = ["default"];

    /// `(key, value)` pairs in source order.
    pub const fn entries(&self) -> [(&'static str, u32); 1] {
        [("default", self.default)]
    }

    /// Append the source-shaped JSON object.
    pub fn write_json(&self, out: &mut String) {
        out.push_str("{\"default\":");
        write_u64(u64::from(self.default), out);
        out.push('}');
    }

    /// Serialize to the source-shaped JSON object.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
}

/// Models used for coding/code-execution helpers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodingModels {
    pub pro: &'static str,
    pub premium: &'static str,
    pub free: &'static str,
    pub exhausted: &'static str,
}

/// `CODING_MODELS` from the source, in declaration order.
pub const CODING_MODELS: CodingModels = CodingModels {
    pro: "google/gemini-2.5-flash-lite",
    premium: "google/gemini-2.5-flash-lite",
    free: "z-ai/glm-4.5-air:nitro",
    exhausted: "z-ai/glm-4.5-air",
};

impl CodingModels {
    /// Keys of `CODING_MODELS` in source order.
    pub const KEYS: [&str; 4] = ["pro", "premium", "free", "exhausted"];

    /// Key/value pairs in source order.
    pub const fn entries(&self) -> [(&'static str, &'static str); 4] {
        [
            ("pro", self.pro),
            ("premium", self.premium),
            ("free", self.free),
            ("exhausted", self.exhausted),
        ]
    }

    /// Own-key lookup with `undefined` represented as `None`.
    pub fn get(&self, key: &str) -> Option<&'static str> {
        self.entries()
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    }

    /// Append the source-shaped JSON object, keys in declaration order.
    pub fn write_json(&self, out: &mut String) {
        out.push('{');
        for (index, (key, value)) in self.entries().iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            write_json_string(key, out);
            out.push(':');
            write_json_string(value, out);
        }
        out.push('}');
    }

    /// Serialize to the source-shaped JSON object.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
}

/// MiniMax model identifier.
pub const MINIMAX_MODEL: &str = "MiniMax-M2.7-highspeed";
/// MiniMax Anthropic-compatible base URL.
pub const MINIMAX_BASE_URL: &str = "https://api.minimax.io/anthropic";
/// MiniMax USD cost per million input tokens (binary64 `0.6`).
pub const MINIMAX_COST_PER_M_INPUT: f64 = 0.6;
/// IEEE-754 bit pattern of [`MINIMAX_COST_PER_M_INPUT`].
pub const MINIMAX_COST_PER_M_INPUT_BITS: u64 = 0x3fe3_3333_3333_3333;
/// MiniMax USD cost per million output tokens (binary64 `2.4`).
pub const MINIMAX_COST_PER_M_OUTPUT: f64 = 2.4;
/// IEEE-754 bit pattern of [`MINIMAX_COST_PER_M_OUTPUT`].
pub const MINIMAX_COST_PER_M_OUTPUT_BITS: u64 = 0x4003_3333_3333_3333;

/// Default AI request timeout in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u32 = 8_000;

/// Embedding model identifiers used by the self-hosted embedding service.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmbeddingModels {
    pub default: &'static str,
    pub multilingual: &'static str,
}

/// `EMBEDDING_MODELS` from the source, in declaration order.
pub const EMBEDDING_MODELS: EmbeddingModels = EmbeddingModels {
    default: "lfm2.5-embedding-350m",
    multilingual: "lfm2.5-embedding-350m",
};

impl EmbeddingModels {
    /// Keys of `EMBEDDING_MODELS` in source order.
    pub const KEYS: [&str; 2] = ["default", "multilingual"];

    /// Key/value pairs in source order.
    pub const fn entries(&self) -> [(&'static str, &'static str); 2] {
        [
            ("default", self.default),
            ("multilingual", self.multilingual),
        ]
    }

    /// Own-key lookup with `undefined` represented as `None`.
    pub fn get(&self, key: &str) -> Option<&'static str> {
        self.entries()
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    }

    /// Append the source-shaped JSON object, keys in declaration order.
    pub fn write_json(&self, out: &mut String) {
        out.push('{');
        for (index, (key, value)) in self.entries().iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            write_json_string(key, out);
            out.push(':');
            write_json_string(value, out);
        }
        out.push('}');
    }

    /// Serialize to the source-shaped JSON object.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
}

/// `EMBEDDING_DIMENSIONS` entries in source order.
pub const EMBEDDING_DIMENSIONS: &[(&str, u32)] = &[("lfm2.5-embedding-350m", 1024)];

/// Own-key lookup into `EMBEDDING_DIMENSIONS`.
pub fn embedding_dimensions(model: &str) -> Option<u32> {
    EMBEDDING_DIMENSIONS
        .iter()
        .find(|(key, _)| *key == model)
        .map(|(_, dimensions)| *dimensions)
}

/// Append the source-shaped `EMBEDDING_DIMENSIONS` JSON object.
pub fn write_embedding_dimensions_json(out: &mut String) {
    out.push('{');
    for (index, (model, dimensions)) in EMBEDDING_DIMENSIONS.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json_string(model, out);
        out.push(':');
        write_u64(u64::from(*dimensions), out);
    }
    out.push('}');
}

/// Runtime value exports of the TypeScript module, in declaration order.
///
/// The source also exports no type-only declarations; every export has a
/// value binding here.
pub const EXPORTS: [&str; 16] = [
    "MODELS",
    "selectChatModel",
    "BACKGROUND_MODELS",
    "getBackgroundSummaryModel",
    "BACKGROUND_MODEL_FALLBACK",
    "MODEL_PROVIDER_RESTRICTIONS",
    "getProviderRestriction",
    "TOKEN_LIMITS",
    "CODING_MODELS",
    "MINIMAX_MODEL",
    "MINIMAX_BASE_URL",
    "MINIMAX_COST_PER_M_INPUT",
    "MINIMAX_COST_PER_M_OUTPUT",
    "DEFAULT_TIMEOUT_MS",
    "EMBEDDING_MODELS",
    "EMBEDDING_DIMENSIONS",
];

/// Serialize every value export in source declaration order.
///
/// Numbers are written with Rust's shortest round-trip `Display`, which
/// reproduces `JSON.stringify` for the finite constants in this module; the
/// `*_BITS` constants exist so a consumer can additionally pin the exact
/// binary64 pattern.
pub fn to_json_string() -> String {
    let mut out = String::new();
    out.push('{');
    write_json_string("MODELS", &mut out);
    out.push(':');
    MODELS.write_json(&mut out);
    out.push(',');
    write_json_string("BACKGROUND_MODELS", &mut out);
    out.push(':');
    BACKGROUND_MODELS.write_json(&mut out);
    out.push(',');
    write_json_string("BACKGROUND_MODEL_FALLBACK", &mut out);
    out.push(':');
    write_json_string(BACKGROUND_MODEL_FALLBACK, &mut out);
    out.push(',');
    write_json_string("MODEL_PROVIDER_RESTRICTIONS", &mut out);
    out.push(':');
    write_provider_restrictions_json(&mut out);
    out.push(',');
    write_json_string("TOKEN_LIMITS", &mut out);
    out.push(':');
    TOKEN_LIMITS.write_json(&mut out);
    out.push(',');
    write_json_string("CODING_MODELS", &mut out);
    out.push(':');
    CODING_MODELS.write_json(&mut out);
    out.push(',');
    write_json_string("MINIMAX_MODEL", &mut out);
    out.push(':');
    write_json_string(MINIMAX_MODEL, &mut out);
    out.push(',');
    write_json_string("MINIMAX_BASE_URL", &mut out);
    out.push(':');
    write_json_string(MINIMAX_BASE_URL, &mut out);
    out.push(',');
    write_json_string("MINIMAX_COST_PER_M_INPUT", &mut out);
    out.push(':');
    write_f64(MINIMAX_COST_PER_M_INPUT, &mut out);
    out.push(',');
    write_json_string("MINIMAX_COST_PER_M_OUTPUT", &mut out);
    out.push(':');
    write_f64(MINIMAX_COST_PER_M_OUTPUT, &mut out);
    out.push(',');
    write_json_string("DEFAULT_TIMEOUT_MS", &mut out);
    out.push(':');
    write_u64(u64::from(DEFAULT_TIMEOUT_MS), &mut out);
    out.push(',');
    write_json_string("EMBEDDING_MODELS", &mut out);
    out.push(':');
    EMBEDDING_MODELS.write_json(&mut out);
    out.push(',');
    write_json_string("EMBEDDING_DIMENSIONS", &mut out);
    out.push(':');
    write_embedding_dimensions_json(&mut out);
    out.push('}');
    out
}

fn str_units_eq(value: &str, target: &str) -> bool {
    value.encode_utf16().eq(target.encode_utf16())
}

/// Exact UTF-16 code-unit equality; never allocates and never panics on lone
/// surrogates.
fn units_eq(units: &[u16], target: &str) -> bool {
    let mut expected = target.encode_utf16();
    for unit in units {
        match expected.next() {
            Some(value) if value == *unit => {}
            _ => return false,
        }
    }
    expected.next().is_none()
}

fn write_json_string(value: &str, out: &mut String) {
    use std::fmt::Write as _;
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", other as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

fn write_u64(value: u64, out: &mut String) {
    use std::fmt::Write as _;
    let _ = write!(out, "{value}");
}

/// Shortest round-trip `f64` rendering; the source constants are finite and
/// their `JSON.stringify` text is identical.
fn write_f64(value: f64, out: &mut String) {
    use std::fmt::Write as _;
    let _ = write!(out, "{value}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_equality_handles_surrogates() {
        assert!(units_eq(&[0x70, 0x72, 0x6f], "pro"));
        assert!(!units_eq(&[0xd800], "pro"));
        assert!(!units_eq(&[0x70, 0x72], "pro"));
        assert!(!units_eq(&[0x70, 0x72, 0x6f, 0x00], "pro"));
    }

    #[test]
    fn lone_surrogate_plan_tiers_fall_back() {
        assert_eq!(
            select_chat_model_value(PlanTierValue::CodeUnits(&[0xd800]), false),
            MODELS.free
        );
        assert_eq!(
            get_background_summary_model_units(&[0xdc00]),
            BACKGROUND_MODELS.free
        );
        assert_eq!(get_provider_restriction_units(&[0xd800]), None);
    }

    #[test]
    fn serialization_keeps_source_order() {
        assert_eq!(
            MODELS.to_json_string(),
            r#"{"free":"deepseek/deepseek-v4.1-flash","exhausted":"meta/muse-spark-1.3-contributor","premium":"deepseek/deepseek-v4.1-flash","pro":"deepseek/deepseek-v4.1-flash"}"#
        );
        assert_eq!(
            CODING_MODELS.to_json_string(),
            r#"{"pro":"google/gemini-2.5-flash-lite","premium":"google/gemini-2.5-flash-lite","free":"z-ai/glm-4.5-air:nitro","exhausted":"z-ai/glm-4.5-air"}"#
        );
        assert!(
            to_json_string().contains(r#""MINIMAX_COST_PER_M_INPUT":0.6"#),
            "minimax input cost text"
        );
        assert!(
            to_json_string().contains(r#""MINIMAX_COST_PER_M_OUTPUT":2.4"#),
            "minimax output cost text"
        );
    }
}
