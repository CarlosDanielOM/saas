//! Socket.IO server foundation on socketioxide, matching the options of
//! `new SocketIOServer(server, …)` in `dimabot/src/server/websocket.ts`.
//!
//! The TypeScript server uses socket.io defaults: path `/socket.io`, ping
//! interval 25 s, ping timeout 20 s, upgrade timeout 10 s, connect timeout
//! 45 s, and a 1 MB `maxHttpBufferSize` for both polling and WebSocket
//! messages. socketioxide's own payload default is 100 kB, so
//! [`socket_io_builder`] sets the socket.io values explicitly.
//!
//! Gaps: socketioxide has no `connectionStateRecovery`, which the TypeScript
//! server enables. Clients that reconnect get a new session and miss events
//! sent while they were away. Namespaces such as `/clip/:id` map to
//! `SocketIo::dyn_ns("/clip/{id}", …)`.

use std::time::Duration;

use socketioxide::{SocketIo, SocketIoBuilder, layer::SocketIoLayer};

/// socket.io's `maxHttpBufferSize` default.
pub const MAX_MESSAGE_BYTES: u64 = 1_000_000;

/// A builder with socket.io's default server options.
pub fn socket_io_builder() -> SocketIoBuilder {
    SocketIo::builder()
        .req_path("/socket.io")
        .ping_interval(Duration::from_millis(25_000))
        .ping_timeout(Duration::from_millis(20_000))
        .upgrade_timeout(Duration::from_millis(10_000))
        .connect_timeout(Duration::from_millis(45_000))
        .max_payload(MAX_MESSAGE_BYTES)
        .ws_max_message_size(MAX_MESSAGE_BYTES as usize)
}

/// Builds the Axum layer and its `SocketIo` handle with default options.
pub fn socket_io_layer() -> (SocketIoLayer, SocketIo) {
    socket_io_builder().build_layer()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};

    use axum::Router;
    use socketioxide::extract::SocketRef;

    use super::*;

    async fn request(address: std::net::SocketAddr, raw: String) -> String {
        tokio::task::spawn_blocking(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            stream.write_all(raw.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        })
        .await
        .unwrap()
    }

    fn body(response: &str) -> &str {
        response.split("\r\n\r\n").nth(1).unwrap_or_default()
    }

    #[tokio::test]
    async fn handshakes_with_socket_io_defaults_and_dynamic_namespaces() {
        let (layer, io) = socket_io_layer();
        io.dyn_ns("/clip/{id}", async |socket: SocketRef| {
            socket.emit("hello", &socket.ns().to_owned()).ok();
        })
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(async move { axum::serve(listener, Router::new().layer(layer)).await });

        let open = request(
            address,
            "GET /socket.io/?EIO=4&transport=polling HTTP/1.1\r\nHost: api\r\nConnection: close\r\n\r\n"
                .to_owned(),
        )
        .await;
        let open = body(&open);
        assert!(open.starts_with('0'), "{open}");
        let handshake: serde_json::Value = serde_json::from_str(&open[1..]).unwrap();
        assert_eq!(handshake["pingInterval"], 25_000);
        assert_eq!(handshake["pingTimeout"], 20_000);
        assert_eq!(handshake["maxPayload"], MAX_MESSAGE_BYTES);
        let sid = handshake["sid"].as_str().unwrap().to_owned();

        let packet = "40/clip/123,";
        let connect = request(
            address,
            format!(
                "POST /socket.io/?EIO=4&transport=polling&sid={sid} HTTP/1.1\r\nHost: api\r\n\
                 Content-Type: text/plain;charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{packet}",
                packet.len()
            ),
        )
        .await;
        assert!(connect.starts_with("HTTP/1.1 200"), "{connect}");

        let poll = request(
            address,
            format!("GET /socket.io/?EIO=4&transport=polling&sid={sid} HTTP/1.1\r\nHost: api\r\nConnection: close\r\n\r\n"),
        )
        .await;
        let poll = body(&poll);
        assert!(poll.contains("40/clip/123,{\"sid\":"), "{poll}");
        assert!(
            poll.contains(r#"42/clip/123,["hello","/clip/123"]"#),
            "{poll}"
        );
        server.abort();
    }
}
