//! Self-test fixture for the rig: a tiny HTTP server that writes to its MongoDB database and its
//! Dragonfly logical database. `--variant good` is the reference behaviour; `equivalent` differs
//! only in generated ids, timing, insertion order and JSON key order; every other variant
//! introduces exactly one defect the rig must catch.
//!
//! Environment: PORT, MONGO_URI, MONGO_DB, REDIS_URL; for the webhook routes FIXTURE_EVENTSUB_SECRET,
//! FIXTURE_POLAR_SECRET and FIXTURE_MOCK_URL (the side's mock, where it answers in chat).
#![forbid(unsafe_code)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use bson::{Bson, Document, doc, oid::ObjectId};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Variant {
    Good,
    ScanPaged,
    ScanMissing,
    ScanLoop,
    Delayed,
    Equivalent,
    Int64,
    NullField,
    NoTtl,
    Status,
    ExtraDoc,
    Crash,
    Number,
    WrongRef,
    WritesOnGet,
    JobKeyOrder,
    NoCookie,
    CookieAttr,
    StrictStartup,
    LeaseReplay,
    NoBump,
    LeaseLength,
    DateAsString,
    DateAsNumber,
    IndexOrder,
    IndexOption,
    StreamField,
    HashBytes,
    /// Answers an EventSub chat message with other text.
    ChatText,
    /// Does not answer an EventSub chat message at all.
    NoChat,
}

impl Variant {
    fn parse(s: &str) -> Result<Variant> {
        Ok(match s {
            "good" => Variant::Good,
            "scan-paged" => Variant::ScanPaged,
            "scan-missing" => Variant::ScanMissing,
            "scan-loop" => Variant::ScanLoop,
            "delayed" => Variant::Delayed,
            "equivalent" => Variant::Equivalent,
            "int64" => Variant::Int64,
            "null-field" => Variant::NullField,
            "no-ttl" => Variant::NoTtl,
            "status" => Variant::Status,
            "extra-doc" => Variant::ExtraDoc,
            "crash" => Variant::Crash,
            "number" => Variant::Number,
            "wrong-ref" => Variant::WrongRef,
            "writes-on-get" => Variant::WritesOnGet,
            "job-key-order" => Variant::JobKeyOrder,
            "no-cookie" => Variant::NoCookie,
            "cookie-attr" => Variant::CookieAttr,
            "strict-startup" => Variant::StrictStartup,
            "lease-replay" => Variant::LeaseReplay,
            "no-bump" => Variant::NoBump,
            "lease-length" => Variant::LeaseLength,
            "date-as-string" => Variant::DateAsString,
            "date-as-number" => Variant::DateAsNumber,
            "index-order" => Variant::IndexOrder,
            "index-option" => Variant::IndexOption,
            "stream-field" => Variant::StreamField,
            "hash-bytes" => Variant::HashBytes,
            "chat-text" => Variant::ChatText,
            "no-chat" => Variant::NoChat,
            other => bail!("unknown variant {other}"),
        })
    }
}

struct App {
    v: Variant,
    client: mongodb::Client,
    db: mongodb::Database,
    redis: redis::aio::MultiplexedConnection,
    posts: AtomicU32,
}

struct Request {
    method: String,
    path: String,
    /// Lower-case names.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

struct Response {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
    headers: Vec<(&'static str, String)>,
}

fn json_resp(status: u16, v: &Value) -> Response {
    Response {
        status,
        content_type: "application/json; charset=utf-8",
        body: serde_json::to_vec(v).unwrap_or_default(),
        headers: Vec::new(),
    }
}

/// `Date.prototype.toISOString` shape: always three fraction digits.
fn iso(dt: bson::DateTime) -> String {
    dima_rig::timefmt::format_iso_ms(dt.timestamp_millis()).unwrap_or_default()
}

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
}

/// The lease deadline the reference wrote in `items/lease`, from its recording
/// (`FIXTURE_CAPTURES`): a candidate that replays an absolute time.
fn replayed_lease() -> Result<f64> {
    let dir = std::env::var("FIXTURE_CAPTURES").context("FIXTURE_CAPTURES is not set")?;
    let text = std::fs::read_to_string(format!("{dir}/selftest/items/lease.json"))?;
    let v: Value = serde_json::from_str(&text)?;
    let docs = v["mongo"]["items"]["documents"]
        .as_array()
        .ok_or_else(|| anyhow!("no items in the recording"))?;
    let lease = docs
        .iter()
        .find(|d| d["name"] == "leased")
        .and_then(|d| d["leaseUntil"]["$numberDouble"].as_str())
        .ok_or_else(|| anyhow!("no leaseUntil in the recording"))?;
    Ok(lease.parse()?)
}

async fn read_request(s: &mut TcpStream) -> Result<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            bail!("connection closed before the request ended");
        }
        buf.extend_from_slice(chunk.get(..n).unwrap_or(&[]));
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > 65_536 {
            bail!("request head too large");
        }
    };
    let head = String::from_utf8_lossy(buf.get(..head_end).unwrap_or(&[])).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut len = 0usize;
    let mut headers = Vec::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let mut body = buf.get(head_end + 4..).unwrap_or(&[]).to_vec();
    while body.len() < len {
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(chunk.get(..n).unwrap_or(&[]));
    }
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

async fn write_response(s: &mut TcpStream, v: Variant, r: Response) -> Result<()> {
    let reason = match r.status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Status",
    };
    let now = dima_rig::timefmt::now_ms();
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\ncontent-type: {}\r\ncontent-length: {}\r\nx-content-type-options: nosniff\r\nconnection: close\r\ndate: {}\r\n",
        r.status,
        r.content_type,
        r.body.len(),
        dima_rig::timefmt::format_http_date(now).unwrap_or_default(),
    );
    // Noise the rig does not compare: only the reference says who it is.
    if v != Variant::Equivalent {
        head.push_str("x-powered-by: Fixture\r\n");
    }
    // A weak ETag from the body, which holds generated values: compared by form only.
    let hash = r.body.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    });
    head.push_str(&format!("etag: W/\"{:x}-{hash:x}\"\r\n", r.body.len()));
    for (k, val) in &r.headers {
        head.push_str(&format!("{k}: {val}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes()).await?;
    s.write_all(&r.body).await?;
    s.flush().await?;
    Ok(())
}

impl App {
    async fn create_item(&self, body: &[u8]) -> Result<Response> {
        let n = self.posts.fetch_add(1, Ordering::SeqCst) + 1;
        if self.v == Variant::Crash && n == 2 {
            println!("fixture: crashing on purpose during POST #{n}");
            std::process::exit(3);
        }
        let input: Value = serde_json::from_slice(body)?;
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("name"))?
            .to_string();
        let qty = input
            .get("qty")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("qty"))?;
        let owner = ObjectId::parse_str(input.get("owner").and_then(Value::as_str).unwrap_or(""))?;
        if self.v == Variant::Equivalent {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let id = ObjectId::new();
        let uuid = uuid::Uuid::new_v4().to_string();
        let now = bson::DateTime::now();
        let qty_bson = if self.v == Variant::Int64 {
            Bson::Int64(qty)
        } else {
            Bson::Int32(i32::try_from(qty)?)
        };
        // One clock reading for createdAt and updatedAt; the lease is exactly 60 s after it.
        let lease = Bson::Double((now.timestamp_millis() + 60_000) as f64);
        let created = match self.v {
            Variant::DateAsString => Bson::String(iso(now)),
            Variant::DateAsNumber => Bson::Double(now.timestamp_millis() as f64),
            _ => Bson::DateTime(now),
        };
        let mut item = if self.v == Variant::Equivalent {
            doc! {"_id": id, "owner": owner, "uuid": &uuid, "tags": ["new"], "leaseUntil": lease, "updatedAt": now, "createdAt": created, "qty": qty_bson, "name": &name}
        } else {
            doc! {"_id": id, "name": &name, "qty": qty_bson, "owner": owner, "uuid": &uuid, "createdAt": created, "updatedAt": now, "leaseUntil": lease, "tags": ["new"]}
        };
        if self.v == Variant::NullField {
            item.insert("note", Bson::Null);
        }
        self.db
            .collection::<Document>("items")
            .insert_one(item)
            .await?;
        let event_id = ObjectId::new();
        let mut events =
            vec![doc! {"_id": event_id, "type": "item.created", "item": id, "at": now}];
        if self.v == Variant::ExtraDoc {
            events.push(doc! {"_id": ObjectId::new(), "type": "item.debug", "item": id, "at": now});
        }
        self.db
            .collection::<Document>("events")
            .insert_many(events)
            .await?;
        let mut r = self.redis.clone();
        let key_id = if self.v == Variant::WrongRef {
            event_id
        } else {
            id
        };
        // Key order differs in `equivalent`: this value is not byte-sensitive (a note only).
        let cached = if self.v == Variant::Equivalent {
            json!({"name": name, "id": id.to_hex()}).to_string()
        } else {
            json!({"id": id.to_hex(), "name": name}).to_string()
        };
        let mut set = redis::cmd("SET");
        set.arg(format!("item:{}", key_id.to_hex())).arg(&cached);
        if self.v != Variant::NoTtl {
            set.arg("EX").arg(3600);
        }
        set.query_async::<()>(&mut r).await?;
        redis::cmd("HSET")
            .arg("items:by-name")
            .arg(&name)
            .arg(id.to_hex())
            .query_async::<i64>(&mut r)
            .await?;
        let total: i64 = redis::cmd("INCR")
            .arg("items:count")
            .query_async(&mut r)
            .await?;
        // A stream entry that repeats a field name.
        let mut xadd = redis::cmd("XADD");
        xadd.arg("items:events")
            .arg("*")
            .arg("item")
            .arg(id.to_hex())
            .arg("tag")
            .arg("new");
        if self.v != Variant::StreamField {
            xadd.arg("tag").arg("created");
        }
        xadd.query_async::<String>(&mut r).await?;
        let total = if self.v == Variant::Number {
            total + 1
        } else {
            total
        };
        let resp = if self.v == Variant::Equivalent {
            json!({"total": total, "createdAt": iso(now), "qty": qty, "name": name, "uuid": uuid, "id": id.to_hex()})
        } else {
            json!({"id": id.to_hex(), "uuid": uuid, "name": name, "qty": qty, "createdAt": iso(now), "total": total})
        };
        let mut r = json_resp(201, &resp);
        // A session cookie with a generated value and an expiry an hour after now.
        let expires = dima_rig::timefmt::format_http_date(now.timestamp_millis() + 3_600_000)
            .unwrap_or_default();
        let sid = uuid::Uuid::new_v4();
        let cookie = match self.v {
            Variant::NoCookie => None,
            Variant::CookieAttr => Some(format!(
                "sid={sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600; Expires={expires}"
            )),
            // Attribute order differs: a note, not a difference.
            Variant::Equivalent => Some(format!(
                "sid={sid}; Path=/; SameSite=Lax; Max-Age=3600; Expires={expires}; HttpOnly"
            )),
            _ => Some(format!(
                "sid={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Expires={expires}"
            )),
        };
        if let Some(c) = cookie {
            r.headers.push(("set-cookie", c));
        }
        if self.v == Variant::Delayed && name == "leased" {
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
        Ok(r)
    }

    /// Renew an item's lease in a second operation: updatedAt moves to now and the lease is now
    /// plus exactly 60 s.
    async fn touch_item(&self, hex: &str) -> Result<Response> {
        let id = ObjectId::parse_str(hex)?;
        let now = bson::DateTime::now();
        let lease = match self.v {
            Variant::LeaseLength => (now.timestamp_millis() + 61_000) as f64,
            // The reference's absolute deadline, read from its recording.
            Variant::LeaseReplay => replayed_lease()?,
            _ => (now.timestamp_millis() + 60_000) as f64,
        };
        let mut set = doc! {"leaseUntil": lease};
        if self.v != Variant::NoBump {
            set.insert("updatedAt", now);
        }
        self.db
            .collection::<Document>("items")
            .update_one(doc! {"_id": id}, doc! {"$set": set})
            .await?;
        Ok(json_resp(200, &json!({"ok": true})))
    }

    async fn get_item(&self, hex: &str) -> Result<Response> {
        let missing = |s: &App| {
            json_resp(
                if s.v == Variant::Status { 200 } else { 404 },
                &json!({"error": "not found"}),
            )
        };
        let Ok(id) = ObjectId::parse_str(hex) else {
            return Ok(missing(self));
        };
        let items = self.db.collection::<Document>("items");
        let Some(d) = items.find_one(doc! {"_id": id}).await? else {
            return Ok(missing(self));
        };
        if self.v == Variant::WritesOnGet {
            items
                .update_one(
                    doc! {"_id": id},
                    doc! {"$set": {"lastReadAt": bson::DateTime::now()}},
                )
                .await?;
        }
        let qty = match d.get("qty") {
            Some(Bson::Int32(i)) => i64::from(*i),
            Some(Bson::Int64(i)) => *i,
            _ => 0,
        };
        Ok(json_resp(
            200,
            &json!({
                "id": hex,
                "name": d.get_str("name").unwrap_or(""),
                "qty": qty,
                "owner": d.get_object_id("owner").map(|o| o.to_hex()).unwrap_or_default(),
                "createdAt": match d.get("createdAt") {
                    Some(Bson::DateTime(t)) => iso(*t),
                    Some(Bson::String(s)) => s.clone(),
                    Some(Bson::Double(f)) => iso(bson::DateTime::from_millis(*f as i64)),
                    _ => String::new(),
                },
            }),
        ))
    }

    async fn queue_jobs(self: &Arc<Self>, body: &[u8]) -> Result<Response> {
        let input: Value = serde_json::from_slice(body)?;
        let item = ObjectId::parse_str(input.get("item").and_then(Value::as_str).unwrap_or(""))?;
        // A queue item a reader removes by value (byte-sensitive: `cron:jobs:queue`).
        let job = if self.v == Variant::JobKeyOrder {
            format!(
                r#"{{"job":"finish","id":"{}","requestedAt":{}}}"#,
                item.to_hex(),
                bson::DateTime::now().timestamp_millis()
            )
        } else {
            format!(
                r#"{{"id":"{}","job":"finish","requestedAt":{}}}"#,
                item.to_hex(),
                bson::DateTime::now().timestamp_millis()
            )
        };
        let mut r = self.redis.clone();
        redis::cmd("RPUSH")
            .arg("cron:jobs:queue")
            .arg(job)
            .query_async::<i64>(&mut r)
            .await?;
        let app = Arc::clone(self);
        tokio::spawn(async move {
            let delay = if app.v == Variant::Equivalent {
                600
            } else {
                300
            };
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if let Err(e) = app.finish_jobs(item).await {
                println!("fixture: job failed: {e}");
            }
        });
        Ok(json_resp(202, &json!({"queued": true})))
    }

    async fn finish_jobs(&self, item: ObjectId) -> Result<()> {
        let (a, b) = (ObjectId::new(), ObjectId::new());
        let now = bson::DateTime::now();
        let mut docs = vec![
            doc! {"_id": a, "item": item, "step": 1, "doneAt": now},
            doc! {"_id": b, "item": item, "step": 2, "doneAt": now},
        ];
        if self.v == Variant::Equivalent {
            docs.reverse();
        }
        let jobs = self.db.collection::<Document>("jobs");
        for d in docs {
            jobs.insert_one(d).await?;
        }
        // An object keyed by generated ids; `equivalent` writes its keys in the other order.
        let mut steps = doc! {a.to_hex(): {"step": 1}, b.to_hex(): {"step": 2}};
        if self.v == Variant::Equivalent {
            steps = doc! {b.to_hex(): {"step": 2}, a.to_hex(): {"step": 1}};
        }
        self.db
            .collection::<Document>("batches")
            .insert_one(doc! {"_id": ObjectId::new(), "item": item, "steps": steps})
            .await?;
        let mut r = self.redis.clone();
        redis::cmd("RPUSH")
            .arg("jobs:done")
            .arg(a.to_hex())
            .arg(b.to_hex())
            .query_async::<i64>(&mut r)
            .await?;
        Ok(())
    }

    /// The bot's EventSub ingress in miniature: the signature is checked like the reference
    /// checks it, a verification is answered with its challenge, and a chat message is answered
    /// in chat through the mock (after the 204, as the bot does).
    async fn eventsub(&self, req: &Request) -> Result<Response> {
        let secret = env("FIXTURE_EVENTSUB_SECRET")?;
        let h = |n: &str| req.header(n).unwrap_or("").to_string();
        let ok = dima_core::crypto::webhook::verify_eventsub_signature(
            &dima_core::SecretBytes::from_text(&secret),
            &h("twitch-eventsub-message-id"),
            &h("twitch-eventsub-message-timestamp"),
            &req.body,
            &h("twitch-eventsub-message-signature"),
        );
        let empty = |status| Response {
            status,
            content_type: "text/plain; charset=utf-8",
            body: Vec::new(),
            headers: Vec::new(),
        };
        if !ok {
            return Ok(empty(403));
        }
        let n: Value = serde_json::from_slice(&req.body)?;
        match h("twitch-eventsub-message-type").as_str() {
            "webhook_callback_verification" => Ok(Response {
                status: 200,
                content_type: "text/plain; charset=utf-8",
                body: n["challenge"].as_str().unwrap_or("").as_bytes().to_vec(),
                headers: Vec::new(),
            }),
            "notification" if n["subscription"]["type"] == "channel.chat.message" => {
                let text = n["event"]["message"]["text"].as_str().unwrap_or("");
                let answer = if self.v == Variant::ChatText {
                    format!("Echo: {text}")
                } else {
                    format!("echo: {text}")
                };
                let body = json!({"broadcaster_id": n["event"]["broadcaster_user_id"], "sender_id": "698614112", "message": answer});
                if self.v != Variant::NoChat {
                    let url = format!(
                        "{}/api.twitch.tv/helix/chat/messages",
                        env("FIXTURE_MOCK_URL")?
                    );
                    tokio::spawn(async move {
                        let c = reqwest::Client::new();
                        let r = c
                            .post(url)
                            .header("authorization", "Bearer fixture-bot-token")
                            .header("client-id", "fixture-client")
                            .json(&body)
                            .send()
                            .await;
                        println!("fixture: chat answer -> {:?}", r.map(|r| r.status()));
                    });
                }
                Ok(empty(204))
            }
            _ => Ok(empty(204)),
        }
    }

    /// A Polar webhook route in miniature: standardwebhooks verified like @polar-sh/sdk.
    fn polar(&self, req: &Request) -> Result<Response> {
        let Some(w) = dima_core::crypto::webhook::PolarWebhook::new(&env("FIXTURE_POLAR_SECRET")?)
        else {
            return Ok(json_resp(500, &json!({"error": "no secret"})));
        };
        let headers = dima_core::crypto::webhook::WebhookHeaders {
            id: req.header("webhook-id"),
            timestamp: req.header("webhook-timestamp"),
            signature: req.header("webhook-signature"),
        };
        match w.verify(&req.body, headers, dima_rig::timefmt::now_ms()) {
            Ok(()) => {
                let v: Value = serde_json::from_slice(&req.body)?;
                Ok(json_resp(202, &json!({"received": v["type"]})))
            }
            Err(e) => Ok(json_resp(403, &json!({"error": e.to_string()}))),
        }
    }

    async fn route(self: &Arc<Self>, req: Request) -> Result<Response> {
        if req.path.starts_with("/scan") {
            let (cursor, names) = match self.v {
                Variant::ScanLoop => ("again", vec!["a"]),
                Variant::ScanMissing => ("0", vec!["a"]),
                Variant::ScanPaged if !req.path.contains("cursor=") => ("next", vec!["b"]),
                Variant::ScanPaged => ("0", vec!["a", "b"]),
                _ => ("0", vec!["a", "b"]),
            };
            let later = self.v == Variant::ScanPaged && req.path.contains("cursor=");
            if later {
                tokio::time::sleep(Duration::from_millis(1200)).await;
            }
            return Ok(json_resp(
                200,
                &json!({"data": {"cursor": cursor, "keys": names.into_iter().map(|name| json!({"name": name, "ttl": if name == "b" { -1 } else if later { 899 } else { 900 }})).collect::<Vec<_>>()}}),
            ));
        }
        let segs: Vec<&str> = req.path.trim_start_matches('/').split('/').collect();
        match (req.method.as_str(), segs.as_slice()) {
            ("GET", ["health"]) => Ok(Response {
                status: 200,
                content_type: "text/plain; charset=utf-8",
                body: b"ok".to_vec(),
                headers: Vec::new(),
            }),
            ("POST", ["items"]) => self.create_item(&req.body).await,
            ("GET", ["items", id]) => self.get_item(id).await,
            ("POST", ["items", id, "touch"]) => self.touch_item(id).await,
            ("POST", ["jobs"]) => self.queue_jobs(&req.body).await,
            ("POST", ["eventsub"]) => self.eventsub(&req).await,
            // A file the scenario seeded into the side's data directory.
            ("GET", ["file", name]) => {
                let dir = env("FIXTURE_DATA_DIR")?;
                match std::fs::read(std::path::Path::new(&dir).join(name)) {
                    Ok(b) => Ok(Response {
                        status: 200,
                        content_type: "text/plain; charset=utf-8",
                        body: b,
                        headers: Vec::new(),
                    }),
                    Err(_) => Ok(json_resp(404, &json!({"error": "no such file"}))),
                }
            }
            // Try to write to a database that is not the side's own.
            ("POST", ["other-db"]) => {
                let other = self.client.database("rig_other_db_probe");
                match other
                    .collection::<Document>("probe")
                    .insert_one(doc! {"x": 1})
                    .await
                {
                    Ok(_) => {
                        let _ = other.drop().await;
                        Ok(json_resp(200, &json!({"refused": false})))
                    }
                    Err(_) => Ok(json_resp(200, &json!({"refused": true}))),
                }
            }
            ("POST", ["polar", "webhook"]) => self.polar(&req),
            // Echo one word (a scenario saves it and uses it in a later step).
            ("GET", ["word", w]) => Ok(json_resp(200, &json!({"word": w}))),
            // In-memory state of this process: how many items it created.
            ("GET", ["memory"]) => Ok(json_resp(
                200,
                &json!({"posts": self.posts.load(Ordering::SeqCst)}),
            )),
            _ => Ok(json_resp(404, &json!({"error": "no route"}))),
        }
    }
}

async fn serve(app: Arc<App>, mut s: TcpStream) {
    let res = match read_request(&mut s).await {
        Ok(req) => {
            let line = format!("{} {}", req.method, req.path);
            let r = app.route(req).await;
            match &r {
                Ok(resp) => println!("fixture: {line} -> {}", resp.status),
                Err(e) => println!("fixture: {line} -> error {e}"),
            }
            r.unwrap_or_else(|e| json_resp(500, &json!({"error": e.to_string()})))
        }
        Err(e) => json_resp(400, &json!({"error": e.to_string()})),
    };
    let _ = write_response(&mut s, app.v, res).await;
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    // Which checkout built this binary (worktrees share one target directory).
    if args.iter().any(|a| a == "--build-info") {
        println!("{}", env!("CARGO_MANIFEST_DIR"));
        return Ok(());
    }
    let variant = match args
        .iter()
        .position(|a| a == "--variant")
        .and_then(|i| args.get(i + 1))
    {
        Some(v) => Variant::parse(v)?,
        None => Variant::Good,
    };
    if let Ok(uri) = std::env::var("FIXTURE_POSTGRES_URI") {
        let pg = dima_rig::postgres::Database::observer(uri);
        match std::env::var("FIXTURE_POSTGRES_DEFECT").as_deref() {
            Ok("precise-number") => {
                pg.execute("UPDATE amounts SET n=0.123456789012345678902")
                    .await?
            }
            Ok("changed-row") => pg.execute("UPDATE items SET qty=99 WHERE id=1").await?,
            Ok("missing-row") => pg.execute("DELETE FROM items WHERE id=1").await?,
            Ok("column-type") => {
                pg.execute("ALTER TABLE items ALTER COLUMN qty TYPE bigint")
                    .await?
            }
            Ok("missing-index") => pg.execute("DROP INDEX items_name").await?,
            _ => {}
        }
    }
    let port: u16 = env("PORT")?.parse()?;
    // One connection, authenticated at start-up before the fixture reports ready: a new pooled
    // connection costs a SCRAM handshake, slow in debug builds under load, which would move a
    // request's times by seconds.
    let mut opts = mongodb::options::ClientOptions::parse(env("MONGO_URI")?).await?;
    opts.max_pool_size = Some(1);
    let client = mongodb::Client::with_options(opts)?;
    let db = client.database(&env("MONGO_DB")?);
    let redis = redis::Client::open(env("REDIS_URL")?)?
        .get_multiplexed_async_connection()
        .await?;
    // Start-up writes, like Mongoose's autoIndex (which logs a failure and carries on) and a
    // boot marker. `strict-startup` exits instead, like a target that needs write access.
    let created = db.run_command(doc! {"createIndexes": "items", "indexes": [{"key": {"name": 1}, "name": "name_1", "unique": true}]}).await;
    if let Err(e) = created {
        if variant == Variant::StrictStartup {
            return Err(e.into());
        }
        println!("fixture: createIndexes failed: {e}");
    }
    let compound = match variant {
        Variant::IndexOrder => {
            doc! {"key": {"createdAt": -1, "owner": 1}, "name": "owner_1_createdAt_-1"}
        }
        Variant::IndexOption => {
            doc! {"key": {"owner": 1, "createdAt": -1}, "name": "owner_1_createdAt_-1", "sparse": true}
        }
        _ => doc! {"key": {"owner": 1, "createdAt": -1}, "name": "owner_1_createdAt_-1"},
    };
    if let Err(e) = db
        .run_command(doc! {"createIndexes": "items", "indexes": [compound]})
        .await
    {
        if variant == Variant::StrictStartup {
            return Err(e.into());
        }
        println!("fixture: createIndexes failed: {e}");
    }
    let mut r = redis.clone();
    // A hash field that is not UTF-8.
    let field: &[u8] = if variant == Variant::HashBytes {
        b"\xff\x02"
    } else {
        b"\xff\x01"
    };
    redis::cmd("HSET")
        .arg("fixture:bin")
        .arg(field)
        .arg("1")
        .query_async::<i64>(&mut r)
        .await?;
    redis::cmd("SET")
        .arg("fixture:boot")
        .arg("1")
        .query_async::<()>(&mut r)
        .await?;
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    println!(
        "fixture: listening on {port}, variant {variant:?}, pid {}, PATH set: {}",
        std::process::id(),
        std::env::var_os("PATH").is_some()
    );
    let app = Arc::new(App {
        v: variant,
        client,
        db,
        redis,
        posts: AtomicU32::new(0),
    });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (s, _) = accepted?;
                tokio::spawn(serve(Arc::clone(&app), s));
            }
            _ = term.recv() => {
                println!("fixture: SIGTERM, stopping");
                return Ok(());
            }
        }
    }
}
