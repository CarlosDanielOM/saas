//! A thread with a stack sized for deep programs.
//!
//! The parser recurses once per level of nesting. Up to [`HARD_NESTING_CEILING`] levels it runs
//! on the caller's stack (any thread, a tokio worker's 2 MiB included); a deeper program is
//! parsed on a short-lived thread whose stack fits [`Limits::nesting`](super::Limits::nesting).
//! The stack is reserved address space: only the pages a parse touches are ever committed.

use super::HARD_NESTING_CEILING;

/// Stack per level of nesting: twice the most any shape needed when measured at
/// [`MAX_NESTING`](super::MAX_NESTING) levels (arrays in arrays: under 2 KiB per level in a
/// release build, under 16 KiB in a debug build; parentheses, assignments, calls, ternaries,
/// unary operators, selectors, templates and loops need less). Release: 64 MiB of address space
/// for the deepest program; debug: 512 MiB.
const BYTES_PER_LEVEL: usize = if cfg!(debug_assertions) {
    32 * 1024
} else {
    4 * 1024
};

/// Room for the frames below the first level.
const BASE_BYTES: usize = 1 << 20;

/// Runs `work` on a thread with a stack for `nesting` levels and returns its result, or `None`
/// when no such thread could be started. A panic in `work` is resumed on the caller.
pub(crate) fn run<T: Send>(nesting: usize, work: impl FnOnce() -> T + Send) -> Option<T> {
    let levels = nesting.max(HARD_NESTING_CEILING);
    let size = levels
        .saturating_mul(BYTES_PER_LEVEL)
        .saturating_add(BASE_BYTES);
    std::thread::scope(|scope| {
        let handle = std::thread::Builder::new()
            .name("dima-syntax-deep".into())
            .stack_size(size)
            .spawn_scoped(scope, work)
            .ok()?;
        match handle.join() {
            Ok(value) => Some(value),
            Err(payload) => std::panic::resume_unwind(payload),
        }
    })
}
