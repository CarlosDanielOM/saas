//! Resource limits of an evaluation. The reference has none beyond the plan's loop depth and
//! iteration counts, the five-deep, fifty-reference command reference rules and the five-deep
//! timer rule (all kept); these are this port's, so that no command text can make the
//! evaluator run or allocate without bound.

/// Limits for one run (one rendered template, or one evaluated program).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EvalLimits {
    /// Work units: one per evaluated node, plus one per 256 bytes of JSON read or written.
    /// Four nested pro loops could otherwise run a body 100 million times.
    pub steps: u64,
    /// Calls into the host (functions, variable reads and writes, timers).
    pub host_calls: u64,
    /// The longest text any value, stored variable or the output may become, in bytes. Text
    /// that doubles in a loop would otherwise grow without bound.
    pub text_bytes: usize,
    /// AST nesting accepted by [`crate::eval::Engine::evaluate`] (the parser's own ceiling).
    pub nesting: usize,
}

impl Default for EvalLimits {
    fn default() -> Self {
        Self {
            steps: 200_000,
            host_calls: 2_000,
            text_bytes: 256 * 1024,
            nesting: crate::syntax::HARD_NESTING_CEILING,
        }
    }
}

/// Which limit was hit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LimitKind {
    /// [`EvalLimits::steps`].
    Steps,
    /// [`EvalLimits::host_calls`].
    HostCalls,
    /// [`EvalLimits::text_bytes`].
    TextSize,
    /// [`EvalLimits::nesting`].
    Nesting,
}

impl LimitKind {
    /// The text shown in chat, as `[Parse error: …]` for the expression that hit it.
    pub fn message(self) -> &'static str {
        match self {
            Self::Steps => "This command does too much work",
            Self::HostCalls => "This command calls too many functions",
            Self::TextSize => "This command builds text that is too long",
            Self::Nesting => "Nesting limit exceeded",
        }
    }
}
