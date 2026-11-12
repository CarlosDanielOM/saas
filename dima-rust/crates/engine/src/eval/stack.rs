//! The evaluation side of the stack contract ([`crate::stack`]): every poll of an evaluation
//! starts with [`EVAL_STACK_BYTES`] left, or the evaluation stops with [`EvalError::Stack`]
//! instead of running.

use super::EvalError;
use crate::stack::{EVAL_STACK_BYTES, remaining};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

/// Runs `inner`, checking the stack left at the start of every poll (a task can move to another
/// thread between polls).
pub(crate) struct Guarded<F> {
    inner: Pin<Box<F>>,
}

impl<F> Guarded<F> {
    pub(crate) fn new(inner: F) -> Self {
        Self {
            inner: Box::pin(inner),
        }
    }
}

impl<T, F: Future<Output = Result<T, EvalError>>> Future for Guarded<F> {
    type Output = Result<T, EvalError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if remaining().is_none_or(|room| room < EVAL_STACK_BYTES) {
            return Poll::Ready(Err(EvalError::Stack));
        }
        self.get_mut().inner.as_mut().poll(cx)
    }
}
