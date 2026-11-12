//! `RequiredGoalContributionError` (reference:
//! `utils/ast_parser/required_goal_contribution_error.ts`): a durable EventSub action failed
//! before its goal contribution was journaled. The goal function raises it and chat delivery
//! lets it propagate so the event is retried (packages P4-ACT-MEDIA and P4-ACT-CORE).

/// See the module docs. Its text is the reference's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, thiserror::Error)]
#[error("Required goal contribution could not be journaled")]
pub struct RequiredGoalContributionError;

impl RequiredGoalContributionError {
    /// The reference's `name`.
    pub const NAME: &'static str = "RequiredGoalContributionError";
}
