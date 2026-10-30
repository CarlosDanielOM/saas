#![cfg(feature = "moderation-semantic")]
//! Every captured source record is visited. Private HTTP only; no application boot.
#[path = "support/moderation_semantic.rs"]
mod support;
use dima_rust::utils::{
    lossless_json::{JsonValue, parse_json},
    moderation::semantic::*,
};
use serde_json::json;
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use support::*;

#[test]
#[ignore = "independently hashed actual-source fixture"]
fn all_pure_source_records() {
    let source = reference();
    let mut visited = BTreeSet::new();
    let mut boundaries = Vec::new();
    let constants = decode(&source["constants"]).unwrap();
    assert_eq!(
        number(
            constants
                .get("SEMANTIC_USD_PER_MILLION_INPUT_TOKENS")
                .unwrap()
        )
        .to_bits(),
        SEMANTIC_USD_PER_MILLION_INPUT_TOKENS.to_bits()
    );
    assert_eq!(
        text(constants.get("SEMANTIC_PRICING_VERSION").unwrap()).as_str(),
        Some(SEMANTIC_PRICING_VERSION)
    );
    assert_eq!(
        text(constants.get("FREE_MODERATION_MODEL").unwrap()).as_str(),
        Some(FREE_MODERATION_MODEL)
    );
    assert_eq!(
        text(constants.get("SPAM_RULE_ID").unwrap()).as_str(),
        Some(dima_rust::utils::moderation::types::SPAM_RULE_ID)
    );
    let attribution = obj(
        dima_rust::utils::openrouter_attribution::OPENROUTER_APP_HEADERS
            .iter()
            .map(|(k, v)| (*k, JsonValue::String((*v).into())))
            .collect(),
    );
    assert_eq!(
        encode(&attribution),
        encode(constants.get("OPENROUTER_APP_HEADERS").unwrap())
    );
    for case in source["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        assert!(visited.insert(id));
        let args = case["args"]["items"].as_array().unwrap();
        let name = case["export"].as_str().unwrap();
        if case["boundary"] == "unknown-category-enum" {
            let input = if name == "parseSpamResponse" {
                arg(args, 1).unwrap()
            } else {
                arg(args, 0)
                    .unwrap()
                    .get("rule")
                    .unwrap()
                    .get("semantic")
                    .unwrap()
                    .get("categories")
                    .unwrap()
                    .clone()
            };
            assert!(categories(&input).is_err());
            assert_eq!(case["result"]["ok"], true);
            boundaries.push(json!({"id":id,"reason":"unknown is not a SpamCategory literal; source accepts unchecked string, native enum rejects it; no valid category fabricated"}));
            continue;
        }
        if case["boundary"] == "sparse-context" {
            let mut raw = arg(args, 0).unwrap();
            let mut expected = decode(&case["result"]["value"]).unwrap();
            let tagged_context = args[0]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry[0] == json!("context".encode_utf16().collect::<Vec<_>>()))
                .unwrap();
            let holes = tagged_context[1]["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["kind"] == "hole")
                .collect::<Vec<_>>();
            let remove = |items: &mut Vec<JsonValue>| {
                let mut index = 0;
                items.retain(|_| {
                    let keep = !holes[index];
                    index += 1;
                    keep
                });
            };
            if let JsonValue::Object(fields) = &mut raw
                && let JsonValue::Array(items) = &mut fields
                    .iter_mut()
                    .find(|(k, _)| k.as_str() == Some("context"))
                    .unwrap()
                    .1
            {
                remove(items);
            }
            if let JsonValue::Object(fields) = &mut expected
                && let JsonValue::Object(state) = &mut fields
                    .iter_mut()
                    .find(|(k, _)| k.as_str() == Some("state"))
                    .unwrap()
                    .1
                && let JsonValue::Array(items) = &mut state
                    .iter_mut()
                    .find(|(k, _)| k.as_str() == Some("input"))
                    .unwrap()
                    .1
            {
                remove(items);
            }
            let actual = semantic_request_value(&raw, None).unwrap();
            assert_eq!(
                encode(&actual),
                encode(&expected),
                "{id}: defined source context elements"
            );
            boundaries.push(json!({"id":id,"reason":"ordinary JSON has no sparse holes; source map preserves holes rather than mapping null. Removed the same tagged hole slots from source input/output and replayed every defined context element; full original hole evidence retained"}));
            continue;
        }
        let actual: Result<JsonValue, String> = match name {
            "semanticPrice" => {
                let p = semantic_price(number(&arg(args, 0).unwrap()));
                Ok(obj(vec![
                    ("billableCostUSD", JsonValue::Number(p.billable_cost_usd)),
                    ("credits", JsonValue::Number(p.credits)),
                    (
                        "pricingVersion",
                        JsonValue::String(p.pricing_version.into()),
                    ),
                    (
                        "usdPerMillionInputTokens",
                        JsonValue::Number(p.usd_per_million_input_tokens),
                    ),
                ]))
            }
            "moderationModelForAccount" => {
                let tier = arg(args, 0);
                Ok(JsonValue::String(
                    moderation_model_for_account(
                        tier.as_ref(),
                        args[1]["value"].as_bool().unwrap(),
                    )
                    .into(),
                ))
            }
            "fallbackResult" => {
                let status = arg(args, 0).unwrap();
                let model = arg(args, 1);
                Ok(fallback_result(text(&status), model.as_ref().map(text)).to_json_value())
            }
            "parseSemanticResponse" => Ok(parse_semantic_response(
                &arg(args, 0).unwrap_or(JsonValue::Null),
                threshold(args, 1),
            )
            .to_json_value()),
            "parseSpamResponse" => Ok(parse_spam_response(
                &arg(args, 0).unwrap_or(JsonValue::Null),
                &categories(&arg(args, 1).unwrap()).unwrap(),
                threshold(args, 2),
            )
            .to_json_value()),
            "semanticRequest" => {
                let raw = arg(args, 0).unwrap();
                let model = arg(args, 1).filter(|v| !matches!(v, JsonValue::Null));
                semantic_request_value(&raw, model.as_ref().map(text)).map_err(|e| e.to_string())
            }
            export => panic!("unhandled export {export}"),
        };
        result(actual, &case["result"], id);
    }
    assert_eq!(visited.len(), source["cases"].as_array().unwrap().len());
    for record in source["abortNormal"].as_array().unwrap() {
        assert_eq!(record["result"]["ok"], true);
        let value = decode(&record["result"]["value"]).unwrap();
        assert_eq!(
            text(value.get("constructor").unwrap()).as_str(),
            Some("AbortSignal")
        );
        assert_eq!(value.get("aborted"), Some(&JsonValue::Bool(false)));
    }
    assert_eq!(source["abortOverflow"]["aborted"], true);
    assert_eq!(source["abortOverflow"]["reasonName"], "TimeoutError");
    for record in source["abortContract"].as_array().unwrap() {
        assert_eq!(record["result"]["ok"], false);
        let n = number(&decode(&record["input"]).unwrap());
        assert!(!n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > f64::from(u32::MAX));
    }
    println!(
        "{}",
        json!({"pureRecordsVisited":visited.len(),"explicitBoundaries":boundaries,"typeErrorAdapter":"native RequestError carries source construction TypeError semantics; engine-specific English message is retained only as evidence"})
    );
}

#[derive(Clone, Debug)]
struct HttpRequest {
    start: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
struct ReplayClock {
    values: Vec<f64>,
    cursor: std::cell::Cell<usize>,
}
impl SemanticClock for ReplayClock {
    fn now_ms(&self) -> f64 {
        let index = self.cursor.get();
        self.cursor.set(index + 1);
        *self
            .values
            .get(index)
            .unwrap_or_else(|| self.values.last().unwrap())
    }
}
struct Endpoint {
    url: String,
    requests: Arc<Mutex<Vec<HttpRequest>>>,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}
impl Endpoint {
    fn new(status: u16, body: Vec<u8>, disconnect: bool, delay: Duration) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let shutdown = stop.clone();
        let join = thread::spawn(move || {
            while !shutdown.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        if let Some(request) = read_request(&mut stream) {
                            records.lock().unwrap().push(request);
                        } else {
                            continue;
                        }
                        let start = Instant::now();
                        while start.elapsed() < delay && !shutdown.load(Ordering::Relaxed) {
                            thread::sleep(Duration::from_millis(1));
                        }
                        if !disconnect && !shutdown.load(Ordering::Relaxed) {
                            let header = format!(
                                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(header.as_bytes());
                            let _ = stream.write_all(&body);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                }
            }
        });
        Self {
            url: format!("http://{address}/api/alpha/decisions"),
            requests,
            stop,
            join: Some(join),
        }
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            join.join().unwrap();
        }
    }
}
fn read_request(stream: &mut TcpStream) -> Option<HttpRequest> {
    let mut bytes = Vec::new();
    let end = loop {
        let mut chunk = [0; 4096];
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        assert!(bytes.len() < 1024 * 1024);
    };
    let header = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let mut lines = header.split("\r\n");
    let start = lines.next().unwrap().to_string();
    let headers = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
        })
        .collect::<Vec<_>>();
    let length = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .map_or(0, |(_, v)| v.parse::<usize>().unwrap());
    while bytes.len() < end + length {
        let mut chunk = [0; 4096];
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    Some(HttpRequest {
        start,
        headers,
        body: bytes[end..end + length].to_vec(),
    })
}
fn header<'a>(request: &'a HttpRequest, name: &str) -> &'a str {
    request
        .headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
        .unwrap()
}
fn config_text(config: &JsonValue, key: &str) -> Option<String> {
    config.get(key).and_then(|v| {
        if let JsonValue::String(s) = v {
            s.as_str().map(str::to_owned)
        } else {
            None
        }
    })
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "independently hashed source fixture; real private HTTP loopback"]
async fn every_evaluate_record_through_concrete_provider() {
    let source = reference();
    let now = source["metadata"]["fixedClockMilliseconds"]
        .as_i64()
        .unwrap() as f64;
    let mut visited = BTreeSet::new();
    let mut adaptations = Vec::new();
    for case in source["evaluate"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        assert!(visited.insert(id));
        let mut decision = decode(&case["decision"]).unwrap();
        let config = decode(&case["config"]).unwrap();
        let model = decode(&case["model"]).filter(|v| !matches!(v, JsonValue::Null));
        let status = config.get("status").map(number).unwrap_or(200.0) as u16;
        let body=config_text(&config,"wireBody").unwrap_or_else(||"{\"answers\":{\"violation\":{\"type\":\"noul\",\"noul\":0.9}},\"usage\":{\"cost\":0.001,\"input_tokens\":10},\"model\":\"provider-model\",\"provider\":\"fixture-provider\",\"id\":\"request-id\"}".into()).into_bytes();
        let throw = config.get("throw");
        let timeout_throw = throw
            .and_then(|v| v.get("name"))
            .is_some_and(|v| matches!(v,JsonValue::String(s)if s.as_str()==Some("TimeoutError")));
        let timeout = timeout_throw;
        if timeout {
            if let JsonValue::Object(fields) = &mut decision {
                let deadline = fields
                    .iter_mut()
                    .find(|(k, _)| k.as_str() == Some("deadline"))
                    .unwrap();
                deadline.1 = JsonValue::Number(now + 50.0);
            }
            adaptations.push(json!({"id":id,"adaptation":"source synthetic TimeoutError reproduced with actual private delayed HTTP; 2000ms source budget shortened to 50ms; exact request body unaffected"}));
        }
        if throw.is_some() && !timeout {
            adaptations.push(json!({"id":id,"adaptation":"synthetic thrown JS value reproduced as concrete HTTP disconnect before response; fallback compared with source under the same clock sequence; source Error identity retained as evidence"}));
        }
        if decision
            .get("deadline")
            .is_some_and(|v| matches!(v,JsonValue::Number(n)if *n-now==1.0))
        {
            if let JsonValue::Object(fields) = &mut decision {
                fields
                    .iter_mut()
                    .find(|(k, _)| k.as_str() == Some("deadline"))
                    .unwrap()
                    .1 = JsonValue::Number(now + 2000.0);
            }
            adaptations.push(json!({"id":id,"adaptation":"source synchronous fetch mock completes within 1ms without network scheduling; concrete loopback success uses 2000ms budget while comparing identical wire request; real expiry is exercised by TimeoutError case"}));
        }
        let endpoint = Endpoint::new(
            status,
            body,
            throw.is_some() && !timeout,
            if timeout {
                Duration::from_millis(200)
            } else {
                Duration::ZERO
            },
        );
        let key = match config.get("key") {
            None => Some("fixture-key".to_string()),
            Some(JsonValue::String(s)) => s.as_str().map(str::to_owned),
            _ => None,
        };
        // An explicitly undefined key was omitted by owned JSON decoding. Keep its
        // tagged presence so missing credentials are reproduced rather than defaulted.
        let tagged_key = case["config"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry[0] == json!("key".encode_utf16().collect::<Vec<_>>()));
        let key = if tagged_key.is_some_and(|entry| entry[1]["kind"] == "undefined") {
            None
        } else {
            key
        };
        if matches!(config.get("key"), Some(JsonValue::Null)) {
            adaptations.push(json!({"id":id,"adaptation":"synthetic null process.env entry is outside real Node string-or-absent environment; mapped to absent credentials with identical preflight result"}));
        }
        let provider = SemanticProvider::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            &endpoint.url,
            key,
        );
        let JsonValue::Array(clock_values) = decode(&case["clock"]).unwrap() else {
            panic!()
        };
        let clock = ReplayClock {
            values: clock_values.iter().map(number).collect(),
            cursor: std::cell::Cell::new(0),
        };
        let actual = provider
            .evaluate_value_with_clock(&decision, model.as_ref().map(text), &clock)
            .await
            .map(|v| v.to_json_value())
            .map_err(|e| e.to_string());
        result(actual, &case["result"], id);
        assert_eq!(
            clock.cursor.get(),
            clock_values.len(),
            "{id}: exact source wall-clock sample order"
        );
        let requests = endpoint.requests.lock().unwrap().clone();
        let expected = case["calls"].as_array().unwrap();
        assert_eq!(requests.len(), expected.len(), "{id}: request count");
        for (actual, expected) in requests.iter().zip(expected) {
            assert_eq!(actual.start, "POST /api/alpha/decisions HTTP/1.1");
            assert_eq!(
                string(&expected["url"]).as_str(),
                Some("https://openrouter.ai/api/alpha/decisions")
            );
            assert_eq!(expected["argc"], 2);
            let options = decode(&expected["options"]).unwrap();
            assert_eq!(text(options.get("method").unwrap()).as_str(), Some("POST"));
            let JsonValue::Object(headers) = options.get("headers").unwrap() else {
                panic!()
            };
            for (name, value) in headers {
                assert_eq!(
                    header(actual, &name.as_str().unwrap().to_ascii_lowercase()),
                    text(value).as_str().unwrap(),
                    "{id}: header {name:?}"
                );
            }
            assert_eq!(
                actual.body,
                text(options.get("body").unwrap())
                    .as_str()
                    .unwrap()
                    .as_bytes(),
                "{id}: exact source body bytes"
            );
            assert!(parse_json(std::str::from_utf8(&actual.body).unwrap()).is_ok());
            assert_eq!(expected["signal"]["constructor"], "AbortSignal");
            assert_eq!(expected["signal"]["aborted"], false);
            assert_eq!(expected["signal"]["hasReason"], false);
        }
        for value in case["timeouts"].as_array().unwrap() {
            let remaining = number(&decode(value).unwrap());
            assert!(remaining > 0.0 || !remaining.is_finite(), "{id}");
        }
    }
    assert_eq!(visited.len(), source["evaluate"].as_array().unwrap().len());
    println!(
        "{}",
        json!({"evaluateRecordsVisited":visited.len(),"concretePipeline":"SemanticProvider + reqwest + private TCP HTTP fixture; URL origin replaced with loopback while path/headers/body compare exactly","seamAdaptations":adaptations,"dateAdapter":"tagged actual-source Date becomes explicit binary64 deadline milliseconds; undefined object properties are omitted as in JSON.stringify"})
    );
}

#[tokio::test(flavor = "current_thread")]
async fn independent_client_timeout_resamples_wall_clock() {
    let raw=parse_json("{\"rule\":{\"id\":\"custom\",\"semantic\":{\"policy\":\"policy\",\"examples\":[]}},\"messageText\":\"target\",\"username\":\"author\",\"context\":[],\"matches\":[],\"channelID\":\"channel\",\"deadline\":2000}").unwrap();
    for (catch_time, expected) in [
        (0.0, "unavailable"),
        (-1000.0, "unavailable"),
        (3000.0, "timeout"),
    ] {
        let endpoint = Endpoint::new(200, b"{}".to_vec(), false, Duration::from_millis(200));
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(30))
            .build()
            .unwrap();
        let provider = SemanticProvider::new(client, &endpoint.url, Some("fixture-key".into()));
        let clock = ReplayClock {
            values: vec![0.0, catch_time],
            cursor: std::cell::Cell::new(0),
        };
        let result = provider
            .evaluate_value_with_clock(&raw, None, &clock)
            .await
            .unwrap();
        assert_eq!(result.status.as_str(), Some(expected));
        assert_eq!(clock.cursor.get(), 2);
    }
    // The native deadline signal retains its initial monotonic budget and maps
    // TimeoutError to timeout even if the sampled wall clock moved backwards.
    let mut short = raw;
    if let JsonValue::Object(fields) = &mut short {
        fields
            .iter_mut()
            .find(|(k, _)| k.as_str() == Some("deadline"))
            .unwrap()
            .1 = JsonValue::Number(30.0);
    }
    let endpoint = Endpoint::new(200, b"{}".to_vec(), false, Duration::from_millis(200));
    let provider = SemanticProvider::new(
        reqwest::Client::builder().no_proxy().build().unwrap(),
        &endpoint.url,
        Some("fixture-key".into()),
    );
    let clock = ReplayClock {
        values: vec![0.0, -1000.0],
        cursor: std::cell::Cell::new(0),
    };
    let result = provider
        .evaluate_value_with_clock(&short, None, &clock)
        .await
        .unwrap();
    assert_eq!(result.status.as_str(), Some("timeout"));
    assert_eq!(clock.cursor.get(), 2);
    if let JsonValue::Object(fields) = &mut short {
        fields
            .iter_mut()
            .find(|(k, _)| k.as_str() == Some("deadline"))
            .unwrap()
            .1 = JsonValue::Number(2147483648.0);
    }
    let overflow_endpoint = Endpoint::new(200, b"{}".to_vec(), false, Duration::from_millis(200));
    let overflow_provider = SemanticProvider::new(
        reqwest::Client::builder().no_proxy().build().unwrap(),
        &overflow_endpoint.url,
        Some("fixture-key".into()),
    );
    let clock = ReplayClock {
        values: vec![0.0, -1000.0],
        cursor: std::cell::Cell::new(0),
    };
    assert_eq!(
        overflow_provider
            .evaluate_value_with_clock(&short, None, &clock)
            .await
            .unwrap()
            .status
            .as_str(),
        Some("timeout")
    );
    assert_eq!(clock.cursor.get(), 2);
}
