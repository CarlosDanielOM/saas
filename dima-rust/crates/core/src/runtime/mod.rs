//! Shutdown, units of work under a deadline, and supervised long-running tasks.
//!
//! All waiting uses `tokio::time`, so tests run it under tokio's paused clock. Every task has an
//! owner: [`run_with_deadline`] joins its work before returning, and the [`Supervisor`] joins its
//! tasks on [`SupervisorHandle::stop`].

pub mod deadline;
pub mod shutdown;
pub mod supervisor;

pub use deadline::{Deadline, DeadlineError, WorkScope, run_with_deadline};
pub use shutdown::{
    Shutdown, ShutdownReport, ShutdownStep, StepOutcome, StopSignal, shutdown_in_order, stop_signal,
};
pub use supervisor::{
    Supervisor, SupervisorConfig, SupervisorHandle, SupervisorReport, TaskExit, TaskState,
    TaskStatus, restart_delay_from_env,
};
