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
//! - resource limits ([`EvalLimits`]): when one is hit inside an expression, that expression's
//!   output is `[Parse error: …]` and rendering goes on (every later expression then hits it
//!   too); [`Engine::evaluate`] returns [`EvalError::Limit`];
//! - a timer's snapshot is a copy taken when it is scheduled (the reference shares the
//!   responses array with the live context until the scheduler serialises it, which it does
//!   immediately);
//! - `JSON.parse` of stored lists rejects nesting deeper than 127 and numbers beyond the double
//!   range, which the reference reads (as deep structures, or `Infinity`).

mod coerce;
mod frame;
mod limits;
mod run;
mod storage;

pub use limits::{EvalLimits, LimitKind};

use crate::context::{Context, State, TimerSnapshot};
use crate::host::{Host, HostError};
use crate::permissions::{Permissions, ReferencePermissions};
use crate::registry::Registry;
use crate::syntax::{
    AstNode, CompiledProgram, CompiledTemplate, Diagnostic, SegmentStep, SyntaxEngine,
};
use crate::value::Value;
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
}

/// Work counters of a run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvalStats {
    /// Work units spent ([`EvalLimits::steps`]).
    pub steps: u64,
    /// Host calls made.
    pub host_calls: u64,
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
    permissions: Arc<dyn Permissions>,
    limits: EvalLimits,
}

impl Default for Engine {
    /// The reference grammar, the reference registry, [`ReferencePermissions`], default limits.
    fn default() -> Self {
        Self::new(Registry::standard(), Arc::new(ReferencePermissions))
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
    /// An engine with the default syntax and limits.
    pub fn new(registry: Arc<Registry>, permissions: Arc<dyn Permissions>) -> Self {
        Self {
            syntax: SyntaxEngine::default(),
            registry,
            permissions,
            limits: EvalLimits::default(),
        }
    }

    /// The same engine with other evaluation limits.
    pub fn with_limits(mut self, limits: EvalLimits) -> Self {
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

    /// Compiles command text for [`Engine::render`]. A syntax resource limit inside one
    /// expression stays with that expression; only a source over the length limit fails.
    pub fn compile(&self, text: &str) -> Result<CompiledTemplate, Diagnostic> {
        self.syntax.compile_segments(text)
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
                SegmentStep::Program(program) => match run.root(program.root()).await {
                    Ok(value) => text.push_str(&value.to_text_or_empty()),
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
    /// cache. Nodes nested deeper than [`EvalLimits::nesting`] are refused.
    pub async fn evaluate(
        &self,
        node: &AstNode,
        context: &Context,
        state: State,
        host: &mut dyn Host,
    ) -> Result<Evaluated, EvalError> {
        if run::depth_exceeds(node, self.limits.nesting) {
            return Err(EvalError::Limit(LimitKind::Nesting));
        }
        let mut run = run::Run::new(self, context, state, host);
        let value = run.root(node).await?;
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
        let mut run = run::Run::new(self, context, state, host);
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
