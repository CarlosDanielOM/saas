//! Exact BSON/service recordings and local-store behavior.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "roulette_support/mod.rs"]
mod support;
use anyhow::{Context, Result, bail};
use bson::doc;
use dima_core::{Clock, ManualClock};
use dima_events::envelope::Envelope;
use dima_features::widgets::{PollRequest, WidgetConfig, WidgetPolls, WidgetService};
use dima_http::guard::BoxFuture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn recording() -> Result<Value> {
    let mut nodes: Vec<Value> = Vec::new();
    fn expand(v: Value, n: &[Value]) -> Result<Value> {
        if let Some(i) = v.get("$ref").and_then(Value::as_u64) {
            return n.get(i as usize).cloned().context("reference");
        }
        Ok(v)
    }
    for line in include_str!("widgets_service_reference.jsonl").lines() {
        let n: Value = serde_json::from_str(line)?;
        if let Some(root) = n.get("root") {
            return expand(root.clone(), &nodes);
        }
        let v = if let Some(a) = n.get("array").and_then(Value::as_array) {
            Value::Array(
                a.iter()
                    .cloned()
                    .map(|v| expand(v, &nodes))
                    .collect::<Result<_>>()?,
            )
        } else if let Some(m) = n.get("object").and_then(Value::as_object) {
            Value::Object(
                m.iter()
                    .map(|(k, v)| Ok((k.clone(), expand(v.clone(), &nodes)?)))
                    .collect::<Result<_>>()?,
            )
        } else {
            bail!("bad node")
        };
        nodes.push(v);
    }
    bail!("missing root")
}
#[derive(Default)]
struct PollState {
    poll: Option<Value>,
    fail: Option<String>,
    calls: Vec<Value>,
}
#[derive(Default)]
struct Polls(Mutex<PollState>);
impl WidgetPolls for Polls {
    fn get<'a>(
        &'a self,
        c: &'a str,
        id: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<Value>, String>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            s.calls.push(json!(["get", c, id]));
            if s.fail.as_deref() == Some("get") {
                return Ok(None);
            }
            Ok(s.poll.clone())
        })
    }
    fn create<'a>(&'a self, c: &'a str, r: PollRequest) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            let args = format!(
                "{};{};{};{}",
                r.title,
                r.options.join("/"),
                r.seconds,
                r.points
            );
            let source = format!("$(start.poll {})", dima_text::to_js_json(&json!(args)));
            s.calls.push(json!(["create",source,{"channelID":c,"scopeType":"widgets","scopeName":r.pack_id,"userPlan":"pro","userLevel":10,"literalArguments":true}]));
            if s.fail.as_deref() == Some("create") {
                return Err("mock poll failed".into());
            }
            s.poll = Some(
                json!({"id":"poll-fixed","title":r.title,"status":"ACTIVE","choices":(0..5).map(|n|json!({"id":format!("choice-{n}"),"votes":0,"channelPointsVotes":0})).collect::<Vec<_>>()}),
            );
            Ok(())
        })
    }
}
fn event(v: &Value) -> Result<Envelope> {
    Ok(Envelope {
        id: bson::oid::ObjectId::new(),
        event_key: v["eventKey"].as_str().context("event key")?.into(),
        source: v["source"].as_str().context("source")?.into(),
        source_event_id: "source".into(),
        kind: v["type"].as_str().context("type")?.into(),
        topic: "channel".into(),
        schema_version: 1.0,
        owner_user_id: None,
        subject: None,
        channel_id: v["channelID"].as_str().map(str::to_owned),
        stream_id: None,
        occurred_at_ms: v["occurredAt"].as_i64().context("occurred")?,
        journaled_at_ms: v["journaledAt"].as_i64(),
        payload: dima_events::value::Object::from_bson(&bson::serialize_to_document(
            &v["payload"],
        )?),
        metadata: dima_events::value::Object::new(),
        expires_at_ms: i64::MAX,
    })
}
#[tokio::test]
async fn widgets_service_bson_recording() -> Result<()> {
    let fixture = recording()?;
    support::with_database(|mongo,_|async move{
  for id in ["1001","1002","1003","1004","1005","1006"]{mongo.documents("users").insert_one(doc!{"_id":format!("user-{id}"),"accounts":[{"type":"twitch","id":id}],"plan_tier":if id=="1002"{"free"}else if id=="1003"{"pro"}else{"premium"}}).await?;}
  let clock=ManualClock::new(1794355200000);let polls=Arc::new(Polls::default());let service=WidgetService::new(mongo.clone(),Arc::new(clock.clone()),Arc::new(support::StreamRandom::new("dima-widgets-stream")),polls.clone(),WidgetConfig::default());
  for (i,step) in fixture["steps"].as_array().context("steps")?.iter().enumerate(){
   clock.set(step["now"].as_i64().context("clock")?);let a=&step["args"];
   {let mut s=polls.0.lock().unwrap();s.calls.clear();s.fail=step["script"]["fail"].as_str().map(str::to_owned);if let Some(p)=step["script"].get("poll"){s.poll=(!p.is_null()).then(||p.clone());}}
   let id=a[0].as_str().unwrap_or("");let result=match step["op"].as_str().context("op")?{
    "execute"=>service.execute(id,a[1].as_str().context("action")?,&a[2],a[3].as_str().context("key")?,a[4].as_f64().context("revision")?).await,
    "snapshot"=>service.snapshot(id).await,
    "settle_due"=>service.settle_due().await.map(|()|Value::Null),
    "event"=>service.apply_widget_event(id,&event(&a[1])?).await.map(|()|Value::Null),
    "event_settings"=>service.widget_event_settings(id).await,
    "targets"=>service.active_widget_event_targets(id).await.map(|v|json!(v)),
    "validate_events"=>dima_features::widgets::events::settings(&a[0],clock.now_ms()).map_err(Into::into),
    "token_save"=>service.save_token(id,a[1].as_str(),a[2].as_str().context("token hash")?,support::from_ejson(&a[3])?,a[4].as_bool().context("replace")?).await.map(Value::from),
    "token_document"=>service.token_document(id).await.map(|d|json!({"tokenHash":d.token_hash,"overlayToken":d.overlay_token.map(|b|b.into_relaxed_extjson())})),
    "authorize"=>service.authorize_overlay(id,a[1].as_str().context("token")?).await.map(Value::from),
    "receipt_window"=>{
     let prepared=dima_model::widget_channels::INFO.prepare_update(&doc!{"_id":id},doc!{"$set":{"receipts":json_bson(&a[1])}},dima_model::UpdateOptions::default(),&mut dima_store::mongo::WriteContext::new(clock.now_ms()))?;
     mongo.writes("widget_channels").update_one(&prepared).await?;
     service.execute(id,"hide",&json!({}),"receipt-window",a[2].as_f64().context("revision")?).await
    },
    "legacy_show"=>{
     mongo.documents("widget_channels").update_one(doc!{"_id":id},doc!{"$set":{"future":"keep","state.futureDate":bson::DateTime::from_millis(1234567),"state.futureNumber":bson::Bson::Int64(7)},"$unset":{"state.config.layout":"","state.wins":""}}).await?;
     service.execute(id,"show",&json!({}),"legacy-show",a[1].as_f64().context("legacy revision")?).await
    },
    "recover_poll"=>{
     let prepared=dima_model::widget_channels::INFO.prepare_update(&doc!{"_id":id},doc!{"$set":{"state":json_bson(&a[1]),"dueAt":dima_store::mongo::number::js_number(clock.now_ms() as f64)}},dima_model::UpdateOptions::default(),&mut dima_store::mongo::WriteContext::new(clock.now_ms()))?;
     mongo.writes("widget_channels").update_one(&prepared).await?;
     service.snapshot(id).await
    },
    "expired_advance"=>{
     mongo.documents("users").update_one(doc!{"_id":"user-1006"},doc!{"$set":{"plan_tier":"free"}}).await?;
     let prepared=dima_model::widget_channels::INFO.prepare_update(&doc!{"_id":id},doc!{"$set":{"state":json_bson(&a[1]),"dueAt":dima_store::mongo::number::js_number(clock.now_ms() as f64)}},dima_model::UpdateOptions::default(),&mut dima_store::mongo::WriteContext::new(clock.now_ms()))?;
     mongo.writes("widget_channels").update_one(&prepared).await?;
     service.snapshot(id).await
    },
    other=>bail!("unknown op {other}"),
   };
   let actual=match result{Ok(v)=>json!({"ok":v}),Err(e)=>if let Some(e)=e.refused(){json!({"error":{"code":e.code,"message":e.message,"status":e.status}})}else{bail!("step {i}: {e}")}};
   assert_eq!(support::numbers_as_doubles(&actual),support::numbers_as_doubles(&step["result"]),"result step {i}");
   assert_eq!(polls.0.lock().unwrap().calls,step["calls"].as_array().context("calls")?.clone(),"poll calls step {i}");
   if !id.is_empty()&&id.bytes().all(|b|b.is_ascii_digit()) {
    let expected=step["documents"].as_array().context("documents")?.iter().find(|d|d["_id"]==id).map(|d|->Result<_>{let b=support::from_ejson(d)?;let d=b.as_document().context("BSON document")?;Ok((d.get("revision").and_then(dima_store::mongo::number::read_number).context("revision")?,d.get("dueAt").and_then(dima_store::mongo::number::read_number),d.get_str("tokenHash").ok().map(str::to_owned)))}).transpose()?;
    assert_eq!(service.version(id).await?,expected,"version step {i}");
   }
   let documents=support::documents(&mongo,"widget_channels").await?;
   assert_eq!(json!(documents),step["documents"],"BSON step {i} {}",step["op"]);
  }
  Ok(())
 }).await
}
#[test]
fn widgets_service_recording_provenance() -> Result<()> {
    let f = recording()?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../dimabot/src");
    for (file, hash) in f["sources"].as_object().context("sources")? {
        assert_eq!(
            dima_core::crypto::sha256(std::fs::read(root.join(file))?).hex(),
            hash.as_str().context("hash")?
        );
    }
    Ok(())
}

fn json_bson(v: &Value) -> bson::Bson {
    match v {
        Value::Object(m) => {
            bson::Bson::Document(m.iter().map(|(k, v)| (k.clone(), json_bson(v))).collect())
        }
        Value::Array(a) => bson::Bson::Array(a.iter().map(json_bson).collect()),
        Value::Number(n) => dima_store::mongo::number::js_number(n.as_f64().unwrap()),
        _ => bson::serialize_to_bson(v).unwrap(),
    }
}

#[tokio::test]
async fn widgets_preserve_legacy_bson_and_reject_unbounded_inputs() -> Result<()> {
    support::with_database(|mongo,_|async move{
  mongo.documents("users").insert_one(doc!{"accounts":[{"type":"twitch","id":"1001"}],"plan_tier":"premium"}).await?;
  let clock=ManualClock::new(1794355200000);let polls=Arc::new(Polls::default());let service=WidgetService::new(mongo.clone(),Arc::new(clock.clone()),Arc::new(support::StreamRandom::new("dima-widgets-stream")),polls,WidgetConfig::default());
  service.load("1001").await?;
  let legacy=bson::DateTime::from_millis(1234567);
  mongo.documents("widget_channels").update_one(doc!{"_id":"1001"},doc!{"$set":{"future":"keep","state.futureDate":legacy,"state.futureNumber":bson::Bson::Int64(7)},"$unset":{"state.config.layout":"","state.wins":""}}).await?;
  service.execute("1001","show",&json!({}),"show",0.0).await?;
  let raw=mongo.documents("widget_channels").find_one(doc!{"_id":"1001"}).await?.context("raw")?;
  assert_eq!(raw.get_str("future")?,"keep");assert_eq!(raw.get_document("state")?.get_datetime("futureDate")?,&legacy);assert_eq!(raw.get_document("state")?.get_i32("futureNumber")?,7);
  let mut deep=json!(true);for _ in 0..34{deep=json!({"x":deep});}
  for data in [json!({"unexpected":"a".repeat(102401)}),deep]{let error=service.execute("1001","configure",&data,"bounded",1.0).await.unwrap_err();assert_eq!(error.refused().context("refusal")?.code,"invalid");}
  assert_eq!(service.read("1001").await?.context("state")?.revision,1.0);
  // JSON floating-point integral values remain valid JavaScript numeric input.
  service.execute("1001","progress",&json!({"role":"killer","delta":1.0}),"float",1.0).await?;
  assert_eq!(service.read("1001").await?.context("state")?.state["wins"]["killer"],1);
  Ok(())
 }).await
}

struct HangingPolls;
impl WidgetPolls for HangingPolls {
    fn get<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<Value>, String>> {
        Box::pin(std::future::pending())
    }
    fn create<'a>(&'a self, _: &'a str, _: PollRequest) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(std::future::pending())
    }
}
#[tokio::test]
async fn widgets_poll_deadline_persists_failure_without_repeating_effect() -> Result<()> {
    support::with_database(|mongo, _| async move {
        mongo
            .documents("users")
            .insert_one(doc! {"accounts":[{"type":"twitch","id":"1001"}],"plan_tier":"premium"})
            .await?;
        let s = WidgetService::new(
            mongo.clone(),
            Arc::new(ManualClock::new(1794355200000)),
            Arc::new(support::StreamRandom::new("deadline")),
            Arc::new(HangingPolls),
            WidgetConfig {
                store_deadline: std::time::Duration::from_secs(10),
                effect_deadline: std::time::Duration::from_millis(5),
            },
        );
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            s.execute("1001", "start", &json!({"mode":"poll"}), "deadline", 0.0),
        )
        .await??;
        assert_eq!(result, json!({"replayed":false}));
        let d = s.read("1001").await?.context("state")?;
        assert_eq!(d.state["phase"], "poll-error");
        assert_eq!(d.state["run"]["error"], "Widget poll deadline exceeded");
        assert_eq!(d.revision, 2.0);
        assert_eq!(
            s.execute("1001", "start", &json!({"mode":"poll"}), "deadline", 0.0)
                .await?,
            json!({"replayed":true})
        );
        assert_eq!(s.read("1001").await?.context("state")?.revision, 2.0);
        Ok(())
    })
    .await
}
