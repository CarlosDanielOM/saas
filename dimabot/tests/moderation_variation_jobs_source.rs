#![cfg(feature = "moderation-variation-jobs")]
//! All 38 actual-source cases, replayed through concrete native Mongo/Redis/HTTP.
//! ORM mocks can fabricate impossible documents. This suite explicitly adapts
//! lookup IDs and the one expired-claim fixture while checking real predicates;
//! it never compares a Mongoose call directly to a defaulted Mongo wire insert.
#[path = "support/moderation_variation_jobs.rs"]
mod support;
use dima_rust::{
    schemas::moderation_variation as schema,
    utils::{
        js_string::JsString,
        moderation::{
            types::VariationMode,
            variation_jobs::{BUDGET_LUA, JobError, variation_job_id, variation_job_view},
            variations::{self, VARIATION_MODEL, VARIATION_VERSION},
        },
    },
};
use mongodb::bson::{Bson, DateTime, Document, doc};
use redis::AsyncCommands;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
use support::*;

const CASE_NAMES: &[&str] = &[
    "saved-prior-cache-order",
    "saved-cache-missing-version",
    "saved-malformed-cache",
    "resolve-off",
    "resolve-common",
    "resolve-broad",
    "resolve-missing",
    "resolve-invalid-stored",
    "view-reserved",
    "view-pending",
    "view-processing",
    "view-completed",
    "view-failed",
    "request-all-cached",
    "request-existing-reserved",
    "request-existing-pending",
    "request-existing-processing",
    "request-existing-completed",
    "request-retry-race",
    "request-duplicate",
    "request-create-error",
    "request-grant-seed-utf16",
    "request-retry-denied",
    "process-empty",
    "process-plan",
    "process-cache-only",
    "process-two-batches",
    "process-timeout-before",
    "process-timeout-after",
    "process-provider-unavailable",
    "process-invalid-provider",
    "process-failure-owner-query",
    "process-failure-cache-query",
    "process-failure-usage-push",
    "process-failure-cache-write",
    "process-failure-complete-write",
    "process-failure-maintenance",
    "process-failure-claim",
];
fn method(step: &Bson) -> &str {
    step.as_document().unwrap().get_str("method").unwrap()
}
fn value(step: &Bson) -> &Bson {
    step.as_document().unwrap().get("value").unwrap()
}
fn thrown(value: &Bson) -> bool {
    value.as_document().is_some_and(|d| d.contains_key("throw"))
}
fn remap(value: &mut Bson, replacements: &BTreeMap<String, String>) {
    match value {
        Bson::String(s) => {
            if let Some(replacement) = replacements.get(s) {
                *s = replacement.clone();
            }
        }
        Bson::Array(items) => {
            for item in items {
                remap(item, replacements);
            }
        }
        Bson::Document(document) => {
            for (_, item) in document.iter_mut() {
                remap(item, replacements);
            }
        }
        _ => {}
    }
}
fn source_calls(case: &Value) -> Vec<Call> {
    case["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|call| {
            let method = call["method"].as_str().unwrap();
            (!method.ends_with(".lean")
                && !method.ends_with(".select")
                && method != "getDragonflyClient"
                && method != "AbortSignal.timeout"
                && method != "Redis.eval")
                .then(|| Call {
                    method: method.into(),
                    args: decode(&call["args"]).as_array().unwrap().clone(),
                })
        })
        .collect()
}
fn job_document(mut job: Document, id: &str) -> Document {
    job.insert("_id", id);
    job.insert("expiresAt", DateTime::from_millis(EPOCH + 180 * 86_400_000));
    schema::job_schema()
        .prepare_insert(job, DateTime::from_millis(EPOCH))
        .unwrap()
}
fn error_contract(actual: &JobError, expected: &Value, context: &str) {
    match actual {
        JobError::Variation(error) => {
            assert_value(
                &Bson::Int32(i32::from(error.status)),
                &decode(&expected["status"]),
                context,
            );
            assert_eq!(error.message, string(&expected["message"]), "{context}");
        }
        JobError::Other(_) => {
            assert_eq!(
                expected["status"]["kind"], "undefined",
                "{context}: domain errors must retain status/message"
            );
            // Native SDK and malformed BSON errors need not reproduce the mock's
            // synthetic English wording or JavaScript's exception class name.
            assert!(
                ["Error", "TypeError"].contains(&string(&expected["name"]).as_str()),
                "{context}"
            );
        }
    }
}
fn compare_contract(actual: &Call, expected: &Call, context: &str) {
    assert_eq!(actual.method, expected.method, "{context}");
    if actual.method == "Fetch" {
        // Source fetch URL/key are inert fixture values; compare the actual
        // request JSON and its channel attribution, not the loopback URL.
        let source_options = expected.args[1].as_document().unwrap();
        assert_eq!(source_options.get_str("method").unwrap(), "POST");
        let source: Value = serde_json::from_str(source_options.get_str("body").unwrap()).unwrap();
        let native: Value = serde_json::from_str(actual.args[0].as_str().unwrap()).unwrap();
        assert_eq!(native, source, "{context}: provider body");
        return;
    }
    if actual.method == "Jobs.create" {
        let actual = actual.args[0].as_document().unwrap();
        let expected = expected.args[0].as_document().unwrap();
        for (key, expected) in expected {
            assert_value(actual.get(key).unwrap(), expected, context);
        }
        for (key, expected) in [
            ("attempts", Bson::Int32(1)),
            ("creditsCharged", Bson::Int32(0)),
            ("providerUsage", Bson::Array(vec![])),
            ("error", Bson::String(String::new())),
        ] {
            assert_value(actual.get(key).unwrap(), &expected, context);
        }
        assert_eq!(
            actual.len(),
            expected.len() + 4,
            "{context}: Mongoose defaults only"
        );
        return;
    }
    assert_value(
        &Bson::Array(actual.args.clone()),
        &Bson::Array(expected.args.clone()),
        context,
    );
}

async fn replay_case(fixture: &Fixture, case: &Value, index: usize) {
    fixture.reset().await;
    let name = case["name"].as_str().unwrap();
    let operation = case["operation"].as_str().unwrap();
    let channel = fixture.channel(&format!("source-{index:02}")).await;
    let channel_text = channel.to_utf8_lossy();
    let mut args = decode(&case["args"]);
    let mut script = decode(&case["script"]);
    let mut calls = source_calls(case);
    let source_args = args.as_array().unwrap();
    let terms = if [
        "savedVariations",
        "resolveVariations",
        "requestVariationJob",
    ]
    .contains(&operation)
    {
        strings(&source_args[1])
    } else if operation == "processNextVariationJob" {
        script
            .as_array()
            .unwrap()
            .iter()
            .find(|step| method(step) == "Jobs.findOneAndUpdate" && !thrown(value(step)))
            .map(value)
            .and_then(Bson::as_document)
            .and_then(|job| job.get("terms"))
            .map(strings)
            .unwrap_or_else(|| vec!["cat".into()])
    } else {
        vec!["cat".into()]
    };
    let native_id = variation_job_id(&channel, &terms);
    let mut replacements = BTreeMap::from([
        ("chan".into(), channel_text.clone()),
        (
            "moderation:chan:variation-words".into(),
            format!("moderation:{channel_text}:variation-words"),
        ),
        (
            "moderation:chan:variation-jobs".into(),
            format!("moderation:{channel_text}:variation-jobs"),
        ),
    ]);
    for term in &terms {
        replacements.insert(
            variations::variation_key(&"chan".into(), term),
            variations::variation_key(&channel, term),
        );
    }
    if operation == "requestVariationJob" {
        // The source mock returns _id:'fixture-job' even for findById(hash).
        // A real DB cannot do that: preserve the computed lookup identity.
        let original_id = variation_job_id(&"chan".into(), &terms);
        for call in &calls {
            if call.method == "Jobs.findById" {
                assert_eq!(
                    call.args[0].as_str().unwrap(),
                    original_id,
                    "{name}: source hash oracle"
                );
            }
        }
        replacements.insert(original_id, native_id.clone());
        replacements.insert("fixture-job".into(), native_id.clone());
    }
    remap(&mut args, &replacements);
    remap(&mut script, &replacements);
    for call in &mut calls {
        for arg in &mut call.args {
            remap(arg, &replacements);
        }
        if call.method == "Fetch" {
            let options = call.args[1].as_document_mut().unwrap();
            let mut body: Value = serde_json::from_str(options.get_str("body").unwrap()).unwrap();
            body["user"] = Value::String(channel_text.clone());
            options.insert("body", body.to_string());
        }
    }
    let args = args.as_array().unwrap();
    let script = script.as_array().unwrap();
    if let Some(step) = script
        .iter()
        .find(|step| method(step) == "Cache.find" && value(step).as_array().is_some())
    {
        let query_ids = calls
            .iter()
            .find(|call| call.method == "Cache.find")
            .unwrap()
            .args[0]
            .as_document()
            .unwrap()
            .get_document("_id")
            .unwrap()
            .get_array("$in")
            .unwrap();
        for (index, item) in value(step).as_array().unwrap().iter().enumerate() {
            let mut document = item.as_document().unwrap().clone();
            document.insert("_id", query_ids[index.min(query_ids.len() - 1)].clone());
            document.insert("channelID", &channel_text);
            document.insert("expiresAt", DateTime::from_millis(EPOCH + 86_400_000));
            fixture
                .db
                .collection::<Document>(CACHE)
                .insert_one(document)
                .await
                .unwrap();
        }
    }
    let mut job_id = None;
    if operation == "requestVariationJob" {
        if let Some(existing) = script
            .iter()
            .find(|step| method(step) == "Jobs.findById")
            .map(value)
            .and_then(Bson::as_document)
        {
            fixture
                .db
                .collection::<Document>(JOBS)
                .insert_one(job_document(existing.clone(), &native_id))
                .await
                .unwrap();
            job_id = Some(native_id.clone());
        }
    } else if operation == "processNextVariationJob" {
        if let Some(job) = script
            .iter()
            .find(|step| method(step) == "Jobs.findOneAndUpdate" && !thrown(value(step)))
            .map(value)
            .and_then(Bson::as_document)
        {
            let id = job.get_str("_id").unwrap().to_owned();
            let mut seeded = job_document(job.clone(), &id);
            seeded.insert("state", "pending");
            // The oracle fabricates an expired claim. Start one millisecond
            // before its deadline, then advance after the atomic real claim.
            if name == "process-timeout-before" {
                fixture.clock.set(EPOCH - 1);
                fixture.hook("Users.findOne", 1, vec![Action::Advance(EPOCH)]);
                for call in &mut calls {
                    if call.method == "Jobs.updateMany" || call.method == "Jobs.findOneAndUpdate" {
                        for arg in &mut call.args {
                            replace_date(arg, EPOCH, EPOCH - 1);
                        }
                    }
                }
            }
            fixture
                .db
                .collection::<Document>(JOBS)
                .insert_one(seeded)
                .await
                .unwrap();
            job_id = Some(id);
        }
        if let Some(owner) = script
            .iter()
            .find(|step| method(step) == "Users.findOne" && !thrown(value(step)))
            .map(value)
            .and_then(Bson::as_document)
        {
            let mut owner = owner.clone();
            owner.insert("accounts", vec![doc! {"type":"twitch","id":&channel_text}]);
            fixture
                .db
                .collection::<Document>("users")
                .insert_one(owner)
                .await
                .unwrap();
        }
    }
    fixture.clear_recording();
    let mut occurrences = BTreeMap::<String, usize>::new();
    for step in script {
        let method = method(step);
        let count = occurrences.entry(method.into()).or_default();
        *count += 1;
        if thrown(value(step)) && name != "request-duplicate" {
            let command = if method.ends_with(".findOneAndUpdate") {
                "findAndModify"
            } else if method.ends_with(".find")
                || method.ends_with(".findOne")
                || method.ends_with(".findById")
            {
                "find"
            } else if method.ends_with(".create") {
                "insert"
            } else {
                "update"
            };
            fixture.hook(
                method,
                *count,
                vec![Action::Fault {
                    command: command.into(),
                    code: 12345,
                }],
            );
        }
    }
    if name == "request-retry-race" {
        let completed = script.last().unwrap();
        let doc = value(completed).as_document().unwrap();
        fixture.hook("Jobs.findOneAndUpdate", 1, vec![Action::Update { collection:JOBS.into(), filter:doc! {"_id":&native_id}, update:doc! {"$set":{"state":"completed","entries":doc.get_array("entries").unwrap().clone()}} }]);
    }
    if name == "request-duplicate" {
        let pending = value(script.last().unwrap()).as_document().unwrap();
        fixture.hook(
            "Jobs.create",
            1,
            vec![Action::Insert {
                collection: JOBS.into(),
                document: job_document(pending.clone(), &native_id),
            }],
        );
    }
    let word_key = format!("moderation:{channel_text}:variation-words");
    let budget_key = format!("moderation:{channel_text}:variation-jobs");
    if name == "request-retry-denied" {
        let _: () = fixture.redis.clone().set(&word_key, 500).await.unwrap();
    }
    let replies = script
        .iter()
        .filter(|step| method(step) == "Fetch")
        .map(|step| {
            let value = value(step).as_document().unwrap();
            Reply {
                http_error: value.get_bool("httpError").unwrap_or(false),
                invalid: value.get_bool("invalid").unwrap_or(false),
                advance: value.get("advance").map(number).unwrap_or(0.0) as i64,
                ..Reply::default()
            }
        })
        .collect::<Vec<_>>();
    let provider = Provider::start(replies, fixture.calls.clone(), fixture.clock.clone());
    let service = fixture.service(&provider.endpoint);
    let result = match operation {
        "savedVariations" => service
            .saved_variations(&channel, &strings(&args[1]), &documents(&args[2]))
            .await
            .map(|saved| {
                Bson::Array(
                    saved
                        .raw_iter()
                        .map(|(key, entry)| Bson::Array(vec![key.clone(), entry.clone()]))
                        .collect(),
                )
            }),
        "resolveVariations" => {
            let mode = match args[2].as_str().unwrap() {
                "off" => VariationMode::Off,
                "common" => VariationMode::Common,
                "broad" => VariationMode::Broad,
                mode => panic!("unexpected mode {mode}"),
            };
            service
                .resolve_variations(
                    &channel,
                    &strings(&args[1]),
                    mode,
                    &documents(&args[3]),
                    args[4].as_bool().unwrap(),
                )
                .await
                .map(Bson::Document)
        }
        "variationJobView" => {
            variation_job_view(args[0].as_document().unwrap()).map(Bson::Document)
        }
        "requestVariationJob" => service
            .request_variation_job(&channel, &strings(&args[1]), &documents(&args[2]))
            .await
            .map(Bson::Document),
        "processNextVariationJob" => service
            .process_next_variation_job()
            .await
            .map(Bson::Boolean),
        operation => panic!("unhandled source operation {operation}"),
    };
    if case["outcome"]["ok"].as_bool().unwrap() {
        let expected = &case["outcome"]["value"];
        let mut expected = if expected["kind"] == "map" {
            Bson::Array(
                expected["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|pair| Bson::Array(vec![decode(&pair[0]), decode(&pair[1])]))
                    .collect(),
            )
        } else {
            decode(expected)
        };
        remap(&mut expected, &replacements);
        if operation == "resolveVariations" {
            // The shared JSON-compatible compiler omits symbolVersion when the
            // source owns it with `undefined`. JSON.stringify omits that field;
            // own-property identity is outside the accepted helper boundary.
            let output = expected.as_document_mut().unwrap();
            for entry in output.get_array_mut("entries").unwrap() {
                let entry = entry.as_document_mut().unwrap();
                if entry.get("symbolVersion") == Some(&Bson::Undefined) {
                    entry.remove("symbolVersion");
                }
            }
        }
        assert_value(
            &result.unwrap_or_else(|error| panic!("{name}: {error}")),
            &expected,
            name,
        );
    } else {
        error_contract(&result.expect_err(name), &case["outcome"], name);
    }
    fixture.assert_hooks_consumed();
    assert_timeout_contract(case, script);
    assert_eq!(
        provider.requests.lock().unwrap().len(),
        script.iter().filter(|step| method(step) == "Fetch").count(),
        "{name}: HTTP request count"
    );
    let observed = fixture.calls.lock().unwrap().clone();
    assert_eq!(observed.len(), calls.len(), "{name}: {observed:?}");
    for (actual, expected) in observed.iter().zip(&calls) {
        compare_contract(actual, expected, name);
    }
    // Reads/writes are checked against source semantics above; persisted state
    // proves operations that the source mocked actually happened.
    if let Some(id) = job_id.or_else(|| {
        (operation == "requestVariationJob"
            && calls.iter().any(|call| call.method == "Jobs.create")
            && name != "request-create-error")
            .then(|| native_id.clone())
    }) {
        let actual = fixture
            .db
            .collection::<Document>(JOBS)
            .find_one(doc! {"_id":id})
            .await
            .unwrap()
            .unwrap();
        assert_value(actual.get("creditsCharged").unwrap(), &Bson::Int32(0), name);
        for (step, call) in script
            .iter()
            .filter(|step| method(step) == "Jobs.updateOne")
            .zip(calls.iter().filter(|call| call.method == "Jobs.updateOne"))
        {
            if !thrown(value(step))
                && let Ok(set) = call.args[1].as_document().unwrap().get_document("$set")
            {
                for (key, expected) in set {
                    assert_value(actual.get(key).unwrap(), expected, name);
                }
            }
        }
        let source_usage = calls
            .iter()
            .filter_map(|call| {
                (call.method == "Jobs.updateOne")
                    .then(|| {
                        call.args[1]
                            .as_document()
                            .unwrap()
                            .get_document("$push")
                            .ok()
                    })
                    .flatten()
            })
            .map(|push| push.get("providerUsage").unwrap().clone())
            .collect::<Vec<_>>();
        let expected_usage = if name == "process-failure-usage-push" {
            vec![]
        } else {
            source_usage
        };
        assert_value(
            actual.get("providerUsage").unwrap(),
            &Bson::Array(expected_usage),
            name,
        );
    }
    let mut cache_writes = calls.iter().filter(|call| call.method == "Cache.updateOne");
    for step in script
        .iter()
        .filter(|step| method(step) == "Cache.updateOne")
    {
        let call = cache_writes.next().unwrap();
        let query = call.args[0].as_document().unwrap().clone();
        let cached = fixture
            .db
            .collection::<Document>(CACHE)
            .find_one(query)
            .await
            .unwrap();
        if thrown(value(step)) {
            assert!(cached.is_none(), "{name}");
        } else {
            let actual = cached.unwrap();
            for (key, expected) in call.args[1]
                .as_document()
                .unwrap()
                .get_document("$set")
                .unwrap()
            {
                assert_value(actual.get(key).unwrap(), expected, name);
            }
        }
    }
    if let Some(budget) = script.iter().find(|step| method(step) == "Redis.eval") {
        let mut redis = fixture.redis.clone();
        if number(value(budget)) == 0.0 {
            assert_eq!(redis.get::<_, i64>(&word_key).await.unwrap(), 500);
            assert!(!redis.exists::<_, bool>(&budget_key).await.unwrap());
        } else {
            let source_eval = case["calls"]
                .as_array()
                .unwrap()
                .iter()
                .find(|call| call["method"] == "Redis.eval")
                .unwrap();
            let eval_args = decode(&source_eval["args"]);
            let eval_args = eval_args.as_array().unwrap();
            assert_eq!(eval_args[0].as_str().unwrap(), BUDGET_LUA);
            let amount: i64 = eval_args[1]
                .as_document()
                .unwrap()
                .get_array("arguments")
                .unwrap()[0]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(redis.get::<_, i64>(&word_key).await.unwrap(), amount);
            assert_eq!(redis.get::<_, i64>(&budget_key).await.unwrap(), 1);
            for key in [&word_key, &budget_key] {
                let ttl = redis.ttl::<_, i64>(key).await.unwrap();
                assert!(
                    (86_380..=86_400).contains(&ttl),
                    "{name}: real Lua TTL {ttl}"
                );
            }
        }
    }
}
fn assert_timeout_contract(case: &Value, script: &[Bson]) {
    use dima_rust::utils::moderation::variation_jobs::provider_deadline_ms;
    let bounds = case["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|call| call["method"] == "AbortSignal.timeout")
        .map(|call| number(&decode(&call["args"]).as_array().unwrap()[0]) as u64)
        .collect::<Vec<_>>();
    let claimed = script
        .iter()
        .find(|step| method(step) == "Jobs.findOneAndUpdate" && !thrown(value(step)))
        .map(value)
        .and_then(Bson::as_document);
    let mut now = EPOCH;
    let mut derived = Vec::new();
    if let Some(job) = claimed {
        let deadline = job.get_datetime("deadline").unwrap().timestamp_millis();
        for fetch in script.iter().filter(|step| method(step) == "Fetch") {
            derived.push(
                provider_deadline_ms(deadline - now)
                    .expect("provider called only with positive remaining time"),
            );
            now += value(fetch)
                .as_document()
                .unwrap()
                .get("advance")
                .map(number)
                .unwrap_or(0.0) as i64;
        }
    }
    assert_eq!(
        derived, bounds,
        "{}: exact source AbortSignal.timeout bounds",
        case["name"]
    );
}
fn replace_date(value: &mut Bson, from: i64, to: i64) {
    match value {
        Bson::DateTime(date) if date.timestamp_millis() == from => {
            *date = DateTime::from_millis(to)
        }
        Bson::Array(items) => {
            for item in items {
                replace_date(item, from, to);
            }
        }
        Bson::Document(d) => {
            for (_, item) in d.iter_mut() {
                replace_date(item, from, to);
            }
        }
        _ => {}
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires independently pinned actual-source oracle and fresh owned keyword Mongo/Dragonfly; see handoff"]
async fn all_38_actual_source_cases_with_native_private_services() {
    let reference = pinned_reference();
    let fixture = Fixture::new().await;
    let cases = reference["cases"].as_array().unwrap();
    let names = cases
        .iter()
        .map(|case| case["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, CASE_NAMES);
    let mut visited = BTreeSet::new();
    for (index, case) in cases.iter().enumerate() {
        replay_case(&fixture, case, index).await;
        assert!(visited.insert(case["name"].as_str().unwrap()));
    }
    assert_eq!(visited.len(), 38);
    fixture.assert_hooks_consumed();
    targeted_budget_and_reservation_failures(&fixture).await;
    targeted_claim_competition_and_expiry(&fixture).await;
    targeted_deadlines_and_usage(&fixture).await;
    targeted_model_cast_and_mixed_values(&fixture).await;
    targeted_redis_uncertain_response(&fixture).await;
}

fn generated(term: &str) -> Bson {
    schema::generated_variation_to_bson(&variations::build_variation(&term.into(), None).unwrap())
}
async fn seed_owner(fixture: &Fixture, channel: &JsString) {
    fixture.db.collection::<Document>("users").insert_one(doc! {"accounts":[{"type":"twitch","id":channel.to_utf8_lossy()}],"plan_tier":"premium"}).await.unwrap();
}
async fn seed_pending(
    fixture: &Fixture,
    id: &str,
    channel: &JsString,
    terms: &[&str],
    entries: Vec<Bson>,
    deadline: i64,
) {
    fixture.db.collection::<Document>(JOBS).insert_one(job_document(doc! {"channelID":channel.to_utf8_lossy(),"terms":terms.to_vec(),"state":"pending","entries":entries,"createdAt":DateTime::from_millis(EPOCH-1000),"deadline":DateTime::from_millis(deadline),"model":VARIATION_MODEL,"version":VARIATION_VERSION}, id)).await.unwrap();
}
async fn read_job(fixture: &Fixture, id: &str) -> Document {
    fixture
        .db
        .collection::<Document>(JOBS)
        .find_one(doc! {"_id":id})
        .await
        .unwrap()
        .unwrap()
}
fn keys(channel: &JsString) -> (String, String) {
    let channel = channel.to_utf8_lossy();
    (
        format!("moderation:{channel}:variation-words"),
        format!("moderation:{channel}:variation-jobs"),
    )
}
fn assert_limit(error: JobError) {
    match error {
        JobError::Variation(error) => {
            assert_eq!(error.status, 429);
            assert_eq!(
                error.message,
                "Daily variation-generation limit reached. Saved variations still work; try again tomorrow."
            );
        }
        error => panic!("expected quota error, got {error}"),
    }
}

async fn targeted_budget_and_reservation_failures(fixture: &Fixture) {
    // Check each independent inclusive boundary and preserve existing nonzero
    // counters' TTL; the source only refreshes a counter previously at zero.
    for (index, word_start, job_start) in [(0, 499, 0), (1, 0, 29), (2, 0, 0)] {
        fixture.reset().await;
        let channel = fixture.channel(&format!("boundary-{index}")).await;
        let (words, jobs) = keys(&channel);
        let mut redis = fixture.redis.clone();
        let _: () = redis.set_ex(&words, word_start, 300).await.unwrap();
        let _: () = redis.set_ex(&jobs, job_start, 300).await.unwrap();
        let service = fixture.service("http://127.0.0.1:1");
        service
            .request_variation_job(&channel, &["cat".into()], &[])
            .await
            .unwrap();
        assert_eq!(redis.get::<_, i64>(&words).await.unwrap(), word_start + 1);
        assert_eq!(redis.get::<_, i64>(&jobs).await.unwrap(), job_start + 1);
        for (key, start) in [(&words, word_start), (&jobs, job_start)] {
            let ttl = redis.ttl::<_, i64>(key).await.unwrap();
            if start == 0 {
                assert!((86_380..=86_400).contains(&ttl));
            } else {
                assert!((280..=300).contains(&ttl));
            }
        }
        if index < 2 {
            assert_limit(
                service
                    .request_variation_job(&channel, &["dog".into()], &[])
                    .await
                    .unwrap_err(),
            );
            assert_eq!(redis.get::<_, i64>(&words).await.unwrap(), word_start + 1);
            assert_eq!(redis.get::<_, i64>(&jobs).await.unwrap(), job_start + 1);
        }
    }
    // Lua is atomic against competitors but does not roll back commands already
    // executed before an error. Never replay a script on that uncertainty.
    for (index, bad_words, bad_jobs, expected_words) in
        [(0, "corrupt", "0", "corrupt"), (1, "0", "0.5", "1")]
    {
        fixture.reset().await;
        let channel = fixture.channel(&format!("corrupt-{index}")).await;
        let (words, jobs) = keys(&channel);
        let mut redis = fixture.redis.clone();
        let _: () = redis.set(&words, bad_words).await.unwrap();
        let _: () = redis.set(&jobs, bad_jobs).await.unwrap();
        let service = fixture.service("http://127.0.0.1:1");
        let id = variation_job_id(&channel, &["cat".into()]);
        assert!(matches!(
            service
                .request_variation_job(&channel, &["cat".into()], &[])
                .await,
            Err(JobError::Other(_))
        ));
        assert_eq!(
            redis.get::<_, String>(&words).await.unwrap(),
            expected_words
        );
        assert_eq!(redis.get::<_, String>(&jobs).await.unwrap(), bad_jobs);
        assert_eq!(
            read_job(fixture, &id).await.get_str("state").unwrap(),
            "reserved"
        );
        assert_eq!(redis.ttl::<_, i64>(&words).await.unwrap(), -1);
        let same = service
            .request_variation_job(&channel, &["cat".into()], &[])
            .await
            .unwrap();
        assert_eq!(same.get_str("state").unwrap(), "pending");
        assert_eq!(
            redis.get::<_, String>(&words).await.unwrap(),
            expected_words
        );
        assert_eq!(redis.get::<_, String>(&jobs).await.unwrap(), bad_jobs);
    }
    fixture.reset().await;
    let channel = fixture.channel("expired-reservation-race").await;
    let (words, jobs) = keys(&channel);
    let id = variation_job_id(&channel, &["cat".into()]);
    fixture.hook("Jobs.updateOne",1,vec![Action::Update { collection:JOBS.into(),filter:doc! {"_id":&id,"state":"reserved"},update:doc! {"$set":{"state":"failed","error":"generation_timeout","deadline":DateTime::from_millis(EPOCH)}} }]);
    let service = fixture.service("http://127.0.0.1:1");
    let raced = service
        .request_variation_job(&channel, &["cat".into()], &[])
        .await
        .unwrap();
    assert_eq!(raced.get_str("state").unwrap(), "failed");
    assert_eq!(raced.get_str("error").unwrap(), "generation_timeout");
    assert_eq!(
        fixture.redis.clone().get::<_, i64>(&words).await.unwrap(),
        1
    );
    assert_eq!(fixture.redis.clone().get::<_, i64>(&jobs).await.unwrap(), 1);
    // A subsequent explicit retry reserves once, increments attempts once, and
    // spends a second budget unit. The failed retry has no hidden queue loop.
    let retried = service
        .request_variation_job(&channel, &["cat".into()], &[])
        .await
        .unwrap();
    assert_eq!(retried.get_str("state").unwrap(), "pending");
    let retried = read_job(fixture, &id).await;
    assert_value(
        retried.get("attempts").unwrap(),
        &Bson::Int32(2),
        "retry attempts",
    );
    assert_eq!(
        retried.get_datetime("deadline").unwrap().timestamp_millis(),
        EPOCH + 300_000
    );
    assert_eq!(
        fixture.redis.clone().get::<_, i64>(&words).await.unwrap(),
        2
    );
    assert_eq!(fixture.redis.clone().get::<_, i64>(&jobs).await.unwrap(), 2);
    for (index, method, occurrence, command, state) in [
        (0, "Jobs.updateOne", 1, "update", "reserved"),
        (1, "Jobs.findById", 2, "find", "pending"),
    ] {
        fixture.reset().await;
        let channel = fixture
            .channel(&format!("request-after-budget-{index}"))
            .await;
        let (words, jobs) = keys(&channel);
        let id = variation_job_id(&channel, &["cat".into()]);
        fixture.hook(
            method,
            occurrence,
            vec![Action::Fault {
                command: command.into(),
                code: 12345,
            }],
        );
        let service = fixture.service("http://127.0.0.1:1");
        assert!(matches!(
            service
                .request_variation_job(&channel, &["cat".into()], &[])
                .await,
            Err(JobError::Other(_))
        ));
        assert_eq!(
            read_job(fixture, &id).await.get_str("state").unwrap(),
            state
        );
        assert_eq!(
            fixture.redis.clone().get::<_, i64>(&words).await.unwrap(),
            1
        );
        assert_eq!(fixture.redis.clone().get::<_, i64>(&jobs).await.unwrap(), 1);
        service
            .request_variation_job(&channel, &["cat".into()], &[])
            .await
            .unwrap();
        assert_eq!(
            fixture.redis.clone().get::<_, i64>(&words).await.unwrap(),
            1
        );
        assert_eq!(fixture.redis.clone().get::<_, i64>(&jobs).await.unwrap(), 1);
    }
}

async fn targeted_claim_competition_and_expiry(fixture: &Fixture) {
    fixture.reset().await;
    let channel = fixture.channel("claim-competition").await;
    seed_owner(fixture, &channel).await;
    seed_pending(
        fixture,
        "one",
        &channel,
        &["cat"],
        vec![generated("cat")],
        EPOCH + 300_000,
    )
    .await;
    let service = fixture.service("http://127.0.0.1:1");
    fixture.clear_recording();
    let (left, right) = tokio::join!(
        service.process_next_variation_job(),
        service.process_next_variation_job()
    );
    assert_eq!(usize::from(left.unwrap()) + usize::from(right.unwrap()), 1);
    assert_eq!(
        read_job(fixture, "one").await.get_str("state").unwrap(),
        "completed"
    );
    assert_eq!(
        fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.method == "Users.findOne")
            .count(),
        1
    );
    fixture.reset().await;
    let channel = fixture.channel("maintenance-and-ready").await;
    seed_owner(fixture, &channel).await;
    for (index, state) in ["reserved", "pending", "processing"].iter().enumerate() {
        let id = format!("expired-{index}");
        seed_pending(
            fixture,
            &id,
            &channel,
            &["cat"],
            vec![generated("cat")],
            EPOCH,
        )
        .await;
        fixture
            .db
            .collection::<Document>(JOBS)
            .update_one(doc! {"_id":&id}, doc! {"$set":{"state":*state}})
            .await
            .unwrap();
    }
    seed_pending(
        fixture,
        "ready-oldest",
        &channel,
        &["cat"],
        vec![generated("cat")],
        EPOCH + 300_000,
    )
    .await;
    seed_pending(
        fixture,
        "ready-newer",
        &channel,
        &["cat"],
        vec![generated("cat")],
        EPOCH + 300_000,
    )
    .await;
    fixture
        .db
        .collection::<Document>(JOBS)
        .update_one(
            doc! {"_id":"ready-newer"},
            doc! {"$set":{"createdAt":DateTime::from_millis(EPOCH)}},
        )
        .await
        .unwrap();
    let service = fixture.service("http://127.0.0.1:1");
    assert!(service.process_next_variation_job().await.unwrap());
    assert_eq!(
        read_job(fixture, "ready-oldest")
            .await
            .get_str("state")
            .unwrap(),
        "completed"
    );
    assert_eq!(
        read_job(fixture, "ready-newer")
            .await
            .get_str("state")
            .unwrap(),
        "pending"
    );
    assert!(service.process_next_variation_job().await.unwrap());
    assert!(!service.process_next_variation_job().await.unwrap());
    for index in 0..3 {
        let job = read_job(fixture, &format!("expired-{index}")).await;
        assert_eq!(job.get_str("state").unwrap(), "failed");
        assert_eq!(job.get_str("error").unwrap(), "generation_timeout");
    }
    // An error writing the catch transition propagates and leaves the original
    // processing claim intact; it is not retried or falsely marked completed.
    fixture.reset().await;
    let channel = fixture.channel("catch-write-failure").await;
    seed_pending(
        fixture,
        "failed-catch",
        &channel,
        &["cat"],
        vec![],
        EPOCH + 300_000,
    )
    .await;
    fixture.clear_recording();
    fixture.hook(
        "Jobs.updateOne",
        1,
        vec![Action::Fault {
            command: "update".into(),
            code: 12345,
        }],
    );
    assert!(
        fixture
            .service("http://127.0.0.1:1")
            .process_next_variation_job()
            .await
            .is_err()
    );
    assert_eq!(
        read_job(fixture, "failed-catch")
            .await
            .get_str("state")
            .unwrap(),
        "processing"
    );
    assert_eq!(
        fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.method == "Jobs.updateOne")
            .count(),
        1
    );
}

async fn targeted_deadlines_and_usage(fixture: &Fixture) {
    use dima_rust::utils::moderation::variation_jobs::provider_deadline_ms;
    for (remaining, expected) in [
        (-1, None),
        (0, None),
        (1, Some(1)),
        (59_999, Some(59_999)),
        (60_000, Some(60_000)),
        (60_001, Some(60_000)),
        (300_000, Some(60_000)),
    ] {
        assert_eq!(provider_deadline_ms(remaining), expected);
    }
    // Test the exact same transport timeout path under a lower explicit cap;
    // no test waits a production minute or alters the 60,000ms default.
    for (index, remaining, cap) in [(0, 300_000, 20), (1, 15, 1000)] {
        fixture.reset().await;
        let channel = fixture.channel(&format!("deadline-cap-{index}")).await;
        seed_owner(fixture, &channel).await;
        seed_pending(
            fixture,
            "cap",
            &channel,
            &["cat"],
            vec![],
            EPOCH + remaining,
        )
        .await;
        let provider = Provider::start(
            vec![Reply {
                delay_ms: 150,
                ..Reply::default()
            }],
            fixture.calls.clone(),
            fixture.clock.clone(),
        );
        let service = fixture
            .service(&provider.endpoint)
            .with_provider_timeout_cap(Duration::from_millis(cap));
        let start = Instant::now();
        assert!(service.process_next_variation_job().await.unwrap());
        assert!(start.elapsed() < Duration::from_secs(2));
        let job = read_job(fixture, "cap").await;
        assert_eq!(job.get_str("error").unwrap(), "invalid_generation");
        assert!(job.get_array("providerUsage").unwrap().is_empty());
        assert_eq!(
            fixture
                .db
                .collection::<Document>(CACHE)
                .count_documents(doc! {})
                .await
                .unwrap(),
            0
        );
    }
    fixture.reset().await;
    let channel = fixture.channel("deadline-post-response").await;
    seed_owner(fixture, &channel).await;
    seed_pending(fixture, "post", &channel, &["cat"], vec![], EPOCH + 1000).await;
    let provider = Provider::start(
        vec![Reply {
            advance: 1000,
            ..Reply::default()
        }],
        fixture.calls.clone(),
        fixture.clock.clone(),
    );
    assert!(
        fixture
            .service(&provider.endpoint)
            .process_next_variation_job()
            .await
            .unwrap()
    );
    let job = read_job(fixture, "post").await;
    assert_eq!(job.get_str("error").unwrap(), "generation_timeout");
    assert_eq!(job.get_array("providerUsage").unwrap().len(), 1);
    assert_value(
        job.get("creditsCharged").unwrap(),
        &Bson::Int32(0),
        "post-response credits",
    );
    assert_eq!(
        fixture
            .db
            .collection::<Document>(CACHE)
            .count_documents(doc! {})
            .await
            .unwrap(),
        0
    );
    // Completion uses its own deadline predicate even when cached entries mean
    // there is no provider loop and no explicit remaining-time branch.
    fixture.reset().await;
    let channel = fixture.channel("deadline-final-write").await;
    seed_owner(fixture, &channel).await;
    seed_pending(
        fixture,
        "completion-expiry",
        &channel,
        &["cat"],
        vec![generated("cat")],
        EPOCH + 1000,
    )
    .await;
    fixture.hook("Cache.find", 1, vec![Action::Advance(EPOCH + 1000)]);
    assert!(
        fixture
            .service("http://127.0.0.1:1")
            .process_next_variation_job()
            .await
            .unwrap()
    );
    let job = read_job(fixture, "completion-expiry").await;
    assert_eq!(job.get_str("state").unwrap(), "processing");
    assert!(
        !fixture
            .service("http://127.0.0.1:1")
            .process_next_variation_job()
            .await
            .unwrap()
    );
    assert_eq!(
        read_job(fixture, "completion-expiry")
            .await
            .get_str("error")
            .unwrap(),
        "generation_timeout"
    );
}

async fn targeted_model_cast_and_mixed_values(fixture: &Fixture) {
    let models = [
        (serde_json::json!(42), Some("42")),
        (serde_json::json!(true), Some("true")),
        (serde_json::json!({"_id":"model-id"}), Some("model-id")),
        (serde_json::json!([]), None),
        (serde_json::json!({"other":1}), None),
        (serde_json::json!({"_id":""}), None),
        (serde_json::json!({"toString":"not-callable"}), None),
    ];
    for (index, (model, cast)) in models.into_iter().enumerate() {
        fixture.reset().await;
        let channel = fixture.channel(&format!("model-cast-{index}")).await;
        seed_owner(fixture, &channel).await;
        seed_pending(
            fixture,
            "model",
            &channel,
            &["cat"],
            vec![],
            EPOCH + 300_000,
        )
        .await;
        let provider = Provider::start(
            vec![Reply {
                model: model.clone(),
                ..Reply::default()
            }],
            fixture.calls.clone(),
            fixture.clock.clone(),
        );
        assert!(
            fixture
                .service(&provider.endpoint)
                .process_next_variation_job()
                .await
                .unwrap()
        );
        let job = read_job(fixture, "model").await;
        assert_eq!(
            job.get_array("providerUsage").unwrap().len(),
            1,
            "usage must precede cache model cast"
        );
        assert_eq!(
            serde_json::to_value(
                job.get_array("providerUsage").unwrap()[0]
                    .as_document()
                    .unwrap()
                    .get("model")
                    .unwrap()
            )
            .unwrap(),
            model
        );
        let cached = fixture
            .db
            .collection::<Document>(CACHE)
            .find_one(doc! {})
            .await
            .unwrap();
        if let Some(expected) = cast {
            assert_eq!(job.get_str("state").unwrap(), "completed");
            assert_eq!(cached.unwrap().get_str("model").unwrap(), expected);
        } else {
            assert_eq!(job.get_str("error").unwrap(), "invalid_generation");
            assert!(cached.is_none());
        }
    }
    let usages = [
        (
            serde_json::json!("ab"),
            doc! {"model":"fixture-model","0":"a","1":"b"},
        ),
        (
            serde_json::json!([{"value":1},2]),
            doc! {"model":"fixture-model","0":{"value":1},"1":2},
        ),
        (serde_json::json!(7), doc! {"model":"fixture-model"}),
        (serde_json::json!(true), doc! {"model":"fixture-model"}),
        (
            serde_json::json!({"model":{"source":"usage"},"other":[1,"a"]}),
            doc! {"model":{"source":"usage"},"other":[1,"a"]},
        ),
    ];
    for (index, (usage, expected)) in usages.into_iter().enumerate() {
        fixture.reset().await;
        let channel = fixture.channel(&format!("usage-spread-{index}")).await;
        seed_owner(fixture, &channel).await;
        seed_pending(
            fixture,
            "usage",
            &channel,
            &["cat"],
            vec![],
            EPOCH + 300_000,
        )
        .await;
        let provider = Provider::start(
            vec![Reply {
                usage,
                ..Reply::default()
            }],
            fixture.calls.clone(),
            fixture.clock.clone(),
        );
        assert!(
            fixture
                .service(&provider.endpoint)
                .process_next_variation_job()
                .await
                .unwrap()
        );
        let job = read_job(fixture, "usage").await;
        assert_eq!(job.get_str("state").unwrap(), "completed");
        assert_value(
            &job.get_array("providerUsage").unwrap()[0],
            &Bson::Document(expected),
            "object spread usage",
        );
    }
    fixture.reset().await;
    let channel = fixture.channel("unknown-mixed").await;
    seed_owner(fixture, &channel).await;
    let unknown = doc! {"date":DateTime::from_millis(EPOCH),"array":["raw",{"nested":[1,true]}],"binary":Bson::Binary(mongodb::bson::Binary {subtype:mongodb::bson::spec::BinarySubtype::Generic,bytes:vec![0,1,255]}),"objectId":mongodb::bson::oid::ObjectId::from_bytes([7;12])};
    let mut entry = generated("cat").as_document().unwrap().clone();
    entry.insert("unknown", unknown.clone());
    entry
        .get_document_mut("pattern")
        .unwrap()
        .insert("unknown", unknown.clone());
    let raw = Bson::Document(entry.clone());
    let cache_id = variations::variation_key(&channel, &"cat".into());
    fixture.db.collection::<Document>(CACHE).insert_one(doc! {"_id":&cache_id,"entry":raw.clone(),"expiresAt":DateTime::from_millis(EPOCH+300_000)}).await.unwrap();
    let service = fixture.service("http://127.0.0.1:1");
    let resolved = service
        .resolve_variations(&channel, &["cat".into()], VariationMode::Broad, &[], true)
        .await
        .unwrap();
    let compiled = resolved.get_array("entries").unwrap()[0]
        .as_document()
        .unwrap();
    assert_eq!(compiled.get_document("unknown").unwrap(), &unknown);
    assert_eq!(
        compiled
            .get_document("pattern")
            .unwrap()
            .get_document("unknown")
            .unwrap(),
        &unknown
    );
    seed_pending(
        fixture,
        "mixed-seeded",
        &channel,
        &["cat"],
        vec![
            Bson::String("raw-string".into()),
            Bson::Array(vec![1.into(), 2.into()]),
            raw.clone(),
        ],
        EPOCH + 300_000,
    )
    .await;
    assert!(service.process_next_variation_job().await.unwrap());
    let job = read_job(fixture, "mixed-seeded").await;
    assert_eq!(job.get_str("state").unwrap(), "completed");
    assert_eq!(job.get_array("entries").unwrap(), &vec![raw]);
    assert!(job.get_array("providerUsage").unwrap().is_empty());
    // Primitive cache entries remain raw values in an undefined-key Map slot.
    // Query one at a time: Mongo does not promise natural order for an $in scan.
    fixture.reset().await;
    let channel = fixture.channel("primitive-cache").await;
    for (term, entry) in [
        ("cat", Bson::String("raw-string".into())),
        ("dog", Bson::Array(vec!["raw-array".into(), 1.into()])),
    ] {
        fixture.db.collection::<Document>(CACHE).insert_one(doc! {"_id":variations::variation_key(&channel,&term.into()),"entry":entry,"expiresAt":DateTime::from_millis(EPOCH+300_000)}).await.unwrap();
    }
    for (term, expected) in [
        ("cat", Bson::String("raw-string".into())),
        ("dog", Bson::Array(vec!["raw-array".into(), 1.into()])),
    ] {
        let saved = fixture
            .service("http://127.0.0.1:1")
            .saved_variations(&channel, &[term.into()], &[])
            .await
            .unwrap();
        let values = saved.raw_iter().collect::<Vec<_>>();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].0, &Bson::Undefined);
        assert_eq!(values[0].1, &expected);
        assert!(saved.get(&term.into()).is_none());
    }
}

async fn targeted_redis_uncertain_response(fixture: &Fixture) {
    use dima_rust::utils::moderation::{
        variation_jobs::VariationJobsService, variations_provider::MuseVariationsProvider,
    };
    fixture.reset().await;
    let channel = fixture.channel("redis-uncertain-response").await;
    let (words, jobs) = keys(&channel);
    // Ensure EVALSHA executes immediately, then lose only its response after
    // the real private Dragonfly has acknowledged the completed script.
    let _: String = redis::cmd("SCRIPT")
        .arg("LOAD")
        .arg(BUDGET_LUA)
        .query_async(&mut fixture.redis.clone())
        .await
        .unwrap();
    let proxy = RedisResponseLoss::start();
    let manager =
        redis::aio::ConnectionManager::new(redis::Client::open(proxy.url.clone()).unwrap())
            .await
            .unwrap();
    let service = VariationJobsService::new(
        fixture.db.clone(),
        manager,
        MuseVariationsProvider::new(reqwest::Client::new(), "http://127.0.0.1:1", None),
    )
    .with_clock(fixture.clock.clone());
    let request = tokio::time::timeout(
        Duration::from_secs(3),
        service.request_variation_job(&channel, &["cat".into()], &[]),
    )
    .await
    .expect("disconnect must be surfaced without waiting for an application retry");
    assert!(matches!(request, Err(JobError::Other(_))));
    assert_eq!(
        proxy.script_count.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "an applied budget command must not be replayed after response loss"
    );
    assert_eq!(
        fixture.redis.clone().get::<_, i64>(&words).await.unwrap(),
        1
    );
    assert_eq!(fixture.redis.clone().get::<_, i64>(&jobs).await.unwrap(), 1);
    let id = variation_job_id(&channel, &["cat".into()]);
    assert_eq!(
        read_job(fixture, &id).await.get_str("state").unwrap(),
        "reserved"
    );
    // Application retry observes the reservation and does not spend again.
    let second = service
        .request_variation_job(&channel, &["cat".into()], &[])
        .await
        .unwrap();
    assert_eq!(second.get_str("state").unwrap(), "pending");
    assert_eq!(
        fixture.redis.clone().get::<_, i64>(&words).await.unwrap(),
        1
    );
    assert_eq!(
        proxy.script_count.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}
