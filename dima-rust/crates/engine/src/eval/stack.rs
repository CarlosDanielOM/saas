//! How much of the thread's stack an evaluation uses.
//!
//! The evaluator recurses: each level of the tree polls the level below, on the thread's stack.
//! The nesting limit bounds the levels; how much stack a level takes depends on the build (a
//! debug build uses several times what a release build does). This is the exact guard: every
//! poll of an evaluation records where its stack starts ([`Metered`]), and before going a level
//! deeper the evaluator compares the current position with it ([`StackBase::used`]). Only
//! addresses of locals are read; nothing is dereferenced.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};

/// The stack position where the current poll of an evaluation started (0 before the first poll).
#[derive(Clone, Debug, Default)]
pub(crate) struct StackBase(Arc<AtomicUsize>);

/// The address of a local, as a number (stack positions only, never dereferenced).
fn position(marker: &u8) -> usize {
    std::ptr::from_ref(std::hint::black_box(marker)).addr()
}

impl StackBase {
    fn mark(&self) {
        let marker = 0u8;
        self.0.store(position(&marker), Ordering::Relaxed);
    }

    /// Bytes of stack between the start of this poll and here.
    pub(crate) fn used(&self) -> usize {
        let marker = 0u8;
        match self.0.load(Ordering::Relaxed) {
            0 => 0,
            base => base.abs_diff(position(&marker)),
        }
    }
}

/// Runs `inner`, recording the stack position at the start of every poll. A task can move to
/// another thread between polls, so the position is taken again each time.
pub(crate) struct Metered<F> {
    inner: Pin<Box<F>>,
    base: StackBase,
}

impl<F: Future> Metered<F> {
    pub(crate) fn new(inner: F, base: StackBase) -> Self {
        Self {
            inner: Box::pin(inner),
            base,
        }
    }
}

impl<F: Future> Future for Metered<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        let this = self.get_mut();
        this.base.mark();
        this.inner.as_mut().poll(cx)
    }
}
