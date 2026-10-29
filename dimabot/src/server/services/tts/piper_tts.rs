//! Piper's concrete HTTP and Python CLI adapters.
//!
//! The deadline covers both HTTP headers and body. CLI ownership lives in a
//! small task so dropping the caller's future still terminates the process
//! group and reaps the direct child. Grandchildren are terminated with that
//! group; their eventual reaping belongs to the host's init, not a process-wide
//! SIGCHLD handler or subreaper installed by this library.
use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use reqwest::Client;
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::oneshot,
    task::JoinHandle,
};

use super::{
    http_support::{abort_reason, cancellation, new_client, read_audio, transport_error},
    speech_paths::{SpeechPaths, node_join},
    tts_provider::{Environment, TtsSynthesisRequest, TtsSynthesisResult},
};
use crate::utils::{js_compat, js_string::JsString};

pub const PIPER_TIMEOUT: Duration = Duration::from_secs(30);
const TIMEOUT_MESSAGE: &str = "Piper TTS timed out";
// This is an orderly shutdown grace, never a synthesis/polling cadence.
const TERMINATION_GRACE: Duration = Duration::from_millis(100);
const STDERR_UNITS: usize = 4096;
const MAX_ERROR_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct PiperConfig {
    pub paths: SpeechPaths,
    pub python_bin: PathBuf,
    pub data_dir: Option<String>,
    pub http_url: Option<String>,
    pub timeout: Duration,
}

impl std::fmt::Debug for PiperConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PiperConfig")
            .field("paths", &self.paths)
            .field("python_bin", &"[REDACTED]")
            .field("data_dir", &self.data_dir.as_ref().map(|_| "[REDACTED]"))
            .field("http_url", &self.http_url.as_ref().map(|_| "[REDACTED]"))
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl PiperConfig {
    pub fn new(paths: SpeechPaths) -> Self {
        Self {
            paths,
            python_bin: PathBuf::from("python3"),
            data_dir: None,
            http_url: None,
            timeout: PIPER_TIMEOUT,
        }
    }

    fn http_url(&self) -> Option<&str> {
        self.http_url
            .as_deref()
            .filter(|url| !js_compat::trim(url).is_empty())
            // Deliberately do not trim nonempty URLs, matching the source.
            .map(|url| url.trim_end_matches('/'))
    }
}

#[derive(Clone)]
pub struct PiperTtsService {
    client: Client,
    pub config: PiperConfig,
    environment: Option<Environment>,
}

impl PiperTtsService {
    pub fn new(config: PiperConfig) -> Self {
        Self::with_client(config, new_client())
    }

    /// An injected client owns its redirect, proxy, TLS and pooling policy.
    pub fn with_client(config: PiperConfig, client: Client) -> Self {
        Self {
            client,
            config,
            environment: None,
        }
    }

    /// Keep HTTP selection after output-directory I/O, and defer CLI-only
    /// configuration until that branch starts. Explicit configurations keep
    /// working without an application environment adapter.
    pub fn with_environment(mut self, environment: Environment) -> Self {
        self.environment = Some(environment);
        self
    }

    pub fn name(&self) -> &'static str {
        "piper"
    }

    pub async fn synthesize(&self, request: &TtsSynthesisRequest) -> TtsSynthesisResult {
        if let Some(reason) = abort_reason(&request.signal) {
            return TtsSynthesisResult::failure(reason);
        }
        let output_dir = if request.private_output {
            request
                .output_path
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf()
        } else {
            self.config.paths.output_dir(&request.channel_id)
        };
        if let Err(error) = tokio::fs::create_dir_all(&output_dir).await {
            return TtsSynthesisResult::failure(file_error(error, "mkdir", &output_dir));
        }
        let output_path = if request.private_output {
            request.output_path.clone()
        } else {
            node_join(&output_dir, &format!("{}.wav", request.speech_id))
        };
        // Cancellation during directory creation must not start a provider.
        if let Some(reason) = abort_reason(&request.signal) {
            return TtsSynthesisResult::failure(reason);
        }
        let mut http_config = self.config.clone();
        if let Some(environment) = &self.environment {
            http_config.http_url = environment("PIPER_HTTP_URL");
        }
        // A slash-only configured URL normalizes to the empty string and is
        // false in the source. Whitespace left before those slashes is truthy.
        let result = if let Some(url) = http_config.http_url().filter(|url| !url.is_empty()) {
            self.run_http(request, &output_path, url).await
        } else {
            self.run_cli(request, &output_path).await
        };
        match result {
            Ok(backend) => TtsSynthesisResult {
                error: false,
                message: format!("Speech synthesized with Piper {backend}"),
                output_path: Some(output_path),
                public_path: (!request.private_output).then(|| {
                    self.config
                        .paths
                        .public_path(&request.channel_id, &request.speech_id)
                }),
                // Piper does not validate the HTTP MIME type or reject empties.
                mime_type: Some("audio/wav"),
            },
            Err(message) => TtsSynthesisResult::failure(message),
        }
    }

    async fn run_http(
        &self,
        request: &TtsSynthesisRequest,
        output_path: &Path,
        base_url: &str,
    ) -> Result<&'static str, String> {
        let mut signal = request.signal.clone();
        let audio = tokio::select! {
            biased;
            _ = cancellation(&mut signal) => {
                return Err(abort_reason(&request.signal).unwrap_or_else(|| "Piper TTS cancelled".into()));
            },
            result = tokio::time::timeout(self.config.timeout, self.http_audio(request, base_url)) => {
                result.map_err(|_| TIMEOUT_MESSAGE.to_owned())??
            },
        };
        tokio::fs::write(output_path, audio)
            .await
            .map_err(|error| file_error(error, "open", output_path))?;
        Ok("HTTP")
    }

    async fn http_audio(
        &self,
        request: &TtsSynthesisRequest,
        base_url: &str,
    ) -> Result<Vec<u8>, String> {
        let body = format!(
            "{{\"text\":{},\"voice\":{}}}",
            request.text.to_json_string(),
            request.voice.to_json_string(),
        );
        let mut response = self
            .client
            .post(format!("{base_url}/synthesize"))
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = if request.private_output {
                // Dropping cancels the body without waiting for provider text.
                String::new()
            } else {
                let bytes = read_audio(&mut response, Some(MAX_ERROR_BODY_BYTES))
                    .await
                    .map_err(|error| {
                        if error == "TTS audio exceeds byte limit" {
                            "Piper HTTP error response exceeds byte limit".to_owned()
                        } else {
                            error
                        }
                    })?;
                let text = String::from_utf8_lossy(&bytes);
                text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
            };
            return Err(if body.is_empty() {
                format!("Piper HTTP synthesis failed with {status}")
            } else {
                body
            });
        }
        read_audio(&mut response, request.max_audio_bytes).await
    }

    async fn run_cli(
        &self,
        request: &TtsSynthesisRequest,
        output_path: &Path,
    ) -> Result<&'static str, String> {
        let mut request = request.clone();
        request.output_path = output_path.to_owned();
        let mut config = self.config.clone();
        if let Some(environment) = &self.environment {
            config.data_dir = environment("PIPER_DATA_DIR");
            config.python_bin = environment("PIPER_PYTHON_BIN")
                .filter(|bin| !bin.is_empty())
                .unwrap_or_else(|| "python3".into())
                .into();
        }
        let (mut sender, receiver) = oneshot::channel();
        // The owner detects receiver closure when the synthesize future is
        // abandoned; it remains alive long enough to kill and reap the child.
        tokio::spawn(async move {
            let result = cli_owned(&config, &request, &mut sender).await;
            let _ = sender.send(result);
        });
        receiver
            .await
            .unwrap_or_else(|_| Err("Piper CLI owner stopped unexpectedly".into()))?;
        Ok("CLI")
    }
}

async fn cli_owned(
    config: &PiperConfig,
    request: &TtsSynthesisRequest,
    sender: &mut oneshot::Sender<Result<(), String>>,
) -> Result<(), String> {
    if let Some(reason) = abort_reason(&request.signal) {
        return Err(reason);
    }
    if sender.is_closed() {
        return Err("Piper TTS cancelled".into());
    }
    let python = if config.python_bin.as_os_str().is_empty() {
        Path::new("python3")
    } else {
        &config.python_bin
    };
    let mut command = Command::new(python);
    command
        .args(["-m", "piper", "-m"])
        .arg(request.voice.to_utf8_lossy())
        .arg("-f")
        .arg(&request.output_path);
    if let Some(dir) = config
        .data_dir
        .as_deref()
        .map(js_compat::trim)
        .filter(|dir| !dir.is_empty())
    {
        command.args(["--data-dir", dir]);
    }
    command
        .arg("--")
        .arg(request.text.to_utf8_lossy())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to start Piper CLI: spawn {} {}",
            python.display(),
            os_code(&error)
        )
    })?;
    let mut group = ProcessGroup::new(&child);
    let stderr = child.stderr.take().expect("Piper stderr is piped");
    let mut stderr = StderrTask(tokio::spawn(stderr_tail(stderr)));
    let mut signal = request.signal.clone();
    let status = tokio::select! {
        biased;
        _ = cancellation(&mut signal) => {
            Err(abort_reason(&request.signal).unwrap_or_else(|| "Piper TTS cancelled".into()))
        },
        _ = sender.closed() => Err("Piper TTS cancelled".into()),
        result = tokio::time::timeout(config.timeout, child.wait()) => {
            match result {
                Err(_) => Err(TIMEOUT_MESSAGE.to_owned()),
                Ok(result) => result.map_err(|error| format!("Piper CLI wait failed: {}", os_code(&error))),
            }
        },
    };
    // A timeout must not use `?` before cleanup. The select's deadline error is
    // handled below together with caller cancellation and normal exit.
    finish_child(&mut child, &mut group, status.is_err()).await;
    let tail = match tokio::time::timeout(TERMINATION_GRACE, &mut stderr.0).await {
        Ok(Ok(tail)) => tail,
        Ok(Err(_)) => Vec::new(),
        Err(_) => {
            stderr.0.abort();
            let _ = (&mut stderr.0).await;
            Vec::new()
        }
    };
    let status = status?;
    if !status.success() {
        let tail = JsString::from_units(tail).trim().to_utf8_lossy();
        return Err(if tail.is_empty() {
            format!(
                "Piper CLI exited with code {}",
                status
                    .code()
                    .map_or_else(|| "null".into(), |code| code.to_string())
            )
        } else {
            tail
        });
    }
    // Source truthiness: a CLI maxAudioBytes of zero disables this check.
    if let Some(max) = request.max_audio_bytes.filter(|max| *max != 0) {
        let size = tokio::fs::metadata(&request.output_path)
            .await
            .map_err(|error| file_error(error, "stat", &request.output_path))?
            .len();
        if size > max as u64 {
            match tokio::fs::remove_file(&request.output_path).await {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(file_error(error, "unlink", &request.output_path)),
            }
            return Err("Piper audio exceeds byte limit".into());
        }
    }
    Ok(())
}

async fn stderr_tail(mut stderr: tokio::process::ChildStderr) -> Vec<u16> {
    let mut tail = Vec::with_capacity(STDERR_UNITS);
    let mut buffer = [0u8; 8192];
    loop {
        let length = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(length) => length,
        };
        // Node String(Buffer) replaces malformed UTF-8 separately per chunk.
        tail.extend(String::from_utf8_lossy(&buffer[..length]).encode_utf16());
        if tail.len() > STDERR_UNITS {
            tail.drain(..tail.len() - STDERR_UNITS);
        }
    }
    tail
}

struct StderrTask(JoinHandle<Vec<u16>>);
impl Drop for StderrTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct ProcessGroup {
    pid: Option<u32>,
}
impl ProcessGroup {
    fn new(child: &Child) -> Self {
        Self { pid: child.id() }
    }
    fn signal(&self, signal: i32) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // SAFETY: this is the dedicated group created for our own child.
            // Negative PID targets its descendants too, never the host group.
            unsafe { libc::kill(-(pid as libc::pid_t), signal) };
        }
        #[cfg(not(unix))]
        let _ = signal;
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
    }
}

async fn finish_child(child: &mut Child, group: &mut ProcessGroup, interrupted: bool) {
    if interrupted {
        #[cfg(unix)]
        group.signal(libc::SIGTERM);
        #[cfg(not(unix))]
        let _ = child.start_kill();
        // Only an interrupted live process receives this bounded grace.
        if tokio::time::timeout(TERMINATION_GRACE, child.wait())
            .await
            .is_err()
        {
            #[cfg(unix)]
            group.signal(libc::SIGKILL);
            let _ = child.start_kill();
        }
    }
    // Also clean up descendants left behind by an otherwise successful root.
    #[cfg(unix)]
    group.signal(libc::SIGKILL);
    let _ = child.wait().await;
    // Do not keep an old PGID armed after its owned processes were terminated.
    group.pid = None;
}

fn os_code(error: &io::Error) -> String {
    match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT".into(),
        Some(libc::EACCES) => "EACCES".into(),
        Some(libc::ENOEXEC) => "ENOEXEC".into(),
        Some(libc::ENOTDIR) => "ENOTDIR".into(),
        Some(libc::EISDIR) => "EISDIR".into(),
        Some(libc::EEXIST) => "EEXIST".into(),
        Some(libc::ENOSPC) => "ENOSPC".into(),
        Some(libc::EROFS) => "EROFS".into(),
        Some(libc::EINVAL) => "EINVAL".into(),
        Some(code) => format!("OS error {code}"),
        None if error.kind() == io::ErrorKind::InvalidInput => "EINVAL".into(),
        None => error.to_string(),
    }
}

fn file_error(error: io::Error, operation: &str, path: &Path) -> String {
    let description = match error.raw_os_error() {
        Some(libc::ENOENT) => "no such file or directory",
        Some(libc::EACCES) => "permission denied",
        Some(libc::ENOTDIR) => "not a directory",
        Some(libc::EISDIR) => "illegal operation on a directory",
        Some(libc::EEXIST) => "file already exists",
        Some(libc::ENOSPC) => "no space left on device",
        Some(libc::EROFS) => "read-only file system",
        _ => return format!("{}: {operation} '{}'", os_code(&error), path.display()),
    };
    format!(
        "{}: {description}, {operation} '{}'",
        os_code(&error),
        path.display()
    )
}
