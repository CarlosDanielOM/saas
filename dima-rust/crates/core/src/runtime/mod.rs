//! Shutdown, units of work under a deadline, and supervised long-running tasks.
//!
//! All waiting uses `tokio::time`, so tests run it under tokio's paused clock. Every task has an
//! owner: [`run_with_deadline`] joins its work before returning and aborts it if the caller is
//! dropped first; its work stays registered in the caller's [`WorkRegistry`] until it has really
//! stopped, and the [`Supervisor`] joins that registry before it restarts a task, as it joins its
//! tasks on [`SupervisorHandle::stop`].

pub mod deadline;
pub mod registry;
pub mod shutdown;
pub mod supervisor;

pub use deadline::{Deadline, DeadlineError, WorkScope, run_with_deadline};
pub use registry::WorkRegistry;
pub use shutdown::{
    Shutdown, ShutdownReport, ShutdownStep, StepOutcome, StopSignal, shutdown_in_order, stop_signal,
};
pub use supervisor::{
    Supervisor, SupervisorConfig, SupervisorHandle, SupervisorReport, TaskExit, TaskState,
    TaskStatus, restart_delay_from_env,
};
