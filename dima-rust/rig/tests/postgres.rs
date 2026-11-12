//! Full record/verify path, with actual PostgreSQL writes by a defective candidate.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;
const RIG: &str = env!("CARGO_BIN_EXE_dima-rig");
const FIXTURE: &str = env!("CARGO_BIN_EXE_dima-rig-fixture");

#[test]
fn postgres_seed_read_catalogue_rows_and_cleanup() {
    let Ok(uri) = std::env::var("DIMA_TEST_POSTGRES_URI") else {
        assert!(
            std::env::var("DIMA_TEST_REQUIRE_STORES").is_err(),
            "PostgreSQL environment required"
        );
        return;
    };
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-postgres-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(work.join("targets")).unwrap();
    std::fs::create_dir_all(work.join("scenarios/pg")).unwrap();
    let mut reference = json!({"command":[FIXTURE,"--variant","good"],"env":{"PORT":"{port}","MONGO_URI":"{mongo_uri}","MONGO_DB":"{mongo_db}","REDIS_URL":"{dragonfly_url}","FIXTURE_POSTGRES_URI":"{postgres_uri}"},"ready":{"http":"/health","timeout_ms":60000}});
    let candidate = {
        let mut c = reference.clone();
        c["env"]["FIXTURE_POSTGRES_DEFECT"] = json!("{var.defect}");
        c
    };
    std::fs::write(
        work.join("targets/pg.json"),
        json!({"rig_target":1,"postgres":true,"reference":reference.take(),"candidate":candidate})
            .to_string(),
    )
    .unwrap();
    std::fs::write(work.join("scenarios/pg/rows.json"), json!({"rig_scenario":2,"description":"SQL seed, read and final catalogue/state.","seed":{"postgres":["CREATE TABLE items(id integer PRIMARY KEY, name text NOT NULL, qty integer); CREATE INDEX items_name ON items(name); INSERT INTO items VALUES (1,'héllo 🍕',3),(2,'مرحبا',4); CREATE TABLE amounts(n numeric); INSERT INTO amounts VALUES(0.123456789012345678901); CREATE TABLE owners(id uuid DEFAULT gen_random_uuid(), name text); INSERT INTO owners(name) VALUES('alpha'),('beta')"]},"steps":[{"sql":"SELECT id,name FROM items ORDER BY id"},{"sql":"SELECT * FROM owners ORDER BY name"},{"sql":"SELECT * FROM amounts"}]}).to_string()).unwrap();
    let run = |command: &str, defect: &str| {
        let report = work.join("report.json");
        let out = Command::new(RIG)
            .args([
                "--rig-dir",
                work.to_str().unwrap(),
                "--report",
                report.to_str().unwrap(),
                "--set",
                &format!("defect={defect}"),
                command,
                "pg",
            ])
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let bytes = std::fs::read(&report).unwrap_or_else(|error| {
            panic!(
                "rig did not write {}: {error}; exit {:?}\n{text}",
                report.display(),
                out.status.code()
            )
        });
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        (out.status.code(), text, value)
    };
    let (code, text, _) = run("record", "good");
    assert_eq!(code, Some(0), "{text}");
    let (code, text, _) = run("verify", "good");
    assert_eq!(code, Some(0), "{text}");
    for (defect, path) in [
        ("precise-number", "amounts"),
        ("changed-row", "rows"),
        ("missing-row", "rows"),
        ("column-type", "columns"),
        ("missing-index", "indexes"),
    ] {
        let (code, text, report) = run("verify", defect);
        assert_eq!(code, Some(1), "{defect}: {text}");
        let differences = report["scenarios"][0]["differences"].to_string();
        assert!(
            differences.contains("postgres") && differences.contains(path),
            "{defect}: {differences}"
        );
        eprintln!("caught {defect}: {differences}");
    }
    // Query failure must still release every side database.
    std::fs::write(work.join("scenarios/pg/error.json"), json!({"rig_scenario":3,"description":"Fail while reading SQL.","steps":[{"sql":"SELECT * FROM absent_table"}]}).to_string()).unwrap();
    let (code, text, _) = run("compare", "good");
    assert_eq!(code, Some(1), "{text}");
    assert!(text.contains("absent_table"), "{text}");
    std::fs::remove_file(work.join("scenarios/pg/error.json")).unwrap();
    // Interrupt after PostgreSQL allocation, before any scenario output exists.
    let mut child = Command::new(RIG)
        .args([
            "--rig-dir",
            work.to_str().unwrap(),
            "--set",
            "defect=good",
            "record",
            "pg",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    let probe_rt = tokio::runtime::Runtime::new().unwrap();
    let probe = dima_rig::postgres::Database::observer(uri.clone());
    let mut allocated = false;
    for _ in 0..300 {
        let rows = probe_rt
            .block_on(probe.read(&format!(
                "SELECT datname FROM pg_database WHERE datname LIKE 'rig_{pid}_%'"
            )))
            .unwrap();
        if !rows.as_array().unwrap().is_empty() {
            allocated = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap()),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let status = child.wait().unwrap();
    assert!(
        allocated,
        "rig did not allocate PostgreSQL before interruption"
    );
    assert_eq!(status.code(), Some(130));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let db = dima_rig::postgres::Database::observer(uri);
    let left = rt
        .block_on(db.read("SELECT datname FROM pg_database WHERE datname LIKE 'rig_%'"))
        .unwrap();
    // Other running rig commands own their databases; every completed process must be gone.
    for row in left.as_array().unwrap() {
        let name = row["datname"].as_str().unwrap();
        let pid = name.split('_').nth(1).unwrap();
        assert!(
            Path::new(&format!("/proc/{pid}")).exists(),
            "orphan PostgreSQL database {name}"
        );
    }
    std::fs::remove_dir_all(work).unwrap();
}
