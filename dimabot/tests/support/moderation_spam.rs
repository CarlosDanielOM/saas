//! Actual-source replay helpers. No application initialization or live endpoints.
#![allow(dead_code)]
use dima_rust::{
    schemas::channel_moderation_settings::IChannelModerationSettings,
    utils::{js_string::JsString, lossless_json::JsonValue, moderation::spam::*},
};
use serde_json::{Value, json};
use std::{env, fs, path::Path};
#[path = "schema_source.rs"]
mod schema_source;
pub const CHATTER_SOURCE: &str = "src/schemas/moderation_chatter.schema.ts";
pub const CHATTER_PIN: &str = "71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e";
pub fn string(v: &Value) -> JsString {
    JsString::from_units(
        v["utf16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
            .collect(),
    )
}
pub fn decode(v: &Value) -> Option<JsonValue> {
    Some(match v["kind"].as_str().unwrap() {
        "undefined" | "hole" => return None,
        "date" => return decode(&v["milliseconds"]),
        "null" => JsonValue::Null,
        "boolean" => JsonValue::Bool(v["value"].as_bool().unwrap()),
        "number" => JsonValue::Number(f64::from_bits(
            u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap(),
        )),
        "string" => JsonValue::String(string(v)),
        "array" => JsonValue::Array(
            v["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| decode(v).unwrap_or(JsonValue::Null))
                .collect(),
        ),
        "object" => JsonValue::Object(
            v["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|pair| {
                    let key = JsString::from_units(
                        pair[0]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|x| x.as_u64().unwrap() as u16)
                            .collect(),
                    );
                    decode(&pair[1]).map(|v| (key, v))
                })
                .collect(),
        ),
        tag => panic!("JSON adapter excludes {tag}"),
    })
}
pub fn encode(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => json!({"kind":"null"}),
        JsonValue::Bool(v) => json!({"kind":"boolean","value":v}),
        JsonValue::Number(v) => json!({"kind":"number","bits":format!("{:016x}",v.to_bits())}),
        JsonValue::String(v) => json!({"kind":"string","utf16":v.units()}),
        JsonValue::Array(v) => {
            json!({"kind":"array","items":v.iter().map(encode).collect::<Vec<_>>()})
        }
        JsonValue::Object(v) => {
            json!({"kind":"object","entries":v.iter().map(|(k,v)|json!([k.units(),encode(v)])).collect::<Vec<_>>()})
        }
    }
}
pub fn obj(fields: Vec<(&str, JsonValue)>) -> JsonValue {
    JsonValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn defaults(v: &IChannelModerationSettings) -> Value {
    let p = v.spam_protection.as_ref().unwrap();
    let p = obj(vec![
        ("enabled", JsonValue::Bool(p.enabled)),
        ("reviewAllMessages", JsonValue::Bool(p.review_all_messages)),
        (
            "categories",
            JsonValue::Array(
                p.categories
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|c| JsonValue::String(c.as_str().into()))
                    .collect(),
            ),
        ),
        (
            "thresholdPercent",
            JsonValue::Number(p.threshold_percent.unwrap()),
        ),
        (
            "exemptTags",
            JsonValue::Array(
                p.exempt_tags
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|c| JsonValue::String(c.as_str().into()))
                    .collect(),
            ),
        ),
    ]);
    assert!(v.rules.is_empty());
    let mut out = encode(&obj(vec![
        ("enabled", JsonValue::Bool(v.enabled)),
        (
            "offenseWindowSeconds",
            JsonValue::Number(v.offense_window_seconds),
        ),
        ("settingsVersion", JsonValue::Number(v.settings_version)),
        ("channelID", JsonValue::String(v.channel_id.clone())),
        ("channel", JsonValue::String(v.channel.clone())),
        ("rules", JsonValue::Array(vec![])),
        ("spamProtection", p),
    ]));
    let entries = out["entries"].as_array_mut().unwrap();
    for (name, date) in [("createdAt", v.created_at), ("updatedAt", v.updated_at)] {
        entries.push(json!([name.encode_utf16().collect::<Vec<_>>(),{"kind":"date","milliseconds":encode(&JsonValue::Number(date.timestamp_millis()as f64))}]));
    }
    out
}
pub enum Prepared {
    Invitation(JsonValue),
    Settings(JsonValue),
    Rule(JsonValue, JsonValue),
    Default(JsString),
    Review(bool, JsonValue, Option<JsonValue>),
    Decision(JsonValue),
    Policy(Option<JsonValue>, JsonValue),
    Marker(JsString, JsString),
}
pub enum Output {
    Value(JsonValue),
    Default(IChannelModerationSettings),
    Bool(bool),
    String(JsString),
    Nullable(Option<&'static str>),
}
impl Prepared {
    pub fn from_case(case: &Value) -> Self {
        let args = case["args"]["items"].as_array().unwrap();
        let value = |i: usize| decode(&args[i]).unwrap_or(JsonValue::Null);
        let context = |i: usize| {
            let mut raw = args[i].clone();
            if let Some(items) = raw["items"].as_array_mut() {
                items.retain(|v| v["kind"] != "hole");
            }
            decode(&raw).unwrap()
        };
        match case["export"].as_str().unwrap() {
            "broadcasterInvitedPromotion" => Self::Invitation(context(0)),
            "spamProtectionSettings" => Self::Settings(value(0)),
            "spamRuleForContext" => Self::Rule(context(0), value(1)),
            "defaultSpamModerationSettings" => Self::Default(string(&args[0])),
            "spamReviewSource" => Self::Review(
                args[0]["value"].as_bool().unwrap(),
                value(1),
                decode(&args[2]),
            ),
            "isSpamDecision" => Self::Decision(value(0)),
            "semanticPolicyActive" => Self::Policy(decode(&args[0]), value(1)),
            "chatterMarkerID" => Self::Marker(string(&args[0]), string(&args[1])),
            x => panic!("unhandled pure export {x}"),
        }
    }
    pub fn run(&self) -> Result<Output, &'static str> {
        match self {
            Self::Invitation(v) => broadcaster_invited_promotion_value(v).map(Output::Bool),
            Self::Settings(v) => spam_protection_settings_value(v).map(Output::Value),
            Self::Rule(c, s) => spam_rule_for_json_context_value(c, s).map(Output::Value),
            Self::Default(c) => Ok(Output::Default(default_spam_moderation_settings(c.clone()))),
            Self::Review(f, s, t) => {
                spam_review_source_value(*f, s, t.as_ref()).map(Output::Nullable)
            }
            Self::Decision(d) => is_spam_decision_value(d).map(Output::Bool),
            Self::Policy(s, d) => semantic_policy_active_value(s.as_ref(), d).map(Output::Bool),
            Self::Marker(c, u) => Ok(Output::String(chatter_marker_id(c, u).into())),
        }
    }
}
pub fn wire(out: &Output) -> Value {
    match out {
        Output::Value(v) => encode(v),
        Output::Default(v) => defaults(v),
        Output::Bool(v) => encode(&JsonValue::Bool(*v)),
        Output::String(v) => encode(&JsonValue::String(v.clone())),
        Output::Nullable(v) => v.map_or_else(
            || encode(&JsonValue::Null),
            |v| encode(&JsonValue::String(v.into())),
        ),
    }
}
pub fn check_result(result: Result<Output, &'static str>, expected: &Value, id: &str) {
    match result {
        Ok(value) => {
            assert_eq!(expected["ok"], true, "{id}");
            assert_eq!(wire(&value), expected["value"], "{id}");
        }
        Err(message) => {
            assert_eq!(expected["ok"], false, "{id}: {message}");
            assert_eq!(
                string(&json!({"utf16":expected["name"]})).as_str(),
                Some("TypeError"),
                "{id}"
            );
        }
    }
}
pub fn external_bytes(path: &str, pin: &str) -> Vec<u8> {
    assert!(Path::new(path).is_absolute());
    let real = fs::canonicalize(path).unwrap();
    let workspace =
        fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap();
    assert!(!real.starts_with(workspace));
    assert!(
        pin.len() == 64
            && pin
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    let bytes = fs::read(real).unwrap();
    assert_eq!(schema_source::sha256(&bytes), pin);
    bytes
}
pub fn reference() -> Value {
    let bytes = external_bytes(
        &env::var("DIMA_SPAM_REFERENCE").unwrap(),
        &env::var("DIMA_SPAM_REFERENCE_SHA256").unwrap(),
    );
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    let m = &data["metadata"];
    assert_eq!(m["format"], 1);
    assert_eq!(
        m["nodeSha256"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for (k, v) in [
        ("node", "24.22.1"),
        ("v8", "13.6.233.17-node.58"),
        ("icu", "78.3"),
        ("unicode", "17.0"),
        ("typescript", "5.9.3"),
        ("mongoose", "8.24.2"),
    ] {
        assert_eq!(m["versions"][k], v);
    }
    assert_eq!(
        m["pins"]["src/utils/moderation/spam.ts"],
        "eaa35698ebd7f7e2351e522ca4ece5a3d96b58a96acc41b162b6f22eb2adaaa8"
    );
    assert_eq!(m["pins"][CHATTER_SOURCE], CHATTER_PIN);
    // The shared schema resolver must resolve the retired chatter source from
    // the archive: exact bytes, unique manifest entry, no live shadow, and the
    // recorded resolver/reader binding must match the workspace fixture.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let archived = schema_source::archived(root, CHATTER_SOURCE);
    assert_eq!(schema_source::sha256(&archived), CHATTER_PIN);
    assert_eq!(m["chatterSource"]["logical"], CHATTER_SOURCE);
    assert_eq!(m["chatterSource"]["sha256"], CHATTER_PIN);
    assert_eq!(
        m["chatterSource"]["provenance"],
        schema_source::provenance(CHATTER_SOURCE)
    );
    assert_eq!(
        m["chatterSource"]["resolvedPath"],
        schema_source::provenance(CHATTER_SOURCE)
    );
    assert_eq!(
        m["sourceProvenance"][CHATTER_SOURCE],
        schema_source::provenance(CHATTER_SOURCE)
    );
    assert_eq!(m["resolver"]["logical"], CHATTER_SOURCE);
    assert_eq!(m["resolver"]["pin"], CHATTER_PIN);
    assert_eq!(
        m["resolver"]["provenance"],
        schema_source::provenance(CHATTER_SOURCE)
    );
    assert_eq!(
        m["resolver"]["resolvedPath"],
        schema_source::provenance(CHATTER_SOURCE)
    );
    assert_eq!(
        m["resolver"]["path"],
        "dimabot/tests/fixtures/schema_source_resolver.cjs"
    );
    assert_eq!(
        m["resolver"]["sha256"],
        schema_source::sha256(
            &fs::read(root.join("tests/fixtures/schema_source_resolver.cjs")).unwrap()
        )
    );
    for logical in [
        "src/utils/moderation/normalize.ts",
        "src/utils/moderation/spam_categories.ts",
    ] {
        assert_eq!(
            m["sourceProvenance"][logical],
            schema_source::provenance(logical),
            "{logical}"
        );
    }
    assert_eq!(
        m["readerSha256"],
        env::var("DIMA_SPAM_READER_SHA256").unwrap()
    );
    assert_eq!(
        m["loaderSha256"],
        env::var("DIMA_SPAM_LOADER_SHA256").unwrap()
    );
    assert_eq!(m["mongooseFiles"].as_object().unwrap().len(), 707);
    assert_eq!(
        schema_source::sha256(&serde_json::to_vec(&m["mongooseFiles"]).unwrap()),
        "63200fe45fbe04c23f601aaa191eb08934ea6795a4442d22ca5a5ba9b679b722"
    );
    assert_eq!(
        m["re2Runtime"]["loadedBinarySha256"],
        "94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb"
    );
    assert_eq!(
        m["re2Runtime"]["sourceManifestSha256"],
        "e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664"
    );
    assert_eq!(
        m["re2Runtime"]["buildProvenanceSha256"],
        "4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c"
    );
    assert_eq!(m["runtimeExports"].as_array().unwrap().len(), 14);
    assert_eq!(
        m["caseCount"].as_u64().unwrap() as usize,
        data["cases"].as_array().unwrap().len()
    );
    assert_eq!(data["schemaEvidence"]["readyState"], 0);
    assert_eq!(
        data["schemaEvidence"]["chatterCollection"],
        "moderation_chatters"
    );
    assert_eq!(
        data["schemaEvidence"]["settingsCollection"],
        "channel_moderation_settings"
    );
    data
}
pub fn checksum(results: &[Output]) -> u32 {
    fn add(h: &mut u32, n: u32) {
        *h = (*h ^ n).wrapping_mul(16_777_619);
    }
    fn visit(h: &mut u32, v: &Value) {
        match v["kind"].as_str().unwrap() {
            "undefined" => add(h, 0),
            "hole" => add(h, 1),
            "null" => add(h, 2),
            "boolean" => {
                add(h, 3);
                add(h, u32::from(v["value"].as_bool().unwrap()));
            }
            "number" => {
                add(h, 4);
                for b in v["bits"].as_str().unwrap().bytes() {
                    add(h, u32::from(b));
                }
            }
            "string" => {
                add(h, 5);
                for u in v["utf16"].as_array().unwrap() {
                    add(h, u.as_u64().unwrap() as u32);
                }
                add(h, 65536);
            }
            "array" => {
                add(h, 6);
                let items = v["items"].as_array().unwrap();
                add(h, items.len() as u32);
                for item in items {
                    visit(h, item);
                }
            }
            "object" => {
                add(h, 7);
                let entries = v["entries"].as_array().unwrap();
                add(h, entries.len() as u32);
                for pair in entries {
                    for u in pair[0].as_array().unwrap() {
                        add(h, u.as_u64().unwrap() as u32);
                    }
                    add(h, 65536);
                    visit(h, &pair[1]);
                }
            }
            "date" => {
                add(h, 8);
                visit(h, &v["milliseconds"]);
            }
            _ => panic!(),
        }
    }
    let mut h = 2_166_136_261;
    for result in results {
        visit(&mut h, &wire(result));
        add(&mut h, 65537);
    }
    h
}

pub fn native_template() -> JsonValue {
    spam_rule_template_value()
}

#[path = "../ai_credit_projection_support/mod.rs"]
mod resp;
use mongodb::{
    Client, Database,
    bson::{Document, doc},
    event::{EventHandler, command::CommandEvent},
    options::ClientOptions,
};
use std::sync::{Arc, Mutex};
#[derive(Clone, Debug)]
enum Call {
    Redis(Vec<String>),
    Mongo(Document),
}
pub struct StorageFixture {
    db: Database,
    control: Client,
    app: String,
    namespace: String,
    calls: Arc<Mutex<Vec<Call>>>,
}
impl StorageFixture {
    pub async fn new() -> Self {
        assert_eq!(
            env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
            Ok("dimabot-migration")
        );
        assert_eq!(
            env::var("KEYWORD_FIXTURE_MONGO_URI").as_deref(),
            Ok("mongodb://keyword-mongo:27017")
        );
        assert_eq!(
            env::var("KEYWORD_FIXTURE_REDIS_URL").as_deref(),
            Ok("redis://keyword-redis:6379/")
        );
        let namespace = env::var("KEYWORD_FIXTURE_NAMESPACE").unwrap();
        assert!(
            namespace.starts_with("keyword-fixture-")
                && namespace.ends_with(':')
                && (24..=50).contains(&namespace.len())
                && namespace
                    .trim_end_matches(':')
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        );
        assert_eq!(env::var("DIMA_SPAM_FAILPOINT_OWNER").unwrap(), namespace);
        let mut options = ClientOptions::parse("mongodb://keyword-mongo:27017")
            .await
            .unwrap();
        options.direct_connection = Some(true);
        options.retry_reads = Some(false);
        options.retry_writes = Some(false);
        let control = Client::with_options(options.clone()).unwrap();
        let app = format!("{namespace}spam");
        options.app_name = Some(app.clone());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        options.command_event_handler = Some(EventHandler::callback(move |event: CommandEvent| {
            if let CommandEvent::Started(e) = event
                && e.command_name == "update"
            {
                recorded.lock().unwrap().push(Call::Mongo(e.command));
            }
        }));
        let client = Client::with_options(options).unwrap();
        let db = client.database(&format!(
            "{}_spam_source",
            namespace.trim_end_matches(':').replace('-', "_")
        ));
        assert_eq!(
            db.collection::<Document>("_owner")
                .count_documents(doc! {})
                .await
                .unwrap(),
            0
        );
        db.collection::<Document>("_owner")
            .insert_one(doc! {"_id":"owner","owner":"dimabot-migration","namespace":&namespace})
            .await
            .unwrap();
        Self {
            db,
            control,
            app,
            namespace,
            calls,
        }
    }
    async fn fail_update(&self, code: i32) {
        let mut data = doc! {"failCommands":["update"],"errorCode":code,"appName":&self.app};
        if code == 11000 {
            // Mongo requires DuplicateKeyErrorInfo even for an injected error.
            data.insert(
                "errorExtraInfo",
                doc! {"keyPattern":{"_id":1},"keyValue":{"_id":"fixture-duplicate"}},
            );
        }
        self.control
            .database("admin")
            .run_command(doc! {"configureFailPoint":"failCommand","mode":{"times":1},"data":data})
            .await
            .expect("fresh private Mongo enableTestCommands=1");
    }
    pub async fn cleanup(&self) {
        let owner = self
            .db
            .collection::<Document>("_owner")
            .find_one(doc! {"_id":"owner"})
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.get_str("owner").unwrap(), "dimabot-migration");
        assert_eq!(owner.get_str("namespace").unwrap(), self.namespace);
        self.control
            .database("admin")
            .run_command(doc! {"configureFailPoint":"failCommand","mode":"off"})
            .await
            .unwrap();
        self.db.drop().await.unwrap();
    }
    pub async fn replay(&self, case: &Value) -> Option<&'static str> {
        let id = case["id"].as_str().unwrap();
        let export = case["export"].as_str().unwrap();
        let config = decode(&case["config"]).unwrap();
        let args = case["args"]["items"].as_array().unwrap();
        let channel = string(&args[0]);
        let source_calls = case["calls"]["items"].as_array().unwrap();
        let first = decode(&source_calls[0]).unwrap();
        let JsonValue::Array(first) = first else {
            panic!()
        };
        assert_eq!(text(&first[0]), "getDragonflyClient");
        assert_eq!(
            text(&first[1]),
            if export == "claimFirstObservedMessage" {
                "moderation.firstObservedMessage"
            } else {
                "moderation.spamReviewBudget"
            }
        );
        let marker = export == "claimFirstObservedMessage";
        // Acquisition failures occur before a concrete Redis handle exists. They
        // remain explicitly audited application-boundary records, not wire passes.
        if config.get("acquireError").is_some() {
            assert_eq!(case["result"]["ok"], false);
            assert_eq!(source_calls.len(), 1);
            let call = decode(&source_calls[0]).unwrap();
            assert!(
                matches!(call,JsonValue::Array(ref a) if matches!(&a[0],JsonValue::String(s) if s.as_str()==Some("getDragonflyClient")))
            );
            return Some(
                "application acquisition mock has no RESP command; concrete explicit-handle service cannot reproduce it",
            );
        }
        self.db
            .collection::<Document>("moderation_chatters")
            .delete_many(doc! {})
            .await
            .unwrap();
        self.calls.lock().unwrap().clear();
        let synthetic_get = matches!(
            config.get("get"),
            Some(
                JsonValue::Number(_)
                    | JsonValue::Bool(_)
                    | JsonValue::Object(_)
                    | JsonValue::Array(_)
            )
        );
        let synthetic_count = matches!(config.get("upsertedCount"), Some(JsonValue::String(_)));
        if marker
            && (matches!(config.get("upsertedCount"),Some(JsonValue::Number(n)) if *n==0.0)
                || synthetic_count)
        {
            let user = string(&args[1]);
            self.db.collection::<Document>("moderation_chatters").insert_one(doc!{"_id":chatter_marker_id(&channel,&user),"firstSeenAt":mongodb::bson::DateTime::from_millis(0)}).await.unwrap();
        }
        if let Some(error) = config.get("mongoError") {
            let code = match error.get("code") {
                Some(JsonValue::Number(n)) => *n as i32,
                _ => 12345,
            };
            self.fail_update(code).await;
        }
        let records = self.calls.clone();
        let replies = config.clone();
        let endpoint = resp::Endpoint::new(move |command| {
            if command[0] == "PING" {
                return b"+PONG\r\n".to_vec();
            }
            records.lock().unwrap().push(Call::Redis(command.clone()));
            match command[0].as_str() {
                "GET" => {
                    if replies.get("getError").is_some() {
                        b"-ERR fixture get failure\r\n".to_vec()
                    } else {
                        match replies.get("get") {
                            Some(JsonValue::String(s)) => resp::bulk(Some(s.as_str().unwrap())),
                            Some(JsonValue::Object(_) | JsonValue::Array(_)) => {
                                resp::bulk(Some("truthy synthetic object"))
                            }
                            _ => resp::bulk(None),
                        }
                    }
                }
                "SET" => {
                    if replies.get("setError").is_some() {
                        b"-ERR fixture set failure\r\n".to_vec()
                    } else {
                        b"+OK\r\n".to_vec()
                    }
                }
                "EVAL" => {
                    if replies.get("evalError").is_some() {
                        b"-ERR fixture eval failure\r\n".to_vec()
                    } else {
                        resp_value(replies.get("eval"))
                    }
                }
                x => panic!("unexpected RESP {x}"),
            }
        });
        let service = SpamService::new(self.db.clone(), endpoint.manager().await);
        let before = milliseconds();
        let actual = if marker {
            service
                .claim_first_observed_message(&channel, &string(&args[1]))
                .await
                .map_err(|e| format!("{e:?}"))
        } else {
            service
                .claim_spam_review_budget(&channel)
                .await
                .map_err(|e| e.to_string())
        };
        let after = milliseconds();
        match actual {
            Ok(value) => {
                assert_eq!(case["result"]["ok"], true, "{id}");
                assert_eq!(
                    encode(&JsonValue::Bool(value)),
                    case["result"]["value"],
                    "{id}"
                );
            }
            Err(error) => assert_eq!(case["result"]["ok"], false, "{id}: {error}"),
        };
        let observed = self.calls.lock().unwrap().clone();
        let expected = source_calls
            .iter()
            .skip(1)
            .map(|c| decode(c).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(observed.len(), expected.len(), "{id}: {observed:?}");
        for (actual, source) in observed.iter().zip(&expected) {
            let JsonValue::Array(source) = source else {
                panic!()
            };
            let method = match &source[0] {
                JsonValue::String(s) => s.as_str().unwrap(),
                _ => panic!(),
            };
            match (actual, method) {
                (Call::Redis(a), "get") => {
                    assert_eq!(a, &vec!["GET".into(), text(&source[1])], "{id}")
                }
                (Call::Redis(a), "set") => {
                    assert_eq!(
                        a,
                        &vec![
                            "SET".into(),
                            text(&source[1]),
                            text(&source[2]),
                            "EX".into(),
                            "86400".into()
                        ],
                        "{id}"
                    );
                    assert_eq!(source[3].get("EX"), Some(&JsonValue::Number(86400.0)));
                }
                (Call::Redis(a), "eval") => {
                    let script = text(&source[1]);
                    assert_eq!(script, BUDGET_LUA, "{id}: Lua bytes");
                    let options = &source[2];
                    let JsonValue::Array(keys) = options.get("keys").unwrap() else {
                        panic!()
                    };
                    let JsonValue::Array(args) = options.get("arguments").unwrap() else {
                        panic!()
                    };
                    assert_eq!(
                        a,
                        &vec![
                            "EVAL".into(),
                            script,
                            "2".into(),
                            text(&keys[0]),
                            text(&keys[1]),
                            text(&args[0]),
                            text(&args[1])
                        ],
                        "{id}"
                    );
                }
                (Call::Mongo(command), "updateOne") => {
                    assert_eq!(command.get_str("update").unwrap(), "moderation_chatters");
                    let updates = command.get_array("updates").unwrap();
                    assert_eq!(updates.len(), 1);
                    let update = updates[0].as_document().unwrap();
                    assert_eq!(
                        update.get_document("q").unwrap().get_str("_id").unwrap(),
                        text(source[1].get("_id").unwrap())
                    );
                    assert_eq!(update.get_document("q").unwrap().len(), 1);
                    assert_eq!(update.get_document("u").unwrap().len(), 1);
                    assert!(update.get_bool("upsert").unwrap());
                    let inserted = update
                        .get_document("u")
                        .unwrap()
                        .get_document("$setOnInsert")
                        .unwrap();
                    let at = inserted
                        .get_datetime("firstSeenAt")
                        .unwrap()
                        .timestamp_millis();
                    assert!((before..=after).contains(&at), "{id}: native clock");
                    assert_eq!(inserted.len(), 1);
                }
                _ => panic!("{id}: order mismatch {actual:?} vs {method}"),
            }
        }
        if marker {
            let user = string(&args[1]);
            let stored = self
                .db
                .collection::<Document>("moderation_chatters")
                .find_one(doc! {"_id":chatter_marker_id(&channel,&user)})
                .await
                .unwrap();
            if config.get("mongoError").is_none()
                && observed.iter().any(|c| matches!(c, Call::Mongo(_)))
            {
                assert!(stored.is_some(), "{id}: real durable write");
            }
        }
        if synthetic_get {
            Some(
                "non-string GET mock adapted to a RESP null/string with identical JS truthiness; source SDK GET boundary is string|null",
            )
        } else if synthetic_count {
            Some(
                "mock upsertedCount string cannot come from Mongo UpdateResult; seeded durable existing row reproduces false result and full update/cache order",
            )
        } else if !marker
            && matches!(
                config.get("eval"),
                Some(JsonValue::Bool(_) | JsonValue::Object(_))
            )
        {
            Some(
                "non-RESP2 mock eval bool/object explicitly mapped to scalar Number-equivalent wire reply",
            )
        } else {
            None
        }
    }
}
fn text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(s) => s.as_str().unwrap().into(),
        _ => panic!("string required"),
    }
}
fn milliseconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
fn resp_value(value: Option<&JsonValue>) -> Vec<u8> {
    match value {
        None | Some(JsonValue::Null) => b"$-1\r\n".to_vec(),
        Some(JsonValue::String(s)) => resp::bulk(s.as_str()),
        Some(JsonValue::Number(n)) if n.is_finite() && n.fract() == 0.0 => {
            format!(":{n}\r\n").into_bytes()
        }
        Some(JsonValue::Number(n)) => resp::bulk(Some(&n.to_string())),
        Some(JsonValue::Bool(v)) => format!(":{}\r\n", i32::from(*v)).into_bytes(),
        Some(JsonValue::Array(v)) => {
            let mut bytes = format!("*{}\r\n", v.len()).into_bytes();
            for item in v {
                bytes.extend(resp_value(Some(item)));
            }
            bytes
        }
        Some(JsonValue::Object(_)) => resp::bulk(Some("[object Object]")),
    }
}
