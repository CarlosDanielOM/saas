//! Self-test fixture for the rig: a tiny HTTP server that writes to its MongoDB database and its
//! Dragonfly logical database. `--variant good` is the reference behaviour; `equivalent` differs
//! only in generated ids, timing, insertion order and JSON key order; every other variant
//! introduces exactly one defect the rig must catch.
//!
//! Environment: PORT, MONGO_URI, MONGO_DB, REDIS_URL.
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
}

impl Variant {
    fn parse(s: &str) -> Result<Variant> {
        Ok(match s {
            "good" => Variant::Good,
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
            other => bail!("unknown variant {other}"),
        })
    }
}

struct App {
    v: Variant,
    db: mongodb::Database,
    redis: redis::aio::MultiplexedConnection,
    posts: AtomicU32,
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

fn json_resp(status: u16, v: &Value) -> Response {
    Response {
        status,
        content_type: "application/json; charset=utf-8",
        body: serde_json::to_vec(v).unwrap_or_default(),
    }
}

/// `Date.prototype.toISOString` shape: always three fraction digits.
fn iso(dt: bson::DateTime) -> String {
    dima_rig::timefmt::format_iso_ms(dt.timestamp_millis()).unwrap_or_default()
}

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set"))
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
    for l in lines {
        if let Some((k, v)) = l.split_once(':')
            && k.trim().eq_ignore_ascii_case("content-length")
        {
            len = v.trim().parse().unwrap_or(0);
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
    Ok(Request { method, path, body })
}

async fn write_response(s: &mut TcpStream, r: Response) -> Result<()> {
    let reason = match r.status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        404 => "Not Found",
        _ => "Status",
    };
    let head = format!(
        "HTTP/1.1 {} {reason}\r\ncontent-type: {}\r\ncontent-length: {}\r\nx-content-type-options: nosniff\r\nconnection: close\r\n\r\n",
        r.status,
        r.content_type,
        r.body.len()
    );
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
        let lease = Bson::Double((now.timestamp_millis() + 60_000) as f64);
        let mut item = if self.v == Variant::Equivalent {
            doc! {"_id": id, "owner": owner, "uuid": &uuid, "tags": ["new"], "leaseUntil": lease, "createdAt": now, "qty": qty_bson, "name": &name}
        } else {
            doc! {"_id": id, "name": &name, "qty": qty_bson, "owner": owner, "uuid": &uuid, "createdAt": now, "leaseUntil": lease, "tags": ["new"]}
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
        let cached = json!({"id": id.to_hex(), "name": name}).to_string();
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
        Ok(json_resp(201, &resp))
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
                "createdAt": d.get_datetime("createdAt").map(|t| iso(*t)).unwrap_or_default(),
            }),
        ))
    }

    async fn queue_jobs(self: &Arc<Self>, body: &[u8]) -> Result<Response> {
        let input: Value = serde_json::from_slice(body)?;
        let item = ObjectId::parse_str(input.get("item").and_then(Value::as_str).unwrap_or(""))?;
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
        let mut r = self.redis.clone();
        redis::cmd("RPUSH")
            .arg("jobs:done")
            .arg(a.to_hex())
            .arg(b.to_hex())
            .query_async::<i64>(&mut r)
            .await?;
        Ok(())
    }

    async fn route(self: &Arc<Self>, req: Request) -> Result<Response> {
        let segs: Vec<&str> = req.path.trim_start_matches('/').split('/').collect();
        match (req.method.as_str(), segs.as_slice()) {
            ("GET", ["health"]) => Ok(Response {
                status: 200,
                content_type: "text/plain; charset=utf-8",
                body: b"ok".to_vec(),
            }),
            ("POST", ["items"]) => self.create_item(&req.body).await,
            ("GET", ["items", id]) => self.get_item(id).await,
            ("POST", ["jobs"]) => self.queue_jobs(&req.body).await,
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
    let _ = write_response(&mut s, res).await;
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let variant = match args
        .iter()
        .position(|a| a == "--variant")
        .and_then(|i| args.get(i + 1))
    {
        Some(v) => Variant::parse(v)?,
        None => Variant::Good,
    };
    let port: u16 = env("PORT")?.parse()?;
    let client = mongodb::Client::with_uri_str(env("MONGO_URI")?).await?;
    let db = client.database(&env("MONGO_DB")?);
    let redis = redis::Client::open(env("REDIS_URL")?)?
        .get_multiplexed_async_connection()
        .await?;
    // Start-up writes, like Mongoose's autoIndex and a boot marker.
    db.run_command(doc! {"createIndexes": "items", "indexes": [{"key": {"name": 1}, "name": "name_1", "unique": true}]}).await?;
    let mut r = redis.clone();
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
