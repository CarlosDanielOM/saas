//! Which model and limits a channel gets: `MODELS`, `TOKEN_LIMITS` and `selectChatModel` of
//! `utils/ai/constants.ts`, the tier helpers of `utils/ai/openrouter/ai.ts` (lines 262–320) and
//! `getModelInfo` of `command.ai.ts`.
//!
//! | Plan | Chat model | `max_tokens` (chat, `$(ai)`) | standalone text | background history | memories (channel, viewer) | semantic history |
//! |---|---|---|---|---|---|---|
//! | free | `deepseek/deepseek-v4.1-flash` | 25 000 | 2 048 | 15 | 2, 2 | the tier default, at most 30 |
//! | premium | `deepseek/deepseek-v4.1-flash` | 25 000 | 2 048 | 35 | 4, 3 | the tier default, at most 30 |
//! | pro | `deepseek/deepseek-v4.1-flash` | 25 000 | 2 048 | 100 | 6, 5 | the tier default, at most 30 |
//! | credits exhausted (any plan) | `meta/muse-spark-1.3-contributor` | 25 000 | 2 048 | as the plan | as the plan | as the plan |
//!
//! Pets and the desktop cap `max_tokens` at 1 024. A plan text other than `premium` or `pro`
//! (missing, `free`, anything else) is free. The semantic default per tier is
//! `getSemanticMemoryLimitForTier` of `qdrant/functions/chat_logs/retrieve_chat_context.qdrant.ts`,
//! which the AI chat (P4-ACT-AI-B) reads with the retrieval itself; here is only the cap of 30.

/// `MODELS.free`, `MODELS.premium`, `MODELS.pro`: every plan uses the same model today.
pub const MODEL_FREE: &str = "deepseek/deepseek-v4.1-flash";
/// `MODELS.premium`.
pub const MODEL_PREMIUM: &str = "deepseek/deepseek-v4.1-flash";
/// `MODELS.pro`.
pub const MODEL_PRO: &str = "deepseek/deepseek-v4.1-flash";
/// `MODELS.exhausted`: the model of a channel whose AI credits are exhausted.
pub const MODEL_EXHAUSTED: &str = "meta/muse-spark-1.3-contributor";

/// `TOKEN_LIMITS.default`, the only entry: every model's output limit.
pub const TOKEN_LIMIT_DEFAULT: u32 = 25_000;

/// `Math.min(getTokenLimit(model), 2048)`: `generateStandaloneText`'s default output limit.
pub const STANDALONE_MAX_TOKENS: u32 = 2_048;

/// `Math.min(getTokenLimit(model), 1024)`: the output limit of a pet's or the desktop's chat.
pub const COMPANION_MAX_TOKENS: u32 = 1_024;

/// `Math.min(effectiveLimit, 30)`: the cap of semantic chat history.
pub const SEMANTIC_HISTORY_CAP: f64 = 30.0;

/// A plan tier as the AI reads it (`streamer.plan_tier`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tier {
    /// `free`, missing, or any other text.
    Free,
    /// `premium`.
    Premium,
    /// `pro`.
    Pro,
}

impl Tier {
    /// `plan_tier === "pro"` / `"premium"`, else free.
    pub fn of(plan_tier: Option<&str>) -> Self {
        match plan_tier {
            Some("pro") => Self::Pro,
            Some("premium") => Self::Premium,
            _ => Self::Free,
        }
    }

    /// The reference's name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Premium => "premium",
            Self::Pro => "pro",
        }
    }
}

/// `selectChatModel(streamer, isExhausted)`.
pub fn select_chat_model(plan_tier: Option<&str>, exhausted: bool) -> &'static str {
    if exhausted {
        return MODEL_EXHAUSTED;
    }
    match Tier::of(plan_tier) {
        Tier::Pro => MODEL_PRO,
        Tier::Premium => MODEL_PREMIUM,
        Tier::Free => MODEL_FREE,
    }
}

/// `getTokenLimit(model)`: `TOKEN_LIMITS[model] || TOKEN_LIMITS.default`, which is 25 000 for
/// every model (the table has no other entry).
pub fn token_limit(_model: &str) -> u32 {
    TOKEN_LIMIT_DEFAULT
}

/// `getEffectiveSemanticLimit(planTier, userLimit)`: the channel's own limit, else the tier's
/// default (`tier_default`, from the retrieval), capped at 30.
pub fn effective_semantic_limit(tier_default: f64, user_limit: Option<f64>) -> f64 {
    user_limit.unwrap_or(tier_default).min(SEMANTIC_HISTORY_CAP)
}

/// `getBackgroundHistoryLimitForTier(planTier)`: live and semantic chat lines in the prompt,
/// apart from the direct thread.
pub fn background_history_limit(tier: Tier) -> usize {
    match tier {
        Tier::Pro => 100,
        Tier::Premium => 35,
        Tier::Free => 15,
    }
}

/// `getMemoryContextLimitsForTier(planTier)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryLimits {
    /// Channel memories in the prompt.
    pub channel: usize,
    /// Facts about the current viewer in the prompt.
    pub current_user: usize,
}

/// `getMemoryContextLimitsForTier(planTier)`.
pub fn memory_context_limits(tier: Tier) -> MemoryLimits {
    match tier {
        Tier::Pro => MemoryLimits {
            channel: 6,
            current_user: 5,
        },
        Tier::Premium => MemoryLimits {
            channel: 4,
            current_user: 3,
        },
        Tier::Free => MemoryLimits {
            channel: 2,
            current_user: 2,
        },
    }
}

/// `ModelInfo` of `getModelInfo(streamer)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    /// The model.
    pub model: &'static str,
    /// The tier.
    pub tier: Tier,
    /// Its output limit.
    pub max_tokens: u32,
}

/// `getModelInfo(streamer)` (`command.ai.ts`; exported, called by nothing in the reference).
pub fn model_info(plan_tier: Option<&str>) -> ModelInfo {
    let tier = Tier::of(plan_tier);
    let model = select_chat_model(plan_tier, false);
    ModelInfo {
        model,
        tier,
        max_tokens: token_limit(model),
    }
}
