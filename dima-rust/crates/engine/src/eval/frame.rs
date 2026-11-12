//! Which changes survive: the reference's context objects, reduced to what is observable.
//!
//! The reference threads one `ExecutionContext` through `evaluate`, but loops and timers work
//! on spread copies (`{...context}`), and three callers ignore the context their child
//! returns (a list index read by `%(list[i])`, and everything `%del(…)` evaluates). Shared
//! state (variables, responses, references, the budget) lives in maps every copy shares, so
//! it always survives; the per-object scalars (`count`, `countModified`, `loopExit`,
//! `loopDepth`, the effect authority) survive only on the object the caller keeps.
//!
//! [`Frames`] reproduces that without copying objects: the scalars live once, a *switch*
//! records that the reference moved to a new object, and a *watch* around a child that the
//! reference evaluates on an object it then keeps restores the scalars that object had when
//! the child moved away from it. Loop variables are handled by the loops themselves (they
//! restore their outer map on exit, as the reference does).

use crate::context::{Effect, LoopExit};
use crate::map::OrderedMap;

/// The per-object scalars.
#[derive(Clone, Debug)]
pub(crate) struct Scalars {
    pub(crate) count: f64,
    pub(crate) count_modified: bool,
    pub(crate) loop_exit: Option<LoopExit>,
    pub(crate) loop_depth: u32,
    pub(crate) effect: Option<Effect>,
}

struct Watcher {
    object: u32,
    saved: Option<Scalars>,
}

/// The current object's scalars and loop variables, plus the watches in progress.
pub(crate) struct Frames {
    pub(crate) scalars: Scalars,
    pub(crate) loop_vars: OrderedMap<String, String>,
    object: u32,
    next_object: u32,
    watchers: Vec<Watcher>,
}

/// A watch in progress (its position on the stack).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Watch(usize);

impl Frames {
    pub(crate) fn new(scalars: Scalars, loop_vars: OrderedMap<String, String>) -> Self {
        Self {
            scalars,
            loop_vars,
            object: 0,
            next_object: 0,
            watchers: Vec::new(),
        }
    }

    /// The reference continues on a new copy of the current object.
    pub(crate) fn switch(&mut self) {
        let current = self.object;
        for watcher in self.watchers.iter_mut().filter(|w| w.object == current) {
            watcher.saved = Some(self.scalars.clone());
        }
        self.next_object = self.next_object.wrapping_add(1);
        self.object = self.next_object;
    }

    /// Starts evaluating a child whose returned context the reference discards.
    pub(crate) fn watch(&mut self) -> Watch {
        self.watchers.push(Watcher {
            object: self.object,
            saved: None,
        });
        Watch(self.watchers.len() - 1)
    }

    /// Back on the watched object, with the scalars it had when the child left it.
    pub(crate) fn unwatch(&mut self, watch: Watch) {
        self.watchers.truncate(watch.0 + 1);
        if let Some(watcher) = self.watchers.pop()
            && watcher.object != self.object
        {
            if let Some(saved) = watcher.saved {
                self.scalars = saved;
            }
            self.object = watcher.object;
        }
    }

    /// Drops watches opened by a child that failed (before a caught error).
    pub(crate) fn abandon_from(&mut self, depth: usize) {
        self.watchers.truncate(depth);
    }

    /// How many watches are open.
    pub(crate) fn watch_depth(&self) -> usize {
        self.watchers.len()
    }

    /// The current object (to go back to an object the reference kept, e.g. an empty loop body).
    pub(crate) fn object(&self) -> u32 {
        self.object
    }

    /// Continues on `object` without restoring anything (its scalars are the current ones).
    pub(crate) fn resume(&mut self, object: u32) {
        self.object = object;
    }
}
