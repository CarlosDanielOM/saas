//! `app.post('/eventsub', …)`: the steps of the module documentation, in order.

use super::dead_letter::{DeadLetter, DeadLetterReason};
use super::dedupe::{self, Claim};
use super::handover::{
    ChatEffectInput, HandlerOptions, Notification, Revocation, RevocationOutcome,
};
use super::headers::{self, DeliveryHeaders, HeaderLimits, HeaderRefusal};
use super::{FaultPoint, Ingress, Inner, body, bump, fault, timestamp};
use bytes::Bytes;
use dima_actions::metrics::eventsub_type_name;
use dima_core::crypto::webhook::verify_eventsub_signature;
use dima_events::producers::Observability;
use dima_events::producers::twitch::{TwitchNotification, is_durable_type, normalize};
use dima_events::value::{Object, Value};
use dima_stream::raid_subscriptions::Subscription as RaidSubscription;
use dima_telemetry::LogOptions;
use dima_text::{JsonLimits, Radix, parse_int, parse_js_json};
use dima_web::{Req, Response};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// The metric kind of every count here.
const KIND: &str = "eventsub_ingress";

/// `MESSAGE_TYPE_VERIFICATION`.
const VERIFICATION: &str = "webhook_callback_verification";
/// `MESSAGE_TYPE_NOTIFICATION`.
const NOTIFICATION: &str = "notification";
/// `MESSAGE_TYPE_REVOCATION`.
const REVOCATION: &str = "revocation";

/// Nesting allowed in a notification (Twitch's are six levels deep at most).
const MAX_JSON_DEPTH: usize = 64;

fn status(code: u16) -> Response {
    Response::send_status(code)
}

/// The route handler.
pub(super) async fn eventsub(req: &mut Req<Ingress>) -> Response {
    let ingress = req.state().clone();
    let inner = &ingress.inner;
    let config = &inner.config;
    let telemetry = &inner.deps.telemetry;

    // 1. A place in flight, held until the answer is made.
    let admission = inner.admission.clone().acquire_owned();
    let Ok(Ok(_permit)) = tokio::time::timeout(config.admission_wait, admission).await else {
        bump(&inner.counters.overloaded);
        telemetry.count(KIND, "overloaded");
        return status(503);
    };

    // 2. Headers.
    let limits = HeaderLimits {
        message_id: config.max_message_id_bytes,
        timestamp: config.max_timestamp_bytes,
        short: config.max_short_header_bytes,
    };
    let delivery = match headers::read(req.headers(), limits) {
        Ok(delivery) => delivery,
        Err(refusal) => {
            bump(&inner.counters.bad_headers);
            telemetry.count(KIND, refusal.as_str());
            let code = if refusal == HeaderRefusal::ContentEncoding {
                415
            } else {
                403
            };
            return status(code).set("Connection", "close");
        }
    };

    // 3. The raw body.
    let declared = req.header("content-length").map(|value| value.into_owned());
    let stream = req.take_body_stream();
    let raw = match body::read(
        stream,
        declared.as_deref(),
        config.body_limit,
        config.body_deadline,
    )
    .await
    {
        Ok(raw) => raw,
        Err(error) => {
            bump(&inner.counters.bad_bodies);
            let (code, name) = match error {
                body::BodyError::TooLarge => (413, "body_too_large"),
                body::BodyError::TimedOut => (408, "body_timed_out"),
                body::BodyError::Aborted => (400, "body_aborted"),
            };
            telemetry.count(KIND, name);
            return status(code).set("Connection", "close");
        }
    };

    // 4. The signature, over the exact bytes.
    if !verify_eventsub_signature(
        &config.secret,
        &delivery.message_id,
        &delivery.timestamp,
        &raw,
        &delivery.signature,
    ) {
        bump(&inner.counters.bad_signatures);
        telemetry.count(KIND, "bad_signature");
        return status(403);
    }

    // From here on the delivery is Twitch's. The reference always ran it inside a trace context
    // (`httpTelemetry`); when telemetry did not give one (export off), a root context keeps the
    // journal's `metadata.observability` as the reference writes it.
    let context = dima_telemetry::trace::current().unwrap_or_else(|| telemetry.root(""));
    let closed = req.closed();
    context
        .scope(verified(ingress.clone(), delivery, raw, closed))
        .await
}

/// `!value` in JavaScript.
fn falsy(value: &Value) -> bool {
    !value.truthy()
}

async fn verified(
    ingress: Ingress,
    delivery: DeliveryHeaders,
    raw: Bytes,
    closed: CancellationToken,
) -> Response {
    let inner = &ingress.inner;
    let config = &inner.config;
    let now = inner.deps.clock.now_ms();

    // 5. `JSON.parse(req.body.toString('utf8'))`.
    let text = String::from_utf8_lossy(&raw);
    let parsed = parse_js_json(
        &text,
        JsonLimits {
            max_depth: MAX_JSON_DEPTH,
            max_bytes: config.body_limit,
        },
    );
    let notification = match parsed {
        Ok(json) => Value::from_json(&json),
        Err(error) => {
            // Not JSON: the type is unknown, so only the ordinary window applies. A stale
            // replay is refused before anything is recorded.
            if !accepted(inner, &delivery, false, now).accepted {
                return stale(inner);
            }
            let detail = error.to_string();
            return dead_letter(
                &ingress,
                &delivery,
                DeadLetterReason::NotJson,
                &detail,
                "",
                &raw,
            )
            .await;
        }
    };
    // `String(notification?.subscription?.type || 'unknown')`.
    let raw_type = notification.at("subscription").at("type");
    let event_type = if raw_type.truthy() {
        raw_type.to_js_string()
    } else {
        "unknown".to_owned()
    };
    let message_type = delivery.message_type.as_str();
    let durable_notification = message_type == NOTIFICATION && is_durable_type(&event_type);
    let decision = accepted(inner, &delivery, durable_notification, now);
    if !decision.accepted {
        return stale(inner);
    }
    let Value::Object(object) = &notification else {
        // `null` threw in the reference; other values met `!notification.subscription` (400).
        if message_type == VERIFICATION {
            return status(400);
        }
        return dead_letter(
            &ingress,
            &delivery,
            DeadLetterReason::NotObject,
            "",
            &event_type,
            &raw,
        )
        .await;
    };

    // 6. By message type.
    match message_type {
        VERIFICATION => {
            bump(&inner.counters.challenges);
            match object.at("challenge") {
                Value::String(challenge) => Response::new()
                    .content_type("text/plain")
                    .text(challenge.clone()),
                _ => status(400),
            }
        }
        REVOCATION => revocation(&ingress, &delivery, object, &event_type, &raw).await,
        NOTIFICATION => {
            notification_step(
                &ingress, &delivery, object, event_type, decision, raw, closed,
            )
            .await
        }
        _ => {
            dead_letter(
                &ingress,
                &delivery,
                DeadLetterReason::UnknownMessageType,
                "",
                &event_type,
                &raw,
            )
            .await
        }
    }
}

fn accepted(
    inner: &Inner,
    delivery: &DeliveryHeaders,
    durable: bool,
    now: i64,
) -> timestamp::TimestampDecision {
    timestamp::accept(
        &delivery.timestamp,
        &delivery.retry,
        durable,
        now,
        inner.config.max_age_ms,
        inner.config.retry_max_age_ms,
    )
}

fn stale(inner: &Inner) -> Response {
    bump(&inner.counters.stale);
    inner.deps.telemetry.count(KIND, "stale");
    status(403)
}

fn unavailable(
    ingress: &Ingress,
    what: &'static str,
    delivery: &DeliveryHeaders,
    kind: &str,
    error: &str,
) -> Response {
    let inner = &ingress.inner;
    bump(&inner.counters.unavailable);
    inner.deps.telemetry.count(KIND, what);
    inner.deps.telemetry.error(
        &json!({
            "function": "eventsub.ingress",
            "step": what,
            "eventType": dima_text::truncate_chars(kind, 200),
            "messageId": delivery.message_id,
            "error": error,
        }),
        LogOptions::console(),
    );
    status(503)
}

/// Writes a dead-letter record and answers 204.
async fn dead_letter(
    ingress: &Ingress,
    delivery: &DeliveryHeaders,
    reason: DeadLetterReason,
    detail: &str,
    subscription_type: &str,
    raw: &[u8],
) -> Response {
    let inner = &ingress.inner;
    let telemetry = &inner.deps.telemetry;
    bump(&inner.counters.dead_letters);
    telemetry.count(KIND, reason.as_str());
    let record = DeadLetter {
        reason,
        detail,
        message_id: &delivery.message_id,
        message_type: &delivery.message_type,
        subscription_type,
        timestamp: &delivery.timestamp,
        retry: &delivery.retry,
        body: raw,
    };
    let at = dima_text::to_iso_string(inner.deps.clock.now_ms()).unwrap_or_default();
    let written = inner
        .dead_letters
        .write(&inner.deps.dragonfly, &record, &at)
        .await;
    if !written {
        bump(&inner.counters.dead_letter_failures);
    }
    telemetry.warn(
        &json!({
            "function": "eventsub.ingress",
            "step": "dead_letter",
            "reason": reason.as_str(),
            "messageId": delivery.message_id,
            "messageType": delivery.message_type,
            "eventType": dima_text::truncate_chars(subscription_type, 200),
            "detail": dima_text::truncate_chars(detail, 300),
            "recorded": written,
        }),
        LogOptions::console(),
    );
    status(204)
}

async fn revocation(
    ingress: &Ingress,
    delivery: &DeliveryHeaders,
    object: &Object,
    event_type: &str,
    raw: &[u8],
) -> Response {
    let inner = &ingress.inner;
    bump(&inner.counters.revocations);
    let Value::Object(subscription) = object.at("subscription") else {
        return dead_letter(
            ingress,
            delivery,
            DeadLetterReason::NoSubscription,
            "",
            event_type,
            raw,
        )
        .await;
    };
    let revoke = inner.deps.handler.revoke(Revocation {
        message_id: delivery.message_id.clone(),
        subscription: subscription.clone(),
    });
    match tokio::time::timeout(inner.config.durable_deadline, revoke).await {
        Ok(RevocationOutcome::Done) => status(204),
        Ok(RevocationOutcome::Retry(error)) => {
            unavailable(ingress, "revocation_failed", delivery, event_type, &error)
        }
        Ok(RevocationOutcome::Invalid(error)) => {
            dead_letter(
                ingress,
                delivery,
                DeadLetterReason::RevocationInvalid,
                &error,
                event_type,
                raw,
            )
            .await
        }
        Err(_) => unavailable(
            ingress,
            "revocation_timed_out",
            delivery,
            event_type,
            "timed out",
        ),
    }
}

/// `bindChannel(event.broadcaster_user_id || (condition.from_broadcaster_user_id ?
/// event.from_broadcaster_user_id : event.to_broadcaster_user_id))`.
fn bound_channel(subscription: &Object, event: &Value) -> String {
    let broadcaster = event.at("broadcaster_user_id");
    let channel = if broadcaster.truthy() {
        broadcaster
    } else if subscription
        .at("condition")
        .at("from_broadcaster_user_id")
        .truthy()
    {
        event.at("from_broadcaster_user_id")
    } else {
        event.at("to_broadcaster_user_id")
    };
    if channel.truthy() {
        channel.to_js_string()
    } else {
        String::new()
    }
}

/// The trace context the reference stores in `metadata.observability`.
fn observability() -> Option<Observability> {
    let context = dima_telemetry::trace::current()?;
    let ids = context.ids();
    Some(Observability {
        trace_id: ids.trace_id.hex().as_str().to_owned(),
        span_id: ids.span_id.hex().as_str().to_owned(),
        sampled: ids.sampled,
        channel: context.channel().as_str().to_owned(),
        outcome: context.outcome().map(str::to_owned),
    })
}

#[allow(clippy::too_many_arguments)]
async fn notification_step(
    ingress: &Ingress,
    delivery: &DeliveryHeaders,
    object: &Object,
    event_type: String,
    decision: timestamp::TimestampDecision,
    raw: Bytes,
    closed: CancellationToken,
) -> Response {
    let inner = &ingress.inner;
    let deps = &inner.deps;
    let config = &inner.config;
    if delivery.message_id.is_empty() {
        return dead_letter(
            ingress,
            delivery,
            DeadLetterReason::NoMessageId,
            "",
            &event_type,
            &raw,
        )
        .await;
    }
    let Value::Object(subscription) = object.at("subscription") else {
        return dead_letter(
            ingress,
            delivery,
            DeadLetterReason::NoSubscription,
            "",
            &event_type,
            &raw,
        )
        .await;
    };
    let event = object.at("event");
    if falsy(event) {
        return dead_letter(
            ingress,
            delivery,
            DeadLetterReason::NoEvent,
            "",
            &event_type,
            &raw,
        )
        .await;
    }

    // Steps 7 and 8 share one deadline: Twitch's answer must not wait for both in turn.
    let deadline = tokio::time::Instant::now() + config.durable_deadline;

    // 7. Raids: the direction's current settings decide.
    if event_type == "channel.raid" {
        let raid = RaidSubscription {
            id: subscription
                .at("id")
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned),
            condition: subscription
                .at("condition")
                .as_object()
                .cloned()
                .unwrap_or_default(),
        };
        let event_object = event.as_object().cloned().unwrap_or_default();
        let check = deps.raids.accepts_raid_notification(&raid, &event_object);
        match tokio::time::timeout_at(deadline, check).await {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => return status(204),
            Ok(Err(error)) => {
                return unavailable(
                    ingress,
                    "raid_filter_failed",
                    delivery,
                    &event_type,
                    &error.to_string(),
                );
            }
            Err(_) => {
                return unavailable(
                    ingress,
                    "raid_filter_timed_out",
                    delivery,
                    &event_type,
                    "timed out",
                );
            }
        }
    }

    dima_telemetry::trace::bind_channel(&bound_channel(subscription, event));
    let type_name = eventsub_type_name(&event_type);
    deps.telemetry.observe("event", type_name, 0.0);
    deps.metrics
        .observe_eventsub_notification(&event_type, raw.len() as u64);

    let retry = parse_int(&delivery.retry, Radix::Decimal);
    let producer = TwitchNotification {
        message_id: delivery.message_id.clone(),
        message_timestamp: Some(delivery.timestamp.clone()),
        // `Number.parseInt(messageRetry, 10) || 0`.
        message_retry: Some(if retry.is_nan() || retry == 0.0 {
            0.0
        } else {
            retry
        }),
        stale_retry: Some(decision.stale_retry),
        subscription: subscription.clone(),
        event: event.clone(),
        source: None,
        durable_chat_handled: true,
        durable_defense_handled: true,
    };
    let durable = match normalize(&producer) {
        Ok(durable) => durable,
        Err(error) => {
            return dead_letter(
                ingress,
                delivery,
                DeadLetterReason::Contract,
                &error.to_string(),
                &event_type,
                &raw,
            )
            .await;
        }
    };

    // 8. Journaled types: recorded before the answer.
    // `durableEvent?.metadata?.durableDefenseHandled === true`.
    let defense_handled = durable
        .as_ref()
        .and_then(|event| event.metadata.as_ref())
        .is_some_and(|metadata| matches!(metadata.at("durableDefenseHandled"), Value::Bool(true)));
    if durable.is_some() {
        let observed = observability();
        let ingest = deps.journal.ingest_twitch(&producer, observed.as_ref());
        match tokio::time::timeout_at(deadline, ingest).await {
            Ok(Ok(Some(journaled))) => {
                if !journaled.inserted {
                    bump(&inner.counters.notifications);
                    bump(&inner.counters.duplicates);
                    deps.telemetry.count(KIND, "duplicate");
                    return status(204);
                }
                fault(inner, FaultPoint::AfterJournal, &delivery.message_id).await;
                if let Some(kind) = journaled.lifecycle_metric() {
                    let name = if kind == "stream.started" {
                        "stream.started"
                    } else {
                        "stream.ended"
                    };
                    deps.telemetry.count("lifecycle", name);
                }
            }
            Ok(Ok(None)) => {
                return unavailable(
                    ingress,
                    "journal_failed",
                    delivery,
                    &event_type,
                    "Durable Twitch producer returned no event",
                );
            }
            Ok(Err(error)) if error.is_permanent() => {
                return dead_letter(
                    ingress,
                    delivery,
                    DeadLetterReason::Refused,
                    &error.to_string(),
                    &event_type,
                    &raw,
                )
                .await;
            }
            Ok(Err(error)) => {
                return unavailable(
                    ingress,
                    "journal_failed",
                    delivery,
                    &event_type,
                    &error.to_string(),
                );
            }
            Err(_) => {
                return unavailable(
                    ingress,
                    "journal_timed_out",
                    delivery,
                    &event_type,
                    "timed out",
                );
            }
        }
    }

    // 9. The answer; 10. after it, the claim and the inline handler.
    bump(&inner.counters.notifications);
    let chat_effect = (event_type == "channel.chat.message")
        .then(|| ChatEffectInput::from_event(event, &delivery.timestamp));
    let handed = Notification {
        message_id: delivery.message_id.clone(),
        message_timestamp: delivery.timestamp.clone(),
        subscription_type: event_type,
        subscription: subscription.clone(),
        event: event.clone(),
        options: HandlerOptions {
            durable_chat_handled: durable.is_some(),
            stale_retry: decision.stale_retry,
            durable_defense_handled: defense_handled,
            chat_effect,
        },
    };
    let timestamp_ms = dima_text::parse_date(&delivery.timestamp).unwrap_or_default();
    let task = after_answer(
        Arc::clone(&ingress.inner),
        handed,
        durable.is_none(),
        timestamp_ms,
        closed,
    );
    ingress
        .inner
        .tasks
        .spawn(dima_telemetry::trace::in_current(task));
    status(204)
}

/// Step 10, on a tracked task: waits for the answer to be written, claims the message id when
/// the type is not journaled, then runs the inline handler.
async fn after_answer(
    inner: Arc<Inner>,
    notification: Notification,
    claim: bool,
    timestamp_ms: i64,
    closed: CancellationToken,
) {
    let _ = tokio::time::timeout(inner.config.answer_wait, closed.cancelled()).await;
    fault(&inner, FaultPoint::AfterAnswer, &notification.message_id).await;
    let deps = &inner.deps;
    if claim {
        let now = deps.clock.now_ms();
        let key = dedupe::key(&inner.config.key_prefix, &notification.message_id);
        let seconds = dedupe::lifetime_seconds(
            inner.config.dedupe_ttl_seconds,
            timestamp_ms,
            inner.config.max_age_ms,
            now,
        );
        let at = dima_text::to_iso_string(now).unwrap_or_default();
        match dedupe::claim(
            &deps.dragonfly,
            &key,
            &at,
            seconds,
            inner.config.dedupe_deadline,
        )
        .await
        {
            Claim::First => {}
            Claim::Seen => {
                bump(&inner.counters.claimed_before);
                deps.telemetry.count(KIND, "claimed_before");
                return;
            }
            Claim::Unknown => {
                deps.telemetry.count(KIND, "claim_failed");
                deps.telemetry.error(
                    &json!({
                        "function": "eventsub.ingress",
                        "step": "claim",
                        "messageId": notification.message_id,
                        "error": "Failed to claim EventSub message dedupe key",
                    }),
                    LogOptions::console(),
                );
            }
        }
    }
    fault(&inner, FaultPoint::BeforeHandler, &notification.message_id).await;
    let tracker = deps
        .metrics
        .start_eventsub_handler(&notification.subscription_type);
    let event_type = notification.subscription_type.clone();
    let message_id = notification.message_id.clone();
    let result = deps.handler.handle(notification).await;
    tracker.end(result.is_err());
    if let Err(error) = result {
        bump(&inner.counters.handler_errors);
        deps.telemetry.count(KIND, "handler_failed");
        deps.telemetry.error(
            &json!({
                "function": "eventsub.ingress",
                "step": "handler",
                "eventType": dima_text::truncate_chars(&event_type, 200),
                "messageId": message_id,
                "error": error.0,
            }),
            LogOptions::console(),
        );
    }
}
