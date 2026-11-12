//! Real JS clients against a small reference Socket.IO server; seeded defects must fail.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use serde_json::Value;
use std::path::Path;
use std::process::Command;
const RIG: &str = env!("CARGO_BIN_EXE_dima-rig");
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
fn socketio_observations_catch_seeded_defects() {
    if std::env::var("DIMA_TEST_MONGO_URI").is_err() {
        assert!(
            std::env::var("DIMA_TEST_REQUIRE_STORES").is_err(),
            "required stores missing"
        );
        return;
    }
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-sockets-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let result = std::panic::catch_unwind(|| {
        let (code, _, text) = rig(&work, "good", &["record", "sockets"]);
        assert_eq!(code, 0, "{text}");
        let (code, _, text) = rig(&work, "good", &["verify", "sockets"]);
        assert_eq!(code, 0, "{text}");
        for (variant, needle) in [
            ("argument", "args"),
            ("missing", "timed out"),
            ("extra", "unexpected Socket.IO"),
            ("order", "event"),
            ("ack", "args"),
            ("recovered", "recovered"),
            ("error-message", "message"),
            ("error-data", "reason"),
        ] {
            let (code, report, text) =
                rig(&work, variant, &["verify", "sockets", "4.8.3-websocket"]);
            assert_eq!(code, 1, "{variant}: {text}");
            assert!(
                text.contains(needle) || report.to_string().contains(needle),
                "{variant}: wanted {needle}: {text} {report}"
            );
            assert_ne!(scenario(&report, "4.8.3-websocket")["status"], "match");
        }
    });
    let _ = std::fs::remove_dir_all(&work);
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}
