//! The reference's recorded deliveries (`tests/reference/record_ingress.mts`), replayed byte for
//! byte against the Rust ingress over fresh stores: the answers (status, content type, body),
//! what the handler was given, the journal documents (BSON types included) and the message-id
//! claims must match, except where [`intended`] states a difference and why. The number of
//! intended differences is asserted, so a new one cannot slip in unnamed.

mod support;

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::Engine as _;
use bson::Bson;
use dima_events::value::Value;
use serde_json::Value as Json;
use std::collections::BTreeMap;
use support::{RawRequest, RecordingHandler, Stores};

/// An outcome that differs from the reference on purpose.
struct Intended {
    /// The Rust answer.
    status: u16,
    /// The dead-letter reason the Rust ingress records, if any.
    dead_letter: Option<&'static str>,
    /// Why (plan section 7 item 5, `packages.md`, or this package's own fix).
    why: &'static str,
}

const NEVER_VALID: &str = "Signed by Twitch but never processable: answered 204 and dead-lettered \
    instead of the reference's 400/503, which Twitch redelivers and counts towards revoking the \
    subscription (lead's decision, plan section 7 item 5).";

fn intended(case: &str) -> Option<Intended> {
    let never_valid = |reason| Intended {
        status: 204,
        dead_letter: Some(reason),
        why: NEVER_VALID,
    };
    Some(match case {
        "non-ASCII signature of the expected length" => Intended {
            status: 403,
            dead_letter: None,
            why: "Reference crash (packages.md): timingSafeEqual threw on unequal byte lengths and \
                  the unhandled rejection exited the bot. Refused here before any work.",
        },
        "body that is not JSON (content type)" | "no content type" => Intended {
            status: 403,
            dead_letter: None,
            why: "Reference crash (packages.md): express.raw left req.body as {}, \
                  createHmac().update({}) threw, the bot exited. Refused here before the body.",
        },
        "valid signature over a body that is not JSON" | "valid signature over an empty body" => {
            never_valid("not_json")
        }
        "valid signature without a message id" => never_valid("no_message_id"),
        "notification without an event" => never_valid("no_event"),
        "follow without a channel" => never_valid("contract"),
        "follow with a date that is not one" => never_valid("journal_refused"),
        "revocation without a subscription" => never_valid("no_subscription"),
        "revocation the handler refuses" => never_valid("revocation_invalid"),
        "unknown message type" => Intended {
            status: 204,
            dead_letter: Some("unknown_message_type"),
            why: "Same answer; the delivery is also kept in the dead-letter record so an \
                  operator sees a message type Twitch added.",
        },
        _ => return None,
    })
}

/// The claim of a message dated nine minutes ahead lives until it could no longer pass the
/// timestamp check (19 minutes), not 10: a replay inside the window must still be seen.
const LONGER_CLAIM: &str = "chat-future";

fn recorded() -> Result<Json> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/ingress_recorded.json"
    );
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    Ok(serde_json::from_str(&text)?)
}

fn b64(text: &str) -> Result<Vec<u8>> {
    Ok(base64::engine::general_purpose::STANDARD.decode(text)?)
}

fn request(case: &Json) -> Result<RawRequest> {
    let request = &case["request"];
    let headers = request["headers"]
        .as_array()
        .context("headers")?
        .iter()
        .map(|pair| {
            let name = pair[0].as_str().context("name")?.to_owned();
            Ok((name, b64(pair[1].as_str().context("value")?)?))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RawRequest {
        method: request["method"].as_str().context("method")?.to_owned(),
        path: request["path"].as_str().context("path")?.to_owned(),
        headers,
        body: b64(request["body"].as_str().context("body")?)?,
    })
}

/// Seeds the reference's documents, raw.
async fn seed(stores: &Stores, seeds: &Json) -> Result<()> {
    for (collection, documents) in seeds.as_object().context("seeds")? {
        let documents = documents
            .as_array()
            .context("documents")?
            .iter()
            .map(support::document)
            .collect::<Result<Vec<_>>>()?;
        stores
            .mongo
            .database()
            .collection::<bson::Document>(collection)
            .insert_many(documents)
            .await?;
    }
    Ok(())
}

/// The handler's call as the recorder wrote it: `{subscription, event, options}`.
fn same_call(expected: &Json, actual: &dima_chat::ingress::Notification) -> Result<()> {
    let subscription = Value::from_json(&expected["subscription"]);
    ensure!(
        subscription == Value::Object(actual.subscription.clone()),
        "subscription differs"
    );
    ensure!(
        Value::from_json(&expected["event"]) == actual.event,
        "event differs"
    );
    let options = &expected["options"];
    let flag = |name: &str| options.get(name).and_then(Json::as_bool).unwrap_or(false);
    ensure!(
        flag("durableChatHandled") == actual.options.durable_chat_handled,
        "durableChatHandled"
    );
    ensure!(
        flag("staleRetry") == actual.options.stale_retry,
        "staleRetry"
    );
    ensure!(
        flag("durableDefenseHandled") == actual.options.durable_defense_handled,
        "durableDefenseHandled"
    );
    ensure!(
        flag("chatEffectContext") == actual.options.chat_effect.is_some(),
        "chatEffectContext"
    );
    Ok(())
}

/// The recorded journal document against the stored one: `_id` is generated (an ObjectId
/// both sides), the trace ids are random (hex of the right length both sides).
fn same_event(expected: &bson::Document, actual: &bson::Document, index: usize) -> Result<()> {
    let mut expected = expected.clone();
    let mut actual = actual.clone();
    for document in [&mut expected, &mut actual] {
        ensure!(
            matches!(document.get("_id"), Some(Bson::ObjectId(_))),
            "event {index}: _id is not an ObjectId"
        );
        document.insert("_id", Bson::Null);
        let observability = document
            .get_document_mut("metadata")
            .ok()
            .and_then(|metadata| metadata.get_document_mut("observability").ok())
            .ok_or_else(|| anyhow!("event {index}: no metadata.observability"))?;
        for (key, length) in [("traceId", 32), ("spanId", 16)] {
            let id = observability.get_str(key).unwrap_or_default();
            ensure!(
                id.len() == length && id.bytes().all(|b| b.is_ascii_hexdigit()),
                "event {index}: {key} {id:?}"
            );
            observability.insert(key, "<random>");
        }
        ensure!(
            matches!(observability.get("sampled"), Some(Bson::Boolean(_))),
            "event {index}: sampled"
        );
        observability.insert("sampled", false);
    }
    support::assert_same(
        &Bson::Document(expected),
        &Bson::Document(actual),
        &format!("event {index}"),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_recorded_deliveries_match() -> Result<()> {
    let fixture = recorded()?;
    support::with_stores("recorded", |stores| async move {
        seed(&stores, &fixture["seeds"]).await?;
        let now = fixture["nowMs"].as_i64().context("nowMs")?;
        let handler = RecordingHandler::default();
        let config = support::config(&stores.prefix);
        let limit = config.body_limit;
        let harness =
            support::harness(&stores, &stores.mongo, config, now, handler.clone(), None).await?;
        let server = support::serve(&harness.ingress).await?;

        let mut differences = Vec::new();
        let mut dead_letters = Vec::new();
        let mut handled_so_far = 0;
        let cases = fixture["cases"].as_array().context("cases")?;
        for case in cases {
            let name = case["name"].as_str().context("name")?;
            let request = request(case)?;
            let answer = support::send(server.address, &request, request.body.len() > limit)
                .await
                .with_context(|| format!("case {name:?}"))?;
            support::settle(&harness.ingress).await?;
            let calls = handler.notifications();
            let new_calls = calls.get(handled_so_far..).unwrap_or_default().to_vec();
            handled_so_far = calls.len();

            let expected = &case["response"];
            let crashed = !case["crash"].as_array().is_none_or(Vec::is_empty);
            match intended(name) {
                Some(intended) => {
                    ensure!(
                        answer.status == intended.status,
                        "{name}: {} instead of the intended {}",
                        answer.status,
                        intended.status
                    );
                    let reference = if crashed {
                        "the process exited".to_owned()
                    } else {
                        expected["status"].to_string()
                    };
                    differences.push(format!(
                        "{name}: reference {reference}, Rust {}",
                        intended.status
                    ));
                    if let Some(reason) = intended.dead_letter {
                        dead_letters.push(reason);
                    }
                    ensure!(!intended.why.is_empty());
                }
                None => {
                    ensure!(
                        !crashed,
                        "{name}: the reference crashed but no difference is stated"
                    );
                    let status = expected["status"].as_u64().context("status")?;
                    ensure!(
                        u64::from(answer.status) == status,
                        "{name}: status {} instead of {status}",
                        answer.status
                    );
                    // Error pages (404, 413) are not contract (MIGRATION.md section 3): their
                    // status is compared; every other answer's type and body must be the
                    // reference's.
                    if !matches!(status, 404 | 413) {
                        let content_type = expected["headers"]["content-type"].as_str();
                        ensure!(
                            answer.header("content-type") == content_type,
                            "{name}: content type {:?} instead of {content_type:?}",
                            answer.header("content-type")
                        );
                        let body = expected["body"].as_str().context("body")?;
                        ensure!(
                            answer.body == body.as_bytes(),
                            "{name}: body {:?} instead of {body:?}",
                            String::from_utf8_lossy(&answer.body)
                        );
                    }
                    if name == "challenge" {
                        ensure!(
                            answer.header("content-length")
                                == expected["headers"]["content-length"].as_str(),
                            "challenge: content length"
                        );
                    }
                }
            }
            let recorded_calls = case["handled"].as_array().context("handled")?;
            ensure!(
                recorded_calls.len() == new_calls.len(),
                "{name}: the handler ran {} times instead of {}",
                new_calls.len(),
                recorded_calls.len()
            );
            for (expected, actual) in recorded_calls.iter().zip(&new_calls) {
                same_call(expected, actual).with_context(|| format!("case {name:?}"))?;
            }
        }

        // The journal.
        let expected: Vec<bson::Document> = fixture["domainEvents"]
            .as_array()
            .context("domainEvents")?
            .iter()
            .map(support::document)
            .collect::<Result<_>>()?;
        let actual = support::documents(&stores.mongo, "domain_events").await?;
        ensure!(
            expected.len() == actual.len(),
            "{} journal documents instead of {}",
            actual.len(),
            expected.len()
        );
        for (index, (expected, actual)) in expected.iter().zip(&actual).enumerate() {
            same_event(expected, actual, index)?;
        }

        // The message-id claims: the same ids, the value is the claim time, the lifetime is
        // the reference's 600 s (less what the run took), longer for the message from the future.
        let prefix = format!("{}twitch:eventsub:message:", stores.prefix);
        let mut claimed = BTreeMap::new();
        for key in support::keys(&stores.dragonfly, &prefix).await? {
            let id = key.strip_prefix(&prefix).unwrap_or_default().to_owned();
            let value = stores.dragonfly.get_text(&key).await?.unwrap_or_default();
            let ttl = match stores.dragonfly.ttl(&key).await? {
                dima_store::dragonfly::Ttl::Seconds(seconds) => seconds,
                other => bail!("{key}: lifetime {other:?}"),
            };
            claimed.insert(id, (value, ttl));
        }
        let expected_claims: Vec<String> = fixture["dedupeKeys"]
            .as_object()
            .context("dedupeKeys")?
            .keys()
            .map(|key| {
                key.trim_start_matches("twitch:eventsub:message:")
                    .to_owned()
            })
            .collect();
        ensure!(
            claimed.keys().cloned().collect::<Vec<_>>() == expected_claims,
            "claimed {:?}, the reference {expected_claims:?}",
            claimed.keys()
        );
        let now_iso = dima_text::to_iso_string(now).unwrap_or_default();
        for (id, (value, ttl)) in &claimed {
            ensure!(value == &now_iso, "{id}: claim value {value}");
            let (low, high) = if id.ends_with(LONGER_CLAIM) {
                differences.push(format!("{id}: claim lives {ttl} s (reference 600 s)"));
                (1100, 1140)
            } else {
                (560, 600)
            };
            ensure!((low..=high).contains(ttl), "{id}: lifetime {ttl}");
        }

        // The dead-letter record: one per never-valid delivery, newest first.
        let records: Vec<Json> = stores
            .dragonfly
            .query::<Vec<String>>(
                redis::cmd("LRANGE")
                    .arg(format!("{}eventsub:dead-letter", stores.prefix))
                    .arg(0)
                    .arg(-1),
            )
            .await?
            .iter()
            .map(|text| serde_json::from_str(text))
            .collect::<std::result::Result<_, _>>()?;
        let reasons: Vec<&str> = records
            .iter()
            .rev()
            .filter_map(|record| record["reason"].as_str())
            .collect();
        ensure!(
            reasons == dead_letters,
            "dead letters {reasons:?}, expected {dead_letters:?}"
        );
        for record in &records {
            ensure!(record["bodySha256"].as_str().map(str::len) == Some(64));
            ensure!(!record["messageType"].is_null());
        }

        // Every intended difference, counted: 3 crashes fixed, 8 never-valid deliveries, the
        // unknown message type's record, the future message's longer claim.
        for line in &differences {
            eprintln!("intended difference: {line}");
        }
        ensure!(
            differences.len() == 13,
            "{} intended differences: {differences:#?}",
            differences.len()
        );
        let stats = harness.ingress.stats();
        ensure!(stats.dead_letter_failures == 0, "{stats:?}");
        server.shutdown.trigger();
        let _ = server.task.await;
        Ok(())
    })
    .await
}
