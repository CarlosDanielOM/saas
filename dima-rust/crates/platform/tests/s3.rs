#![allow(clippy::unwrap_used)]
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::Bytes;
use dima_core::{ManualClock, SecretString, crypto::digest::sha256};
use dima_http::{
    HttpClient, Method,
    testing::{MockResponse, MockServer},
};
use dima_platform::s3::{signing::sign, *};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
const KEY: &str = "folder/a b+!*'()é😀/file.txt";
const SECRET: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
fn client(endpoint: &str) -> Client {
    Client::new(
        HttpClient::builder().build().unwrap(),
        Config {
            endpoint: endpoint.into(),
            region: "us-east-1".into(),
            bucket: "examplebucket".into(),
            access_key_id: "AKIDEXAMPLE".into(),
            secret_key: SECRET.into(),
            addressing: Addressing::Path,
            public_url: "https://cdn.test".into(),
        },
        Arc::new(ManualClock::new(1369353600000)),
    )
    .unwrap()
}
fn limits() -> Limits {
    Limits {
        max_bytes: 4096,
        timeout: Duration::from_secs(2),
    }
}
fn options() -> PutOptions<'static> {
    PutOptions {
        content_type: "text/plain",
        cache_control: Some("public, max-age=31536000"),
        public_read: true,
    }
}

#[test]
fn official_aws_get_object_vector() {
    let payload = sha256("").hex();
    let h = BTreeMap::from([
        ("host".into(), "examplebucket.s3.amazonaws.com".into()),
        ("range".into(), "bytes=0-9".into()),
        ("x-amz-content-sha256".into(), payload.clone()),
        ("x-amz-date".into(), "20130524T000000Z".into()),
    ]);
    let s = sign(
        "GET",
        "/test.txt",
        "",
        &h,
        &payload,
        "us-east-1",
        "AKIAIOSFODNN7EXAMPLE",
        &SECRET.into(),
    );
    assert_eq!(
        s.canonical_request,
        format!(
            "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:{payload}\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\n{payload}"
        )
    );
    assert_eq!(
        s.canonical_hash,
        "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972"
    );
    assert_eq!(
        s.string_to_sign,
        "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972"
    );
    assert_eq!(
        s.signature,
        "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
}
#[test]
fn official_aws_put_object_vector() {
    let payload = sha256("Welcome to Amazon S3.").hex();
    assert_eq!(
        payload,
        "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
    );
    let h = BTreeMap::from([
        ("host".into(), "examplebucket.s3.amazonaws.com".into()),
        ("date".into(), "Fri, 24 May 2013 00:00:00 GMT".into()),
        ("x-amz-storage-class".into(), "REDUCED_REDUNDANCY".into()),
        ("x-amz-content-sha256".into(), payload.clone()),
        ("x-amz-date".into(), "20130524T000000Z".into()),
    ]);
    let s = sign(
        "PUT",
        "/test%24file.text",
        "",
        &h,
        &payload,
        "us-east-1",
        "AKIAIOSFODNN7EXAMPLE",
        &SECRET.into(),
    );
    assert_eq!(
        s.canonical_request,
        format!(
            "PUT\n/test%24file.text\n\ndate:Fri, 24 May 2013 00:00:00 GMT\nhost:examplebucket.s3.amazonaws.com\nx-amz-content-sha256:{payload}\nx-amz-date:20130524T000000Z\nx-amz-storage-class:REDUCED_REDUNDANCY\n\ndate;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class\n{payload}"
        )
    );
    assert_eq!(
        s.canonical_hash,
        "9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d"
    );
    assert_eq!(
        s.string_to_sign,
        "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d"
    );
    assert_eq!(
        s.signature,
        "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
    );
}

#[tokio::test]
async fn all_recorded_sdk_requests_match_including_every_signed_header_and_body() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("sdk-requests.json")).unwrap();
    for (i, f) in fixtures.iter().enumerate() {
        let server = MockServer::start().await.unwrap();
        server.push(MockResponse::new(200).body(if i == 7 {
            "<DeleteResult/>"
        } else if i == 5 {
            "hello"
        } else {
            ""
        }));
        let c = client(&server.url()).with_diagnostics(Diagnostics {
            invocation_id: f["headers"]["amz-sdk-invocation-id"]
                .as_str()
                .unwrap()
                .into(),
            request: f["headers"]["amz-sdk-request"].as_str().unwrap().into(),
            user_agent: f["headers"]["x-amz-user-agent"].as_str().unwrap().into(),
        });
        match i {
            0..=3 => {
                let o = PutOptions {
                    content_type: f["headers"]["content-type"].as_str().unwrap(),
                    cache_control: f["headers"]["cache-control"].as_str(),
                    public_read: f["headers"]["x-amz-acl"] == "public-read",
                };
                c.put(KEY, Bytes::from_static(b"hello"), o, limits())
                    .await
                    .unwrap();
            }
            4 => c
                .put_stream(
                    KEY,
                    futures_util::stream::iter([Ok(Bytes::from_static(b"hello"))]),
                    5,
                    options(),
                    limits(),
                )
                .await
                .unwrap(),
            5 => {
                assert_eq!(
                    c.get(KEY, limits()).await.unwrap().bytes().await.unwrap(),
                    "hello"
                );
            }
            6 => c.delete(KEY, limits()).await.unwrap(),
            7 => c.delete_objects(&[KEY, "a&<b"], limits()).await.unwrap(),
            _ => unreachable!(),
        }
        let actual = server.next_request().await.unwrap();
        assert_eq!(actual.method, f["method"].as_str().unwrap());
        assert_eq!(actual.target, f["target"].as_str().unwrap());
        assert_eq!(
            actual.body,
            STANDARD.decode(f["body"].as_str().unwrap()).unwrap(),
            "fixture {i}"
        );
        let auth = f["headers"]["authorization"].as_str().unwrap();
        let names = auth
            .split("SignedHeaders=")
            .nth(1)
            .unwrap()
            .split(',')
            .next()
            .unwrap();
        let mut signed = BTreeMap::new();
        for name in names.split(';') {
            let expected = f["headers"][name].as_str().unwrap();
            if name != "host" {
                assert_eq!(actual.header(name), Some(expected), "fixture {i} {name}");
            }
            signed.insert(name.to_owned(), actual.header(name).unwrap().to_owned());
        }
        let (path, query) = actual.target.split_once('?').unwrap();
        let payload = signed["x-amz-content-sha256"].clone();
        let actual_sig = sign(
            &actual.method,
            path,
            query,
            &signed,
            &payload,
            "us-east-1",
            "AKIDEXAMPLE",
            &SECRET.into(),
        );
        assert_eq!(
            actual.header("authorization"),
            Some(actual_sig.authorization.expose())
        );
        signed.insert("host".into(), f["headers"]["host"].as_str().unwrap().into());
        let fixture_sig = sign(
            &actual.method,
            path,
            query,
            &signed,
            &payload,
            "us-east-1",
            "AKIDEXAMPLE",
            &SECRET.into(),
        );
        assert_eq!(
            fixture_sig.canonical_request,
            f["canonical"].as_str().unwrap(),
            "fixture {i}"
        );
        assert_eq!(fixture_sig.authorization.expose(), auth, "fixture {i}");
        if let Some(cache) = f["headers"]["cache-control"].as_str() {
            assert_eq!(actual.header("cache-control"), Some(cache));
        }
    }
}
#[tokio::test]
async fn service_errors_are_typed() {
    let server = MockServer::start().await.unwrap();
    let c = client(&server.url());
    server.push(MockResponse::new(404).body("<Error><Code>NoSuchKey</Code></Error>"));
    assert!(matches!(c.get(KEY, limits()).await, Err(Error::NotFound)));
    server.push(MockResponse::new(403).body("<Error><Code>AccessDenied</Code></Error>"));
    assert!(matches!(
        c.delete(KEY, limits()).await,
        Err(Error::AccessDenied)
    ));
    server.push(MockResponse::new(503).body("<Error><Code>SlowDown</Code></Error>"));
    assert!(
        matches!(c.put(KEY,Bytes::new(),options(),limits()).await,Err(Error::Service{status:503,code}) if code=="SlowDown")
    );
}
#[tokio::test]
async fn partial_batch_errors_are_not_success() {
    let s = MockServer::start().await.unwrap();
    s.push(
        MockResponse::new(200).body(
            "<DeleteResult><Error><Key>a</Key><Code>AccessDenied</Code></Error></DeleteResult>",
        ),
    );
    assert!(
        matches!(client(&s.url()).delete_objects(&["a"],limits()).await,Err(Error::PartialDelete{codes}) if codes==["AccessDenied"])
    );
}
#[tokio::test]
async fn timeout_is_transport_failure() {
    let s = MockServer::start().await.unwrap();
    s.push(MockResponse::new(200).delay(Duration::from_secs(1)));
    assert!(matches!(
        client(&s.url())
            .get(
                KEY,
                Limits {
                    timeout: Duration::from_millis(20),
                    ..limits()
                }
            )
            .await,
        Err(Error::Transport(_))
    ));
}
#[tokio::test]
async fn upload_limit_rejects_before_sending() {
    let s = MockServer::start().await.unwrap();
    let c = client(&s.url());
    let l = Limits {
        max_bytes: 4,
        ..limits()
    };
    assert!(matches!(
        c.put(KEY, Bytes::from_static(b"hello"), options(), l).await,
        Err(Error::TooLarge)
    ));
    assert!(matches!(
        c.put_stream(
            KEY,
            futures_util::stream::iter([Ok(Bytes::from_static(b"hello"))]),
            5,
            options(),
            l
        )
        .await,
        Err(Error::TooLarge)
    ));
    assert!(s.requests().is_empty());
}
#[tokio::test]
async fn dishonest_stream_length_fails() {
    let s = MockServer::start().await.unwrap();
    let c = client(&s.url());
    assert!(
        c.put_stream(
            KEY,
            futures_util::stream::iter([Ok(Bytes::from_static(b"hello"))]),
            4,
            options(),
            limits()
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn cut_short_and_oversized_downloads_fail() {
    let s = MockServer::start().await.unwrap();
    let c = client(&s.url());
    s.push(MockResponse::new(200).body("hello").drop_after(2));
    assert!(c.get(KEY, limits()).await.unwrap().bytes().await.is_err());
    s.push(MockResponse::new(200).body("hello"));
    assert!(
        c.get(
            KEY,
            Limits {
                max_bytes: 4,
                ..limits()
            }
        )
        .await
        .unwrap()
        .bytes()
        .await
        .is_err()
    );
}
#[test]
fn addressing_unicode_and_redaction() {
    let c = client("https://s3.test/base");
    let p = c
        .prepare(
            Method::GET,
            Some("مرحبا/e\u{301}/😀"),
            "",
            BTreeMap::new(),
            "UNSIGNED-PAYLOAD",
            None,
        )
        .unwrap();
    assert_eq!(
        p.path.as_str(),
        "/examplebucket/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7/e%CC%81/%F0%9F%98%80"
    );
    assert_eq!(c.public_object_url("a b"), "https://cdn.test/a b");
    assert!(!format!("{c:?} {p:?}").contains(SECRET));
    for key in ["a/../b", "a//b", "."] {
        assert!(
            c.prepare(Method::GET, Some(key), "", BTreeMap::new(), "", None)
                .is_err()
        );
    }
    let c = Client::new(
        HttpClient::builder().build().unwrap(),
        Config {
            endpoint: "https://s3.test".into(),
            region: "r".into(),
            bucket: "bucket".into(),
            access_key_id: "a".into(),
            secret_key: SecretString::from("s"),
            addressing: Addressing::VirtualHost,
            public_url: "".into(),
        },
        Arc::new(ManualClock::new(0)),
    )
    .unwrap();
    let p = c
        .prepare(Method::GET, Some("a/b"), "", BTreeMap::new(), "", None)
        .unwrap();
    assert_eq!(p.path.as_str(), "/a/b");
    assert_eq!(p.headers["host"], "bucket.s3.test");
}

#[tokio::test]
async fn stalled_download_obeys_total_deadline() {
    let s = MockServer::start().await.unwrap();
    s.push(MockResponse::new(200).body("hello").stall_after_headers());
    let c = client(&s.url());
    let r = c
        .get(
            KEY,
            Limits {
                timeout: Duration::from_millis(20),
                ..limits()
            },
        )
        .await
        .unwrap();
    assert!(r.bytes().await.is_err());
}
#[tokio::test]
async fn short_upload_stream_fails() {
    let s = MockServer::start().await.unwrap();
    let c = client(&s.url());
    assert!(
        c.put_stream(
            KEY,
            futures_util::stream::iter([Ok(Bytes::from_static(b"hi"))]),
            5,
            options(),
            limits()
        )
        .await
        .is_err()
    );
}
