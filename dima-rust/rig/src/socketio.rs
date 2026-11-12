//! Owned JSON-lines connection to the real JavaScript clients. No Socket.IO wire code here.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Open {
        client: String,
        namespace: String,
        version: String,
        transports: Vec<String>,
        auth: Value,
        #[serde(default)]
        port: Option<String>,
        timeout_ms: u64,
    },
    Emit {
        client: String,
        event: String,
        args: Vec<Value>,
        #[serde(default)]
        ack: bool,
        timeout_ms: u64,
    },
    Wait {
        client: String,
        count: usize,
        timeout_ms: u64,
    },
    Quiet {
        client: String,
        timeout_ms: u64,
    },
    Disconnect {
        client: String,
        #[serde(default)]
        transport: bool,
        timeout_ms: u64,
    },
    Reconnect {
        client: String,
        timeout_ms: u64,
    },
}
impl Action {
    pub fn validate(&self) -> Result<(), String> {
        if self.timeout_ms() == 0 || self.timeout_ms() > 600_000 {
            return Err("timeout_ms must be 1..600000".into());
        }
        if let Self::Open {
            namespace,
            version,
            transports,
            ..
        } = self
        {
            if !namespace.starts_with('/') || namespace.contains(['?', '#']) {
                return Err("namespace must start with / and contain no query or fragment".into());
            }
            if !["4.8.3", "4.7.5"].contains(&version.as_str()) {
                return Err("version must be 4.8.3 or 4.7.5".into());
            }
            if transports.is_empty()
                || transports
                    .iter()
                    .any(|t| !["polling", "websocket"].contains(&t.as_str()))
            {
                return Err("transports must contain polling and/or websocket".into());
            }
        }
        if let Self::Wait { count, .. } = self
            && (*count == 0 || *count > 4096)
        {
            return Err("count must be 1..4096".into());
        }
        Ok(())
    }
    pub fn timeout_ms(&self) -> u64 {
        match self {
            Self::Open { timeout_ms, .. }
            | Self::Emit { timeout_ms, .. }
            | Self::Wait { timeout_ms, .. }
            | Self::Quiet { timeout_ms, .. }
            | Self::Disconnect { timeout_ms, .. }
            | Self::Reconnect { timeout_ms, .. } => *timeout_ms,
        }
    }
}

pub struct Client {
    child: Child,
    input: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
}
impl Client {
    pub fn start() -> Result<Self, String> {
        let mut child = Command::new("node")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/node/socketio.mjs"))
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("start Socket.IO helper: {e}"))?;
        let input = child.stdin.take().ok_or("helper stdin missing")?;
        let stdout = child.stdout.take().ok_or("helper stdout missing")?;
        Ok(Self {
            child,
            input,
            lines: BufReader::new(stdout).lines(),
        })
    }
    pub async fn request(&mut self, value: &Value, ms: u64) -> Result<Value, String> {
        let exchange = async {
            let mut data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
            if data.len() > 1024 * 1024 {
                return Err("Socket.IO command exceeds 1 MiB".into());
            }
            data.push(b'\n');
            self.input
                .write_all(&data)
                .await
                .map_err(|e| e.to_string())?;
            let line = self
                .lines
                .next_line()
                .await
                .map_err(|e| e.to_string())?
                .ok_or("Socket.IO helper exited (check installed client packages)")?;
            if line.len() > 32 * 1024 * 1024 {
                return Err("Socket.IO result exceeds 32 MiB".into());
            }
            let result: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if let Some(e) = result.get("error") {
                return Err(format!("Socket.IO: {e}"));
            }
            result
                .get("ok")
                .cloned()
                .ok_or_else(|| "invalid Socket.IO helper response".into())
        };
        tokio::time::timeout(Duration::from_millis(ms + 2000), exchange)
            .await
            .map_err(|_| "Socket.IO helper RPC timed out".to_string())?
    }
    pub async fn stop(mut self) {
        let _ = self.input.shutdown().await;
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Action;
    use serde_json::json;

    #[test]
    fn socket_actions_reject_unsupported_options_and_bounds() {
        let open = json!({"action":"open","client":"a","namespace":"/test","version":"4.8.3","transports":["websocket"],"auth":{},"timeout_ms":100});
        let action: Action = serde_json::from_value(open.clone()).unwrap();
        assert!(action.validate().is_ok());
        for (field, value) in [
            ("version", json!("5")),
            ("transports", json!([])),
            ("namespace", json!("test")),
            ("timeout_ms", json!(0)),
        ] {
            let mut input = open.clone();
            input[field] = value;
            assert!(
                serde_json::from_value::<Action>(input)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut extra = open;
        extra["ignored_option"] = json!(true);
        assert!(serde_json::from_value::<Action>(extra).is_err());
        let wait: Action = serde_json::from_value(
            json!({"action":"wait","client":"a","count":4097,"timeout_ms":100}),
        )
        .unwrap();
        assert!(wait.validate().is_err());
    }
}
