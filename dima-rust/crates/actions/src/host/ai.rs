//! The AI group of the command language: `$(ai)`, which asks the channel's AI personality and
//! answers its reply. Package **P4-ACT-AI-A** fills this module (the entry forwards to
//! [`crate::ai`]); until then [`call`] answers [`super::ActionError::NotYetPorted`].
//!
//! TypeScript it ports (baseline `0c71108e`): the `ai` function of
//! `utils/ast_parser/functions/channel.functions.ts`, which calls `executeAiCommand`
//! (`utils/ai/openrouter/command.ai.ts`, in [`crate::ai`]).

use super::{ActionError, DimaHost};
use dima_engine::host::{HostCall, HostError};
use dima_engine::value::Value;

/// The AI group's handles: P4-ACT-AI-A adds what `$(ai)` needs (the AI client of `dima-ai`,
/// the billing ledger of `dima-billing`). Empty until then.
#[derive(Debug, Default)]
pub struct Deps {}

/// Runs `$(ai)`.
pub async fn call(_host: &mut DimaHost, call: HostCall<'_>) -> Result<Value, HostError> {
    Err(ActionError::NotYetPorted(call.function).into())
}
