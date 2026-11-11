//! End-to-end self-test of the rig without the real applications.
//!
//! `dima-rig` runs the fixture server (`tests/fixture/server.rs`) as both sides of the target in
//! `tests/selftest-rig`. The reference is `--variant good`; the candidate is `equivalent` (differs
//! only in generated ids, timing, insertion order and key order: the rig must report a match) or
//! one variant per defect (the rig must catch it and name the path, and report nothing else).
//!
//! Needs the local stores (`eval "$(dima-rust/tools/test-env)"`); skips with a message otherwise.
//! Every database the rig creates is dropped; the test checks that none is left behind.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{Value, json};

const RIG: &str = env!("CARGO_BIN_EXE_dima-rig");
const FIXTURE: &str = env!("CARGO_BIN_EXE_dima-rig-fixture");

static N: AtomicU32 = AtomicU32::new(0);

fn selftest_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/selftest-rig")
}

struct Run {
    code: i32,
    pid: u32,
    report: Value,
    text: String,
}

impl Run {
    fn scenario(&self, name: &str) -> &Value {
        self.report["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["scenario"] == name)
            .unwrap_or_else(|| panic!("no scenario {name} in the report:\n{}", self.text))
    }

    fn status(&self, name: &str) -> String {
        self.scenario(name)["status"].as_str().unwrap().to_string()
    }

    fn differences(&self, name: &str) -> Vec<(String, String)> {
        self.scenario(name)["differences"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                (
                    d["path"].as_str().unwrap().to_string(),
                    d["what"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }
}

/// Run `dima-rig` with the self-test directories and parse its JSON report.
fn rig(work: &Path, rig_dir: &Path, variant: &str, args: &[&str]) -> Run {
    let report = work.join(format!("report-{}.json", N.fetch_add(1, Ordering::SeqCst)));
    let child = Command::new(RIG)
        .arg("--rig-dir")
        .arg(rig_dir)
        .arg("--captures-dir")
        .arg(work.join("captures"))
        .arg("--out-dir")
        .arg(work.join("out"))
        .arg("--report")
        .arg(&report)
        .arg("--set")
        .arg(format!("fixture={FIXTURE}"))
        .arg("--set")
        .arg(format!("variant={variant}"))
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("start dima-rig");
    let pid = child.id();
    let out = child.wait_with_output().expect("run dima-rig");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let report = std::fs::read_to_string(&report)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    Run {
        code: out.status.code().unwrap_or(-1),
        pid,
        report,
        text,
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dest = to.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

/// Every difference of every scenario satisfies `expected`, and each scenario named in `hit` has at least one.
fn assert_only(run: &Run, variant: &str, hit: &[&str], expected: impl Fn(&str, &str) -> bool) {
    assert_eq!(run.code, 1, "variant {variant}: exit code\n{}", run.text);
    for name in ["items/create", "items/jobs", "items/restart"] {
        let diffs = run.differences(name);
        for (p, w) in &diffs {
            assert!(
                expected(p, w),
                "variant {variant}, {name}: unexpected difference {p} :: {w}\n{}",
                run.text
            );
        }
        if hit.contains(&name) {
            assert_eq!(
                run.status(name),
                "differ",
                "variant {variant}, {name}\n{}",
                run.text
            );
            assert!(
                !diffs.is_empty(),
                "variant {variant}, {name}: defect not caught\n{}",
                run.text
            );
        } else {
            assert_eq!(
                run.status(name),
                "match",
                "variant {variant}, {name}\n{}",
                run.text
            );
        }
    }
}

fn check_variant(work: &Path, variant: &str) -> u32 {
    let rd = selftest_dir();
    let run = rig(work, &rd, variant, &["verify", "selftest"]);
    let all = ["items/create", "items/jobs", "items/restart"];
    match variant {
        "equivalent" => {
            assert_eq!(run.code, 0, "equivalent must match\n{}", run.text);
            for name in all {
                assert_eq!(run.status(name), "match", "{name}\n{}", run.text);
            }
            // Key order differs on purpose: notes, not failures.
            let notes = run.scenario("items/create")["notes"]
                .as_array()
                .unwrap()
                .len();
            assert!(notes > 0, "key order notes expected\n{}", run.text);
        }
        "int64" => assert_only(&run, variant, &all, |p, w| {
            p.starts_with("mongo.items[")
                && p.ends_with("].qty")
                && w.contains("reference int32, candidate int64")
        }),
        "null-field" => assert_only(&run, variant, &all, |p, w| {
            p.starts_with("mongo.items[")
                && p.ends_with("].note")
                && w.contains("missing in reference, null in candidate")
        }),
        "no-ttl" => assert_only(&run, variant, &all, |p, w| {
            p.starts_with("dragonfly[\"item:<oid:")
                && p.ends_with("].ttl")
                && w.contains("candidate has none")
        }),
        "status" => assert_only(&run, variant, &["items/create"], |p, w| {
            p == "steps[4].status" && w.contains("HTTP status differs")
        }),
        "extra-doc" => {
            assert_only(&run, variant, &all, |p, w| {
                p.starts_with("mongo.events[") && w.contains("document only in candidate")
            });
            assert_eq!(
                run.differences("items/jobs").len(),
                1,
                "one extra document, one difference\n{}",
                run.text
            );
        }
        "number" => assert_only(&run, variant, &all, |p, w| {
            p.ends_with(".body.total") && w == "number differs"
        }),
        "wrong-ref" => assert_only(&run, variant, &all, |p, w| {
            p.starts_with("dragonfly[\"item:<oid:") && w.contains("cross-reference differs")
        }),
        "crash" => {
            assert_eq!(run.code, 1, "a crash fails the run\n{}", run.text);
            let create = run.scenario("items/create");
            assert_eq!(create["status"], "error", "{}", run.text);
            let e = &create["errors"][0];
            assert_eq!(e["side"], "candidate");
            assert_eq!(e["step"], 1);
            assert!(
                e["message"]
                    .as_str()
                    .unwrap()
                    .contains("exited (exit code 3)"),
                "{}",
                run.text
            );
            let tail: Vec<&str> = e["log_tail"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert!(
                tail.iter().any(|l| l.contains("crashing on purpose")),
                "log tail shown\n{}",
                run.text
            );
            // The next scenarios get a fresh process and match.
            assert_eq!(run.status("items/jobs"), "match", "{}", run.text);
            assert_eq!(run.status("items/restart"), "match", "{}", run.text);
        }
        other => panic!("no expectation for variant {other}"),
    }
    run.pid
}

fn mongo_names(uri: &str) -> Vec<String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let c = mongodb::Client::with_uri_str(uri).await.unwrap();
        c.list_database_names().await.unwrap()
    })
}

/// A database for `diff-get`, standing in for the local production copy.
fn with_read_db<T>(uri: &str, name: &str, f: impl FnOnce() -> T) -> T {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let client = rt
        .block_on(async { mongodb::Client::with_uri_str(uri).await })
        .unwrap();
    let db = client.database(name);
    rt.block_on(async {
        let oid = |h: &str| bson::oid::ObjectId::parse_str(h).unwrap();
        db.collection::<bson::Document>("items")
            .insert_many([
                bson::doc! {"_id": oid("640000000000000000000001"), "name": "old 🍕", "qty": 4_i32, "owner": oid("650000000000000000000001"), "createdAt": bson::DateTime::from_millis(1_700_000_000_000)},
                bson::doc! {"_id": oid("640000000000000000000002"), "name": "ñ", "qty": 9_i64, "owner": oid("650000000000000000000001"), "createdAt": bson::DateTime::from_millis(1_700_000_000_500)},
            ])
            .await
            .unwrap();
        // The index the fixture creates at start-up, so its start-up is not a write.
        db.run_command(bson::doc! {"createIndexes": "items", "indexes": [{"key": {"name": 1}, "name": "name_1", "unique": true}]})
            .await
            .unwrap();
    });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    rt.block_on(async { db.drop().await }).unwrap();
    match result {
        Ok(v) => v,
        Err(p) => std::panic::resume_unwind(p),
    }
}

#[test]
fn self_test_end_to_end() {
    let Some(uri) = std::env::var("DIMA_TEST_MONGO_URI")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        eprintln!(
            "skipping the rig self-test: DIMA_TEST_MONGO_URI is not set (run `eval \"$(dima-rust/tools/test-env)\"`)"
        );
        return;
    };
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-selftest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let rd = selftest_dir();
    let mut pids = Vec::new();

    // Record: two reference runs agree, captures are written; a second record changes nothing.
    let rec = rig(&work, &rd, "good", &["record", "selftest"]);
    pids.push(rec.pid);
    assert_eq!(rec.code, 0, "record\n{}", rec.text);
    for name in ["items/create", "items/jobs", "items/restart"] {
        assert_eq!(rec.status(name), "recorded", "{}", rec.text);
        assert!(
            work.join("captures/selftest")
                .join(format!("{name}.json"))
                .is_file()
        );
    }
    let capture =
        std::fs::read_to_string(work.join("captures/selftest/items/create.json")).unwrap();
    assert!(
        capture.contains("\"rig_capture\": 1")
            && capture.contains("<oid:1>")
            && capture.contains("🍕 pizza"),
        "{capture}"
    );
    let again = rig(&work, &rd, "good", &["record", "--once", "selftest"]);
    pids.push(again.pid);
    assert_eq!(again.code, 0, "{}", again.text);
    for name in ["items/create", "items/jobs", "items/restart"] {
        assert_eq!(
            again.status(name),
            "unchanged",
            "re-recording an unchanged reference keeps the file\n{}",
            again.text
        );
    }

    // Verify every candidate variant, a few at a time.
    let variants = [
        "equivalent",
        "int64",
        "null-field",
        "no-ttl",
        "status",
        "extra-doc",
        "crash",
        "number",
        "wrong-ref",
    ];
    for chunk in variants.chunks(3) {
        std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|v| s.spawn(|| check_variant(&work, v)))
                .collect();
            for h in handles {
                match h.join() {
                    Ok(pid) => pids.push(pid),
                    Err(p) => std::panic::resume_unwind(p),
                }
            }
        });
    }

    // Compare: both sides live.
    let live = rig(
        &work,
        &rd,
        "equivalent",
        &["compare", "selftest", "items/create"],
    );
    pids.push(live.pid);
    assert_eq!(live.code, 0, "{}", live.text);
    let live = rig(&work, &rd, "int64", &["compare", "selftest", "items"]);
    pids.push(live.pid);
    assert_eq!(live.code, 1, "{}", live.text);
    assert!(
        live.differences("items/jobs")
            .iter()
            .any(|(p, _)| p == "mongo.items[0].qty"),
        "{}",
        live.text
    );

    // diff-get: GET requests over an existing database, compared; a side that writes is caught.
    let read_db = format!("rig_selftest_read_{}", std::process::id());
    let list = work.join("gets.json");
    std::fs::write(
        &list,
        serde_json::to_string_pretty(&json!({
            "rig_get_list": 1,
            "description": "items over a read-only database",
            "requests": [
                "/items/640000000000000000000001",
                {"path": "/items/640000000000000000000002", "headers": {"accept": "application/json"}},
                "/items/640000000000000000000003"
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    with_read_db(&uri, &read_db, || {
        let ok = rig(
            &work,
            &rd,
            "equivalent",
            &[
                "diff-get",
                "selftest",
                "--db",
                &read_db,
                "--paths",
                list.to_str().unwrap(),
            ],
        );
        pids.push(ok.pid);
        assert_eq!(ok.code, 0, "{}", ok.text);
        assert_eq!(
            ok.report["scenarios"].as_array().unwrap().len(),
            3,
            "one entry per request\n{}",
            ok.text
        );
        let st = rig(
            &work,
            &rd,
            "status",
            &[
                "diff-get",
                "selftest",
                "--db",
                &read_db,
                "--paths",
                list.to_str().unwrap(),
            ],
        );
        pids.push(st.pid);
        assert_eq!(st.code, 1, "{}", st.text);
        assert!(
            st.text.contains("steps[2].status: HTTP status differs"),
            "{}",
            st.text
        );
        let writes = rig(
            &work,
            &rd,
            "writes-on-get",
            &[
                "diff-get",
                "selftest",
                "--db",
                &read_db,
                "--paths",
                list.to_str().unwrap(),
            ],
        );
        pids.push(writes.pid);
        assert_eq!(writes.code, 1, "{}", writes.text);
        assert!(
            writes
                .text
                .contains(&format!("the candidate wrote to database {read_db}")),
            "{}",
            writes.text
        );
    });

    // Check: strict files and stale captures, without running anything.
    let edited = work.join("edited-rig");
    copy_dir(&rd, &edited);
    let create = edited.join("scenarios/selftest/items/create.json");
    let text = std::fs::read_to_string(&create)
        .unwrap()
        .replace("Create two items", "Create two new items");
    std::fs::write(&create, text).unwrap();
    std::fs::write(
        edited.join("scenarios/selftest/items/typo.json"),
        r#"{"rig_scenario": 1, "description": "a typo", "steps": [{"http": {"method": "GET", "path": "/health", "expected": {"status": 200}}}]}"#,
    )
    .unwrap();
    let chk = rig(&work, &edited, "good", &["check", "selftest"]);
    assert_eq!(chk.code, 1, "{}", chk.text);
    let warnings = chk.scenario("items/create")["warnings"].to_string();
    assert!(warnings.contains("stale"), "{}", chk.text);
    let typo = chk.scenario("items/typo")["errors"][0]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        typo.contains("unknown field `expected`") && typo.contains("expect"),
        "{typo}"
    );
    let ver = rig(
        &work,
        &edited,
        "good",
        &["verify", "selftest", "items/create"],
    );
    assert_eq!(ver.code, 1, "{}", ver.text);
    assert!(ver.text.contains("capture is stale"), "{}", ver.text);

    // Nothing left behind.
    let left: Vec<String> = mongo_names(&uri)
        .into_iter()
        .filter(|n| n == &read_db || pids.iter().any(|p| n.starts_with(&format!("rig_{p}_"))))
        .collect();
    assert!(left.is_empty(), "databases left behind: {left:?}");
    let _ = std::fs::remove_dir_all(&work);
}
