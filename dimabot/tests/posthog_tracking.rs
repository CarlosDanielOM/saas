#![cfg(feature = "posthog-tracking")]

use dima_rust::utils::{
    ai_usage::{
        AiUsageContext, AiUsageContextInput, Category, EntryKind, ResourceType, UsageUnit,
        create_ai_usage_context,
    },
    js_string::JsString,
    lossless_json::{JsonValue, parse_json},
    posthog::{FLUSH_AT, FLUSH_INTERVAL_MS, POSTHOG_HOST, POSTHOG_PROJECT_KEY},
    posthog_lossless::PosthogLosslessConfig,
    posthog_tracking::{
        self as tracking, CaptureError, NativeUsageRecorded, PosthogTracking,
        PosthogTrackingRuntime, PreparedEvent, StreamerIdentityState, ai_operation,
        ai_usage_recorded, command, default_config, native_context, sdk_value, tts,
    },
};
use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicU16, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

fn s(v: &str) -> JsonValue {
    JsonValue::String(JsString::from(v))
}
fn obj(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(
        fields
            .into_iter()
            .map(|(k, v)| (JsString::from(k), v))
            .collect(),
    )
}
fn get<'a>(v: &'a JsonValue, k: &str) -> &'a JsonValue {
    v.get(k).unwrap_or_else(|| panic!("missing {k}"))
}
fn string(v: &JsonValue) -> &str {
    let JsonValue::String(s) = v else {
        panic!("expected string: {v:?}")
    };
    s.as_str().expect("scalar string")
}
fn array(v: &JsonValue) -> &[JsonValue] {
    let JsonValue::Array(a) = v else {
        panic!("expected array")
    };
    a
}
fn number(v: &JsonValue) -> f64 {
    let JsonValue::Number(n) = v else {
        panic!("expected number")
    };
    *n
}
fn command_input() -> JsonValue {
    parse_json(r#"{"channelID":"ch","channelName":"name","command":"!hi","status":"success","userID":"","username":""}"#).unwrap()
}
fn examples() -> Vec<PreparedEvent> {
    vec![command(&command_input()).unwrap(),
        tts(&parse_json(r#"{"channelID":"ch","channelName":"name","source":"ast","ttsType":"fish","characters":17,"message":"😀","status":"error","userID":"u","username":"n","mode":"","provider":null,"errorMessage":"bad"}"#).unwrap()).unwrap(),
        ai_usage_recorded(&parse_json(r#"{"context":{"schemaVersion":1,"pricingVersion":"legacy-polar-math-v1","entryId":"e","requestId":"r","entryKind":"usage","category":"tts","operation":"synthesize","source":"tts_queue","provider":"fish","channelID":"","quantity":0,"model":"","unit":"characters","resourceType":"speech","resourceId":"s","parentRequestId":"p"},"credits":1.5,"reason":"tts_fish","polarCostAmount":0,"inputTokens":0,"outputTokens":2,"totalTokens":2}"#).unwrap()).unwrap(),
        ai_operation(&parse_json(r#"{"requestId":"r","channelID":"ch","category":"tts","operation":"synthesize","source":"ast","lifecycle":"failed","requestedProvider":"fish","actualProvider":"piper","fallbackReason":"down","errorCode":"bad","resourceType":"speech","resourceId":"s","latencyMs":0}"#).unwrap()).unwrap()]
}

#[test]
fn direct_conversion_preserves_bits_and_defaults_without_acquiring_production_runtime() {
    let config = default_config(); // Inert; never call the production-key getter.
    assert_eq!(config.api_key, POSTHOG_PROJECT_KEY);
    assert_eq!(config.endpoint, format!("{POSTHOG_HOST}/batch/"));
    assert_eq!(config.flush_at, FLUSH_AT);
    assert_eq!(
        config.flush_interval,
        Duration::from_millis(FLUSH_INTERVAL_MS)
    );
    assert_eq!(config.max_batch_size, 100);
    // The installed Node wrapper overrides the core queue default.
    assert_eq!(config.max_queue_size, 10_000);
    assert_eq!(config.request_timeout, Duration::from_secs(10));
    assert_eq!(config.shutdown_timeout, Duration::from_secs(30));
    let mut context = create_ai_usage_context(
        "tts_fish",
        AiUsageContextInput {
            entry_id: Some("entry".into()),
            quantity: Some(-0.0),
            ..Default::default()
        },
    );
    for n in [
        -0.0,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::MAX,
        f64::MIN_POSITIVE,
        -1.25,
    ] {
        context.quantity = Some(n); // Public DTOs may be manually constructed.
        let c = native_context(&context).unwrap();
        assert_eq!(number(get(&c, "quantity")).to_bits(), n.to_bits());
        let p = NativeUsageRecorded {
            context: &context,
            credits: n,
            reason: "tts_fish",
            polar_cost_amount: Some(n),
            input_tokens: Some(n),
            output_tokens: None,
            total_tokens: None,
        }
        .prepare()
        .unwrap();
        for key in ["credits", "quantity", "polar_cost_amount", "input_tokens"] {
            assert_eq!(number(get(&p.properties, key)).to_bits(), n.to_bits());
        }
        let wire = sdk_value(&p.properties).unwrap();
        if !n.is_finite() {
            assert!(wire["credits"].is_null());
        }
        if n == 0.0 {
            assert_eq!(wire["credits"], 0);
        }
    }
    let bad = parse_json(r#"{"nested":{"\ud800":["\udc00"]}}"#).unwrap();
    assert_eq!(sdk_value(&bad), Err(CaptureError::UnrepresentableUtf16));
    let identities = StreamerIdentityState::default();
    let id = JsString::from_units(vec![0xd800]);
    let name = JsString::from_units(vec![0xdc00]);
    assert!(identities.identify(&id, &name).is_some());
    assert!(identities.identify(&id, &name).is_none());
    assert!(
        StreamerIdentityState::default()
            .identify(&id, &name)
            .is_some()
    );
    // These aliases compile without ever acquiring or invoking a default client.
    let _ = tracking::identifyStreamer;
    let _ = tracking::trackCommand;
    let _ = tracking::trackTts;
    let _ = tracking::trackAiUsageRecorded;
    let _ = tracking::trackAiOperation;
    let _ = tracking::shutdownPosthog;
}

#[test]
fn native_and_plain_usage_keep_every_field_order_bits_and_absence() {
    // Manually constructed DTOs must stay raw, without the context factory's
    // normalization, finite-number policy or schema-version default.
    let mut context = AiUsageContext {
        schema_version: 255,
        pricing_version: " raw 😀 ".into(),
        entry_id: "e😀".into(),
        request_id: " r ".into(),
        parent_request_id: Some(String::new()),
        entry_kind: EntryKind::Adjustment,
        category: Category::Other,
        operation: " op ".into(),
        source: " source ".into(),
        provider: " provider ".into(),
        model: Some(String::new()),
        channel_id: Some("ch".into()),
        quantity: Some(-0.0),
        unit: Some(UsageUnit::Minutes),
        resource_type: Some(ResourceType::VodAnalysis),
        resource_id: Some(String::new()),
    };
    let native = NativeUsageRecorded {
        context: &context,
        credits: -0.0,
        reason: " reason ",
        polar_cost_amount: Some(0.0),
        input_tokens: Some(1.0),
        output_tokens: Some(2.0),
        total_tokens: Some(3.0),
    }
    .prepare()
    .unwrap();
    assert_eq!(native.distinct_id, JsString::from("ch"));
    assert_eq!(
        native.properties.to_json_string(),
        r#"{"$insert_id":"e😀","schema_version":255,"pricing_version":" raw 😀 ","entry_id":"e😀","request_id":" r ","parent_request_id":"","entry_kind":"adjustment","category":"other","operation":" op ","source":" source ","provider":" provider ","model":"","channel_id":"ch","credits":0,"reason":" reason ","polar_cost_amount":0,"quantity":0,"unit":"minutes","resource_type":"vod_analysis","resource_id":"","input_tokens":1,"output_tokens":2,"total_tokens":3}"#
    );
    assert_eq!(
        native_context(&context).unwrap().to_json_string(),
        r#"{"schemaVersion":255,"pricingVersion":" raw 😀 ","entryId":"e😀","requestId":" r ","entryKind":"adjustment","category":"other","operation":" op ","source":" source ","provider":" provider ","parentRequestId":"","model":"","channelID":"ch","resourceId":"","unit":"minutes","resourceType":"vod_analysis","quantity":0}"#
    );
    let names: Vec<_> = if let JsonValue::Object(fields) = &native.properties {
        fields.iter().map(|(k, _)| k.clone()).collect()
    } else {
        panic!("object")
    };
    for include_text in [false, true] {
        context.parent_request_id = include_text.then(String::new);
        context.model = include_text.then(String::new);
        context.resource_id = include_text.then(String::new);
        context.unit = include_text.then_some(UsageUnit::Tokens);
        context.resource_type = include_text.then_some(ResourceType::LlmGeneration);
        for channel in [None, Some(""), Some(" ch😀 ")] {
            context.channel_id = channel.map(str::to_owned);
            for value in [
                None,
                Some(-0.0),
                Some(0.0),
                Some(f64::from_bits(0x7ff8_0000_0000_0042)),
                Some(f64::INFINITY),
                Some(f64::NEG_INFINITY),
                Some(f64::from_bits(1)),
                Some(f64::MAX),
            ] {
                context.quantity = value;
                let dto = NativeUsageRecorded {
                    context: &context,
                    credits: value.unwrap_or(-0.0),
                    reason: " reason ",
                    polar_cost_amount: value,
                    input_tokens: value,
                    output_tokens: value,
                    total_tokens: value,
                };
                let mut fields = vec![
                    ("context", native_context(&context).unwrap()),
                    ("credits", JsonValue::Number(dto.credits)),
                    ("reason", s(dto.reason)),
                ];
                if let Some(value) = value {
                    for name in [
                        "polarCostAmount",
                        "inputTokens",
                        "outputTokens",
                        "totalTokens",
                    ] {
                        fields.push((name, JsonValue::Number(value)));
                    }
                }
                let plain = ai_usage_recorded(&obj(fields)).unwrap();
                let direct = dto.prepare().unwrap();
                assert_eq!(direct.event, plain.event);
                assert_eq!(direct.distinct_id, plain.distinct_id);
                assert_eq!(
                    direct.distinct_id.as_str(),
                    Some(channel.filter(|c| !c.is_empty()).unwrap_or("billing: r "))
                );
                assert_raw(&direct.properties, &plain.properties);
                assert_eq!(
                    direct.properties.to_json_string(),
                    plain.properties.to_json_string()
                );
                let JsonValue::Object(fields) = &direct.properties else {
                    panic!("object")
                };
                assert_eq!(
                    fields.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
                    names
                );
                for (name, present) in [
                    ("parentRequestId", include_text),
                    ("model", include_text),
                    ("resourceId", include_text),
                    ("unit", include_text),
                    ("resourceType", include_text),
                    ("channelID", channel.is_some()),
                    ("quantity", value.is_some()),
                ] {
                    assert_eq!(
                        native_context(&context).unwrap().get(name).is_some(),
                        present
                    );
                }
            }
        }
    }
}

#[test]
fn plain_usage_keeps_falsy_channel_casts_utf16_and_required_error_order() {
    let base = parse_json(r#"{"schemaVersion":1,"pricingVersion":"p","entryId":["cast"],"requestId":"r\ud800","entryKind":"usage","category":"other","operation":"op","source":"src","provider":"p"}"#).unwrap();
    let params = |context| {
        obj(vec![
            ("context", context),
            ("credits", JsonValue::Number(-0.0)),
            ("reason", JsonValue::Null),
        ])
    };
    for channel in [
        None,
        Some(JsonValue::Null),
        Some(JsonValue::Bool(false)),
        Some(JsonValue::Number(-0.0)),
        Some(JsonValue::Number(f64::NAN)),
        Some(s("")),
    ] {
        let mut context = base.clone();
        let JsonValue::Object(fields) = &mut context else {
            panic!("object")
        };
        if let Some(value) = &channel {
            fields.push((JsString::from("channelID"), value.clone()));
        }
        let prepared = ai_usage_recorded(&params(context)).unwrap();
        assert_eq!(
            prepared.distinct_id.to_json_string(),
            r#""billing:r\ud800""#
        );
        assert_raw(
            get(&prepared.properties, "channel_id"),
            channel.as_ref().unwrap_or(&JsonValue::Null),
        );
        assert_eq!(
            get(&prepared.properties, "$insert_id"),
            get(&base, "entryId")
        );
        assert_eq!(get(&prepared.properties, "entry_id"), get(&base, "entryId"));
        assert_eq!(get(&prepared.properties, "reason"), &JsonValue::Null);
        assert_eq!(
            number(get(&prepared.properties, "credits")).to_bits(),
            (-0.0_f64).to_bits()
        );
    }
    for channel in [
        JsonValue::Bool(true),
        JsonValue::Number(1.0),
        obj(vec![]),
        JsonValue::Array(vec![]),
    ] {
        let mut context = base.clone();
        let JsonValue::Object(fields) = &mut context else {
            panic!("object")
        };
        fields.push((JsString::from("channelID"), channel));
        assert_eq!(
            ai_usage_recorded(&params(context)),
            Err(CaptureError::InvalidInput("channelID"))
        );
    }
    for (raw, expected) in [
        (r#"{}"#, "requestId"),
        (r#"{"requestId":"r"}"#, "entryId"),
        (r#"{"channelID":"ch"}"#, "entryId"),
        (r#"{"channelID":"ch","entryId":"e"}"#, "schemaVersion"),
        (r#"{"channelID":true}"#, "channelID"),
    ] {
        assert_eq!(
            ai_usage_recorded(&params(parse_json(raw).unwrap())),
            Err(CaptureError::InvalidInput(expected))
        );
    }
    assert_eq!(
        ai_usage_recorded(&obj(vec![])),
        Err(CaptureError::InvalidInput("context"))
    );
    assert_eq!(
        ai_usage_recorded(&params(JsonValue::Null)),
        Err(CaptureError::InvalidInput("context"))
    );
}

// Task-owned HTTP fixture. Accept/read/write have absolute bounds and byte caps.
// Every owned thread signals completion even on panic. Drop requests stop, waits
// for completion with a deadline, and joins only an already-completed thread.
// The short recv_timeout in accept is idle waiting, never pacing ready work.
struct Server {
    host: String,
    requests: mpsc::Receiver<Request>,
    status: Arc<AtomicU16>,
    stop: mpsc::Sender<()>,
    done: mpsc::Receiver<()>,
    worker: Option<thread::JoinHandle<()>>,
}
struct Request {
    path: String,
    body: Vec<u8>,
    release: Option<mpsc::Sender<()>>,
}
impl Drop for Request {
    fn drop(&mut self) {
        if let Some(tx) = self.release.take() {
            let _ = tx.send(());
        }
    }
}
impl Server {
    fn new(gated: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let (tx, requests) = mpsc::channel();
        let (stop, stopping) = mpsc::channel();
        let (finish, done) = mpsc::channel();
        let status = Arc::new(AtomicU16::new(200));
        let response_status = status.clone();
        let worker = thread::spawn(move || {
            struct Finish(mpsc::Sender<()>);
            impl Drop for Finish {
                fn drop(&mut self) {
                    let _ = self.0.send(());
                }
            }
            let _finish = Finish(finish);
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                if Instant::now() >= deadline || stopping.try_recv().is_ok() {
                    return;
                }
                let (mut socket, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if stopping.recv_timeout(Duration::from_millis(2)).is_ok() {
                            return;
                        }
                        continue;
                    }
                    Err(e) => panic!("accept: {e}"),
                };
                let (path, body) = read_request(&mut socket);
                let (release, wait) = mpsc::channel();
                if tx
                    .send(Request {
                        path,
                        body,
                        release: gated.then_some(release),
                    })
                    .is_err()
                {
                    return;
                }
                if gated {
                    let _ = wait.recv_timeout(Duration::from_secs(3));
                }
                let status = response_status.load(Ordering::SeqCst);
                socket
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let reply = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{{\"status\":1}}"
                );
                // Timeout tests may have closed their end already.
                let _ = socket.write_all(reply.as_bytes());
            }
        });
        Self {
            host,
            requests,
            status,
            stop,
            done,
            worker: Some(worker),
        }
    }
    fn next(&self) -> Request {
        self.requests
            .recv_timeout(Duration::from_secs(8))
            .expect("bounded loopback request")
    }
    fn empty(&self) {
        assert!(matches!(
            self.requests.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if self.done.recv_timeout(Duration::from_secs(8)).is_ok() {
            if let Some(worker) = self.worker.take() {
                let result = worker.join();
                if !thread::panicking() {
                    result.expect("fixture thread panicked");
                }
            }
        } else if !thread::panicking() {
            panic!("fixture thread exceeded teardown deadline");
        }
    }
}
fn read_request(socket: &mut TcpStream) -> (String, Vec<u8>) {
    socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut bytes = Vec::new();
    let mut buf = [0; 8192];
    loop {
        assert!(
            Instant::now() < deadline && bytes.len() <= 4 * 1024 * 1024,
            "bounded request"
        );
        match socket.read(&mut buf) {
            Ok(0) => panic!("early EOF"),
            Ok(n) => bytes.extend_from_slice(&buf[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(e) => panic!("read: {e}"),
        }
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let header = std::str::from_utf8(&bytes[..end]).unwrap();
            let path = header
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap()
                .to_owned();
            assert_eq!(path, "/batch/");
            let len: usize = header
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .expect("content-length");
            assert!(len <= 4 * 1024 * 1024);
            if bytes.len() >= end + 4 + len {
                return (path, bytes[end + 4..end + 4 + len].to_vec());
            }
        }
    }
}
async fn sdk(server: &Server, flush_at: usize) -> PosthogTracking {
    let options = posthog_rs::ClientOptionsBuilder::default()
        .api_key("phc_fixture_only".to_owned())
        .host(server.host.clone())
        .flush_at(flush_at)
        .flush_interval_ms(60_000u64)
        .max_batch_size(100usize)
        .request_timeout_seconds(2u64)
        .shutdown_timeout_ms(2_000u64)
        .retry_initial_backoff_ms(60_000u64)
        .retry_max_backoff_ms(60_000u64)
        .is_server(false)
        .build()
        .unwrap();
    PosthogTracking::new(posthog_rs::client(options).await)
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("bounded client operation")
}
fn body(request: &Request) -> JsonValue {
    assert_eq!(request.path, "/batch/");
    let body = parse_json(std::str::from_utf8(&request.body).unwrap()).unwrap();
    assert_eq!(get(&body, "api_key"), &s("phc_fixture_only"));
    body
}
fn assert_payload(event: &JsonValue, expected: &PreparedEvent) {
    assert_eq!(get(event, "event"), &s(expected.event));
    assert_eq!(
        get(event, "distinct_id"),
        &JsonValue::String(expected.distinct_id.clone())
    );
    let properties = get(event, "properties");
    let JsonValue::Object(fields) = &expected.properties else {
        panic!("object")
    };
    for (key, value) in fields {
        let actual = get(properties, key.as_str().unwrap());
        assert_wire(actual, value);
    }
    // Extra SDK/transport metadata is not application payload parity.
    let JsonValue::Object(actual) = properties else {
        panic!("object")
    };
    for (key, _) in actual {
        if !fields.iter().any(|(k, _)| k == key) {
            assert!(
                [
                    "$lib",
                    "$lib_version",
                    "$lib_version__major",
                    "$lib_version__minor",
                    "$lib_version__patch",
                    "$geoip_disable",
                    "$is_server",
                    "$os",
                    "$os_version",
                    "$process_person_profile"
                ]
                .contains(&key.as_str().unwrap()),
                "unexpected metadata {key:?}"
            );
        }
    }
}
fn assert_wire(a: &JsonValue, b: &JsonValue) {
    assert_raw(
        &parse_json(&a.to_json_string()).unwrap(),
        &parse_json(&b.to_json_string()).unwrap(),
    );
}
fn assert_raw(a: &JsonValue, b: &JsonValue) {
    match (a, b) {
        (JsonValue::Number(a), JsonValue::Number(b)) => assert_eq!(a.to_bits(), b.to_bits()),
        (JsonValue::Array(a), JsonValue::Array(b)) => {
            assert_eq!(a.len(), b.len());
            for (a, b) in a.iter().zip(b) {
                assert_raw(a, b);
            }
        }
        (JsonValue::Object(a), JsonValue::Object(b)) => {
            assert_eq!(a.len(), b.len());
            for (key, v) in a {
                assert_raw(
                    v,
                    &b.iter().find(|(k, _)| k == key).expect("same property").1,
                );
            }
        }
        _ => assert_eq!(a, b),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_sdk_all_payloads_identity_clone_rename_and_separate_instances() {
    let server = Server::new(false);
    let runtime = sdk(&server, 100).await;
    let clone = runtime.clone();
    let id = JsString::from("ch");
    for (owner, name) in [(&runtime, "name"), (&clone, "name"), (&clone, "renamed")] {
        owner.identify_streamer(&id, &JsString::from(name)).unwrap();
    }
    let expected = examples();
    for event in &expected {
        clone.capture(event.clone()).unwrap();
    }
    let bad = parse_json(
        r#"{"channelID":"ch","channelName":"name","command":"\ud800","status":"success"}"#,
    )
    .unwrap();
    assert_eq!(
        clone.track_command(&bad),
        Err(CaptureError::UnrepresentableUtf16)
    );
    assert_eq!(
        clone.identify_streamer(&JsString::from_units(vec![0xd800]), &id),
        Err(CaptureError::UnrepresentableUtf16)
    );
    bounded(runtime.flush()).await.unwrap();
    let payload = body(&server.next());
    let events = array(get(&payload, "batch"));
    assert_eq!(events.len(), 6);
    assert_eq!(get(events.first().unwrap(), "event"), &s("$identify"));
    assert_eq!(
        get(get(&events[1], "properties"), "$set"),
        &obj(vec![("channel_name", s("renamed"))])
    );
    assert_eq!(
        get(get(&events[0], "properties"), "$set_once"),
        &obj(vec![])
    );
    for (event, expected) in events[2..].iter().zip(&expected) {
        assert_payload(event, expected);
    }
    bounded(runtime.shutdown_posthog()).await.unwrap();
    let separate = sdk(&server, 100).await;
    separate
        .identify_streamer(&id, &JsString::from("name"))
        .unwrap();
    bounded(separate.shutdown_posthog()).await.unwrap();
    assert_eq!(array(get(&body(&server.next()), "batch")).len(), 1);
    server.empty();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_sdk_threshold_flush_shutdown_drain_and_closed_client() {
    let server = Server::new(false);
    let runtime = sdk(&server, 2).await;
    runtime.track_command(&command_input()).unwrap();
    runtime.track_command(&command_input()).unwrap();
    assert_eq!(array(get(&body(&server.next()), "batch")).len(), 2); // Automatic threshold.
    runtime.track_command(&command_input()).unwrap();
    bounded(runtime.flush()).await.unwrap();
    assert_eq!(array(get(&body(&server.next()), "batch")).len(), 1);
    runtime.track_command(&command_input()).unwrap();
    bounded(runtime.clone().shutdown_posthog()).await.unwrap();
    assert_eq!(array(get(&body(&server.next()), "batch")).len(), 1); // Shutdown drains.
    bounded(runtime.shutdown_posthog()).await.unwrap();
    runtime.track_command(&command_input()).unwrap(); // SDK capture returns no delivery result.
    bounded(runtime.flush()).await.unwrap();
    server.empty(); // Causal barrier: shutdown joined the worker; no timer wait needed.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_sdk_failure_attempts_and_shutdown_waits_for_delivery_response() {
    let server = Server::new(false);
    let runtime = sdk(&server, 100).await;
    server.status.store(503, Ordering::SeqCst);
    runtime.track_command(&command_input()).unwrap();
    bounded(runtime.flush()).await.unwrap(); // Attempted delivery, not a delivery receipt.
    assert_eq!(array(get(&body(&server.next()), "batch")).len(), 1);
    server.status.store(200, Ordering::SeqCst);
    bounded(runtime.shutdown_posthog()).await.unwrap(); // Forces held retry without ready-work sleeps.
    assert_eq!(array(get(&body(&server.next()), "batch")).len(), 1);
    let permanent = sdk(&server, 100).await;
    server.status.store(400, Ordering::SeqCst);
    permanent.track_command(&command_input()).unwrap();
    bounded(permanent.flush()).await.unwrap();
    let _ = server.next();
    bounded(permanent.flush()).await.unwrap();
    bounded(permanent.shutdown_posthog()).await.unwrap();
    server.empty(); // Nonretryable response is terminal.

    let gated = Server::new(true);
    let runtime = sdk(&gated, 100).await;
    runtime.track_command(&command_input()).unwrap();
    let closing = tokio::spawn(async move { runtime.shutdown_posthog().await });
    let request = gated.next(); // Worker has actually started the shutdown drain.
    assert!(!closing.is_finished());
    drop(request); // Causal response release, no timing guess.
    bounded(closing).await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concrete_lossless_lazy_factory_utf16_identity_native_context_and_shutdown() {
    let server = Server::new(false);
    let mut config =
        PosthogLosslessConfig::new("phc_fixture_only", format!("{}/batch/", server.host));
    config.flush_interval = Duration::from_secs(60);
    config.request_timeout = Duration::from_secs(2);
    config.shutdown_timeout = Duration::from_secs(2);
    let factory = PosthogTrackingRuntime::new(config);
    server.empty();
    let runtime = factory.get().await.unwrap();
    assert!(std::ptr::eq(runtime, factory.get().await.unwrap()));
    server.empty(); // Acquisition itself produces neither captures nor requests.
    let clone = runtime.clone();
    let id = JsString::from_units(vec![0xd800]);
    let name = JsString::from_units(vec![0xdc00]);
    let renamed = JsString::from_units(vec![0xdc00, b'x' as u16]);
    runtime.identify_streamer(&id, &name).unwrap();
    clone.identify_streamer(&id, &name).unwrap();
    clone.identify_streamer(&id, &renamed).unwrap();
    let identities = StreamerIdentityState::default();
    let mut expected = vec![
        identities.identify(&id, &name).unwrap(),
        identities.identify(&id, &renamed).unwrap(),
    ];
    for p in examples() {
        clone.capture(p.clone()).unwrap();
        expected.push(p);
    }
    let context = create_ai_usage_context(
        "messages",
        AiUsageContextInput {
            entry_id: Some("e😀".into()),
            quantity: Some(-0.0),
            ..Default::default()
        },
    );
    let native = NativeUsageRecorded {
        context: &context,
        credits: f64::INFINITY,
        reason: "messages",
        polar_cost_amount: Some(-0.0),
        input_tokens: Some(f64::NAN),
        output_tokens: Some(0.0),
        total_tokens: None,
    };
    clone.track_native_ai_usage_recorded(&native).unwrap();
    expected.push(native.prepare().unwrap());
    bounded(clone.shutdown_posthog()).await.unwrap();
    let payload = body(&server.next());
    let batch = array(get(&payload, "batch"));
    assert_eq!(batch.len(), expected.len());
    for (event, expected) in batch.iter().zip(&expected) {
        assert_payload(event, expected);
    }
    bounded(runtime.shutdown_posthog()).await.unwrap();
    assert!(runtime.track_command(&command_input()).is_err());
    server.empty();
    let separate = PosthogTracking::from_lossless_config(PosthogLosslessConfig::new(
        "phc_fixture_only",
        format!("{}/batch/", server.host),
    ))
    .unwrap();
    separate.identify_streamer(&id, &name).unwrap();
    bounded(separate.shutdown_posthog()).await.unwrap();
    assert_eq!(array(get(&body(&server.next()), "batch")).len(), 1);
}

// Tagged fixture numbers survive JSON transport as exact binary64 bit strings.
// Undefined object fields become absence, matching the documented plain contract.
fn decode(v: &JsonValue) -> JsonValue {
    if let Some(bits) = v.get("$numberBits") {
        return JsonValue::Number(f64::from_bits(
            u64::from_str_radix(string(bits), 16).unwrap(),
        ));
    }
    match v {
        JsonValue::Array(a) => JsonValue::Array(a.iter().map(decode).collect()),
        JsonValue::Object(o) => JsonValue::Object(
            o.iter()
                .filter(|(_, v)| v.get("$undefined").is_none())
                .map(|(k, v)| (k.clone(), decode(v)))
                .collect(),
        ),
        _ => v.clone(),
    }
}
fn source_call(p: &PreparedEvent) -> JsonValue {
    if p.event == "$identify" {
        obj(vec![
            ("kind", s("identify")),
            (
                "value",
                obj(vec![
                    ("distinctId", JsonValue::String(p.distinct_id.clone())),
                    ("properties", get(&p.properties, "$set").clone()),
                ]),
            ),
        ])
    } else {
        obj(vec![
            ("kind", s("capture")),
            (
                "value",
                obj(vec![
                    ("distinctId", JsonValue::String(p.distinct_id.clone())),
                    ("event", s(p.event)),
                    ("properties", p.properties.clone()),
                ]),
            ),
        ])
    }
}
fn prepare(method: &str, args: &[JsonValue]) -> Result<PreparedEvent, CaptureError> {
    match method {
        "trackCommand" => command(&args[0]),
        "trackTts" => tts(&args[0]),
        "trackAiUsageRecorded" => ai_usage_recorded(&args[0]),
        "trackAiOperation" => ai_operation(&args[0]),
        _ => panic!("unexpected capture {method}"),
    }
}
fn native_input(record: &JsonValue) -> (dima_rust::utils::ai_usage::AiUsageContext, JsonValue) {
    let native = decode(get(record, "native"));
    let p = decode(&array(get(record, "args"))[0]);
    if native.get("direct") == Some(&JsonValue::Bool(true)) {
        let source = get(&p, "context");
        let mut scalar = sdk_value(source).unwrap();
        let schema = number(get(source, "schemaVersion"));
        assert!((0.0..=255.0).contains(&schema) && schema.fract() == 0.0);
        scalar["schemaVersion"] = serde_json::Value::from(schema as u8);
        let mut context: dima_rust::utils::ai_usage::AiUsageContext =
            serde_json::from_value(scalar).unwrap();
        context.quantity = source.get("quantity").map(number);
        assert_raw(&native_context(&context).unwrap(), source);
        return (context, p);
    }
    let input = get(&native, "input");
    let mut dto: AiUsageContextInput = serde_json::from_value(sdk_value(input).unwrap()).unwrap();
    dto.quantity = input.get("quantity").map(number); // Preserve -0/NaN before normalization.
    let context = create_ai_usage_context(string(get(&native, "reason")), dto);
    assert_raw(&native_context(&context).unwrap(), get(&p, "context"));
    (context, p)
}
fn native_params<'a>(
    context: &'a dima_rust::utils::ai_usage::AiUsageContext,
    p: &'a JsonValue,
) -> NativeUsageRecorded<'a> {
    NativeUsageRecorded {
        context,
        credits: number(get(p, "credits")),
        reason: string(get(p, "reason")),
        polar_cost_amount: p.get("polarCostAmount").map(number),
        input_tokens: p.get("inputTokens").map(number),
        output_tokens: p.get("outputTokens").map(number),
        total_tokens: p.get("totalTokens").map(number),
    }
}

fn fixture() -> JsonValue {
    let dir = std::env::var_os("POSTHOG_TRACKING_FIXTURES").expect(
        "set POSTHOG_TRACKING_FIXTURES to the oracle directory; missing fixtures must fail",
    );
    let path = std::path::Path::new(&dir).join("posthog_tracking.json");
    let file = std::fs::read_to_string(path).expect("required nonempty source fixture");
    let fixture = parse_json(&file).expect("lossless fixture JSON");
    let metadata = get(&fixture, "metadata");
    assert_eq!(get(metadata, "format"), &JsonValue::Number(2.0));
    assert_eq!(string(get(metadata, "node")), "v24.22.1");
    assert_eq!(string(get(metadata, "v8")), "13.6.233.17-node.58");
    assert_eq!(string(get(metadata, "typescript")), "5.9.3");
    assert_eq!(
        get(get(metadata, "strict"), "diagnostics"),
        &JsonValue::Number(0.0)
    );
    let records = array(get(&fixture, "records"));
    assert!(records.len() >= 300, "empty/truncated corpus");
    assert_eq!(number(get(metadata, "recordCount")) as usize, records.len());
    let exports = array(get(get(metadata, "sourceAst"), "exports"));
    assert_eq!(
        exports.iter().map(string).collect::<Vec<_>>(),
        [
            "identifyStreamer",
            "trackCommand",
            "trackTts",
            "trackAiUsageRecorded",
            "trackAiOperation",
            "shutdownPosthog"
        ]
    );
    assert_eq!(
        array(get(get(metadata, "sourceAst"), "signatures")).len(),
        6
    );
    assert!(!array(get(get(metadata, "usageAst"), "interfaces")).is_empty());
    // Byte-exact source readback supplements the oracle's SHA-256 evidence and
    // catches stale artifacts without adding a crypto dependency to this graph.
    let sources = get(&fixture, "sources");
    macro_rules! source {
        ($path:literal) => {
            assert_eq!(
                string(get(sources, $path)),
                include_str!(concat!("../", $path)),
                "stale source {}",
                $path
            );
            assert_eq!(string(get(get(metadata, "hashes"), $path)).len(), 64);
        };
    }
    source!("src/utils/posthog_events.ts");
    source!("src/utils/ai_usage_event.ts");
    source!("src/utils/posthog_events.rs");
    source!("src/utils/ai_usage.rs");
    source!("src/utils/js_string.rs");
    source!("src/utils/js_compat.rs");
    source!("src/utils/lossless_json.rs");
    source!("src/utils/json_number.rs");
    source!("src/utils/posthog_tracking.rs");
    source!("src/utils/posthog_lossless.rs");
    source!("tests/posthog_tracking.rs");
    source!("tests/fixtures/posthog_tracking_reference.cjs");
    source!("Cargo.lock");
    source!("package.json");
    source!("package-lock.json");
    assert_eq!(
        string(get(get(metadata, "sdkPins"), "src/event.rs")),
        "5a4112ea152b483a2dc25195bd56901ece4e6da363dd0904babe48776ceae312"
    );
    assert_eq!(
        string(get(get(metadata, "sdkPins"), "src/client/async_client.rs")),
        "0c2bb5560eff1a281dd4b1986a40256a3fbb0c3eea3847751a06d6a3c00fbd72"
    );
    assert_eq!(
        string(get(get(metadata, "sdkPins"), "src/client/transport.rs")),
        "2f1cbce6b0ac5bd33c76cfc43957f22651640ff626224c9e1753603a4caf059b"
    );
    assert_eq!(array(get(metadata, "runtimeImports")).len(), 3);
    assert_eq!(array(get(metadata, "callers")).len(), 5);
    assert_eq!(
        string(get(
            get(get(metadata, "packagePins"), "posthog-node"),
            "version"
        )),
        "5.47.3"
    );
    let constructors = get(&fixture, "constructors");
    for process in ["process-a", "process-b"] {
        let constructor = get(constructors, process);
        assert_eq!(string(get(constructor, "key")), POSTHOG_PROJECT_KEY);
        assert_eq!(
            get(constructor, "options"),
            &obj(vec![
                ("host", s(POSTHOG_HOST)),
                ("flushInterval", JsonValue::Number(1000.0)),
                ("flushAt", JsonValue::Number(20.0))
            ])
        );
    }
    fixture
}

#[test]
#[ignore = "requires explicit pinned actual-source oracle artifacts; parent isolated execution only"]
fn replays_every_source_record_and_metadata() {
    let fixture = fixture();
    let mut identities = HashMap::<String, Arc<StreamerIdentityState>>::new();
    let mut coverage = BTreeMap::<String, usize>::new();
    for record in array(get(&fixture, "records")) {
        let method = string(get(record, "method"));
        *coverage.entry(method.into()).or_default() += 1;
        let args = decode(get(record, "args"));
        let args = array(&args);
        let raw = decode(get(record, "raw"));
        assert_wire(&raw, &parse_json(string(get(record, "wire"))).unwrap());
        if get(record, "reject") != &JsonValue::Null {
            let result = prepare(method, args);
            let CaptureError::InvalidInput(field) = result.unwrap_err() else {
                panic!("expected contract rejection")
            };
            assert_eq!(field, string(get(record, "reject")));
            continue; // Source output is retained for the explicitly excluded cast.
        }
        assert_eq!(get(record, "exception"), &JsonValue::Null);
        let actual = match method {
            "identifyStreamer" => {
                let state = identities
                    .entry(string(get(record, "instance")).into())
                    .or_default()
                    .clone();
                let JsonValue::String(id) = &args[0] else {
                    panic!("id")
                };
                let JsonValue::String(name) = &args[1] else {
                    panic!("name")
                };
                JsonValue::Array(state.identify(id, name).iter().map(source_call).collect())
            }
            "shutdownPosthog" => JsonValue::Array(vec![
                obj(vec![("kind", s("shutdown-start"))]),
                obj(vec![("kind", s("shutdown-end"))]),
            ]),
            _ => {
                let p = prepare(method, args).unwrap();
                if get(record, "native") != &JsonValue::Null {
                    let (context, input) = native_input(record);
                    let native = native_params(&context, &input).prepare().unwrap();
                    assert_raw(&native.properties, &p.properties);
                    assert_eq!(native.distinct_id, p.distinct_id);
                }
                JsonValue::Array(vec![source_call(&p)])
            }
        };
        assert_raw(&actual, &raw);
        let wire = parse_json(string(get(record, "wire"))).unwrap();
        assert_wire(&actual, &wire);
    }
    assert_eq!(coverage.len(), 6);
    for capture in [
        "trackCommand",
        "trackTts",
        "trackAiUsageRecorded",
        "trackAiOperation",
    ] {
        assert!(coverage[capture] >= 50);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit source oracle; concrete lossless loopback replay, never production defaults"]
async fn source_replay_through_concrete_lossless_factory_and_shared_clones() {
    let fixture = fixture();
    let server = Server::new(false);
    let mut config =
        PosthogLosslessConfig::new("phc_fixture_only", format!("{}/batch/", server.host));
    config.flush_at = 100;
    config.flush_interval = Duration::from_secs(60);
    config.request_timeout = Duration::from_secs(2);
    config.shutdown_timeout = Duration::from_secs(2);
    let factory = PosthogTrackingRuntime::new(config);
    let a = factory.get().await.unwrap();
    assert!(std::ptr::eq(a, factory.get().await.unwrap()));
    let b = PosthogTracking::from_lossless_config(PosthogLosslessConfig::new(
        "phc_fixture_only",
        format!("{}/batch/", server.host),
    ))
    .unwrap();
    let mut identities = HashMap::<String, StreamerIdentityState>::new();
    let mut expected = Vec::new();
    let mut closed = std::collections::HashSet::new();
    let mut pending = 0;
    for record in array(get(&fixture, "records")) {
        if get(record, "reject") != &JsonValue::Null {
            continue;
        }
        let process = string(get(record, "instance"));
        let owner = if process == "process-a" { a } else { &b };
        let clone = owner.clone();
        let owner = if string(get(record, "handle")) == "clone" {
            &clone
        } else {
            owner
        };
        let args = decode(get(record, "args"));
        let args = array(&args);
        let method = string(get(record, "method"));
        if method == "shutdownPosthog" {
            bounded(owner.shutdown_posthog()).await.unwrap();
            closed.insert(process.to_owned());
            continue;
        }
        if method == "identifyStreamer" {
            let JsonValue::String(id) = &args[0] else {
                panic!("id")
            };
            let JsonValue::String(name) = &args[1] else {
                panic!("name")
            };
            owner.identify_streamer(id, name).unwrap();
            if let Some(p) = identities
                .entry(process.into())
                .or_default()
                .identify(id, name)
            {
                expected.push(p);
                pending += 1;
            }
        } else {
            let result = match method {
                "trackCommand" => owner.track_command(&args[0]),
                "trackTts" => owner.track_tts(&args[0]),
                "trackAiOperation" => owner.track_ai_operation(&args[0]),
                "trackAiUsageRecorded" if get(record, "native") != &JsonValue::Null => {
                    let (context, input) = native_input(record);
                    owner.track_native_ai_usage_recorded(&native_params(&context, &input))
                }
                "trackAiUsageRecorded" => owner.track_ai_usage_recorded(&args[0]),
                _ => panic!("method"),
            };
            if closed.contains(process) {
                assert!(result.is_err());
                continue;
            }
            result.unwrap();
            expected.push(prepare(method, args).unwrap());
            pending += 1;
        }
        if pending >= 50 {
            bounded(owner.flush()).await.unwrap();
            pending = 0;
        }
    }
    bounded(a.shutdown_posthog()).await.unwrap();
    bounded(b.shutdown_posthog()).await.unwrap();
    let mut actual = Vec::new();
    for request in server.requests.try_iter() {
        let payload = body(&request);
        actual.extend(array(get(&payload, "batch")).iter().cloned());
    }
    assert_eq!(actual.len(), expected.len());
    // Match exact application payloads without relying on cross-client flush order.
    let mut expected: Vec<Option<PreparedEvent>> = expected.into_iter().map(Some).collect();
    for event in actual {
        let index = expected
            .iter()
            .position(|p| {
                p.as_ref().is_some_and(|p| {
                    get(&event, "event") == &s(p.event)
                        && get(&event, "distinct_id") == &JsonValue::String(p.distinct_id.clone())
                        && {
                            let JsonValue::Object(fields) = &p.properties else {
                                return false;
                            };
                            fields.iter().all(|(k, v)| {
                                get(&event, "properties")
                                    .get(k.as_str().unwrap())
                                    .is_some_and(|a| {
                                        // JSON numbers are compared after the source wire boundary.
                                        a.to_json_string() == v.to_json_string()
                                    })
                            })
                        }
                })
            })
            .expect("all source events must arrive losslessly");
        assert_payload(&event, expected[index].as_ref().unwrap());
        expected[index] = None;
    }
    assert!(expected.iter().all(Option::is_none));
}
