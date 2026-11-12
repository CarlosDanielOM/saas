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

/// Every scenario of the self-test target.
const ALL: &[&str] = &[
    "items/create",
    "items/jobs",
    "items/lease",
    "items/memory",
    "items/restart",
];

/// The rig and fixture binaries were built from this checkout. Worktrees share one cargo target
/// directory, so another worktree's build of this crate can replace them while a test runs.
fn assert_own_binaries() {
    let here = env!("CARGO_MANIFEST_DIR");
    let rig = Command::new(RIG).arg("--version").output().unwrap();
    let fixture = Command::new(FIXTURE).arg("--build-info").output().unwrap();
    for (name, out) in [("dima-rig", rig), ("dima-rig-fixture", fixture)] {
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.contains(here),
            "{name} in the shared target directory was built from another checkout ({}), not {here}: another worktree is building this crate; rerun, or use a private CARGO_TARGET_DIR",
            text.trim()
        );
    }
}

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
    rig_with(work, rig_dir, &work.join("captures"), variant, args)
}

fn rig_with(work: &Path, rig_dir: &Path, captures: &Path, variant: &str, args: &[&str]) -> Run {
    let report = work.join(format!("report-{}.json", N.fetch_add(1, Ordering::SeqCst)));
    let child = Command::new(RIG)
        .arg("--rig-dir")
        .arg(rig_dir)
        .arg("--captures-dir")
        .arg(captures)
        .arg("--out-dir")
        .arg(work.join("out"))
        .arg("--report")
        .arg(&report)
        .arg("--set")
        .arg(format!("fixture={FIXTURE}"))
        .arg("--set")
        .arg(format!("variant={variant}"))
        .arg("--set")
        .arg(format!("captures={}", captures.display()))
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
    for name in ALL {
        let diffs = run.differences(name);
        for (p, w) in &diffs {
            assert!(
                expected(p, w),
                "variant {variant}, {name}: unexpected difference {p} :: {w}\n{}",
                run.text
            );
        }
        if hit.contains(name) {
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
    let all = ALL;
    match variant {
        "equivalent" | "delayed" => {
            assert_eq!(run.code, 0, "equivalent must match\n{}", run.text);
            for name in all {
                assert_eq!(run.status(name), "match", "{name}\n{}", run.text);
            }
            // Key order differs on purpose: notes, not failures.
            let notes = run.scenario("items/create")["notes"]
                .as_array()
                .unwrap()
                .len();
            assert!(
                variant == "delayed" || notes > 0,
                "key order notes expected\n{}",
                run.text
            );
        }
        "int64" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("mongo.items[")
                && p.ends_with("].qty")
                && w.contains("reference int32, candidate int64")
        }),
        "null-field" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("mongo.items[")
                && p.ends_with("].note")
                && w.contains("missing in reference, null in candidate")
        }),
        "no-ttl" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("dragonfly[\"item:<oid:")
                && p.ends_with("].ttl")
                && w.contains("candidate has none")
        }),
        "status" => assert_only(&run, variant, &["items/create"], |p, w| {
            p == "steps[4].status" && w.contains("HTTP status differs")
        }),
        "extra-doc" => {
            assert_only(&run, variant, all, |p, w| {
                p.starts_with("mongo.events[") && w.contains("document only in candidate")
            });
            assert_eq!(
                run.differences("items/jobs").len(),
                1,
                "one extra document, one difference\n{}",
                run.text
            );
        }
        "number" => assert_only(&run, variant, all, |p, w| {
            p.ends_with(".body.total") && w == "number differs"
        }),
        "wrong-ref" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("dragonfly[\"item:<oid:") && w.contains("cross-reference differs")
        }),
        "no-cookie" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("steps[")
                && p.ends_with("].headers.set-cookie")
                && w == "header missing in candidate"
        }),
        "cookie-attr" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("steps[")
                && p.ends_with("].headers.set-cookie.sid.samesite")
                && w == "text differs"
        }),
        // A lease deadline replayed from the reference's recording (an absolute time).
        "lease-replay" => assert_only(&run, variant, &["items/lease"], |p, w| {
            p == "mongo.items[0].leaseUntil"
                && (w.contains("run-relative times differ") || w.contains("step-relative times differ") || w.contains("time produced by different steps")
                    || w.contains("time relation")
                    // Under load the recorded deadline can precede candidate startup.
                    || w == "candidate wrote this time during start-up, reference during the run or another time")
        }),
        // updatedAt not bumped by the second operation: only the relation sees it.
        "no-bump" => assert_only(&run, variant, &["items/lease"], |p, w| {
            p == "mongo.items[0].updatedAt"
                && (w.contains("time relation to mongo.items[0].createdAt differs")
                    || w.contains("time produced by different steps"))
        }),
        // A lease of 61 s instead of 60 s: within the window tolerance, a fixed duration broken.
        "lease-length" => assert_only(&run, variant, &["items/lease"], |p, w| {
            p == "mongo.items[0].leaseUntil" && w.contains("a fixed duration")
        }),
        "date-as-string" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("mongo.items[")
                && p.ends_with("].createdAt")
                && w == "type differs: reference BSON date, candidate string"
        }),
        "date-as-number" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("mongo.items[")
                && p.ends_with("].createdAt")
                && w == "type differs: reference BSON date, candidate double epoch-ms"
        }),
        "index-order" => assert_only(&run, variant, all, |p, w| {
            p == "mongo.items.indexes.owner_1_createdAt_-1.key" && w == "index key order differs"
        }),
        "index-option" => assert_only(&run, variant, all, |p, w| {
            p == "mongo.items.indexes.owner_1_createdAt_-1.sparse" && w == "field only in candidate"
        }),
        "stream-field" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("dragonfly[\"items:events\"].value[")
                && p.ends_with("].fields[2]")
                && w == "array element missing in candidate"
        }),
        "hash-bytes" => assert_only(&run, variant, all, |p, w| {
            p.starts_with("dragonfly[\"fixture:bin\"].value[\"<bytes:ff>")
                && (w == "field missing in candidate" || w == "field only in candidate")
        }),
        "job-key-order" => assert_only(&run, variant, &["items/jobs"], |p, w| {
            p == "dragonfly[\"cron:jobs:queue\"].value[0]" && w == "text differs"
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
            for name in ALL.iter().filter(|n| **n != "items/create") {
                assert_eq!(run.status(name), "match", "{name}\n{}", run.text);
            }
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
        // The indexes the fixture creates at start-up, so its start-up is not a write.
        db.run_command(bson::doc! {"createIndexes": "items", "indexes": [
            {"key": {"name": 1}, "name": "name_1", "unique": true},
            {"key": {"owner": 1, "createdAt": -1}, "name": "owner_1_createdAt_-1"},
        ]})
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
    assert_own_binaries();
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-selftest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let rd = selftest_dir();
    let mut pids = Vec::new();

    // Record: two reference runs agree, captures are written; a second record changes nothing.
    let rec = rig(
        &work,
        &rd,
        "good",
        &["record", "--label", "selftest-label", "selftest"],
    );
    pids.push(rec.pid);
    assert_eq!(rec.code, 0, "record\n{}", rec.text);
    for name in ALL {
        assert_eq!(rec.status(name), "recorded", "{}", rec.text);
        assert!(
            work.join("captures/selftest")
                .join(format!("{name}.json"))
                .is_file()
        );
    }
    let capture =
        std::fs::read_to_string(work.join("captures/selftest/items/create.json")).unwrap();
    // Raw: what was observed, with the run's metadata and provenance.
    let parsed: Value = serde_json::from_str(&capture).unwrap();
    assert_eq!(
        parsed["rig_capture"],
        dima_rig::capture::CAPTURE_VERSION,
        "{capture}"
    );
    assert!(
        parsed["calls"].as_array().is_some_and(Vec::is_empty),
        "{capture}"
    );
    assert!(parsed["run"]["mock_port"].is_u64(), "{capture}");
    assert_eq!(parsed["provenance"]["side"], "reference", "{capture}");
    assert_eq!(parsed["provenance"]["label"], "selftest-label", "{capture}");
    assert!(parsed["run"]["ports"]["http"].is_u64(), "{capture}");
    assert!(
        !parsed["run"]["mongo_uri"].as_str().unwrap().contains('@'),
        "no credentials in a capture: {capture}"
    );
    assert!(
        parsed["steps"][0]["http"]["body"]
            .as_str()
            .unwrap()
            .contains("🍕 pizza"),
        "{capture}"
    );
    assert!(capture.contains("\"$oid\""), "{capture}");
    let again = rig(&work, &rd, "good", &["record", "--once", "selftest"]);
    pids.push(again.pid);
    assert_eq!(again.code, 0, "{}", again.text);
    for name in ALL {
        assert_eq!(
            again.status(name),
            "unchanged",
            "re-recording an unchanged reference keeps the file\n{}",
            again.text
        );
    }

    // Format 5 keeps its original run-relative checks and still catches timing defects.
    let legacy = work.join("legacy-captures");
    copy_dir(&work.join("captures"), &legacy);
    let lease_path = legacy.join("selftest/items/lease.json");
    let mut lease: Value = serde_json::from_slice(&std::fs::read(&lease_path).unwrap()).unwrap();
    let fields = lease.as_object_mut().unwrap();
    fields.insert("rig_capture".into(), json!(5));
    for name in ["step_ends", "time_anchors", "ttl_origins", "scan_pages"] {
        fields.remove(name);
    }
    std::fs::write(&lease_path, serde_json::to_vec(&lease).unwrap()).unwrap();
    for (variant, path, message) in [
        ("good", "", ""),
        ("no-bump", "mongo.items[0].updatedAt", "time relation"),
        (
            "lease-length",
            "mongo.items[0].leaseUntil",
            "a fixed duration",
        ),
    ] {
        let run = rig_with(
            &work,
            &rd,
            &legacy,
            variant,
            &["verify", "selftest", "items/lease"],
        );
        pids.push(run.pid);
        if variant == "good" {
            assert_eq!(run.code, 0, "legacy reference must match: {}", run.text);
        } else {
            assert_eq!(run.code, 1, "legacy defect {variant}: {}", run.text);
            assert!(
                run.differences("items/lease")
                    .iter()
                    .any(|(p, w)| p == path && w.contains(message)),
                "legacy defect {variant} lacks actionable path: {}",
                run.text
            );
        }
    }

    // One process per scenario: a scenario verified alone gives what it gave after the others.
    let alone = rig(
        &work,
        &rd,
        "equivalent",
        &["verify", "selftest", "items/memory"],
    );
    pids.push(alone.pid);
    assert_eq!(alone.code, 0, "{}", alone.text);

    // Verify every candidate variant, a few at a time.
    let variants = [
        "equivalent",
        "delayed",
        "int64",
        "null-field",
        "no-ttl",
        "status",
        "extra-doc",
        "crash",
        "number",
        "wrong-ref",
        "job-key-order",
        "no-cookie",
        "cookie-attr",
        "lease-replay",
        "no-bump",
        "lease-length",
        "date-as-string",
        "date-as-number",
        "index-order",
        "index-option",
        "stream-field",
        "hash-bytes",
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
        // A side reads with a user that may only read the database: a write is refused (the
        // candidate's GET fails) and the database is unchanged.
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
            writes.text.contains("steps[0].status: HTTP status differs"),
            "{}",
            writes.text
        );
        assert!(
            !writes.text.contains("wrote to database"),
            "{}",
            writes.text
        );
        // With --allow-writes the write happens, the before/after check catches it, and the
        // report says that writes were possible.
        let allowed = rig(
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
                "--allow-writes",
            ],
        );
        pids.push(allowed.pid);
        assert_eq!(allowed.code, 1, "{}", allowed.text);
        assert!(
            allowed
                .text
                .contains(&format!("the candidate wrote to database {read_db}")),
            "{}",
            allowed.text
        );
        assert!(
            allowed.report["warnings"]
                .to_string()
                .contains("--allow-writes: both sides had write access"),
            "{}",
            allowed.text
        );
        // A target that cannot start with read-only credentials is told so.
        let strict = rig(
            &work,
            &rd,
            "strict-startup",
            &[
                "diff-get",
                "selftest",
                "--db",
                &read_db,
                "--paths",
                list.to_str().unwrap(),
            ],
        );
        pids.push(strict.pid);
        assert_eq!(strict.code, 1, "{}", strict.text);
        assert!(
            strict.text.contains("rerun with --allow-writes"),
            "{}",
            strict.text
        );
    });

    // Temporary users are dropped.
    let users = {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let c = mongodb::Client::with_uri_str(&uri).await.unwrap();
            c.database("admin")
                .run_command(bson::doc! {"usersInfo": 1})
                .await
                .unwrap()
                .to_string()
        })
    };
    for p in &pids {
        assert!(
            !users.contains(&format!("rig_{p}_")),
            "a temporary user of rig {p} was left behind: {users}"
        );
    }

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

    // The Dragonfly allow-list applies to the rendered command: a saved value that becomes a
    // command name outside the list is refused when the step runs (CONFIG GET is harmless even
    // if this check were broken).
    std::fs::write(
        edited.join("scenarios/selftest/items/rendered.json"),
        serde_json::to_string_pretty(&json!({
            "rig_scenario": 1,
            "description": "A command name that comes from a response.",
            "steps": [
                { "http": { "method": "GET", "path": "/word/CONFIG", "save": { "cmd": "body.word" } } },
                { "dragonfly": ["${cmd}", "GET", "maxmemory"] }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let refused = rig(
        &work,
        &edited,
        "good",
        &["compare", "selftest", "items/rendered"],
    );
    pids.push(refused.pid);
    assert_eq!(refused.code, 1, "{}", refused.text);
    let e = &refused.scenario("items/rendered")["errors"][0];
    assert_eq!(e["step"], 1, "{}", refused.text);
    assert!(
        e["message"]
            .as_str()
            .unwrap()
            .contains("CONFIG is not allowed in scenarios"),
        "{}",
        refused.text
    );

    // Nothing left behind.
    let left: Vec<String> = mongo_names(&uri)
        .into_iter()
        .filter(|n| n == &read_db || pids.iter().any(|p| n.starts_with(&format!("rig_{p}_"))))
        .collect();
    assert!(left.is_empty(), "databases left behind: {left:?}");
    assert_own_binaries();
    let _ = std::fs::remove_dir_all(&work);
}

/// The rig's settings as it computes them (lock directory, stores) from this environment.
fn rig_settings() -> dima_rig::run::Settings {
    dima_rig::config::settings(
        &dima_rig::config::Overrides::default(),
        std::env::vars().collect(),
    )
    .unwrap()
}

/// The logical databases a rig run says it flushed (from its stderr).
fn flushed_indexes(text: &str) -> Vec<u8> {
    text.lines()
        .filter_map(|l| l.split("flushed Dragonfly logical databases ").nth(1))
        .flat_map(|rest| {
            rest.split(';')
                .next()
                .unwrap_or("")
                .split(',')
                .filter_map(|n| n.trim().parse::<u8>().ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// After the rig released logical database `idx`, it is empty (checked under its lock; when
/// another rig run has claimed it since, the lock is busy and the content is theirs).
fn assert_flushed(idx: u8) {
    let s = rig_settings();
    let path = dima_rig::stores::lock_path(&s.stores, idx);
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .unwrap();
    if f.try_lock().is_err() {
        eprintln!("logical database {idx} was claimed by another rig run since; not checked");
        return;
    }
    let url = format!(
        "redis://{}:{}/{idx}",
        s.stores.dragonfly_host, s.stores.dragonfly_port
    );
    let mut c = redis::Client::open(url).unwrap().get_connection().unwrap();
    let n: i64 = redis::cmd("DBSIZE").query(&mut c).unwrap();
    assert_eq!(n, 0, "logical database {idx} was not flushed");
}

fn assert_no_databases_of(uri: &str, pid: u32) {
    let left: Vec<String> = mongo_names(uri)
        .into_iter()
        .filter(|n| n.starts_with(&format!("rig_{pid}_")))
        .collect();
    assert!(left.is_empty(), "databases left behind: {left:?}");
}

/// Wait until a process is gone (or a zombie nobody has reaped yet).
fn process_gone(pid: &str) -> bool {
    for _ in 0..250 {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => return true,
            Ok(stat)
                if stat
                    .rsplit(')')
                    .next()
                    .is_some_and(|t| t.trim_start().starts_with('Z')) =>
            {
                return true;
            }
            Ok(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    false
}

fn find_in_logs(dir: &Path, needle: &str) -> Option<String> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(text) = std::fs::read_to_string(&p)
                && let Some(line) = text.lines().find(|l| l.contains(needle))
            {
                return Some(line.to_string());
            }
        }
    }
    None
}

/// One cleanup path: after an error of the rig itself and after Ctrl-C, the side databases are
/// dropped, the claimed logical databases flushed, the locks released and the processes gone.
#[test]
fn cleanup_after_a_failure_and_an_interrupt() {
    let Some(uri) = std::env::var("DIMA_TEST_MONGO_URI")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        eprintln!("skipping: DIMA_TEST_MONGO_URI is not set");
        return;
    };
    assert_own_binaries();
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-cleanup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let rd = work.join("rig");
    copy_dir(&selftest_dir(), &rd);
    std::fs::write(
        rd.join("scenarios/selftest/items/slow.json"),
        serde_json::to_string_pretty(&json!({
            "rig_scenario": 1,
            "description": "Create an item, then wait long enough to be interrupted.",
            "seed": { "include": ["../_seeds/users.json"] },
            "steps": [
                { "http": { "method": "POST", "path": "/items", "json": { "name": "slow", "qty": 1, "owner": "650000000000000000000001" } } },
                { "pause_ms": 60000 }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    // An error of the rig itself after the sides ran: the captures directory cannot be created.
    let blocker = work.join("not-a-directory");
    std::fs::write(&blocker, "x").unwrap();
    let failed = Command::new(RIG)
        .arg("--rig-dir")
        .arg(&rd)
        .arg("--captures-dir")
        .arg(blocker.join("captures"))
        .arg("--out-dir")
        .arg(work.join("out-failure"))
        .args([
            "--set",
            &format!("fixture={FIXTURE}"),
            "--set",
            "variant=good",
        ])
        .args(["record", "--once", "selftest", "items/create"])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&failed.stderr).to_string();
    assert_eq!(failed.status.code(), Some(2), "{text}");
    assert!(
        text.contains("cleanup: dropped MongoDB databases rig_"),
        "{text}"
    );
    let flushed = flushed_indexes(&text);
    assert_eq!(flushed.len(), 1, "{text}");
    flushed.iter().for_each(|i| assert_flushed(*i));
    // The rig process is gone, so its pid cannot be reused for a check; the databases it named are.
    for name in text
        .split("dropped MongoDB databases ")
        .nth(1)
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .split(", ")
    {
        assert!(
            !mongo_names(&uri).contains(&name.trim().to_string()),
            "{name} left behind"
        );
    }

    // Ctrl-C in the middle of a scenario.
    let logs = work.join("out-interrupt");
    let child = Command::new(RIG)
        .arg("--rig-dir")
        .arg(&rd)
        .arg("--captures-dir")
        .arg(work.join("captures"))
        .arg("--out-dir")
        .arg(&logs)
        .args([
            "--set",
            &format!("fixture={FIXTURE}"),
            "--set",
            "variant=good",
        ])
        .args(["record", "--once", "selftest", "items/slow"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let rig_pid = child.id();
    let mut fixture_pid = None;
    for _ in 0..500 {
        if find_in_logs(&logs, "POST /items -> 201").is_some() {
            fixture_pid = find_in_logs(&logs, "fixture: listening on").and_then(|l| {
                l.split(", pid ")
                    .nth(1)
                    .and_then(|r| r.split(',').next())
                    .map(str::to_string)
            });
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let fixture_pid = fixture_pid.expect("the scenario did not start");
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(rig_pid).unwrap()),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stderr).to_string();
    assert_eq!(out.status.code(), Some(130), "{text}");
    assert!(
        text.contains("cleanup: dropped MongoDB databases rig_"),
        "{text}"
    );
    let flushed = flushed_indexes(&text);
    assert_eq!(flushed.len(), 1, "{text}");
    flushed.iter().for_each(|i| assert_flushed(*i));
    assert_no_databases_of(&uri, rig_pid);
    assert!(
        process_gone(&fixture_pid),
        "the side process {fixture_pid} outlived the interrupted rig"
    );
    assert_own_binaries();
    let _ = std::fs::remove_dir_all(&work);
}

#[test]
fn cursor_scan_compares_union_and_reports_missing_keys_and_loops() {
    let Some(uri) = std::env::var("DIMA_TEST_MONGO_URI")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let work =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("rig-scan-{}", std::process::id()));
    let rd = work.join("rig");
    copy_dir(&selftest_dir(), &rd);
    std::fs::write(rd.join("scenarios/selftest/scan.json"), json!({
        "rig_scenario": 5, "description": "Compare a complete cursor walk.",
        "steps": [{"http": {"method": "GET", "path": "/scan", "scan": {
            "cursor": "/data/cursor", "items": "/data/keys", "identity": "/name", "query": "cursor", "max_pages": 10, "ttl": "/ttl"
        }}}]
    }).to_string()).unwrap();
    let recorded = rig(&work, &rd, "good", &["record", "selftest", "scan"]);
    assert_eq!(recorded.code, 0, "{}", recorded.text);
    let paged = rig(&work, &rd, "scan-paged", &["verify", "selftest", "scan"]);
    assert_eq!(paged.code, 0, "{}", paged.text);
    let missing = rig(&work, &rd, "scan-missing", &["verify", "selftest", "scan"]);
    assert_eq!(missing.code, 1, "{}", missing.text);
    assert!(
        missing
            .differences("scan")
            .iter()
            .any(|(p, w)| p == "steps[0].body.data.keys[1]" && w.contains("missing in candidate")),
        "{}",
        missing.text
    );
    let looping = rig(&work, &rd, "scan-loop", &["verify", "selftest", "scan"]);
    assert_eq!(looping.code, 1, "{}", looping.text);
    assert!(
        looping.text.contains("scan repeated cursor"),
        "{}",
        looping.text
    );
    for run in [recorded, paged, missing, looping] {
        assert_no_databases_of(&uri, run.pid);
    }
    std::fs::remove_dir_all(work).unwrap();
}
