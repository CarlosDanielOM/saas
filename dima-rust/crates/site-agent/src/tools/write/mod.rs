//! The agent's write tools, with approvals. One submodule per TypeScript file: P4-SA-WRITE-A fills
//! `commands` and `repeat`, P4-SA-WRITE-B `timers` and part of `settings`, at the same time (wave
//! 3). Packages **P4-SA-WRITE-A**, **P4-SA-WRITE-B** fill this module (each its own files); it is
//! empty until then.

pub mod commands;
pub mod repeat;
pub mod settings;
pub mod timers;
