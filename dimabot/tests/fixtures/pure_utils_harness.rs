use dima_rust::utils::{
    chat_message, eventsub, eventsub_bits_config, json_number, links, twitch_reward_body,
};
use serde_json::{Value, json};

pub fn fixture() -> Value {
    serde_json::from_str(include_str!("pure_utils_cases.json")).expect("frozen source corpus")
}

fn number(value: Option<&Value>, default: f64) -> f64 {
    match value {
        None => default,
        Some(value) if value.get("$number").is_some() => match value["$number"].as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => panic!("invalid numeric fixture sentinel {other}"),
        },
        Some(value) => value.as_f64().expect("numeric fixture"),
    }
}

fn condition_json(value: eventsub::Condition) -> Value {
    Value::Object(
        value
            .iter()
            .map(|(key, value)| (key.to_owned(), json!(value)))
            .collect(),
    )
}

pub fn evaluate(case: &Value) -> Value {
    let input = &case["input"];
    match case["operation"].as_str().unwrap() {
        "reward_map" => Value::Object(twitch_reward_body::to_twitch_reward_body(
            input["body"].as_object().unwrap(),
            if input["mode"] == "create" {
                twitch_reward_body::TwitchRewardBodyMode::Create
            } else {
                twitch_reward_body::TwitchRewardBodyMode::Update
            },
        )),
        "reward_validate" => json!(twitch_reward_body::validate_reward_settings(
            input["body"].as_object().unwrap()
        )),
        "reward_only" => json!(twitch_reward_body::is_twitch_only_reward_update(
            input["body"].as_object().unwrap()
        )),
        "bits_config" => Value::Object(eventsub_bits_config::build_bits_eventsub_config(
            input.get("canonical"),
            input["legacy"].as_array().unwrap(),
        )),
        "helix_url" => Value::String(links::get_twitch_helix_url(
            input["endpoint"].as_str().unwrap(),
            input["params"].as_str(),
        )),
        "oauth_url" => Value::String(links::get_twitch_oauth_url(
            input["endpoint"].as_str(),
            input["params"].as_str(),
        )),
        "foreign_chat" => json!(chat_message::is_foreign_shared_chat_event(
            input["type"].as_str().unwrap(),
            &input["event"],
            input.get("receiver")
        )),
        "is_raid" => json!(eventsub::is_raid_event(input["type"].as_str().unwrap())),
        "raid_direction" => json!(eventsub::raid_direction_value(input.get("condition")).as_str()),
        "raid_config_type" => json!(eventsub::raid_config_type_value(
            input["type"].as_str().unwrap(),
            input.get("condition")
        )),
        "raid_condition" => condition_json(eventsub::raid_condition_value(
            input["channel"].as_str().unwrap(),
            input["direction"].as_str().unwrap(),
        )),
        "expected_condition" => Value::Object(eventsub::build_expected_condition_value(
            input["subscription"]["type"].as_str().unwrap(),
            &input["subscription"]["condition"],
            input["channel"].as_str().unwrap(),
        )),
        "circuit_breaker" => json!(eventsub::should_trip_circuit_breaker_numbers(
            number(input.get("total"), f64::NAN),
            number(input.get("unhealthy"), f64::NAN),
            number(input.get("ratio"), 0.25),
            number(input.get("minimum"), 5.0),
        )),
        "number_coercion" => {
            let result = json_number::to_number(&input["value"]);
            if result.is_finite() {
                json!(result)
            } else {
                json!(json_number::number_string(result))
            }
        }
        "number_string" => json!(json_number::number_string(number(
            input.get("value"),
            f64::NAN
        ))),
        other => panic!("unknown fixture operation {other}"),
    }
}

pub fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(l, r)| json_equal(l, r))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|other| json_equal(value, other))
                })
        }
        _ => left == right,
    }
}

pub fn benchmark_cases(fixture: &Value) -> Vec<&Value> {
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| {
            matches!(
                case["operation"].as_str().unwrap(),
                "reward_map"
                    | "bits_config"
                    | "helix_url"
                    | "oauth_url"
                    | "foreign_chat"
                    | "expected_condition"
                    | "circuit_breaker"
            ) && !case["input"].to_string().contains("$number")
        })
        .collect()
}

pub fn checksum(value: &Value) -> u64 {
    match value {
        Value::Bool(value) => u64::from(*value),
        Value::String(value) => value.encode_utf16().count() as u64,
        Value::Object(value) => value.len() as u64,
        _ => panic!("benchmark only includes boolean, string, and object operations"),
    }
}
