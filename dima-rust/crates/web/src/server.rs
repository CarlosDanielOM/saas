//! Serving: HTTP/1.1 connections on a bound listener, with upgrades and graceful shutdown.

use std::convert::Infallible;
use std::future::Future as _;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::BoxError;
use axum::body::HttpBody;
use bytes::Bytes;
use hyper::body::{Frame, Incoming, SizeHint};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt as _;

use crate::Body;
use crate::request::PeerAddr;

/// Connection settings.
#[derive(Debug, Clone, Copy)]
pub struct ServeOptions {
    /// Time a client has to send a complete request head (Node's `server.headersTimeout`, 60 s).
    pub header_read_timeout: Duration,
    /// Time from the request head to the end of its body (Node's `server.requestTimeout`,
    /// 300 s). A body still arriving after it fails to read, which body parsers report as 400.
    pub request_timeout: Duration,
    /// After shutdown is requested, how long open connections may finish their requests before
    /// they are closed.
    pub drain_timeout: Duration,
}

impl Default for ServeOptions {
    fn default() -> Self {
        Self {
            header_read_timeout: Duration::from_secs(60),
            request_timeout: Duration::from_secs(300),
            drain_timeout: Duration::from_secs(10),
        }
    }
}

/// A request body that fails once the request deadline has passed.
struct DeadlineBody {
    inner: Incoming,
    deadline: Pin<Box<tokio::time::Sleep>>,
}

impl HttpBody for DeadlineBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if self.deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Some(Err("request timeout".into())));
        }
        Pin::new(&mut self.inner).poll_frame(cx).map_err(Into::into)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Serves `service` on `listener` until `shutdown` is cancelled, then stops accepting, lets open
/// requests finish (up to [`ServeOptions::drain_timeout`]) and returns.
///
/// Every request carries the connection's [`PeerAddr`] and hyper's upgrade handle in its
/// extensions, so a service in front of the [`crate::App`] (Socket.IO) or a handler
/// ([`crate::Req::take_upgrade`]) can take over the connection on the same port.
pub async fn serve<T, B>(
    listener: TcpListener,
    service: T,
    shutdown: CancellationToken,
    options: ServeOptions,
) -> io::Result<()>
where
    T: tower::Service<http::Request<Body>, Response = http::Response<B>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    T::Future: Send + 'static,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    let service = service.clone();
                    let shutdown = shutdown.clone();
                    connections.spawn(connection(stream, peer, service, shutdown, options));
                }
                // Accept errors (descriptor exhaustion, aborted handshakes) are transient: like
                // Node, keep listening, after a short pause so a hot loop cannot form.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    drop(listener);
    let drained = tokio::time::timeout(options.drain_timeout, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        connections.shutdown().await;
    }
    Ok(())
}

async fn connection<T, B>(
    stream: TcpStream,
    peer: SocketAddr,
    service: T,
    shutdown: CancellationToken,
    options: ServeOptions,
) where
    T: tower::Service<http::Request<Body>, Response = http::Response<B>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    T::Future: Send + 'static,
    B: HttpBody<Data = Bytes> + Send + 'static,
    B::Error: Into<BoxError>,
{
    // Node sets TCP_NODELAY on server sockets by default.
    let _ = stream.set_nodelay(true);
    let handler = hyper::service::service_fn(move |request: http::Request<Incoming>| {
        let deadline = Box::pin(tokio::time::sleep(options.request_timeout));
        let mut request = request.map(|inner| Body::new(DeadlineBody { inner, deadline }));
        request.extensions_mut().insert(PeerAddr(peer));
        service.clone().oneshot(request)
    });
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(options.header_read_timeout)
        .keep_alive(true);
    let connection = builder
        .serve_connection(TokioIo::new(stream), handler)
        .with_upgrades();
    let mut connection = std::pin::pin!(connection);
    tokio::select! {
        _ = connection.as_mut() => {}
        () = shutdown.cancelled() => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
    }
}
