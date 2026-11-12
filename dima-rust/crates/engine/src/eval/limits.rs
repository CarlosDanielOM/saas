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
    /// that doubles in a loop would otherwise grow without bound. It is also the budget for
    /// what one step gathers: the arguments of one call together, the items of one list
    /// literal, the argument of one command reference, and the result of a builtin, which is
    /// sized before it is built.
    pub text_bytes: usize,
    /// The most a run may keep, in bytes: the variables it writes (memory variables and the
    /// database memo), its loop variables and the arguments of the command references it
    /// starts. Each value is within [`Self::text_bytes`]; this bounds how many there are.
    pub memory_bytes: usize,
    /// The deepest tree evaluated, at most [`MAX_EVAL_NESTING`]. The evaluator recurses on the
    /// thread's stack, one level per tree level, within the stack contract ([`crate::stack`]).
    /// A deeper tree (read back from storage, say: the parser already stops at the same depth)
    /// is refused before it runs (its segment shows `[Parse error: …]`) and the running depth is
    /// checked again as a guard. The deepest stored command in the production copy has 10
    /// levels.
    pub nesting: usize,
}

/// The deepest nesting [`EvalLimits::nesting`] may allow: the depth the stack contract is
/// proven for ([`crate::stack::EVAL_STACK_BYTES`]).
pub const MAX_EVAL_NESTING: usize = 32;

impl Default for EvalLimits {
    fn default() -> Self {
        Self {
            steps: 200_000,
            host_calls: 2_000,
            text_bytes: 256 * 1024,
            memory_bytes: 4 * 1024 * 1024,
            nesting: MAX_EVAL_NESTING,
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
    /// [`EvalLimits::memory_bytes`].
    Memory,
}

impl LimitKind {
    /// The text shown in chat, as `[Parse error: …]` for the expression that hit it.
    pub fn message(self) -> &'static str {
        match self {
            Self::Steps => "This command does too much work",
            Self::HostCalls => "This command calls too many functions",
            Self::TextSize => "This command builds text that is too long",
            Self::Nesting => "Nesting limit exceeded",
            Self::Memory => "This command keeps too much data",
        }
    }
}
