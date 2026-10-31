//! Native `console.error` developer diagnostics.
//!
//! Ports `src/utils/notifications.ts`. The source is deliberately a console
//! placeholder for a future Discord webhook (`TODO: Configure Discord webhook
//! URL in .env`); it performs no network call and no external notification.
//! This port keeps exactly that contract: one formatted line per call, written
//! to stderr (`console.error`) through an injectable console boundary.
//!
//! There is intentionally no webhook, HTTP client, queue, retry or Discord
//! adapter here. A future notifier that really delivers messages is a separate
//! dependency with its own configuration and delivery review; adding one must
//! not change the source-visible `[DEV NOTIFICATION - ...]` line.

use std::{
    fmt,
    io::{self, Write},
    sync::Arc,
};

pub const NOTIFICATION_PREFIX: &str = "[DEV NOTIFICATION - ";

/// The source union `'error' | 'warning' | 'info'`, upper-cased in the output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DeveloperSeverity {
    Error,
    Warning,
    Info,
}
impl DeveloperSeverity {
    /// Exact `severity.toUpperCase()` result used in the log line.
    pub const fn as_label(self) -> &'static str {
        match self {
            Self::Error => "ERROR",
            Self::Warning => "WARNING",
            Self::Info => "INFO",
        }
    }
}
impl fmt::Display for DeveloperSeverity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_label())
    }
}

/// `[DEV NOTIFICATION - ERROR]: message`, byte-for-byte the source template.
pub fn format_developer_notification(severity: DeveloperSeverity, message: &str) -> String {
    format!("{NOTIFICATION_PREFIX}{}]: {message}", severity.as_label())
}

/// Injectable `console.error` boundary. Implementations must not block on the
/// network; the source sink is stderr.
pub trait DeveloperConsole: Send + Sync {
    fn write_error(&self, line: &str);
}

/// The real source sink: `console.error(line)` writes to stderr.
///
/// Node's default `console.error` does not throw when the stderr stream is
/// closed or fails: the write error is ignored. This sink matches that by
/// taking the stderr lock and ignoring the `writeln!` result, so a broken pipe
/// cannot panic a notification path that is only a diagnostic placeholder.
#[derive(Debug, Default, Clone, Copy)]
pub struct StderrDeveloperConsole;
impl DeveloperConsole for StderrDeveloperConsole {
    fn write_error(&self, line: &str) {
        let _ = writeln!(io::stderr().lock(), "{line}");
    }
}

/// Concrete port of `notifyDevelopers`. Cloning shares the console boundary.
#[derive(Clone)]
pub struct DeveloperNotifier {
    console: Arc<dyn DeveloperConsole>,
}
impl Default for DeveloperNotifier {
    fn default() -> Self {
        Self::new()
    }
}
impl fmt::Debug for DeveloperNotifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DeveloperNotifier(<console>)")
    }
}
impl DeveloperNotifier {
    /// Stderr sink; construction performs no I/O and reads no configuration.
    pub fn new() -> Self {
        Self::with_console(Arc::new(StderrDeveloperConsole))
    }
    /// Replace the console boundary, for example with a test recorder.
    pub fn with_console(console: Arc<dyn DeveloperConsole>) -> Self {
        Self { console }
    }
    /// Source order: format, then write one line. Never panics on sink failure
    /// because the sink owns its own error handling.
    pub async fn notify(&self, message: &str, severity: DeveloperSeverity) {
        let line = format_developer_notification(severity, message);
        self.console.write_error(&line);
    }
}

/// Free-function port for call sites that need no injected console.
pub async fn notify_developers(message: &str, severity: DeveloperSeverity) {
    DeveloperNotifier::new().notify(message, severity).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);
    impl DeveloperConsole for Recorder {
        fn write_error(&self, line: &str) {
            self.0.lock().unwrap().push(line.to_owned());
        }
    }

    #[test]
    fn formats_every_source_severity() {
        assert_eq!(
            format_developer_notification(DeveloperSeverity::Error, "broken"),
            "[DEV NOTIFICATION - ERROR]: broken"
        );
        assert_eq!(
            format_developer_notification(DeveloperSeverity::Warning, "careful"),
            "[DEV NOTIFICATION - WARNING]: careful"
        );
        assert_eq!(
            format_developer_notification(DeveloperSeverity::Info, "fyi"),
            "[DEV NOTIFICATION - INFO]: fyi"
        );
    }

    #[tokio::test]
    async fn writes_one_line_per_call() {
        let recorder = Arc::new(Recorder::default());
        let notifier = DeveloperNotifier::with_console(recorder.clone());
        notifier
            .notify(
                "Bot does not have valid authentication.",
                DeveloperSeverity::Error,
            )
            .await;
        notifier.notify("plain", DeveloperSeverity::Info).await;
        let lines = recorder.0.lock().unwrap().clone();
        assert_eq!(
            lines,
            vec![
                "[DEV NOTIFICATION - ERROR]: Bot does not have valid authentication.".to_owned(),
                "[DEV NOTIFICATION - INFO]: plain".to_owned()
            ]
        );
    }
}
