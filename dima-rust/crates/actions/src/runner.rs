//! Running commands: looking a command up and executing its stored text
//! (`commandHandler`, `executeCustomCommand`), and the [`CommandRunner`] handle the AI chat's
//! tools run command language through. Package **P4-ACT-CORE** fills this module and implements
//! [`CommandRunner`]; the trait is declared now because the AI packages (P4-ACT-AI-B,
//! P4-ACT-AI-C) are written against it.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call:
//!
//! - `handlers/commands.handler.ts` (198 lines): `commandHandler`, `executeCustomCommand`
//! - `utils/ast_parser/index.ts` (50 lines): `parseAndEvaluate`

use dima_engine::context::Context;
use dima_engine::eval::EvalError;
use dima_engine::host::HostFuture;
use dima_engine::syntax::Diagnostic;
use dima_engine::value::Value;

/// What the AI chat's tools use to run command language, without naming the host or the
/// runner's implementation (plan section 2.1: "its tools get `&dyn ChatOut` and a
/// `CommandRunner` handle, not the host module").
///
/// Implemented by P4-ACT-CORE over the engine, [`crate::host::DimaHost`] and
/// [`crate::delivery::ChatDelivery`]; called by the `ast_parser` tool of [`crate::ai::catalog`]
/// (P4-ACT-AI-C) and by the tool loop of [`crate::ai::chat`] (P4-ACT-AI-B). A tool's test uses
/// a fake.
pub trait CommandRunner: Send + Sync {
    /// `parseAndEvaluate(program, context)` then `deliverAstMessage(channel, { parsedText: '',
    /// commandReferences })` (`utils/ai/tools/ast_parser.tool.ts:150-158`): parses `program` as
    /// one program, evaluates it as a message of its own with `context`, delivers the command
    /// references it produced (their own text is posted), and answers the program's value.
    ///
    /// The caller builds `context` as the tool does: an `llm` authorization carrying the real
    /// chatter's identity, a level never above the chatter's verified one, the channel's plan,
    /// and `enforce_function_permissions` on.
    fn run_program<'a>(
        &'a self,
        program: &'a str,
        context: Context,
    ) -> HostFuture<'a, Result<Value, RunError>>;
}

/// Why [`CommandRunner::run_program`] produced no value.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum RunError {
    /// The program does not parse (`[Parse error: …]` in chat).
    #[error("{}", .0.message)]
    Parse(Diagnostic),
    /// The evaluation stopped: a host failure, a limit, a coercion, the stack contract.
    #[error(transparent)]
    Eval(#[from] EvalError),
}
