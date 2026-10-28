use super::moderation_failure;
use crate::{
    functions::{FunctionFailure, RequestCancellation, TwitchFunctions, internal, query},
    utils::{
        js_compat, json_number,
        twitch::{TWITCH_BOT_ACCOUNT_ID, TwitchAuth},
    },
};
use reqwest::{Method, header::HeaderMap};
use serde_json::{Map, Value, json};

async fn read_response_body(
    response: reqwest::Response,
    cancel: Option<&RequestCancellation>,
) -> Value {
    if let Some(cancel) = cancel {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => json!({}),
            data = response.json() => data.unwrap_or_else(|_| json!({})),
        }
    } else {
        response.json().await.unwrap_or_else(|_| json!({}))
    }
}

fn numeric_header(headers: &HeaderMap, name: &str) -> Option<f64> {
    let raw = headers.get(name)?.to_str().ok()?;
    if js_compat::trim(raw).is_empty() {
        return None;
    }
    let value = json_number::to_number(&Value::String(raw.into()));
    (value.is_finite() && value >= 0.0).then_some(value)
}
/// Numeric seconds and HTTP date forms of Retry-After, plus RFC3339. Values
/// remain milliseconds and fractional numeric values are preserved.
pub fn ban_rate_limit_headers(headers: &HeaderMap, now_millis: i64) -> Map<String, Value> {
    let mut output = Map::new();
    if let Some(value) = numeric_header(headers, "ratelimit-remaining") {
        output.insert("rateLimitRemaining".into(), json!(value));
    }
    if let Some(value) = numeric_header(headers, "ratelimit-reset") {
        output.insert("rateLimitResetAt".into(), json!(value * 1000.0));
    }
    let retry = numeric_header(headers, "retry-after")
        .map(|seconds| seconds * 1000.0)
        .or_else(|| {
            let date = parse_retry_date(headers.get("retry-after")?.to_str().ok()?)?;
            Some(((date as f64) - (now_millis as f64)).max(0.0))
        });
    if let Some(value) = retry {
        output.insert("retryAfterMs".into(), json!(value));
    }
    output
}
fn parse_retry_date(raw: &str) -> Option<i64> {
    if let Ok(value) = mongodb::bson::DateTime::parse_rfc3339_str(raw) {
        return Some(value.timestamp_millis());
    }
    let fields: Vec<_> = raw.split_ascii_whitespace().collect();
    let (month, day, year, time) = match fields.as_slice() {
        [_, day, month, year, time, "GMT"] | [_, day, month, year, time, "UTC"] => (
            *month,
            day.parse::<u32>().ok()?,
            year.parse::<i32>().ok()?,
            *time,
        ),
        [_, month, day, time, year] => (
            *month,
            day.parse::<u32>().ok()?,
            year.parse::<i32>().ok()?,
            *time,
        ),
        [_, date, time, "GMT"] => {
            let mut parts = date.split('-');
            let day = parts.next()?.parse().ok()?;
            let month = parts.next()?;
            let year = parts.next()?.parse::<i32>().ok()?;
            if parts.next().is_some() {
                return None;
            }
            (
                month,
                day,
                if year < 70 {
                    2000 + year
                } else if year < 100 {
                    1900 + year
                } else {
                    year
                },
                *time,
            )
        }
        _ => return None,
    };
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|value| value.eq_ignore_ascii_case(month))?
        + 1;
    mongodb::bson::DateTime::parse_rfc3339_str(format!("{year:04}-{month:02}-{day:02}T{time}Z"))
        .ok()
        .map(|date| date.timestamp_millis())
}

impl TwitchFunctions {
    /// The requester argument is attribution only; moderation is always bot
    /// owned, as required by the repository's moderator identity policy.
    pub async fn ban(
        &self,
        channel: &str,
        user: &str,
        _requesting_moderator: &str,
        duration: Option<f64>,
        reason: Option<&str>,
        cancel: Option<&RequestCancellation>,
    ) -> Value {
        let result = async {
            let params = query([
                ("broadcaster_id".into(), channel.into()),
                ("moderator_id".into(), TWITCH_BOT_ACCOUNT_ID.into()),
            ]);
            let mut body = json!({"data":{"user_id":user}});
            if let Some(duration) = duration.filter(|value| *value != 0.0 && !value.is_nan()) {
                body["data"]["duration"] = json!(duration);
            }
            if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
                body["data"]["reason"] = reason.into();
            }
            let response = self
                .request(
                    TwitchAuth::Bot,
                    Method::POST,
                    "moderation/bans",
                    Some(&params),
                    Some(&body),
                    cancel,
                )
                .await?;
            let status = response.status();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |time| time.as_millis() as i64);
            let limits = ban_rate_limit_headers(response.headers(), now);
            let data = read_response_body(response, cancel).await;
            let mut result = moderation_failure(&data, status, "Twitch ban request failed")
                .unwrap_or_else(|| {
                    let mut result =
                        json!({"error":false,"message":"Success","status":status.as_u16()});
                    if let Some(data) = data
                        .get("data")
                        .and_then(Value::as_array)
                        .and_then(|data| data.first())
                    {
                        result["data"] = data.clone();
                    }
                    result
                });
            result
                .as_object_mut()
                .ok_or(FunctionFailure::Internal)?
                .extend(limits);
            Ok(result)
        }
        .await;
        self.finish(
            "ban",
            channel,
            result,
            internal(true),
            Some("permission_error"),
        )
        .await
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        time::Duration,
    };

    #[tokio::test]
    async fn cancellation_after_headers_interrupts_a_held_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, wait) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 1024];
            let received = stream.read(&mut request).unwrap();
            assert!(received > 0);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n").unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(2));
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(format!("http://{address}/held"))
            .send()
            .await
            .unwrap();
        let cancel = RequestCancellation::new();
        cancel.cancel();
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            read_response_body(response, Some(&cancel)),
        )
        .await;
        let _ = release.send(());
        server.join().unwrap();
        assert_eq!(result.unwrap(), json!({}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_and_http_date_headers_match_source_examples() {
        let mut headers = HeaderMap::new();
        headers.insert("ratelimit-reset", "123".parse().unwrap());
        headers.insert("ratelimit-remaining", "0".parse().unwrap());
        headers.insert("retry-after", "5".parse().unwrap());
        assert_eq!(
            Value::Object(ban_rate_limit_headers(&headers, 1000)),
            json!({"rateLimitRemaining":0.0,"rateLimitResetAt":123000.0,"retryAfterMs":5000.0})
        );
        headers.insert(
            "retry-after",
            "Thu, 01 Jan 1970 00:01:00 GMT".parse().unwrap(),
        );
        assert_eq!(
            ban_rate_limit_headers(&headers, 1000)["retryAfterMs"],
            json!(59000.0)
        );
        assert!(ban_rate_limit_headers(&HeaderMap::new(), 0).is_empty());
        assert_eq!(
            parse_retry_date("Thursday, 01-Jan-70 00:01:00 GMT"),
            Some(60000)
        );
        assert_eq!(parse_retry_date("Thu Jan 1 00:01:00 1970"), Some(60000));
    }
}
