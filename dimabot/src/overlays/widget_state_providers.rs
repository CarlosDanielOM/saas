//! Interaction compatibility projection from `widget-state-providers.ts`.
//! The concrete provider reuses the existing `MongoInteractions` adapter. Poll
//! and prediction share one sanitized public aggregate read per channel, and
//! the transitional legacy envelope is projected from the same widget states.

use std::sync::Arc;

use crate::domain_event_contracts::interaction::{InteractionSnapshot, InteractionState};
use crate::utils::lossless_json::{parse_json, JsonValue};

use super::interactions::MongoInteractions;
use super::widget_contract::{WidgetStateEntry, WidgetStates};
pub use super::widget_contract::INTERACTION_SOURCE;
use super::widget_state::{StateFuture, WidgetStateRegistry, WidgetStateSource};

/// Convert a public interaction snapshot into widget states. Both keys are
/// always present; an absent aggregate is an explicit clear.
pub fn interaction_states(snapshot: &InteractionSnapshot) -> Result<WidgetStates, String> {
    Ok(WidgetStates::from([
        ("poll".into(), interaction_entry(snapshot.poll.as_ref())?),
        (
            "prediction".into(),
            interaction_entry(snapshot.prediction.as_ref())?,
        ),
    ]))
}

/// Package one interaction aggregate as a public widget state entry. The
/// revision is preserved without eager validation; the registry applies the
/// safe-integer policy only to keys selected by visible state widgets, matching
/// the source provider. An invalid unselected aggregate therefore does not fail
/// a selected one.
pub fn interaction_entry(state: Option<&InteractionState>) -> Result<WidgetStateEntry, String> {
    let Some(state) = state else {
        return Ok(WidgetStateEntry::cleared());
    };
    let wire = serde_json::to_string(state).map_err(|_| "invalid interaction state".to_owned())?;
    Ok(WidgetStateEntry {
        revision: state.revision,
        state: parse_json(&wire).map_err(|_| "invalid interaction state".to_owned())?,
    })
}

/// Project the transitional compatibility envelope from the selected widget
/// states returned in a snapshot. Only null or a missing entry becomes `null`;
/// falsy state values are preserved exactly as the source's nullish coalescing
/// does.
pub fn legacy_interactions(states: &WidgetStates, server_time: f64) -> JsonValue {
    let state = |key: &str| {
        states
            .get(key)
            .map_or(JsonValue::Null, |entry| entry.state.clone())
    };
    JsonValue::Object(vec![
        ("poll".into(), state("poll")),
        ("prediction".into(), state("prediction")),
        ("serverTime".into(), JsonValue::Number(server_time)),
    ])
}

/// Built-in Mongo-backed sanitized Twitch interaction provider.
pub struct InteractionStateSource {
    interactions: MongoInteractions,
}

impl InteractionStateSource {
    /// Create the provider around an injected Mongo adapter; construction
    /// performs no I/O.
    pub fn new(interactions: MongoInteractions) -> Self {
        Self { interactions }
    }
}

impl WidgetStateSource for InteractionStateSource {
    fn source(&self) -> &str {
        INTERACTION_SOURCE
    }

    fn snapshot<'a>(&'a self, channel: &'a str, now_ms: i64) -> StateFuture<'a, WidgetStates> {
        Box::pin(async move {
            let snapshot = self
                .interactions
                .interaction_snapshot(channel, now_ms as f64)
                .await
                .map_err(|_| "interaction state unavailable".to_owned())?;
            interaction_states(&snapshot)
        })
    }
}

/// The concrete interaction source used by the live overlay runtime.
pub fn interaction_state_source(interactions: MongoInteractions) -> Arc<dyn WidgetStateSource> {
    Arc::new(InteractionStateSource::new(interactions))
}

/// Build the interaction-backed registry used by the live overlay runtime.
/// The source list has one entry, so the registry's duplicate check cannot fail.
pub fn widget_state_registry(
    interactions: MongoInteractions,
) -> Result<WidgetStateRegistry, String> {
    WidgetStateRegistry::with_sources(vec![interaction_state_source(interactions)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain_event_contracts::interaction::{
        InteractionChoice, InteractionKind, InteractionPhase,
    };
    use crate::overlays::widget_contract::{
        get_widget_definition, WidgetStateBinding,
    };

    fn poll_state(revision: f64) -> InteractionState {
        InteractionState {
            kind: InteractionKind::Poll,
            id: "poll-1".into(),
            title: "Best pet".into(),
            phase: InteractionPhase::Active,
            choices: vec![InteractionChoice {
                id: "cats".into(),
                title: "Cats".into(),
                votes: 3.0,
                channel_points_votes: Some(1.0),
                users: 0.0,
                points: 0.0,
                color: None,
            }],
            started_at: "2026-10-31T00:00:00.000Z".into(),
            deadline: Some("2026-10-31T00:01:00.000Z".into()),
            ended_at: None,
            winner_id: None,
            occurred_at: "2026-10-31T00:00:10.000Z".into(),
            receipt: "receipt-1".into(),
            revision,
        }
    }

    fn prediction_state() -> InteractionState {
        InteractionState {
            kind: InteractionKind::Prediction,
            id: "prediction-1".into(),
            title: "Winner".into(),
            phase: InteractionPhase::Locked,
            choices: vec![InteractionChoice {
                id: "a".into(),
                title: "A".into(),
                votes: 0.0,
                channel_points_votes: None,
                users: 2.0,
                points: 100.0,
                color: Some("pink".into()),
            }],
            started_at: "2026-10-31T00:00:00.000Z".into(),
            deadline: None,
            ended_at: None,
            winner_id: None,
            occurred_at: "2026-10-31T00:00:10.000Z".into(),
            receipt: "receipt-2".into(),
            revision: 4.0,
        }
    }

    #[test]
    fn snapshot_projects_sanitized_poll_and_prediction_entries() {
        let snapshot = InteractionSnapshot {
            poll: Some(poll_state(7.0)),
            prediction: None,
            server_time: 99.0,
        };
        let states = interaction_states(&snapshot).expect("states");
        assert_eq!(states.len(), 2);
        assert_eq!(
            states["poll"],
            WidgetStateEntry {
                revision: 7.0,
                state: parse_json(
                    r#"{"kind":"poll","id":"poll-1","title":"Best pet","phase":"active","choices":[{"id":"cats","title":"Cats","votes":3,"channelPointsVotes":1,"users":0,"points":0}],"startedAt":"2026-10-31T00:00:00.000Z","deadline":"2026-10-31T00:01:00.000Z","endedAt":null,"winnerId":null,"occurredAt":"2026-10-31T00:00:10.000Z","receipt":"receipt-1","revision":7}"#
                )
                .expect("json"),
            }
        );
        assert_eq!(states["prediction"], WidgetStateEntry::cleared());

        let snapshot = InteractionSnapshot {
            poll: None,
            prediction: Some(prediction_state()),
            server_time: 0.0,
        };
        let states = interaction_states(&snapshot).expect("states");
        assert_eq!(states["poll"], WidgetStateEntry::cleared());
        assert_eq!(
            states["prediction"],
            WidgetStateEntry {
                revision: 4.0,
                state: parse_json(
                    r#"{"kind":"prediction","id":"prediction-1","title":"Winner","phase":"locked","choices":[{"id":"a","title":"A","votes":0,"users":2,"points":100,"color":"pink"}],"startedAt":"2026-10-31T00:00:00.000Z","deadline":null,"endedAt":null,"winnerId":null,"occurredAt":"2026-10-31T00:00:10.000Z","receipt":"receipt-2","revision":4}"#
                )
                .expect("json"),
            }
        );
    }

    #[test]
    fn interaction_entry_preserves_source_revisions_for_registry_validation() {
        for revision in [-1.0, 1.5, 9_007_199_254_740_992.0, f64::INFINITY] {
            let entry = interaction_entry(Some(&poll_state(revision))).expect("entry");
            assert_eq!(entry.revision, revision);
            assert_ne!(entry.state, JsonValue::Null);
        }
        let not_a_number = interaction_entry(Some(&poll_state(f64::NAN))).expect("entry");
        assert!(not_a_number.revision.is_nan());
        assert_ne!(not_a_number.state, JsonValue::Null);
        assert_eq!(
            interaction_entry(None).expect("missing state"),
            WidgetStateEntry::cleared()
        );
        let zero = interaction_entry(Some(&poll_state(0.0))).expect("zero revision");
        assert_eq!(zero.revision, 0.0);
        assert_ne!(zero.state, JsonValue::Null);
    }

    #[test]
    fn interaction_states_preserve_unselected_invalid_aggregates_for_the_registry() {
        let mut prediction = prediction_state();
        prediction.revision = -1.0;
        let snapshot = InteractionSnapshot {
            poll: Some(poll_state(7.0)),
            prediction: Some(prediction),
            server_time: 0.0,
        };
        let states = interaction_states(&snapshot).expect("states");
        assert_eq!(states["poll"].revision, 7.0);
        assert_eq!(states["prediction"].revision, -1.0);
    }

    #[test]
    fn legacy_envelope_uses_the_same_read_and_preserves_falsy_states() {
        let snapshot = InteractionSnapshot {
            poll: Some(poll_state(3.0)),
            prediction: None,
            server_time: 0.0,
        };
        let states = interaction_states(&snapshot).expect("states");
        let legacy = legacy_interactions(&states, 42.0);
        assert_eq!(
            legacy,
            JsonValue::Object(vec![
                ("poll".into(), states["poll"].state.clone()),
                ("prediction".into(), JsonValue::Null),
                ("serverTime".into(), JsonValue::Number(42.0)),
            ])
        );

        let mut falsy = WidgetStates::new();
        falsy.insert(
            "prediction".into(),
            WidgetStateEntry {
                revision: 1.0,
                state: JsonValue::Bool(false),
            },
        );
        assert_eq!(
            legacy_interactions(&falsy, 0.0),
            parse_json(r#"{"poll":null,"prediction":false,"serverTime":0}"#).expect("json")
        );
        assert_eq!(
            legacy_interactions(&WidgetStates::new(), 0.0),
            parse_json(r#"{"poll":null,"prediction":null,"serverTime":0}"#).expect("json")
        );
    }

    #[test]
    fn interaction_definitions_use_the_registered_source() {
        for (kind, state_key) in [("poll", "poll"), ("prediction", "prediction")] {
            assert_eq!(
                get_widget_definition(kind).expect("definition").state,
                Some(WidgetStateBinding {
                    source: INTERACTION_SOURCE,
                    state_key,
                })
            );
        }
    }
}
