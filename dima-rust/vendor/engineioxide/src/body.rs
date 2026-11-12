//! Response Body wrapper in order to return a custom body or the body from the inner service

use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use http_body_util::Full;
use pin_project_lite::pin_project;
use std::pin::Pin;
use std::task::{Context, Poll};

pin_project! {
    #[project = BodyProj]
    pub enum ResponseBody<B> {
        EmptyResponse,
        CustomBody {
            #[pin]
            body: Full<Bytes>,
        },
        // [dima-rust patch 7] A polling payload: its messages are done when the body is dropped.
        Payload {
            #[pin]
            body: Full<Bytes>,
            done: MessagesDone,
        },
        Body {
            #[pin]
            body: B,
        },
    }
}
impl<B> Default for ResponseBody<B> {
    fn default() -> Self {
        Self::empty_response()
    }
}
impl<B> ResponseBody<B> {
    pub fn empty_response() -> Self {
        ResponseBody::EmptyResponse
    }

    pub fn custom_response(body: Full<Bytes>) -> Self {
        ResponseBody::CustomBody { body }
    }

    pub fn new(body: B) -> Self {
        ResponseBody::Body { body }
    }

    /// [dima-rust patch 7]
    pub(crate) fn payload(body: Full<Bytes>, done: MessagesDone) -> Self {
        ResponseBody::Payload { body, done }
    }
}

/// [dima-rust patch 7] Counts `count` messages of a socket as done when dropped.
pub struct MessagesDone {
    done: std::sync::Arc<tokio::sync::watch::Sender<u64>>,
    count: u64,
}

impl MessagesDone {
    pub(crate) fn new(done: std::sync::Arc<tokio::sync::watch::Sender<u64>>, count: u64) -> Self {
        Self { done, count }
    }
}

impl Drop for MessagesDone {
    fn drop(&mut self) {
        crate::socket::add_done(&self.done, self.count);
    }
}

impl<B> Body for ResponseBody<B>
where
    B: Body<Data = Bytes>,
    B::Error: std::error::Error + 'static,
{
    type Data = B::Data;

    type Error = B::Error;

    fn is_end_stream(&self) -> bool {
        match &self {
            ResponseBody::EmptyResponse => true,
            ResponseBody::Body { body } => body.is_end_stream(),
            ResponseBody::CustomBody { body } => body.is_end_stream(),
            ResponseBody::Payload { body, .. } => body.is_end_stream(),
        }
    }

    fn size_hint(&self) -> SizeHint {
        match &self {
            ResponseBody::EmptyResponse => {
                let mut hint = SizeHint::default();
                hint.set_upper(0);
                hint
            }
            ResponseBody::Body { body } => body.size_hint(),
            ResponseBody::CustomBody { body } => body.size_hint(),
            ResponseBody::Payload { body, .. } => body.size_hint(),
        }
    }

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.project() {
            BodyProj::EmptyResponse => Poll::Ready(None),
            BodyProj::Body { body } => body.poll_frame(cx),
            BodyProj::CustomBody { body } => body.poll_frame(cx).map_err(|err| match err {}),
            BodyProj::Payload { body, .. } => body.poll_frame(cx).map_err(|err| match err {}),
        }
    }
}
