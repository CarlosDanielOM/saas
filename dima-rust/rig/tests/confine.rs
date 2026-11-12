//! Proof that a reference process run by the rig cannot reach anything but its mock: a probe
//! (`tests/confine-rig/probe.mjs`) in the reference image with the rig's Node preload tries every
//! way out, and every attempt must end at the mock or at the preload's guard, and fail the
//! scenario with the attempt shown.
//!
//! Needs Docker with the image `dimabot-ref:0c71108e` and the local stores; skips otherwise.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::Command;

use serde_json::Value;

const RIG: &str = env!("CARGO_BIN_EXE_dima-rig");
const IMAGE: &str = "dimabot-ref:0c71108e";

#[test]
fn nothing_escapes_the_reference() {
    if std::env::var("DIMA_TEST_MONGO_URI").is_err() {
        eprintln!("skipping: DIMA_TEST_MONGO_URI is not set");
        return;
    }
    let image = Command::new("docker")
        .args(["image", "inspect", IMAGE, "--format", "{{.Id}}"])
        .output();
    if !image.is_ok_and(|o| o.status.success()) {
        eprintln!("skipping: the image {IMAGE} is not available");
        return;
    }
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-confine-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let report = work.join("report.json");
    let child = Command::new(RIG)
        .arg("--rig-dir")
        .arg(here.join("tests/confine-rig"))
        .arg("--captures-dir")
        .arg(work.join("captures"))
        .arg("--out-dir")
        .arg(work.join("out"))
        .arg("--report")
        .arg(&report)
        .args(["--set", &format!("image={IMAGE}")])
        .args(["record", "confine", "--once"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let rig_pid = child.id();
    let out = child.wait_with_output().unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        out.status.code(),
        Some(1),
        "the scenario must fail:\n{text}"
    );
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
    let sc = &r["scenarios"][0];
    assert_eq!(sc["status"], "error", "{text}");
    let message = sc["errors"][0]["message"].as_str().unwrap();
    for shown in [
        "unknown-host",
        "GET example.com/escape?via=fetch",
        "GET neverssl.com/escape?via=https",
        "GET 93.184.215.14/escape?via=http",
        "GET example.com/escape?via=wget",
        "the preload refused connect 93.184.215.14:443",
        "the preload refused dns resolve4 example.org",
    ] {
        assert!(message.contains(shown), "`{shown}` not in: {message}");
    }
    assert!(!work.join("captures/confine").exists(), "nothing recorded");
    // What the probe itself saw: the mock's 501, the guard's refusals, a TEST-NET answer, and
    // a normal answer from a provider the mock knows.
    let log = sc["errors"][0]["log"].as_str().unwrap();
    let log = std::fs::read_to_string(log).unwrap();
    let line = log
        .lines()
        .find_map(|l| l.split_once("PROBE ").map(|(_, j)| j))
        .unwrap_or_else(|| panic!("no PROBE line in the log:\n{log}"));
    let p: Value = serde_json::from_str(line).unwrap();
    for k in ["fetch_unknown", "https_get_unknown", "http_get_unknown"] {
        assert_eq!(p[k]["value"]["status"], 501, "{k}: {p}");
        assert!(
            p[k]["value"]["body"]
                .as_str()
                .unwrap()
                .contains("dima-rig mock"),
            "{k}: {p}"
        );
    }
    assert_eq!(p["raw_socket"]["error"], "ECONNREFUSED", "{p}");
    assert_eq!(p["dns_resolve"]["error"], "ENOTFOUND", "{p}");
    assert_eq!(p["dns_lookup"]["value"]["address"], "203.0.113.10", "{p}");
    assert!(
        p["child_wget"]["error"].as_str().unwrap().contains("501"),
        "{p}"
    );
    assert_eq!(p["known_provider"]["value"]["status"], 401, "{p}");
    // The cleanup removed the side's container (the rig labels them with its pid).
    let left = Command::new("docker")
        .args([
            "ps",
            "-aq",
            "--filter",
            &format!("label=dima-rig={rig_pid}"),
        ])
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&left.stdout).trim().is_empty(),
        "a container of this run is still there"
    );
    assert!(!text.contains("cleanup failed"), "{text}");
    let _ = std::fs::remove_dir_all(&work);
}
