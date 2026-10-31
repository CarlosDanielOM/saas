//! Overlay queue control types from `controls.ts` and `live.ts`.
//! Platform scopes and pause revisions follow the studio control operation;
//! skip and clear capture delivery IDs separately and do not mutate pause state.

use std::collections::BTreeMap;

/// Event platforms accepted by the overlay studio.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum OverlayPlatform {
    /// Twitch event origin.
    Twitch,
    /// Kick event origin.
    Kick,
    /// Other event origin.
    Other,
}

/// Platforms accepted on the wire.
pub const OVERLAY_PLATFORMS: [&str; 3] = ["twitch", "kick", "other"];
/// Actions accepted on the wire.
pub const OVERLAY_ACTIONS: [&str; 4] = ["skip", "pause", "resume", "clear"];

/// A platform or the all-platform scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayScope {
    /// Every platform.
    All,
    /// One platform.
    Platform(OverlayPlatform),
}

/// An accepted studio control action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayAction {
    /// Skip currently selected events.
    Skip,
    /// Pause the selected scope.
    Pause,
    /// Resume the selected scope.
    Resume,
    /// Clear currently selected events.
    Clear,
}

/// Persisted pause state; missing platform entries remain distinct from false.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QueueState {
    /// Incremented for each pause or resume request.
    pub revision: u64,
    /// Global pause flag.
    pub all: bool,
    /// Per-platform pause overrides.
    pub platforms: BTreeMap<OverlayPlatform, bool>,
}

/// A skip or clear command with IDs captured when the request was made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueCommand {
    /// Unique command identifier supplied by the caller.
    pub id: String,
    /// Skip or clear action.
    pub action: QueueCommandAction,
    /// Selected event origin.
    pub platform: OverlayScope,
    /// Previously captured delivery IDs.
    pub event_ids: Vec<String>,
}

/// The two actions that can be persisted as commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueCommandAction {
    /// Skip selected deliveries.
    Skip,
    /// Clear selected deliveries.
    Clear,
}

/// Construct the TypeScript initial queue state.
pub fn initial_queue_state() -> QueueState {
    QueueState::default()
}

/// Whether a scope includes a platform.
pub fn platform_matches(scope: OverlayScope, platform: OverlayPlatform) -> bool {
    scope == OverlayScope::All || scope == OverlayScope::Platform(platform)
}

/// Apply pause or resume; skip and clear leave the stored state untouched.
/// Returns `None` on revision overflow instead of wrapping a persisted revision.
pub fn reduce_queue_state(
    state: &QueueState,
    action: OverlayAction,
    scope: OverlayScope,
) -> Option<QueueState> {
    let paused = match action {
        OverlayAction::Pause => true,
        OverlayAction::Resume => false,
        OverlayAction::Skip | OverlayAction::Clear => return Some(state.clone()),
    };
    let mut next = state.clone();
    next.revision = next.revision.checked_add(1)?;
    match scope {
        OverlayScope::All => {
            next.all = paused;
            next.platforms.clear();
        }
        OverlayScope::Platform(platform) => {
            next.platforms.insert(platform, paused);
        }
    }
    Some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_all_or_the_exact_platform() {
        assert!(platform_matches(OverlayScope::All, OverlayPlatform::Kick));
        assert!(platform_matches(OverlayScope::Platform(OverlayPlatform::Twitch), OverlayPlatform::Twitch));
        assert!(!platform_matches(OverlayScope::Platform(OverlayPlatform::Twitch), OverlayPlatform::Kick));
    }

    #[test]
    fn pause_and_resume_increment_and_all_clears_overrides() {
        let state = initial_queue_state();
        let state = reduce_queue_state(&state, OverlayAction::Pause, OverlayScope::Platform(OverlayPlatform::Kick)).expect("revision fits");
        assert_eq!(state.platforms.get(&OverlayPlatform::Kick), Some(&true));
        let state = reduce_queue_state(&state, OverlayAction::Resume, OverlayScope::All).expect("revision fits");
        assert_eq!(state.revision, 2);
        assert!(!state.all);
        assert!(state.platforms.is_empty());
    }

    #[test]
    fn skip_and_clear_do_not_change_pause_state() {
        let state = initial_queue_state();
        for action in [OverlayAction::Skip, OverlayAction::Clear] {
            assert_eq!(reduce_queue_state(&state, action, OverlayScope::All), Some(state.clone()));
        }
    }
}
