//! The identity a command reference runs with comes from `dima-commands`' role rules (the
//! reviewed port of `roles.ts`), not from rules of the engine's own.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_commands::permissions::{UserIdentity, create_broadcaster_identity, parse_user_identity};
use dima_engine::context::{Authorization, Context, Origin, ReferenceOrigin, State};
use dima_engine::value::Value;
use memory::{MemoryHost, engine_with, render};
use serde_json::json;

fn reference_identity(context: &Context) -> (ReferenceOrigin, UserIdentity) {
    let engine = engine_with(&[]);
    let mut host = MemoryHost::new(1);
    let rendered = render(
        &engine,
        "#(target a b)",
        context,
        State::default(),
        &mut host,
    );
    let reference = rendered.state.command_references.first().unwrap();
    (
        reference.authorization.origin,
        reference.authorization.identity.clone(),
    )
}

#[test]
fn references_run_with_the_permission_systems_identities() {
    let authored = Context {
        broadcaster_id: "123".into(),
        enforce_function_permissions: false,
        ..Context::default()
    };
    assert_eq!(
        reference_identity(&authored),
        (ReferenceOrigin::Authored, create_broadcaster_identity())
    );
    let stored = [
        json!({"level": 7.8, "tags": ["mod", "INVALID", "mod"], "userId": "1234", "login": "UPPER"}),
        json!({"level": "9", "tags": "mod", "userId": "x1", "login": "no spaces"}),
        json!({"level": -100, "tags": ["broadcaster"]}),
        json!({"level": 1e300}),
        json!(["mod"]),
        json!("text"),
        json!(0),
        json!(null),
    ];
    for user_level in [1.0, 4.9, 12.0, f64::NAN] {
        let fallback = if user_level.is_finite() {
            user_level.trunc().clamp(1.0, 10.0)
        } else {
            1.0
        };
        for raw in &stored {
            let context = Context {
                broadcaster_id: "123".into(),
                enforce_function_permissions: true,
                user_level,
                authorization: Some(Authorization {
                    origin: Origin::Llm,
                    audit_origin: None,
                    identity: Some(Value::from(raw.clone())),
                }),
                ..Context::default()
            };
            // A falsy stored identity is not parsed (`authorization.identity ? … : …`).
            let truthy =
                !matches!(raw, serde_json::Value::Null) && raw != &json!(0) && raw != &json!("");
            let want = if truthy {
                parse_user_identity(Some(raw), fallback)
            } else {
                UserIdentity::new(fallback, [], None, None)
            };
            assert_eq!(
                reference_identity(&context),
                (ReferenceOrigin::Llm, want),
                "{raw} at level {user_level}"
            );
        }
    }
}
