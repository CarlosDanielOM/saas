//! The ws transport module is responsible for handling websocket connections
//! The only public function is [`new_req`] which is used to upgrade a http request to a websocket connection
//!
//! Other functions are used internally to handle the websocket connection through tasks and channels
//! and to handle upgrade from polling to ws

use std::sync::Arc;

use futures_util::{
    SinkExt, StreamExt, TryStreamExt,
    stream::{SplitSink, SplitStream},
};
use http::{HeaderValue, Request, Response, StatusCode, request::Parts};
use smallvec::smallvec;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        self, Message,
        handshake::derive_accept_key,
        protocol::{Role, WebSocketConfig},
    },
};
use tokio_util::future::FutureExt as _;

use engineioxide_core::{Packet, ProtocolVersion, Sid, Str, TransportType};

use crate::{
    DisconnectReason, Socket, body::ResponseBody, config::EngineIoConfig, engine::EngineIo,
    errors::Error, handler::EngineIoHandler, socket::InternalRx, transport::make_open_packet,
};

/// Create a response for websocket upgrade
fn ws_response<B>(ws_key: &HeaderValue) -> Response<ResponseBody<B>> {
    let derived = derive_accept_key(ws_key.as_bytes());
    let sec = derived.parse::<HeaderValue>().unwrap();
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(http::header::UPGRADE, HeaderValue::from_static("websocket"))
        .header(
            http::header::CONNECTION,
            HeaderValue::from_static("Upgrade"),
        )
        .header(http::header::SEC_WEBSOCKET_ACCEPT, sec)
        .body(ResponseBody::empty_response())
        .unwrap() // we are only using constants
}

/// Upgrade a websocket request to create a websocket connection.
///
/// If a sid is provided in the query it means that is is upgraded from an existing HTTP polling request.
/// In this case the http polling request is closed and the SID is kept for the websocket
pub fn new_req<R: Send + 'static, B, H: EngineIoHandler>(
    engine: Arc<EngineIo<H>>,
    protocol: ProtocolVersion,
    sid: Option<Sid>,
    req: Request<R>,
) -> Result<Response<ResponseBody<B>>, Error> {
    let (parts, body) = req.into_parts();
    let req = Request::from_parts(parts.clone(), body);

    let ws_key = parts
        .headers
        .get("Sec-WebSocket-Key")
        .ok_or(Error::InvalidWebSocketKey)?
        .clone();

    tokio::spawn(async move {
        let conn = hyper::upgrade::on(req)
            .await
            .map(hyper_util::rt::TokioIo::new);

        let res = match conn {
            Ok(conn) => on_init(engine.clone(), conn, protocol, sid, parts).await,
            Err(_e) => {
                #[cfg(feature = "tracing")]
                tracing::debug!("ws upgrade error: {}", _e);
                return;
            }
        };

        // [dima-rust patch 1] An error here is a failed upgrade (or a new WebSocket session
        // that never started): it ends the new transport only, never the polling session.
        match res {
            Ok(_) => {
                #[cfg(feature = "tracing")]
                tracing::debug!(?sid, "ws closed")
            }
            Err(Error::MultipleWebsocketRequests) => {}
            Err(_e) => {
                #[cfg(feature = "tracing")]
                tracing::debug!(?sid, "ws closed with error: {_e}");
            }
        }
    });

    Ok(ws_response(&ws_key))
}

/// Handle a websocket connection upgrade
///
/// Sends an open packet if it is not an upgrade from a polling request
///
/// Read packets from the websocket and handle them, it will block until the connection is closed
#[cfg_attr(
    feature = "tracing",
    tracing::instrument(level = "trace", name = "init_websocket", skip(engine, conn, req_data))
)]
pub async fn on_init<H: EngineIoHandler, S>(
    engine: Arc<EngineIo<H>>,
    conn: S,
    protocol: ProtocolVersion,
    sid: Option<Sid>,
    req_data: Parts,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let ws_config = WebSocketConfig::default()
        .read_buffer_size(engine.config.ws_read_buffer_size)
        .max_message_size(Some(engine.config.ws_max_message_size))
        .max_frame_size(Some(engine.config.ws_max_frame_size));

    let ws_init = move || WebSocketStream::from_raw_socket(conn, Role::Server, Some(ws_config));
    let (socket, ws) = if let Some(sid) = sid {
        match engine.get_socket(sid) {
            None => return Err(Error::UnknownSessionID(sid)),
            // [dima-rust patch 2] One upgrade at a time, and none after one succeeded: the new
            // WebSocket is closed after its handshake, the session is untouched (engine.io
            // server.js 616-623).
            Some(socket) if socket.is_ws() || !socket.claim_upgrade() => {
                close_unused_ws(&mut ws_init().await).await;
                return Err(Error::MultipleWebsocketRequests);
            }
            Some(socket) => {
                let mut ws = ws_init().await;

                let upgrade_fut = upgrade_handshake::<H, S>(&socket, &mut ws);
                // [dima-rust patch 1] A failed upgrade (timeout, the new WebSocket closing or
                // sending anything but the probe and the upgrade packet, the session closing)
                // closes the new WebSocket only; the session carries on over polling
                // (engine.io socket.js 211-218, 243-246, 264-275).
                let failure = match tokio::time::timeout(engine.config.upgrade_timeout, upgrade_fut)
                    .with_cancellation_token(&socket.cancellation_token)
                    .await
                {
                    Some(Ok(Ok(()))) => None,
                    Some(Ok(Err(e))) => Some(e),
                    Some(Err(_)) => {
                        #[cfg(feature = "tracing")]
                        tracing::debug!(?sid, "ws upgrade timed out, closing the new transport");
                        Some(Error::Upgrade)
                    }
                    None => {
                        #[cfg(feature = "tracing")]
                        tracing::debug!(?sid, "socket is being closed");
                        Some(Error::Upgrade)
                    }
                };
                if let Some(e) = failure {
                    socket.cancel_upgrade();
                    close_unused_ws(&mut ws).await;
                    return Err(e);
                }
                (socket, ws)
            }
        }
    } else {
        let socket = engine.create_session(protocol, TransportType::Websocket, req_data, false);

        #[cfg(feature = "tracing")]
        tracing::debug!("new websocket connection");

        let mut ws = ws_init().await;
        init_handshake(socket.id, &mut ws, &engine.config).await?;
        socket
            .clone()
            .spawn_heartbeat(engine.config.ping_interval, engine.config.ping_timeout);
        (socket, ws)
    };
    let (tx, rx) = ws.split();

    // Pipe between websocket and internal socket channel.
    tokio::spawn(forward_to_socket::<H, S>(socket.clone(), tx));

    // pipe between internal socket channel and websocket
    match forward_to_handler(&engine, rx, &socket)
        .with_cancellation_token(&socket.cancellation_token)
        .await
    {
        Some(Err(ref e)) => {
            let reason =
                Option::<DisconnectReason>::from(e).unwrap_or(DisconnectReason::TransportError);

            #[cfg(feature = "tracing")]
            tracing::debug!("error when handling packet: {:?}", e);
            engine.close_session(socket.id, reason);
        }
        Some(Ok(())) => {
            #[cfg(feature = "tracing")]
            tracing::debug!(sid = %socket.id, "ws transport was closed");
            engine.close_session(socket.id, DisconnectReason::TransportClose);
        }
        None => {
            #[cfg(feature = "tracing")]
            tracing::debug!(sid = %socket.id, "socket is closing");
        }
    }
    Ok(())
}

/// Forwards all packets received from a websocket to a EngineIo [`Socket`]
async fn forward_to_handler<H: EngineIoHandler, S>(
    engine: &Arc<EngineIo<H>>,
    mut rx: SplitStream<WebSocketStream<S>>,
    socket: &Arc<Socket<H::Data>>,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    while let Some(msg) = rx.try_next().await? {
        match msg {
            Message::Text(msg) => match Packet::parse(socket.protocol, ws_bytes_to_str(msg))? {
                Packet::Close => {
                    #[cfg(feature = "tracing")]
                    tracing::debug!("[sid={}] closing session", socket.id);
                    engine.close_session(socket.id, DisconnectReason::TransportClose);
                    break;
                }
                Packet::Pong | Packet::Ping => socket
                    .heartbeat_tx
                    .try_send(())
                    .map_err(|_| Error::HeartbeatTimeout),
                Packet::Message(msg) => {
                    engine.handler.on_message(msg, socket.clone());
                    Ok(())
                }
                p => return Err(Error::BadPacket(p)),
            },
            Message::Binary(mut data) => {
                if socket.protocol == ProtocolVersion::V3 && !data.is_empty() {
                    // The first byte is the message type, which we don't need.
                    data = data.split_off(1);
                }
                engine.handler.on_binary(data, socket.clone());
                Ok(())
            }
            Message::Close(_) => {
                #[cfg(feature = "tracing")]
                tracing::debug!("websocket closed, closing session");
                engine.close_session(socket.id, DisconnectReason::TransportClose);
                break;
            }
            _ => {
                #[cfg(feature = "tracing")]
                tracing::debug!(sid = ?socket.id, "unexpected ws message");
                Ok(())
            }
        }?
    }
    Ok(())
}

/// Forwards all packets waiting to be sent to the websocket
///
/// The websocket stream is flushed only when the internal channel is drained
async fn forward_to_socket<H: EngineIoHandler, S>(
    socket: Arc<Socket<H::Data>>,
    mut tx: SplitSink<WebSocketStream<S>, Message>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut internal_rx = socket.internal_rx.try_lock().unwrap();
    let InternalRx {
        buffered_rx,
        volatile_rx,
        ..
    } = &mut *internal_rx;

    // map a packet to a websocket message
    // It is declared as a macro rather than a closure to avoid ownership issues
    macro_rules! map_fn {
            ($item:ident) => {
                let res = match $item {
                    Packet::Binary(bin) | Packet::BinaryV3(bin) => {
                        if socket.protocol == ProtocolVersion::V3 {
                            // v3 protocol requires packet type as the first byte.
                            // This requires a new buffer. This is OK as it is only for the V3 protocol.
                            let mut buff = Vec::with_capacity(bin.len() + 1);
                            buff.push(0x04);
                            buff.extend(bin);
                            tx.feed(Message::Binary(buff.into())).await
                        } else {
                            tx.feed(Message::Binary(bin)).await
                        }
                    }
                    // A Noop Packet maybe sent by the server to upgrade from a polling connection
                    // In the case that the packet was not poll in time it will remain in the buffer and therefore
                    // it should be discarded here
                    Packet::Noop => Ok(()),
                    _ => {
                        let packet: String = $item.try_into().unwrap();
                        tx.feed(Message::Text(packet.into())).await
                    }
                };
                if let Err(_e) = res {
                    #[cfg(feature = "tracing")]
                    tracing::debug!("[sid={}] error sending packet: {}", socket.id, _e);
                }
            };
        }

    // Forward buffered packets until the channel is closed or the session is cancelled.
    loop {
        tokio::select! {
            biased;
            items = buffered_rx.recv() => {
                match items {
                    Some(packets) => {
                        for item in packets {
                            map_fn!(item);
                        }
                        while let Ok(packets) = buffered_rx.try_recv() {
                            for item in packets {
                                map_fn!(item);
                            }
                        }
                    }
                    None => break
                }
            }
            _ = socket.cancellation_token.cancelled() => break,
            Ok(()) = volatile_rx.changed() => {
                let val = volatile_rx.borrow_and_update().clone();
                if let Some(packets) = val {
                    #[cfg(feature = "tracing")]
                    tracing::debug!(sid = ?socket.id, "ws volatile flush: {} packets", packets.len());
                    for item in packets {
                        map_fn!(item);
                    }
                }
            },
        }

        #[cfg(feature = "tracing")]
        tracing::trace!(sid = %socket.id, "ws flush");
        tx.flush().await.ok();
    }

    #[cfg(feature = "tracing")]
    tracing::trace!(sid = %socket.id, "ws closing flush");

    tx.flush().await.ok();
    tx.close().await.ok();
}
/// Send a Engine.IO [`OpenPacket`] to initiate a websocket connection
async fn init_handshake<S>(
    sid: Sid,
    ws: &mut WebSocketStream<S>,
    config: &EngineIoConfig,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let packet = Packet::Open(make_open_packet(TransportType::Websocket, sid, config));
    let packet: String = packet.into();
    ws.send(Message::Text(packet.into())).await?;
    Ok(())
}

/// Upgrade a session from a polling request to a websocket request.
///
/// Before upgrading the session the server should send a NOOP packet to any pending polling request.
///
/// ## Handshake :
/// ```text
/// CLIENT                                                 SERVER
///│                                                      │
///│   GET /engine.io/?EIO=4&transport=websocket&sid=...  │
///│ ───────────────────────────────────────────────────► │
///│  ◄─────────────────────────────────────────────────┘ │
///│            HTTP 101 (WebSocket handshake)            │
///│                                                      │
///│            -----  WebSocket frames -----             │
///│  ─────────────────────────────────────────────────►  │
///│                         2probe                       │ (ping packet)
///│  ◄─────────────────────────────────────────────────  │
///│                         3probe                       │ (pong packet)
///│  ─────────────────────────────────────────────────►  │
///│                         5                            │ (upgrade packet)
///│                                                      │
///│            -----  WebSocket frames -----             │
/// ```
#[cfg_attr(
    feature = "tracing",
    tracing::instrument(level = "trace", skip(socket, ws))
)]
async fn upgrade_handshake<H: EngineIoHandler, S>(
    socket: &Arc<Socket<H::Data>>,
    ws: &mut WebSocketStream<S>,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    #[cfg(feature = "tracing")]
    tracing::debug!("starting websocket connection upgrade");

    // [dima-rust patch 1] Probe pings, then the upgrade packet (engine.io socket.js 220-247).
    // Polls go on as usual until the probe is answered; from then on they get noops and the
    // packet buffer is held for the WebSocket.
    let mut paused = None;
    loop {
        let msg = match ws.next().await {
            Some(Ok(Message::Text(d))) => d,
            // Control frames are not packets (`ws` answers them itself).
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
            Some(Ok(Message::Close(_))) => {
                #[cfg(feature = "tracing")]
                tracing::debug!("ws stream closed before upgrade");
                Err(Error::Upgrade)?
            }
            _ => {
                #[cfg(feature = "tracing")]
                tracing::debug!("unexpected ws message before upgrade");
                Err(Error::Upgrade)?
            }
        };
        match Packet::parse(socket.protocol, ws_bytes_to_str(msg))? {
            Packet::PingUpgrade => {
                #[cfg(feature = "tracing")]
                tracing::debug!("received ping upgrade");
                // Respond with a PongUpgrade packet
                ws.send(Message::Text(String::from(Packet::PongUpgrade).into()))
                    .await?;
                if paused.is_none() {
                    paused = Some(pause_polling(socket).await?);
                }
            }
            Packet::Upgrade => break,
            p => Err(Error::BadPacket(p))?,
        };
    }
    // An upgrade packet without a probe before it is accepted too (socket.js 228).
    let _paused = match paused {
        Some(paused) => paused,
        None => pause_polling(socket).await?,
    };

    #[cfg(feature = "tracing")]
    tracing::debug!("ws upgraded successfully");
    socket.upgrade_to_websocket();
    Ok(())
}

/// [dima-rust patch 1] From now on the socket is upgrading: polls are answered with noops. A
/// poll waiting for data gets one at once; once it has returned, the packet buffer's lock is
/// returned, so the WebSocket takes over the buffered packets.
async fn pause_polling<D>(
    socket: &Socket<D>,
) -> Result<tokio::sync::MutexGuard<'_, InternalRx>, Error>
where
    D: Default + Send + Sync + 'static,
{
    socket.start_upgrade();
    // We send a last Noop request to close a potential waiting polling request.
    socket
        .internal_tx
        .send(smallvec![Packet::Noop])
        .await
        .map_err(|_| Error::Upgrade)?;
    // wait for any current polling connection to finish by waiting for the socket to be unlocked
    Ok(socket.internal_rx.lock().await)
}

/// [dima-rust patch 1] How long closing a WebSocket may take: `ws`'s close timeout, after which
/// it destroys the socket (ws 8.21.3, lib/websocket.js `close` and `setCloseTimer`).
const WS_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// [dima-rust patch 1] Closes a WebSocket that did not become the session's transport, as
/// `engine.io` does with `transport.close()`: a close frame, within the close timeout.
async fn close_unused_ws<S>(ws: &mut WebSocketStream<S>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    tokio::time::timeout(WS_CLOSE_TIMEOUT, ws.close(None))
        .await
        .ok();
}

fn ws_bytes_to_str(bytes: tungstenite::Utf8Bytes) -> Str {
    // SAFETY: the bytes are guaranteed to be valid UTF-8 by the tungstenite parser
    unsafe { Str::from_bytes_unchecked(bytes.into()) }
}
