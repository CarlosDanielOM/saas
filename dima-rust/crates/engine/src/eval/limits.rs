//! Resource limits of an evaluation. The reference has none beyond the plan's loop depth and
//! iteration counts, the five-deep, fifty-reference command reference rules and the five-deep
//! timer rule (all kept); these are this port's, so that no command text can make the
//! evaluator run or allocate without bound.
//!
//! The work and host-call limits follow the plan, as the reference's loop bounds do. They are
//! calibrated against the **supported workload**: two nested loops of the plan's iteration
//! count (Free 25, Premium 50, Pro 100) with [`SUPPORTED_STATEMENTS`] statements in the inner
//! body, each a read or a write of a variable of any storage (memory, `#`, `##`, `*`, `**`).
//! It completes; ten times that (ten times the statements) does not (`tests/workload.rs`).
//!
//! # One message
//!
//! A message (a chat message, a timer, a redemption) runs one command, which may start up to
//! fifty command references, at any depth. Each run has the limits above; all of them together
//! draw from one budget of [`EvalLimits::message_factor`] (2) times those figures, and the
//! message ends at [`EvalLimits::deadline_ms`] (`super::MessageBudget`). The worst one message
//! can cost, by default:
//!
//! | Plan    | Work units | Host calls | Kept       | Output  | Seconds |
//! |---------|-----------:|-----------:|-----------:|--------:|--------:|
//! | Free    |    375,000 |    187,500 | 8 MiB      | 512 KiB |      10 |
//! | Premium |  1,500,000 |    750,000 | 8 MiB      | 512 KiB |      10 |
//! | Pro     |  6,000,000 |  3,000,000 | 8 MiB      | 512 KiB |      10 |
//!
//! Computed from the limits (`super::MessageLimits::of`) and measured
//! (`tests/workload.rs`, `the_worst_message_is_bounded`): a command that starts fifty
//! references to the worst command spends exactly the work units, or the host calls, of its
//! row and stops; on a debug build with an in-memory host the Pro message takes 4.5 s (work)
//! and 4.8 s (host calls), about twice the worst single command. *Kept* is what the runs keep
//! (variables, memos, loop variables, reference arguments), each value within
//! [`EvalLimits::text_bytes`]; *output* is every run's rendered text together. *Seconds* is the
//! deadline on the host's clock: past it the message stops within one lease of work (1,024
//! units: well under a millisecond) or, during a host call, when the host's alarm fires
//! (`crate::host::Host::alarm`; a host without one lets that call finish, so its own timeout
//! is the overrun).

use crate::context::Plan;

/// Statements in the inner body of the supported workload.
pub const SUPPORTED_STATEMENTS: u64 = 50;

/// A limit for each plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PerPlan {
    /// Free.
    pub free: u64,
    /// Premium.
    pub premium: u64,
    /// Pro.
    pub pro: u64,
}

impl PerPlan {
    /// The same limit for every plan.
    pub const fn all(limit: u64) -> Self {
        Self {
            free: limit,
            premium: limit,
            pro: limit,
        }
    }

    /// The limit of `plan`.
    pub fn of(self, plan: Plan) -> u64 {
        match plan {
            Plan::Free => self.free,
            Plan::Premium => self.premium,
            Plan::Pro => self.pro,
        }
    }

    /// `per_statement` for every statement the supported workload of each plan runs.
    fn supported(per_statement: u64) -> Self {
        let workload = |plan: Plan| {
            let iterations = u64::from(plan.max_loop_iterations());
            iterations * iterations * SUPPORTED_STATEMENTS * per_statement
        };
        Self {
            free: workload(Plan::Free),
            premium: workload(Plan::Premium),
            pro: workload(Plan::Pro),
        }
    }
}

/// Work units allowed per statement of the supported workload. Measured, loops included: viewer
/// cache variables (`##`, the costliest) take 4.1 a statement, memory variables (the cheapest)
/// 1.6. Six leaves the costliest half again as much, and stays below ten times the cheapest,
/// so ten times the workload stops whatever its storage.
pub const STEPS_PER_STATEMENT: u64 = 6;

/// Host calls allowed per statement of the supported workload. Measured: viewer cache
/// variables (the costliest) make 2.5 a statement (a write sets and expires two keys, a read
/// finds the first); three leaves room.
pub const HOST_CALLS_PER_STATEMENT: u64 = 3;

/// Limits for one run (one rendered template, or one evaluated program).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EvalLimits {
    /// Work units, by plan: one per evaluated node and per host call, plus one per 256 bytes
    /// of JSON read or written. Four nested Pro loops could otherwise run a body 100 million
    /// times.
    pub steps: PerPlan,
    /// Calls into the host (functions, variable reads and writes, timers), by plan.
    pub host_calls: PerPlan,
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
    /// How many times one command's figures a whole message may spend
    /// ([`super::MessageLimits`]): the command a chat message (or a timer, or a redemption)
    /// runs and every command reference it starts, at any depth, draw their work, host calls,
    /// memory and output from one budget of [`Self::steps`], [`Self::host_calls`],
    /// [`Self::memory_bytes`] and [`Self::text_bytes`] times this. Each run still has its own
    /// limits. Two: a command with a few references runs as before, fifty heavy ones do not
    /// (the stored commands of the production copy use at most a small share of it,
    /// `tests/real_commands.rs`).
    pub message_factor: u64,
    /// How long one message may take, from its start to the end of its last command
    /// reference, in milliseconds of the host's clock, by plan ([`super::MessageBudget`]).
    /// Ten seconds: the supported workload takes well under a second in a debug build with an
    /// in-memory host (`tests/workload.rs`); waits and slow host calls are what reaches it.
    pub deadline_ms: PerPlan,
}

/// The default [`EvalLimits::message_factor`].
pub const MESSAGE_FACTOR: u64 = 2;

/// The default [`EvalLimits::deadline_ms`] of every plan.
pub const DEADLINE_MS: u64 = 10_000;

/// The deepest nesting [`EvalLimits::nesting`] may allow: the depth the stack contract is
/// proven for ([`crate::stack::EVAL_STACK_BYTES`]).
pub const MAX_EVAL_NESTING: usize = 32;

impl Default for EvalLimits {
    fn default() -> Self {
        Self {
            steps: PerPlan::supported(STEPS_PER_STATEMENT),
            host_calls: PerPlan::supported(HOST_CALLS_PER_STATEMENT),
            text_bytes: 256 * 1024,
            memory_bytes: 4 * 1024 * 1024,
            nesting: MAX_EVAL_NESTING,
            message_factor: MESSAGE_FACTOR,
            deadline_ms: PerPlan::all(DEADLINE_MS),
        }
    }
}

/// Which limit was hit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LimitKind {
    /// [`EvalLimits::steps`], or the message's ([`super::MessageLimits::steps`]).
    Steps,
    /// [`EvalLimits::host_calls`], or the message's.
    HostCalls,
    /// [`EvalLimits::text_bytes`], or the message's output.
    TextSize,
    /// [`EvalLimits::nesting`].
    Nesting,
    /// [`EvalLimits::memory_bytes`], or the message's.
    Memory,
    /// The message's deadline ([`EvalLimits::deadline_ms`]).
    Deadline,
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
            Self::Deadline => "This command took too long",
        }
    }
}
