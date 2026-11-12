//! The evaluator (`evaluator.ts`, `render.ts`, `timer.ts`): runs compiled command text against
//! a [`Context`] and a [`Host`].
//!
//! - [`Engine::render`]: what the bot does with a command's response text
//!   (`renderAstWithSourceReference`): text segments copied, each expression evaluated in turn
//!   with the state threaded through, a parse error shown in place, an unclosed expression
//!   ending the output.
//! - [`Engine::evaluate`]: one program or node (`evaluate(ast, ctx)`), as the AI tools and the
//!   reference's tests call it.
//!
//! An evaluation is a `Send` future over `&mut dyn Host`; it keeps no global state and no
//! reference counting, so many run at once on a multi-threaded runtime.
//!
//! Differences from the reference, all on purpose:
//!
//! - text functions count characters, not UTF-16 units (`length`, `slice`, `capitalize`, the
//!   per-character spread of text event data into a command reference);
//! - text ordering (`<`, `>`, …) is by code point;
//! - resource limits ([`EvalLimits`]; the work and host-call limits are by plan, calibrated
//!   against the supported workload of [`SUPPORTED_STATEMENTS`]): when one is hit inside an
//!   expression, that expression's output is `[Parse error: …]` and rendering goes on (once the work, call or text budget is
//!   spent, every later expression hits it too); [`Engine::evaluate`] returns
//!   [`EvalError::Limit`]. Nothing is allocated past a limit first: a builtin sizes its
//!   result before building it, the values one step gathers (a call's arguments, a list
//!   literal's items, a reference's argument, a list written as JSON) are counted as they are
//!   gathered, and what a run keeps (variables, the database memo, loop variables, reference
//!   arguments) is charged to [`EvalLimits::memory_bytes`]. A tree deeper than
//!   [`EvalLimits::nesting`] (32, as the parser) is refused before any of it runs;
//! - the stack contract ([`crate::stack`]): every poll of an evaluation needs
//!   [`crate::stack::EVAL_STACK_BYTES`] left on a registered thread, or it stops with
//!   [`EvalError::Stack`]; within it, the deepest tree fits, as `tests/stack_contract.rs`
//!   proves in a debug build;
//! - `String()` and `Number()` fail where JavaScript throws ([`crate::value::CoercionError`]:
//!   an object with an own `toString` key, or a list holding one). Where the reference catches
//!   the throw, so does the port: a stored JSON value read as a list is then empty
//!   (`getArrayFromStorage`), a stored JSON list iterated by a loop is one item, its text
//!   (`parseIterableValue`), and removing a list item from a cache or database variable leaves
//!   it as it was. Everywhere else the evaluation stops with [`EvalError::Coercion`], as the
//!   reference's render does (it catches nothing);
//! - parse limits are the caller's ([`Engine::new`] takes the syntax [`Limits`]): the bot passes
//!   the input size its substituted texts need;
//! - a timer's snapshot is a copy taken when it is scheduled (the reference shares the
//!   responses array with the live context until the scheduler serialises it, which it does
//!   immediately);
//! - `JSON.parse` of stored values ([`crate::json`]) refuses nesting deeper than
//!   [`crate::json::MAX_JSON_NESTING`] (V8 reads any depth).

mod coerce;
mod frame;
mod limits;
mod run;
mod stack;
mod storage;

pub use limits::{
    EvalLimits, HOST_CALLS_PER_STATEMENT, LimitKind, MAX_EVAL_NESTING, PerPlan,
    STEPS_PER_STATEMENT, SUPPORTED_STATEMENTS,
};

use crate::context::{Context, State, TimerSnapshot};
use crate::host::{Host, HostError};
use crate::registry::Registry;
use crate::syntax::{
    AstNode, CompiledProgram, CompiledTemplate, Diagnostic, Limits, PreparedGrammar, SegmentStep,
    SyntaxEngine,
};
use crate::value::{CoercionError, Value};
use std::sync::Arc;

/// Why an evaluation stopped.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum EvalError {
    /// The host failed (the reference would have thrown).
    #[error(transparent)]
    Host(#[from] HostError),
    /// The random source failed.
    #[error("random number generator unavailable")]
    Random,
    /// A resource limit of this port.
    #[error("{}", .0.message())]
    Limit(LimitKind),
    /// `String()` or `Number()` threw, where nothing in the reference catches it: the command
    /// stops, as the reference's render does.
    #[error(transparent)]
    Coercion(#[from] CoercionError),
    /// The evaluation was polled with less stack than its contract needs
    /// ([`crate::stack::EVAL_STACK_BYTES`] left on a registered thread): it did not run on.
    #[error("the command engine was run with too little stack (see dima_engine::stack)")]
    Stack,
}

/// Work counters of a run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvalStats {
    /// Work units spent ([`EvalLimits::steps`]).
    pub steps: u64,
    /// Host calls made.
    pub host_calls: u64,
    /// The most stack the evaluation used below where it started, in bytes, seen at each level
    /// of the tree (on the thread of each poll).
    pub stack_bytes: usize,
}

/// The result of [`Engine::evaluate`].
#[derive(Debug)]
pub struct Evaluated {
    /// The value (`result.value`).
    pub value: Value,
    /// The state afterwards.
    pub state: State,
    /// Work counters.
    pub stats: EvalStats,
}

/// The result of [`Engine::render`].
#[derive(Debug)]
pub struct Rendered {
    /// The rendered text, before the bot's final unescape pass (`parsedText`).
    pub text: String,
    /// The state afterwards.
    pub state: State,
    /// Work counters.
    pub stats: EvalStats,
}

/// Syntax, registry, permission rules and limits, shared by every evaluation.
#[derive(Clone)]
pub struct Engine {
    syntax: SyntaxEngine,
    registry: Arc<Registry>,
    limits: EvalLimits,
}

impl Default for Engine {
    /// The reference grammar and registry, the syntax's default [`Limits`] and default
    /// [`EvalLimits`]. Production callers use [`Engine::new`] with the
    /// parse limits they need.
    fn default() -> Self {
        Self::new(Registry::standard(), Limits::default())
    }
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("functions", &self.registry.len())
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl Engine {
    /// An engine for the reference grammar with the caller's parse limits (the bot sets
    /// [`Limits::input_chars`] for its substituted texts) and default evaluation limits.
    pub fn new(registry: Arc<Registry>, syntax: Limits) -> Self {
        Self {
            syntax: SyntaxEngine::new(PreparedGrammar::default(), syntax),
            registry,
            limits: EvalLimits::default(),
        }
    }

    /// The same engine with other evaluation limits; the nesting is capped at
    /// [`MAX_EVAL_NESTING`].
    pub fn with_limits(mut self, mut limits: EvalLimits) -> Self {
        limits.nesting = limits.nesting.min(MAX_EVAL_NESTING);
        self.limits = limits;
        self
    }

    /// The same engine with another syntax.
    pub fn with_syntax(mut self, syntax: SyntaxEngine) -> Self {
        self.syntax = syntax;
        self
    }

    /// The syntax.
    pub fn syntax(&self) -> &SyntaxEngine {
        &self.syntax
    }

    /// The registry.
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// The limits.
    pub fn limits(&self) -> EvalLimits {
        self.limits
    }

    /// Compiles command text (placeholders already substituted) for [`Engine::render`]. A
    /// syntax resource limit inside one expression stays with that expression; only a text over
    /// [`Limits::input_chars`] fails.
    pub fn compile(&self, text: &str) -> Result<CompiledTemplate, Diagnostic> {
        self.syntax.compile_template(text)
    }

    /// Parses one program for [`Engine::evaluate_program`] (`parse`).
    pub fn parse(&self, text: &str) -> Result<CompiledProgram, Diagnostic> {
        self.syntax.parse(text)
    }

    /// Renders compiled command text (`renderAstWithSourceReference`).
    pub async fn render(
        &self,
        template: &CompiledTemplate,
        context: &Context,
        state: State,
        host: &mut dyn Host,
    ) -> Result<Rendered, EvalError> {
        stack::Guarded::new(self.render_guarded(template, context, state, host)).await
    }

    async fn render_guarded(
        &self,
        template: &CompiledTemplate,
        context: &Context,
        state: State,
        host: &mut dyn Host,
    ) -> Result<Rendered, EvalError> {
        let mut run = run::Run::new(self, context, state, host);
        let mut text = String::new();
        for plan in template.segments() {
            match plan.step() {
                SegmentStep::Text => text.push_str(plan.segment().text(template.source())),
                SegmentStep::Unclosed(_) => {
                    text.push_str("[Parse error: Unclosed expression]");
                    break;
                }
                SegmentStep::ParseError(error) => {
                    text.push_str("[Parse error: ");
                    text.push_str(&error.message);
                    text.push(']');
                }
                SegmentStep::Program(program) => match run.program(program.root()).await {
                    Ok(value) => text.push_str(&value.to_text_or_empty()?),
                    Err(EvalError::Limit(kind)) => {
                        run.after_limit();
                        text.push_str("[Parse error: ");
                        text.push_str(kind.message());
                        text.push(']');
                    }
                    Err(error) => return Err(error),
                },
            }
            if text.len() > self.limits.text_bytes {
                text = dima_text::truncate_bytes(&text, self.limits.text_bytes).to_owned();
                text.push_str("[Parse error: ");
                text.push_str(LimitKind::TextSize.message());
                text.push(']');
                break;
            }
        }
        let (state, stats) = run.finish();
        Ok(Rendered { text, state, stats })
    }

    /// Evaluates a parsed program (`evaluate(parse(text).ast, ctx)`).
    pub async fn evaluate_program(
        &self,
        program: &CompiledProgram,
        context: &Context,
        state: State,
        host: &mut dyn Host,
    ) -> Result<Evaluated, EvalError> {
        self.evaluate(program.root(), context, state, host).await
    }

    /// Evaluates any node (`evaluate(node, ctx)`), for instance a timer body read back from the
    /// cache. A tree deeper than [`EvalLimits::nesting`] is refused before it runs
    /// ([`EvalError::Limit`] with [`LimitKind::Nesting`]).
    pub async fn evaluate(
        &self,
        node: &AstNode,
        context: &Context,
        state: State,
        host: &mut dyn Host,
    ) -> Result<Evaluated, EvalError> {
        let run = run::Run::new(self, context, state, host);
        stack::Guarded::new(Self::finish_program(run, node)).await
    }

    async fn finish_program<'a>(
        mut run: run::Run<'a>,
        node: &AstNode,
    ) -> Result<Evaluated, EvalError> {
        let value = run.program(node).await?;
        let (state, stats) = run.finish();
        Ok(Evaluated {
            value,
            state,
            stats,
        })
    }

    /// `evaluateTimer(node, ctx)` on its own: a `$(timer …)` function node.
    pub async fn evaluate_timer(
        &self,
        args: &[AstNode],
        context: &Context,
        state: State,
        host: &mut dyn Host,
    ) -> Result<Evaluated, EvalError> {
        let run = run::Run::new(self, context, state, host);
        stack::Guarded::new(Self::finish_timer(run, args)).await
    }

    async fn finish_timer<'a>(
        mut run: run::Run<'a>,
        args: &[AstNode],
    ) -> Result<Evaluated, EvalError> {
        let value = run.timer(args).await?;
        let (state, stats) = run.finish();
        Ok(Evaluated {
            value,
            state,
            stats,
        })
    }

    /// `snapshotTimerContext(ctx)` of a context and state.
    pub fn snapshot(&self, context: &Context, state: &State) -> TimerSnapshot {
        run::snapshot(context, state, state.count, &state.loop_vars)
    }
}
