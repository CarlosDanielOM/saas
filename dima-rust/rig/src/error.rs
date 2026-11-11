//! Errors of the rig itself (not differences between sides).

#[derive(Debug, thiserror::Error)]
pub enum RigError {
    /// A target, scenario or option is invalid. The message says where and how to fix it.
    #[error("{0}")]
    Config(String),
    /// MongoDB or Dragonfly refused or failed.
    #[error("{0}")]
    Store(String),
    #[error("{0}")]
    Io(String),
    #[error("interrupted")]
    Interrupted,
}

pub type Result<T> = std::result::Result<T, RigError>;

pub fn config(msg: impl Into<String>) -> RigError {
    RigError::Config(msg.into())
}

pub fn store(what: &str, e: impl std::fmt::Display) -> RigError {
    RigError::Store(format!("{what}: {e}"))
}

pub fn io(what: &str, e: impl std::fmt::Display) -> RigError {
    RigError::Io(format!("{what}: {e}"))
}
