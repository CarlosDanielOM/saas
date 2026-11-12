//! The agent's tools. One submodule per TypeScript file, so that the two packages that fill them,
//! at the same time (wave 2), never edit the same file. Packages **P4-SA-TOOLS-A**,
//! **P4-SA-TOOLS-B** fill this module (each its own files); it is empty until then.
//!
//! P4-SA-TOOLS-A: `effects`, `knowledge`, `read`, `ui`, `util`. P4-SA-TOOLS-B: `registry`,
//! `settings_read`, `stream`. The write tools are `write` (wave 3).

pub mod effects;
pub mod knowledge;
pub mod read;
pub mod registry;
pub mod settings_read;
pub mod stream;
pub mod ui;
pub mod util;
pub mod write;
