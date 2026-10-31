#![cfg(feature = "ast-bot-runtime")]
//! Loopback HTTP coverage of the concrete AST Twitch chat sender.
use std::{io::{Read, Write}, net::TcpListener, sync::Arc, thread, time::{Duration, Instant}};
use dima_rust::{
    functions::{CacheCommand, CacheValue, FunctionAuth, FunctionCache, FunctionFailure, FunctionFuture, TwitchFunctions},
    utils::{ast_runtime::{ChatSender, chat::TwitchChatSender}, twitch::{AccessToken, TwitchAuth, TwitchClient, TwitchEndpoints, TWITCH_BOT_ACCOUNT_ID}},
};
use serde_json::json;

struct Auth;
impl FunctionAuth for Auth {
    fn acquire<'a>(&'a self, auth: &'a TwitchAuth) -> FunctionFuture<'a, Result<AccessToken, FunctionFailure>> {
        Box::pin(async move { assert_eq!(auth, &TwitchAuth::App); Ok(AccessToken::app("fixture-token")) })
    }
}
struct Cache;
impl FunctionCache for Cache {
    fn execute<'a>(&'a self, _: CacheCommand) -> FunctionFuture<'a, Result<CacheValue, FunctionFailure>> {
        Box::pin(async { panic!("chat send must not use cache") })
    }
}

#[tokio::test]
#[ignore = "requires loopback execution lease"]
async fn twitch_sender_posts_and_maps_status() {
    for (status, response, expected_error, expected_message) in [
        (200, r#"{"data":[{"is_sent":true,"message_id":"m1"}]}"#, false, "Message sent"),
        (401, r#"{"error":"Unauthorized","message":"nope"}"#, true, "nope"),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback bind");
        let base = format!("http://{}/", listener.local_addr().expect("address"));
        listener.set_nonblocking(true).expect("nonblocking listener");
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                    Err(error) => panic!("loopback accept: {error}"),
                }
            };
            stream.set_read_timeout(Some(Duration::from_secs(5))).expect("timeout");
            let mut data = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                let count = stream.read(&mut buffer).expect("read headers");
                assert!(count > 0);
                data.extend_from_slice(&buffer[..count]);
                if let Some(pos) = data.windows(4).position(|v| v == b"\r\n\r\n") { break pos + 4; }
            };
            let headers = String::from_utf8(data[..header_end].to_vec()).expect("headers");
            let length: usize = headers.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().expect("length"))
            }).expect("content length");
            while data.len() < header_end + length {
                let count = stream.read(&mut buffer).expect("read body");
                assert!(count > 0);
                data.extend_from_slice(&buffer[..count]);
            }
            let reply = format!("HTTP/1.1 {status} Fixture\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}", response.len());
            stream.write_all(reply.as_bytes()).expect("respond");
            (headers, data[header_end..header_end + length].to_vec())
        });
        let endpoints = TwitchEndpoints::new(&base, &base).expect("loopback endpoints");
        let client = TwitchClient::new("fixture-client", endpoints, Some(Duration::from_secs(5))).expect("client");
        let twitch = TwitchFunctions::with_adapters(client, Arc::new(Auth), Arc::new(Cache), None, None);
        let mut sender = TwitchChatSender::new(twitch);
        let result = sender.send("channel-1", "hello world").await.expect("send result");
        let (headers, body) = server.join().expect("server shutdown");
        assert_eq!(headers.lines().next(), Some("POST /chat/messages HTTP/1.1")); // no query string
        assert!(headers.lines().any(|line| line.eq_ignore_ascii_case("authorization: Bearer fixture-token")));
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).expect("JSON"), json!({"broadcaster_id":"channel-1","sender_id":TWITCH_BOT_ACCOUNT_ID,"message":"hello world","for_source_only":true}));
        assert_eq!(result.error, expected_error);
        assert_eq!(result.message, expected_message);
        assert_eq!(result.status, Some(status));
    }
}
