//! The signed-webhook steps, `wait_call` and the outbound comparison, end to end with the
//! fixture server (`tests/fixture/server.rs`) as both sides of the `hooks` target: its EventSub
//! ingress verifies the signature as the bot does and answers chat through the mock; its Polar
//! route verifies standardwebhooks as @polar-sh/sdk does.
//!
//! Needs the local stores; skips without `DIMA_TEST_MONGO_URI`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::Command;

use serde_json::Value;

const RIG: &str = env!("CARGO_BIN_EXE_dima-rig");
const FIXTURE: &str = env!("CARGO_BIN_EXE_dima-rig-fixture");

fn rig(work: &Path, variant: &str, args: &[&str]) -> (i32, Value, String) {
    let report = work.join(format!("report-{variant}-{}.json", args.join("-")));
    let out = Command::new(RIG)
        .arg("--rig-dir")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/selftest-rig"))
        .arg("--captures-dir")
        .arg(work.join("captures"))
        .arg("--out-dir")
        .arg(work.join("out"))
        .arg("--report")
        .arg(&report)
        .args(["--set", &format!("fixture={FIXTURE}")])
        .args(["--set", &format!("variant={variant}")])
        .args(args)
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let v = std::fs::read_to_string(&report)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    (out.status.code().unwrap_or(-1), v, text)
}

fn scenario<'v>(r: &'v Value, name: &str) -> &'v Value {
    r["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["scenario"] == name)
        .unwrap_or_else(|| panic!("no {name} in {r}"))
}

#[test]
fn webhooks_wait_call_and_outbound_comparison() {
    if std::env::var("DIMA_TEST_MONGO_URI").is_err() {
        eprintln!("skipping: DIMA_TEST_MONGO_URI is not set");
        return;
    }
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-webhooks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();

    // Recorded twice and stable.
    let (code, r, text) = rig(&work, "good", &["record", "hooks"]);
    assert_eq!(code, 0, "{text}");
    assert_eq!(
        scenario(&r, "webhooks/chat")["status"],
        "recorded",
        "{text}"
    );
    assert_eq!(
        scenario(&r, "isolation/files")["status"],
        "recorded",
        "{text}"
    );
    // The side's data directory had the seeded file; its MongoDB user could not write to
    // another database; a binary Dragonfly argument went through without a script.
    let iso: Value = serde_json::from_str(
        &std::fs::read_to_string(work.join("captures/hooks/isolation/files.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(iso["steps"][0]["http"]["body"], "hola 👋 from the seed");
    assert_eq!(iso["steps"][1]["http"]["status"], 404);
    assert_eq!(iso["steps"][2]["http"]["body"], r#"{"refused":true}"#);
    assert_eq!(
        iso["steps"][5]["dragonfly"]["reply"]["bulk"]["$rigBytes"],
        "/wDvvwE="
    );
    let cap: Value = serde_json::from_str(
        &std::fs::read_to_string(work.join("captures/hooks/webhooks/chat.json")).unwrap(),
    )
    .unwrap();
    let statuses: Vec<Value> = cap["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["http"]["status"].clone())
        .collect();
    assert_eq!(
        statuses,
        serde_json::json!([200, 403, 204, null, 202, 403, 403])
            .as_array()
            .unwrap()
            .clone(),
        "verification, bad signature, chat, wait, polar, other secret, too old"
    );
    assert!(
        cap["steps"][0]["http"]["body"]
            .as_str()
            .unwrap()
            .starts_with("rigchallenge-"),
        "the challenge is echoed"
    );
    let calls = cap["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0]["provider"], "twitch");
    assert!(
        calls[0]["body"]
            .as_str()
            .unwrap()
            .contains("echo: hola 👋 ñandú")
    );
    let auth = calls[0]["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h[0] == "authorization")
        .unwrap();
    assert_eq!(auth[1], "Bearer <redacted>", "no credential in a capture");

    // An equivalent candidate matches; a different chat answer is one difference, at its path.
    let (code, r, text) = rig(&work, "good", &["verify", "hooks"]);
    assert_eq!(code, 0, "{text}");
    assert_eq!(scenario(&r, "webhooks/chat")["status"], "match", "{text}");
    assert_eq!(scenario(&r, "isolation/files")["status"], "match", "{text}");
    let (code, r, text) = rig(&work, "chat-text", &["verify", "hooks"]);
    assert_eq!(code, 1, "{text}");
    assert_eq!(scenario(&r, "isolation/files")["status"], "match", "{text}");
    let diffs = scenario(&r, "webhooks/chat")["differences"]
        .as_array()
        .unwrap();
    assert_eq!(diffs.len(), 1, "{text}");
    assert_eq!(diffs[0]["path"], "calls.twitch[0].body.message", "{text}");
    // No answer at all: the wait for the call fails the scenario, naming the call.
    let (code, r, text) = rig(&work, "no-chat", &["verify", "hooks"]);
    assert_eq!(code, 1, "{text}");
    let sc = scenario(&r, "webhooks/chat");
    assert_eq!(sc["status"], "error", "{text}");
    let msg = sc["errors"][0]["message"].as_str().unwrap();
    assert!(
        msg.contains("wait_call timed out")
            && msg.contains("POST api.twitch.tv/helix/chat/messages"),
        "{msg}"
    );
    assert_eq!(sc["errors"][0]["step"], 3, "{text}");
    let _ = std::fs::remove_dir_all(&work);
}
