//! Pure pet contracts compared with recordings of the frozen TypeScript.
use anyhow::{Context, Result, bail};
use dima_features::pets::{model, moods};
use serde_json::{Value, json};
fn recording() -> Result<Value> {
    let mut nodes: Vec<Value> = Vec::new();
    fn expand(value: Value, nodes: &[Value]) -> Result<Value> {
        if let Some(id) = value.get("$ref").and_then(Value::as_u64) {
            return nodes
                .get(id as usize)
                .cloned()
                .context("backward fixture reference");
        }
        Ok(value)
    }
    for line in include_str!("pets_reference.jsonl").lines() {
        let node: Value = serde_json::from_str(line)?;
        if let Some(root) = node.get("root") {
            return expand(root.clone(), &nodes);
        }
        let value = if let Some(items) = node.get("array").and_then(Value::as_array) {
            Value::Array(
                items
                    .iter()
                    .cloned()
                    .map(|v| expand(v, &nodes))
                    .collect::<Result<_>>()?,
            )
        } else if let Some(map) = node.get("object").and_then(Value::as_object) {
            Value::Object(
                map.iter()
                    .map(|(k, v)| Ok((k.clone(), expand(v.clone(), &nodes)?)))
                    .collect::<Result<_>>()?,
            )
        } else {
            bail!("invalid recording node");
        };
        nodes.push(value);
    }
    bail!("recording root missing")
}

#[test]
fn pets_recorded_model() -> Result<()> {
    let fixture = recording()?;
    for case in fixture["cases"].as_array().context("cases")? {
        let v = &case["input"];
        let result = match case["fn"].as_str().context("fn")? {
            "default" => Ok(model::default_settings()),
            "settings" => model::validate_settings(v),
            "moods" => moods::validate(v),
            "saved" => Ok(moods::saved(Some(v))),
            "resolve" => Ok(json!(moods::resolve(
                v.as_str().context("text")?,
                &moods::defaults()
            ))),
            "instruction" => Ok(json!(moods::instruction(&moods::defaults()))),
            "images" => {
                let tier = v["tier"].as_str().context("tier")?;
                let m = &v["v"];
                Ok(
                    json!({"slots":moods::image_slots(m),"active":moods::active_images(m,tier),"limit":moods::image_limit(tier),"config":moods::configuration(m,tier)}),
                )
            }
            "view" => Ok(model::request_view(Some(&v["v"]), v["enabled"] == true)),
            _ => bail!("unknown case"),
        };
        let actual = match result {
            Ok(v) => json!({"ok":v}),
            Err(e) => json!({"error":e.code}),
        };
        assert_eq!(actual, case["result"], "{}", case);
    }
    Ok(())
}
#[test]
fn pets_scalar_text_and_identity_bounds() -> Result<()> {
    let mut s = model::default_settings();
    s["name"] = json!("👋".repeat(40));
    assert!(model::validate_settings(&s).is_ok());
    s["name"] = json!("👋".repeat(41));
    assert!(model::validate_settings(&s).is_err());
    for name in ["é", "עברית", "\u{feff}Dima\u{feff}"] {
        s["name"] = json!(name);
        assert!(model::validate_settings(&s).is_ok());
    }
    assert!(model::command_id(&json!("command:_-09")).is_ok());
    for id in ["", "שלום", "x y"] {
        assert!(model::command_id(&json!(id)).is_err());
    }
    for (owns, tier, code) in [
        (false, "pro", "access_denied"),
        (true, "free", "plan_required"),
    ] {
        assert_eq!(
            model::require_plan(owns, tier)
                .err()
                .context("refusal")?
                .code,
            code
        );
    }
    for tier in ["premium", "pro"] {
        model::require_plan(true, tier)?;
    }
    assert!(model::terminal("expired"));
    assert!(!model::terminal("playing"));
    Ok(())
}
#[test]
fn pets_legacy_read_is_nonmutating() {
    let mut legacy = model::default_settings();
    legacy.as_object_mut().unwrap().remove("sources");
    legacy.as_object_mut().unwrap().remove("appearance");
    legacy["behavior"]
        .as_object_mut()
        .unwrap()
        .remove("queueSize");
    let prior = legacy.clone();
    let normalized = model::normalize_saved_settings(Some(&legacy));
    assert_eq!(
        normalized["sources"],
        json!({"independent":true,"readTts":false})
    );
    assert_eq!(normalized["behavior"]["queueSize"], 5);
    assert_eq!(legacy, prior);
    assert_eq!(
        model::normalize_saved_settings(None),
        model::default_settings()
    );
}
