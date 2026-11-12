//! The stack contract of parsing and evaluation.
//!
//! The parser and the evaluator recurse: each level of nesting in a command costs a bounded
//! amount of the thread's stack, and the nesting limits ([`crate::syntax::MAX_NESTING`],
//! [`crate::eval::MAX_EVAL_NESTING`], both 32; the deepest stored command has 11) bound
//! the levels. So each needs at most a fixed amount of stack, which `tests/stack_contract.rs`
//! proves in a debug build (where a level costs several times what it costs in a release build)
//! for every recursive path of the grammar and every kind of node, at the limit and one past it.
//!
//! What cannot be known without help is how much stack a thread has left: the engine sees where
//! it is on the stack, not where the stack ends. A thread says how large its stack is with
//! [`register_thread`], first thing after it starts; from then on [`remaining`] is exact up to
//! [`THREAD_RESERVE`], which covers everything above the registration (the thread's start
//! frames, thread-local storage, the guard page). With tokio:
//!
//! ```
//! const STACK: usize = 2 * 1024 * 1024;
//! let runtime = tokio::runtime::Builder::new_multi_thread()
//!     .thread_stack_size(STACK)
//!     .on_thread_start(|| dima_engine::stack::register_thread(STACK))
//!     .build();
//! # drop(runtime);
//! ```
//!
//! The contract:
//!
//! - **Parsing** ([`crate::syntax::SyntaxEngine`], and the engine's `compile` and `parse`) needs
//!   [`PARSE_STACK_BYTES`]. On a thread that is not registered, or has less left, a program is
//!   parsed on a short-lived thread with a stack of [`PARSE_THREAD_STACK_BYTES`] instead, so
//!   parsing works on any thread; on a registered thread with room it costs nothing extra. At
//!   most [`PARSE_THREADS`] such threads run at once; a caller over the cap waits its turn.
//! - **Evaluation** (every entry point of [`crate::eval::Engine`]: `render_message`,
//!   `render_reference`, `evaluate_message`, `evaluate_program_message`, `evaluate_reference`,
//!   `evaluate_timer_message`) needs [`EVAL_STACK_BYTES`] left every time its future is polled. A future
//!   polled with less, or on a thread that is not registered, returns
//!   [`crate::eval::EvalError::Stack`] instead of running: a caller that breaks the contract gets
//!   an error, not a crash. A tokio worker with the default 2 MiB stack, registered, keeps it
//!   with room for the caller's own frames.
//! - Of the evaluation's stack, [`HOST_STACK_BYTES`] are the host's: every future of
//!   [`crate::host::Host`] the evaluator polls, at any depth, may use that much.

use std::cell::Cell;
use std::sync::{Condvar, Mutex, PoisonError};

/// The stack a parse needs: the deepest program (32 levels on the costliest recursive path of
/// the grammar, a loop's header: about 22 KiB a level) measured in a debug build, with room for
/// the frames below the last level (`tests/stack_contract.rs`).
pub const PARSE_STACK_BYTES: usize = 800 * 1024;

/// The stack of the thread a program is parsed on when the caller's thread has too little left.
pub const PARSE_THREAD_STACK_BYTES: usize = PARSE_STACK_BYTES + THREAD_RESERVE + 64 * 1024;

/// The stack an evaluation needs left when its future is polled: the deepest tree (32 levels of
/// every kind of node, a 256-level JSON value read, written and dropped at the bottom, and
/// [`HOST_STACK_BYTES`] for the host there) measured in a debug build, with room to spare
/// (`tests/stack_contract.rs`).
pub const EVAL_STACK_BYTES: usize = 512 * 1024;

/// The stack a host future may use when the evaluator polls it, at any depth.
pub const HOST_STACK_BYTES: usize = 64 * 1024;

/// The part of a registered thread's stack taken as used before [`register_thread`] runs.
pub const THREAD_RESERVE: usize = 64 * 1024;

thread_local! {
    /// Where this thread's registration was, and its stack size (0 when not registered).
    static THREAD: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
}

/// The address of a local, as a number: a stack position, never dereferenced.
fn position(marker: &u8) -> usize {
    std::ptr::from_ref(std::hint::black_box(marker)).addr()
}

/// Declares that the current thread was started with a stack of `stack_size` bytes. Call it
/// first thing on the thread (with tokio, in `on_thread_start`); a later call on the same thread
/// changes nothing. Declaring more than the thread has breaks the contract.
pub fn register_thread(stack_size: usize) {
    let marker = 0u8;
    THREAD.with(|thread| {
        if thread.get().1 == 0 {
            thread.set((position(&marker), stack_size));
        }
    });
}

/// The stack left on the current thread, in bytes, or `None` when the thread is not registered.
pub fn remaining() -> Option<usize> {
    let marker = 0u8;
    let (top, size) = THREAD.with(Cell::get);
    if size == 0 {
        return None;
    }
    let used = top.saturating_sub(position(&marker));
    Some(size.saturating_sub(THREAD_RESERVE).saturating_sub(used))
}

/// Runs `work` on a new thread with a stack of `stack_size` bytes, registered, and returns its
/// result; `None` when no thread could be started. A panic in `work` is resumed on the caller.
pub fn run_on_thread<T: Send>(stack_size: usize, work: impl FnOnce() -> T + Send) -> Option<T> {
    std::thread::scope(|scope| {
        let handle = std::thread::Builder::new()
            .name("dima-engine-stack".into())
            .stack_size(stack_size)
            .spawn_scoped(scope, move || {
                register_thread(stack_size);
                work()
            })
            .ok()?;
        match handle.join() {
            Ok(value) => Some(value),
            Err(payload) => std::panic::resume_unwind(payload),
        }
    })
}

/// How many parses may run on their own thread at once ([`crate::syntax::SyntaxEngine`] on a
/// thread that is not registered, or has too little stack left): four, about 3.7 MiB of
/// parse stacks at most. A caller over the cap waits its turn: every parse is bounded by its
/// own work budget, so a turn always comes.
pub const PARSE_THREADS: usize = 4;

/// The parse threads in flight, and the signal that one ended.
static PARSE_SLOTS: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

/// One of the [`PARSE_THREADS`] places, given back when dropped (a panic in the parse
/// included).
struct ParseSlot;

impl ParseSlot {
    fn take() -> Self {
        let (busy, freed) = &PARSE_SLOTS;
        let mut busy = busy.lock().unwrap_or_else(PoisonError::into_inner);
        while *busy >= PARSE_THREADS {
            busy = freed.wait(busy).unwrap_or_else(PoisonError::into_inner);
        }
        *busy += 1;
        Self
    }
}

impl Drop for ParseSlot {
    fn drop(&mut self) {
        let (busy, freed) = &PARSE_SLOTS;
        let mut busy = busy.lock().unwrap_or_else(PoisonError::into_inner);
        *busy = busy.saturating_sub(1);
        drop(busy);
        freed.notify_one();
    }
}

/// Runs a parse on its own short-lived thread with a stack of [`PARSE_THREAD_STACK_BYTES`],
/// at most [`PARSE_THREADS`] at once: a caller over the cap blocks until one ends. Waiting,
/// not a "busy" error: every parse is bounded by its own work budget (derived from its
/// length, [`crate::syntax::WORK_PER_INPUT_BYTE`]), so a turn always comes, and the waiting
/// thread is the caller's own, which exists already; an error would show a valid command as
/// `[Parse error: …]` in chat whenever a burst arrived. A parse never waits for a slot from
/// inside a parse thread, so the wait cannot deadlock.
pub(crate) fn run_on_parse_thread<T: Send>(work: impl FnOnce() -> T + Send) -> Option<T> {
    let _slot = ParseSlot::take();
    run_on_thread(PARSE_THREAD_STACK_BYTES, work)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_threads_are_capped() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let current = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let finished = AtomicUsize::new(0);
        let callers = 4 * PARSE_THREADS;
        std::thread::scope(|scope| {
            for _ in 0..callers {
                scope.spawn(|| {
                    let done = run_on_parse_thread(|| {
                        let now = current.fetch_add(1, SeqCst) + 1;
                        peak.fetch_max(now, SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(30));
                        current.fetch_sub(1, SeqCst);
                    });
                    if done.is_some() {
                        finished.fetch_add(1, SeqCst);
                    }
                });
            }
        });
        // Every caller got its parse; never more than the cap ran at once.
        assert_eq!(finished.load(SeqCst), callers);
        let peak = peak.load(SeqCst);
        assert!(
            (1..=PARSE_THREADS).contains(&peak),
            "{peak} parse threads at once"
        );
    }

    #[test]
    fn a_burst_of_parses_on_unregistered_threads_all_complete() {
        let engine = crate::syntax::SyntaxEngine::default();
        let deep = format!("{}a{}", "$(upper ".repeat(20), ")".repeat(20));
        std::thread::scope(|scope| {
            let parses: Vec<_> = (0..4 * PARSE_THREADS)
                .map(|_| scope.spawn(|| engine.parse(&deep).is_ok()))
                .collect();
            for parse in parses {
                assert!(parse.join().unwrap_or(false));
            }
        });
    }

    #[test]
    fn a_registered_thread_knows_what_is_left() {
        let size = 1024 * 1024;
        let left = run_on_thread(size, || {
            let at_start = remaining().unwrap_or(0);
            // A frame with a large local uses at least that much more.
            fn deeper() -> usize {
                let pad = [0u8; 64 * 1024];
                std::hint::black_box(&pad);
                remaining().unwrap_or(0)
            }
            (at_start, deeper())
        });
        let (at_start, deeper) = left.unwrap_or_default();
        assert!(at_start <= size - THREAD_RESERVE && at_start > size / 2);
        assert!(deeper + 64 * 1024 <= at_start);
        // The test harness's thread is not registered.
        assert_eq!(remaining(), None);
    }
}
