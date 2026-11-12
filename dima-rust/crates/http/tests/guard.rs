//! The guarded client against loopback servers: refusals, the rebinding case, redirect chains,
//! credentials across origins, limits.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use dima_core::Shutdown;
use dima_http::guard::{BoxFuture, GuardPolicy, GuardedClient, Resolver};
use dima_http::testing::{MockResponse, MockServer};
use dima_http::{BlockReason, Error, Method, TimeoutKind};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const LOOPBACK: &str = "127.0.0.1";

fn loopback() -> IpAddr {
    LOOPBACK.parse().unwrap()
}

/// Answers from a script per name; each call takes the next answer (the last one repeats).
#[derive(Debug, Default)]
struct ScriptedResolver {
    answers: Mutex<HashMap<String, Vec<Vec<IpAddr>>>>,
    calls: Mutex<Vec<String>>,
}

impl ScriptedResolver {
    fn answer(&self, host: &str, answers: &[&[&str]]) {
        self.answers.lock().unwrap().insert(
            host.to_owned(),
            answers
                .iter()
                .map(|a| a.iter().map(|ip| ip.parse().unwrap()).collect())
                .collect(),
        );
    }

    fn calls(&self, host: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|h| *h == host)
            .count()
    }
}

impl Resolver for ScriptedResolver {
    fn resolve<'a>(&'a self, host: &'a str) -> BoxFuture<'a, std::io::Result<Vec<IpAddr>>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(host.to_owned());
            let mut answers = self.answers.lock().unwrap();
            let list = answers
                .get_mut(host)
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no such host"))?;
            Ok(if list.len() > 1 {
                list.remove(0)
            } else {
                list[0].clone()
            })
        })
    }
}

/// Plain http on the mock's port, the test hosts allowed, loopback exempted for the mock.
fn policy(server: &MockServer, hosts: &[&str]) -> GuardPolicy {
    GuardPolicy::https_hosts(hosts.iter().copied())
        .allow_http(true)
        .ports(&[server.addr().port()])
        .allow_address_for_tests(loopback())
}

fn client(policy: GuardPolicy, resolver: &Arc<ScriptedResolver>) -> GuardedClient {
    GuardedClient::with_resolver(policy, resolver.clone(), Shutdown::new()).unwrap()
}

fn reason(error: &Error) -> BlockReason {
    error
        .block_reason()
        .cloned()
        .unwrap_or_else(|| panic!("not blocked: {error:?}"))
}

#[tokio::test]
async fn fetches_an_allowed_host_and_sends_no_credentials() {
    let server = MockServer::start().await.unwrap();
    server.push(MockResponse::new(200).body("image"));
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("cdn.test", &[&[LOOPBACK]]);
    let client = client(policy(&server, &["cdn.test"]), &resolver);
    let url = format!("http://cdn.test:{}/a.png", server.addr().port());
    let body = client
        .get(&url)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&body[..], b"image");
    let request = server.next_request().await.unwrap();
    assert_eq!(request.target, "/a.png");
    assert_eq!(
        request.header("host"),
        Some(&*format!("cdn.test:{}", server.addr().port()))
    );
    for name in ["authorization", "cookie", "referer", "proxy-authorization"] {
        assert_eq!(request.header(name), None, "{name}");
    }
}

#[tokio::test]
async fn refuses_names_that_resolve_to_refused_addresses() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("meta.test", &[&["169.254.169.254"]]);
    resolver.answer("mixed.test", &[&["93.184.215.14", "10.0.0.1"]]);
    resolver.answer("mapped.test", &[&["::ffff:127.0.0.2"]]);
    resolver.answer("nat64.test", &[&["64:ff9b::a9fe:a9fe"]]);
    resolver.answer("empty.test", &[&[]]);
    let hosts = [
        "meta.test",
        "mixed.test",
        "mapped.test",
        "nat64.test",
        "empty.test",
        "missing.test",
    ];
    let client = client(policy(&server, &hosts), &resolver);
    let port = server.addr().port();
    let fetch = |host: &str| client.get(&format!("http://{host}:{port}/")).send();
    assert_eq!(
        reason(&fetch("meta.test").await.unwrap_err()),
        BlockReason::Address("169.254.169.254".parse().unwrap())
    );
    // One bad address refuses the whole answer, even with a public one first.
    assert_eq!(
        reason(&fetch("mixed.test").await.unwrap_err()),
        BlockReason::Address("10.0.0.1".parse().unwrap())
    );
    assert!(matches!(
        reason(&fetch("mapped.test").await.unwrap_err()),
        BlockReason::Address(_)
    ));
    assert!(matches!(
        reason(&fetch("nat64.test").await.unwrap_err()),
        BlockReason::Address(_)
    ));
    assert_eq!(
        reason(&fetch("empty.test").await.unwrap_err()),
        BlockReason::Unresolvable
    );
    assert_eq!(
        reason(&fetch("missing.test").await.unwrap_err()),
        BlockReason::Unresolvable
    );
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn literal_addresses_in_every_notation_never_connect() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    // Any public host, literals enabled, but loopback not exempted.
    let policy = GuardPolicy::any_public_host()
        .allow_http(true)
        .allow_ip_literals(true)
        .ports(&[server.addr().port()]);
    let client = client(policy, &resolver);
    let port = server.addr().port();
    for host in [
        "127.0.0.1",
        "2130706433",
        "0x7f000001",
        "0x7f.0.0.1",
        "0177.0.0.1",
        "017700000001",
        "127.1",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "[0:0:0:0:0:0:0:1]",
        "[::127.0.0.1]",
        "0",
        "localhost",
    ] {
        let error = client
            .get(&format!("http://{host}:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert!(error.block_reason().is_some(), "{host}: {error:?}");
    }
    for raw in [
        format!("http://[fe80::1%25lo]:{port}/"),
        format!("http://[::1%251]:{port}/"),
        "not a url".to_owned(),
        format!("http://user:pass@127.0.0.1:{port}/"),
    ] {
        assert!(
            client
                .get(&raw)
                .send()
                .await
                .unwrap_err()
                .block_reason()
                .is_some(),
            "{raw}"
        );
    }
    assert!(server.requests().is_empty());
}

/// The rebinding case: the resolver answers an allowed address first and a refused one next.
/// One fetch resolves exactly once and connects to the address it checked; the next fetch
/// resolves again, sees the refused answer and is stopped before connecting.
#[tokio::test]
async fn dns_rebinding_cannot_swap_the_checked_address() {
    let server = MockServer::start().await.unwrap();
    server.fallback(|_| MockResponse::new(200).body("ok"));
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("rebind.test", &[&[LOOPBACK], &["127.0.0.2"]]);
    let client = client(policy(&server, &["rebind.test"]), &resolver);
    let url = format!("http://rebind.test:{}/", server.addr().port());
    let text = client.get(&url).send().await.unwrap().text().await.unwrap();
    assert_eq!(text, "ok");
    assert_eq!(
        resolver.calls("rebind.test"),
        1,
        "one resolution per connection"
    );
    let error = client.get(&url).send().await.unwrap_err();
    assert_eq!(
        reason(&error),
        BlockReason::Address("127.0.0.2".parse().unwrap())
    );
    assert_eq!(resolver.calls("rebind.test"), 2);
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn redirect_chains_are_rechecked_hop_by_hop() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("a.test", &[&[LOOPBACK]]);
    resolver.answer("b.test", &[&[LOOPBACK]]);
    resolver.answer("evil.test", &[&[LOOPBACK]]);
    resolver.answer("internal.test", &[&["10.1.1.1"]]);
    let port = server.addr().port();
    let client = client(
        policy(&server, &["a.test", "b.test", "internal.test"]),
        &resolver,
    );

    // Three hops are allowed: a -> b -> a -> b.
    server.push(MockResponse::new(302).header("location", &format!("http://b.test:{port}/2")));
    server.push(MockResponse::new(301).header("location", "/3"));
    server.push(MockResponse::new(307).header("location", &format!("http://a.test:{port}/4")));
    server.push(MockResponse::new(200).body("done"));
    let text = client
        .get(&format!("http://a.test:{port}/1"))
        .header("x-token", "only-for-a")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(text, "done");
    let requests = server.requests();
    let hosts: Vec<_> = requests
        .iter()
        .map(|r| {
            (
                r.header("host")
                    .unwrap()
                    .split(':')
                    .next()
                    .unwrap()
                    .to_owned(),
                r.target.clone(),
            )
        })
        .collect();
    assert_eq!(
        hosts,
        [
            ("a.test".into(), "/1".into()),
            ("b.test".into(), "/2".into()),
            ("b.test".into(), "/3".into()),
            ("a.test".into(), "/4".into())
        ]
    );
    // The caller's header went to the first origin only, never across.
    assert_eq!(requests[0].header("x-token"), Some("only-for-a"));
    assert!(requests[1..].iter().all(|r| r.header("x-token").is_none()));

    // A fourth hop is too many.
    for _ in 0..4 {
        server.push(MockResponse::new(302).header("location", "/again"));
    }
    let error = client
        .get(&format!("http://a.test:{port}/"))
        .send()
        .await
        .unwrap_err();
    assert_eq!(reason(&error), BlockReason::TooManyRedirects);

    // A hop to an unlisted host, to a refused address, to another scheme or port, or to a
    // zone id is refused before anything is sent there.
    let before = server.requests().len();
    for location in [
        format!("http://evil.test:{port}/"),
        format!("http://internal.test:{port}/"),
        format!("http://127.0.0.1:{port}/"),
        format!("ftp://a.test:{port}/"),
        format!("http://a.test:{}/", port.wrapping_add(1)),
        format!("http://[fe80::1%25eth0]:{port}/"),
        format!("http://user@a.test:{port}/"),
    ] {
        server.push(MockResponse::new(302).header("location", &location));
        let error = client
            .get(&format!("http://a.test:{port}/"))
            .send()
            .await
            .unwrap_err();
        assert!(error.block_reason().is_some(), "{location}: {error:?}");
    }
    assert_eq!(server.requests().len(), before + 7);
}

#[tokio::test]
async fn post_turns_into_get_on_303_and_keeps_its_body_on_307() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("a.test", &[&[LOOPBACK]]);
    let port = server.addr().port();
    let client = client(policy(&server, &["a.test"]), &resolver);
    server.push(MockResponse::new(307).header("location", "/kept"));
    server.push(MockResponse::new(303).header("location", "/got"));
    server.push(MockResponse::new(200));
    client
        .request(Method::POST, &format!("http://a.test:{port}/start"))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .unwrap();
    let requests = server.requests();
    assert_eq!(
        requests
            .iter()
            .map(|r| (r.method.as_str(), r.body_text()))
            .collect::<Vec<_>>(),
        [
            ("POST", "{}".into()),
            ("POST", "{}".into()),
            ("GET", String::new())
        ]
    );
}

#[tokio::test]
async fn request_bodies_are_bounded_before_anything_is_sent() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("a.test", &[&[LOOPBACK]]);
    let port = server.addr().port();
    let client = client(
        policy(&server, &["a.test"]).max_request_bytes(16),
        &resolver,
    );
    let url = format!("http://a.test:{port}/upload");
    let error = client
        .request(Method::POST, &url)
        .body(vec![b'x'; 17])
        .send()
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::RequestBodyTooLarge { limit: 16, .. }),
        "{error:?}"
    );
    assert!(server.requests().is_empty());
    // At the limit it goes out; one request may raise its own limit.
    server.push(MockResponse::new(200));
    server.push(MockResponse::new(200));
    client
        .request(Method::POST, &url)
        .body(vec![b'x'; 16])
        .send()
        .await
        .unwrap();
    client
        .request(Method::POST, &url)
        .body(vec![b'x'; 17])
        .max_request_bytes(32)
        .send()
        .await
        .unwrap();
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn size_and_time_limits_hold() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("a.test", &[&[LOOPBACK]]);
    let port = server.addr().port();
    let client = client(
        policy(&server, &["a.test"])
            .max_bytes(16)
            .timeout(Duration::from_millis(300)),
        &resolver,
    );
    let url = format!("http://a.test:{port}/");
    server.push(MockResponse::new(200).body(vec![0u8; 17]));
    let error = client
        .get(&url)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::BodyTooLarge { limit: 16, .. }),
        "{error:?}"
    );
    server.push(MockResponse::new(200).body(vec![0u8; 16]));
    assert_eq!(
        client
            .get(&url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap()
            .len(),
        16
    );
    server.push(MockResponse::new(200).delay(Duration::from_secs(5)));
    let error = client.get(&url).send().await.unwrap_err();
    assert!(
        matches!(
            error,
            Error::Timeout {
                kind: TimeoutKind::Total,
                ..
            }
        ),
        "{error:?}"
    );
    // The deadline covers every hop together.
    server.push(
        MockResponse::new(302)
            .header("location", "/b")
            .delay(Duration::from_millis(200)),
    );
    server.push(MockResponse::new(200).delay(Duration::from_millis(200)));
    let error = client.get(&url).send().await.unwrap_err();
    assert!(error.is_timeout(), "{error:?}");
    // Errors never show the URL.
    let printed = format!("{error} {error:?}");
    assert!(!printed.contains("a.test"), "{printed}");
}

#[tokio::test]
async fn the_reference_policy_refuses_what_media_ts_refuses() {
    let resolver = Arc::new(ScriptedResolver::default());
    let client = GuardedClient::with_resolver(
        GuardPolicy::https_hosts(["cdn.streamelements.com", "static.streamelements.com"]),
        resolver.clone(),
        Shutdown::new(),
    )
    .unwrap();
    for (url, expected) in [
        ("http://cdn.streamelements.com/a.png", BlockReason::Scheme),
        (
            "https://cdn.streamelements.com:8443/a.png",
            BlockReason::Port,
        ),
        (
            "https://user@cdn.streamelements.com/a.png",
            BlockReason::Userinfo,
        ),
        ("https://streamelements.com/a.png", BlockReason::Host),
        ("https://api.streamelements.com/a.png", BlockReason::Host),
        ("https://1.1.1.1/a.png", BlockReason::Host),
    ] {
        let error = client.get(url).send().await.unwrap_err();
        assert_eq!(reason(&error), expected, "{url}");
    }
    // An allowed name with a private answer: refused before connecting.
    resolver.answer("cdn.streamelements.com", &[&["192.168.1.10"]]);
    let error = client
        .get("https://cdn.streamelements.com/a.png")
        .send()
        .await
        .unwrap_err();
    assert_eq!(
        reason(&error),
        BlockReason::Address("192.168.1.10".parse().unwrap())
    );
}

/// A 307 or 308 keeps the body: to another host, scheme or port it is refused before anything
/// is sent there. A 303 to another origin drops the body and is followed.
#[tokio::test]
async fn a_body_never_follows_a_redirect_to_another_origin() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("a.test", &[&[LOOPBACK]]);
    resolver.answer("b.test", &[&[LOOPBACK]]);
    let port = server.addr().port();
    let client = client(policy(&server, &["a.test", "b.test"]), &resolver);
    for status in [307, 308] {
        server.push(
            MockResponse::new(status).header("location", &format!("http://b.test:{port}/steal")),
        );
        let error = client
            .request(Method::POST, &format!("http://a.test:{port}/start"))
            .header("content-type", "application/json")
            .body(r#"{"api_key":"SECRET"}"#)
            .send()
            .await
            .unwrap_err();
        assert_eq!(reason(&error), BlockReason::BodyToOtherOrigin, "{status}");
    }
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|r| r.target == "/start"));

    server.push(MockResponse::new(303).header("location", &format!("http://b.test:{port}/got")));
    server.push(MockResponse::new(200));
    client
        .request(Method::POST, &format!("http://a.test:{port}/start"))
        .body(r#"{"api_key":"SECRET"}"#)
        .send()
        .await
        .unwrap();
    let last = server.requests().pop().unwrap();
    assert_eq!(
        (last.method.as_str(), last.target.as_str()),
        ("GET", "/got")
    );
    assert!(last.body.is_empty());
}

/// A user's URL can carry any secret under any name: `Response::info()` and every error built
/// from the response show the query's names, never a value.
#[tokio::test]
async fn guarded_responses_show_query_names_only() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("a.test", &[&[LOOPBACK]]);
    let port = server.addr().port();
    let client = client(policy(&server, &["a.test"]), &resolver);
    let url = format!("http://a.test:{port}/p?session=MARKER1&X-Goog-Signature=MARKER2&flag");
    server.push(MockResponse::new(404).body("missing"));
    let response = client.get(&url).send().await.unwrap();
    let info = format!("{} | {:?}", response.info(), response.info());
    assert!(!info.contains("MARKER"), "{info}");
    assert!(
        info.contains("session=<redacted>") && info.contains("flag"),
        "{info}"
    );
    let error = response.error_for_status().await.unwrap_err();
    let printed = format!("{error} | {error:?}");
    assert!(!printed.contains("MARKER"), "{printed}");
    assert!(printed.contains("X-Goog-Signature"), "{printed}");
}

#[derive(Debug, Default)]
struct Recorder {
    events: Mutex<Vec<String>>,
}

impl dima_http::observe::Observer for Recorder {
    fn request_start(&self, start: &dima_http::observe::RequestStart<'_>) {
        self.events.lock().unwrap().push(format!("{start:?}"));
    }
    fn request_end(&self, end: &dima_http::observe::RequestEnd<'_>) {
        self.events.lock().unwrap().push(format!("{end:?}"));
    }
}

/// The observer sees each guarded fetch as provider "guarded" with the host class, its status,
/// failure and sizes; never the URL, the host or the path.
#[tokio::test]
async fn the_observer_sees_the_host_class_never_the_url() {
    let server = MockServer::start().await.unwrap();
    let resolver = Arc::new(ScriptedResolver::default());
    resolver.answer("secret-host.test", &[&[LOOPBACK]]);
    let port = server.addr().port();
    let recorder = Arc::new(Recorder::default());
    let client =
        client(policy(&server, &["secret-host.test"]), &resolver).with_observer(recorder.clone());
    server.push(MockResponse::new(200).body("image"));
    let body = client
        .get(&format!(
            "http://secret-host.test:{port}/secret-path?k=secret-query"
        ))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&body[..], b"image");
    // A refused fetch is reported too.
    client
        .get("http://secret-host.test:1/secret-path")
        .send()
        .await
        .unwrap_err();
    client.get("not a url secret").send().await.unwrap_err();
    let events = recorder.events.lock().unwrap().clone();
    assert_eq!(events.len(), 6, "{events:#?}");
    for event in &events {
        assert!(!event.contains("secret"), "{event}");
        assert!(event.contains("\"guarded\""), "{event}");
    }
    assert!(events[0].contains("listed-host"), "{}", events[0]);
    assert!(
        events[1].contains("status: Some(200)")
            && events[1].contains("body_complete: true")
            && events[1].contains("bytes_received: 5"),
        "{}",
        events[1]
    );
    assert!(events[3].contains("Blocked"), "{}", events[3]);
    assert!(events[4].contains("invalid"), "{}", events[4]);
}
