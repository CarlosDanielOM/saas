//! Compare the pure widget input model with unedited recordings of the frozen TypeScript.
use anyhow::{Context, Result, bail};
use dima_features::widgets::model;
use serde_json::{Value, json};

// Nodes point backwards, so expansion is bounded by the recording's line count.
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
    for line in include_str!("widgets_reference.json").lines() {
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
fn widgets_recorded_inputs_and_public_projection() -> Result<()> {
    let fixture: Value = recording()?;
    assert_eq!(model::catalog()?, fixture["catalog"]);
    assert_eq!(model::initial(), fixture["initial"]);
    for case in fixture["cases"].as_array().context("cases")? {
        let input = &case["input"];
        let result = match case["fn"].as_str().context("fn")? {
            "config" => model::config(input),
            "layout" => model::layout(input),
            "pack" => model::pack(input.as_str().context("pack id")?),
            "normalize" => {
                let mut state = input.clone();
                model::normalize(&mut state).map(|()| state)
            }
            "publicState" => model::public_state(&mut input.clone()),
            "active" => Ok(model::active(input).into()),
            "idle" => model::idle(input).map(|()| Value::Null),
            other => bail!("unimplemented recorded function {other}"),
        };
        let actual = match result {
            Ok(value) => json!({"ok":value}),
            Err(error) => {
                json!({"error":{"code":error.code,"message":error.message,"status":error.status}})
            }
        };
        // Forty astral characters fit the migration's scalar-value text budget. Node
        // counts eighty UTF-16 units and refuses this one recorded configuration.
        let scalar_exception = input["subWheels"][0]["name"]
            .as_str()
            .is_some_and(|s| s == "👋".repeat(40));
        if scalar_exception {
            assert!(actual.get("ok").is_some());
            assert!(case["result"].get("error").is_some());
            continue;
        }
        assert_eq!(
            actual, case["result"],
            "{}: {}",
            case["name"], case["input"]
        );
    }
    Ok(())
}

#[derive(Debug)]
struct RecordedRandom(i64);
impl dima_core::Random for RecordedRandom {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), dima_core::RandomError> {
        bytes.fill(0);
        Ok(())
    }
    fn int(&self, min: i64, max: i64) -> Result<i64, dima_core::RandomError> {
        Ok(min + self.0 % (max - min))
    }
}

#[test]
fn widgets_recorded_draws_sequences_and_due_transitions() -> Result<()> {
    let fixture: Value = recording()?;
    for scenario in fixture["transitions"].as_array().context("transitions")? {
        let mut state = scenario["input"].clone();
        let random = RecordedRandom(scenario["ticket"].as_i64().context("ticket")?);
        for step in scenario["steps"].as_array().context("steps")? {
            let now = step["now"].as_i64().context("now")?;
            let result = match step["op"].as_str().context("op")? {
                "start" => model::start(&mut state, now, scenario["mode"].as_str(), &random)
                    .map(|()| Value::Null),
                "early" | "settle" => model::settle(&mut state, now, &random).map(Value::from),
                "reveal" => {
                    let votes: Vec<i64> = serde_json::from_value(scenario["votes"].clone())?;
                    model::reveal(&mut state, &votes, now, &random).map(|()| Value::Null)
                }
                other => bail!("unexpected operation {other}"),
            };
            let actual = match result {
                Ok(v) => json!({"ok":v}),
                Err(e) => json!({"error":{"code":e.code,"message":e.message,"status":e.status}}),
            };
            assert_eq!(
                actual, step["result"],
                "{} {}",
                scenario["name"], step["op"]
            );
            assert_eq!(state, step["state"], "{} {}", scenario["name"], step["op"]);
            assert_eq!(model::public_state(&mut state.clone())?, step["public"]);
            assert_eq!(model::poll_points_per_vote(&state), step["price"]);
        }
    }
    Ok(())
}

#[test]
fn widgets_recording_provenance() -> Result<()> {
    let fixture: Value = recording()?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("dimabot/src");
    for (file, hash) in fixture["sources"].as_object().context("source hashes")? {
        assert_eq!(
            dima_core::crypto::sha256(std::fs::read(root.join(file))?).hex(),
            hash.as_str().context("hash")?,
            "reference drift: {file}"
        );
    }
    assert_eq!(
        serde_json::from_str::<Value>(include_str!("../src/widgets/dbd.json"))?,
        serde_json::from_slice::<Value>(&std::fs::read(root.join("widgets/dbd.json"))?)?
    );
    Ok(())
}
