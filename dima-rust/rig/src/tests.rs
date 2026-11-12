//! Normalisation and comparison, end to end on hand-built captures (no stores, no processes).

use std::collections::BTreeMap;

use bson::{Bson, Document, doc, oid::ObjectId};
use serde_json::{Value, json};

use crate::allow::{AllowKind, Allowances};
use crate::capture::{
    self, Capture, CaptureFile, Hashes, Provenance, RawCall, RawCapture, RawColl, RawEntry,
    RawHttp, RawStep, RawValue, RunMeta,
};
use crate::compare::{self, Outcome};
use crate::detect::tests::{START, oid_at, window};
use crate::detect::{Known, NOISE_HEADERS, Patterns, Window};
use crate::path::Pattern;
use crate::run::{RawRun, Rules, normalise};

const MIN: i64 = 60_000;
const DAY: i64 = 86_400_000;

fn http(status: u16, body: Value) -> RawStep {
    RawStep::Http(RawHttp {
        at: START + 1000,
        status,
        headers: vec![
            (
                "content-type".into(),
                b"application/json; charset=utf-8".to_vec(),
            ),
            ("x-powered-by".into(), b"whatever".to_vec()),
        ],
        body: serde_json::to_vec(&body).unwrap(),
    })
}

fn http_h(status: u16, headers: &[(&str, &str)], body: &[u8]) -> RawStep {
    RawStep::Http(RawHttp {
        at: START + 1000,
        status,
        headers: headers
            .iter()
            .map(|(n, v)| (n.to_string(), v.as_bytes().to_vec()))
            .collect(),
        body: body.to_vec(),
    })
}

fn id_index() -> Document {
    doc! {"v": 2, "key": {"_id": 1}, "name": "_id_"}
}

fn coll(docs: Vec<Document>) -> RawColl {
    RawColl {
        kind: "collection".into(),
        options: doc! {},
        indexes: vec![id_index()],
        docs,
    }
}

fn entry(key: &str, value: &str, pttl: i64) -> RawEntry {
    RawEntry {
        key: key.as_bytes().to_vec(),
        kind: "string".into(),
        value: RawValue::Str(value.as_bytes().to_vec()),
        pttl,
        pttl_at: START + 3000,
    }
}

fn oid(hex: &str) -> Bson {
    Bson::ObjectId(ObjectId::parse_str(hex).unwrap())
}

fn date(ms: i64) -> Bson {
    Bson::DateTime(bson::DateTime::from_millis(ms))
}

fn raw(steps: Vec<RawStep>, mongo: Vec<(&str, RawColl)>, dragonfly: Vec<RawEntry>) -> RawCapture {
    RawCapture {
        postgres: None,
        steps,
        mongo: mongo
            .into_iter()
            .map(|(n, c)| (n.to_string(), c))
            .collect::<BTreeMap<_, _>>(),
        dragonfly,
        calls: Vec::new(),
        startup_ignored: BTreeMap::new(),
        startup_keys: Vec::new(),
    }
}

fn allow(list: &[(&str, AllowKind)]) -> Allowances {
    Allowances::new(
        list.iter()
            .map(|(p, k)| {
                (
                    Pattern::parse(p).unwrap(),
                    k.clone(),
                    "test reason that is long enough".into(),
                )
            })
            .collect(),
    )
}

fn meta(w: Window, port: u16) -> RunMeta {
    RunMeta {
        seeded_at: w.seeded_at,
        start: w.start,
        end: w.end,
        process_start: w.proc_start,
        ports: [("http".to_string(), port)].into(),
        mongo_db: "rig_1_0_ref".into(),
        mongo_uri: "mongodb://127.0.0.1:27017/rig_1_0_ref".into(),
        dragonfly_db: 3,
        dragonfly_url: "redis://127.0.0.1:6379/3".into(),
        mock_port: Some(41300),
        qdrant_port: None,
        qdrant_prefix: None,
    }
}

fn run_of(r: &RawCapture, w: Window, port: u16) -> RawRun {
    let mut raw = r.clone();
    raw.sort();
    RawRun {
        raw,
        run: meta(w, port),
    }
}

/// The byte-sensitive key globs the unit tests use.
const BYTE_SENSITIVE: &[&str] = &["q:*", "cas:*"];

fn norm_run(run: &RawRun, known: &Known, a: &Allowances) -> Capture {
    norm_run_with(run, known, a, &crate::detect::CallRules::default())
}

fn norm_run_with(
    run: &RawRun,
    known: &Known,
    a: &Allowances,
    calls: &crate::detect::CallRules,
) -> Capture {
    let p = Patterns::new().unwrap();
    let skip: Vec<String> = NOISE_HEADERS.iter().map(|s| s.to_string()).collect();
    let bs: Vec<String> = BYTE_SENSITIVE.iter().map(|s| s.to_string()).collect();
    let rules = Rules {
        patterns: &p,
        known,
        skip_headers: &skip,
        as_text: &[],
        byte_sensitive: &bs,
        seed_offsets: &[(60_000, false)],
        calls,
    };
    normalise(run, &rules, a)
}

fn norm_w(r: &RawCapture, w: Window, known: &Known, a: &Allowances) -> Capture {
    norm_run(&run_of(r, w, 41234), known, a)
}

fn file_of(run: &RawRun) -> CaptureFile {
    CaptureFile {
        provenance: Provenance {
            target: "t".into(),
            scenario: "s".into(),
            side: "reference".into(),
            label: None,
            recorded_at: START + 5000,
            rig_version: "test".into(),
        },
        hashes: Hashes {
            scenario: "h".into(),
            files: vec![],
        },
        run: run.run.clone(),
        raw: run.raw.clone(),
    }
}

/// A raw run through the capture file format and back, as `verify` reads the reference.
fn through_file(run: &RawRun) -> RawRun {
    let text = capture::to_file_string(&file_of(run));
    let back = capture::from_file_json(&serde_json::from_str(&text).unwrap()).unwrap();
    RawRun {
        raw: back.raw,
        run: back.run,
    }
}

fn shifted(ms: i64) -> Window {
    let w = window();
    Window {
        start: w.start + ms,
        end: w.end + ms,
        proc_start: w.proc_start + ms,
        seeded_at: w.seeded_at + ms,
    }
}

fn diff_w(a: &RawCapture, wa: Window, b: &RawCapture, wb: Window, al: &Allowances) -> Outcome {
    let known = Known::default();
    // The reference through the raw file format, as `verify` reads it.
    let ca = norm_run(&through_file(&run_of(a, wa, 41234)), &known, al);
    let cb = norm_run(&run_of(b, wb, 41234), &known, al);
    compare::compare(&ca, &cb, al, compare::Tolerances::default())
}

fn diff(a: &RawCapture, b: &RawCapture) -> Outcome {
    diff_w(a, window(), b, window(), &Allowances::default())
}

fn paths(o: &Outcome) -> Vec<String> {
    o.differences
        .iter()
        .map(|d| format!("{} :: {}", d.path, d.what))
        .collect()
}

fn assert_match(o: &Outcome) {
    assert!(
        o.differences.is_empty(),
        "expected a match, got:\n{}",
        paths(o).join("\n")
    );
}

fn assert_one(o: &Outcome, path: &str, what: &str) {
    let found: Vec<String> = paths(o);
    assert!(
        o.differences
            .iter()
            .any(|d| d.path == path && d.what.contains(what)),
        "expected `{path}` :: `{what}`, got:\n{}",
        found.join("\n")
    );
}

/// A small but complete capture: a create response, two documents that reference each other,
/// a cache key and a hash keyed by name. `ids` are the generated ids, `order` flips insertion order.
fn scenario_capture(ids: [&str; 3], flip: bool, t: i64) -> RawCapture {
    let [item1, item2, event] = ids;
    let mut items = vec![
        doc! {"_id": oid(item1), "name": "🍕 pizza", "qty": 3, "createdAt": date(START + t), "leaseUntil": (START + t + MIN) as f64},
        doc! {"_id": oid(item2), "name": "ñandú", "qty": 5, "createdAt": date(START + t + 10), "leaseUntil": (START + t + 10 + MIN) as f64},
    ];
    let mut entries = vec![
        entry(
            &format!("item:{item1}"),
            &format!("{{\"id\":\"{item1}\",\"name\":\"🍕 pizza\"}}"),
            3_600_000 - 3000,
        ),
        entry(
            &format!("item:{item2}"),
            &format!("{{\"id\":\"{item2}\",\"name\":\"ñandú\"}}"),
            3_600_000 - 2990,
        ),
        RawEntry {
            key: b"items:by-name".to_vec(),
            kind: "hash".into(),
            value: RawValue::Hash(vec![
                (
                    b"\xf0\x9f\x8d\x95 pizza".to_vec(),
                    item1.as_bytes().to_vec(),
                ),
                ("ñandú".as_bytes().to_vec(), item2.as_bytes().to_vec()),
            ]),
            pttl: -1,
            pttl_at: START + 3000,
        },
    ];
    if flip {
        items.reverse();
        entries.reverse();
    }
    raw(
        vec![
            http(
                201,
                json!({"id": item1, "name": "🍕 pizza", "createdAt": crate::timefmt::format_iso_ms(START + t).unwrap(), "total": 1}),
            ),
            http(201, json!({"id": item2, "name": "ñandú", "total": 2})),
        ],
        vec![
            ("items", coll(items)),
            (
                "events",
                coll(vec![
                    doc! {"_id": oid(event), "item": oid(item1), "type": "created"},
                ]),
            ),
        ],
        entries,
    )
}

fn ids_a() -> [String; 3] {
    [
        oid_at(START + 100, 1),
        oid_at(START + 110, 2),
        oid_at(START + 120, 3),
    ]
}

fn ids_b() -> [String; 3] {
    [
        oid_at(START + 400, 0xa1),
        oid_at(START + 900, 0xb2),
        oid_at(START + 300, 0xc3),
    ]
}

fn refs(ids: &[String; 3]) -> [&str; 3] {
    [ids[0].as_str(), ids[1].as_str(), ids[2].as_str()]
}

#[test]
fn runs_that_differ_only_in_generated_values_produce_identical_captures() {
    let (a, b) = (ids_a(), ids_b());
    let known = Known::default();
    let none = Allowances::default();
    let ca = norm_w(
        &scenario_capture(refs(&a), false, 50),
        window(),
        &known,
        &none,
    );
    let cb = norm_w(
        &scenario_capture(refs(&b), true, 50),
        window(),
        &known,
        &none,
    );
    assert_eq!(ca, cb, "normalised captures differ");
    let (fa, fb) = (
        capture::normalised_json(&ca).to_string(),
        capture::normalised_json(&cb).to_string(),
    );
    assert_eq!(fa, fb);
    assert!(
        fa.contains("<oid:1>") && fa.contains("item:<oid:2>"),
        "{fa}"
    );
    assert!(
        !fa.contains(&a[0]),
        "a generated id leaked into the capture"
    );
}

#[test]
fn cross_referenced_identifiers_match_across_sides() {
    let (a, b) = (ids_a(), ids_b());
    assert_match(&diff(
        &scenario_capture(refs(&a), false, 50),
        &scenario_capture(refs(&b), true, 300),
    ));
}

#[test]
fn a_broken_cross_reference_is_a_difference() {
    let (a, b) = (ids_a(), ids_b());
    let good = scenario_capture(refs(&a), false, 50);
    let mut bad = scenario_capture(refs(&b), false, 50);
    // The candidate's event points at the second item instead of the first.
    bad.mongo.get_mut("events").unwrap().docs[0].insert("item", oid(&b[1]));
    let o = diff(&good, &bad);
    assert_one(&o, "mongo.events[0].item", "cross-reference differs");
    // A key named after the wrong document.
    let mut bad = scenario_capture(refs(&b), false, 50);
    bad.dragonfly[0].key = format!("item:{}", b[2]).into_bytes();
    let o = diff(&good, &bad);
    assert!(
        o.differences
            .iter()
            .any(|d| d.path.starts_with("dragonfly[") && d.what.contains("cross-reference")),
        "{:#?}",
        paths(&o)
    );
}

#[test]
fn an_extra_document_is_reported_once_without_shifting_the_rest() {
    let (a, b) = (ids_a(), ids_b());
    let good = scenario_capture(refs(&a), false, 50);
    let mut extra = scenario_capture(refs(&b), false, 50);
    let early = oid_at(START + 5, 9);
    extra.mongo.get_mut("items").unwrap().docs.insert(0, doc! {"_id": oid(&early), "name": "aaa first", "qty": 1, "createdAt": date(START), "leaseUntil": (START + MIN) as f64});
    let o = diff(&good, &extra);
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert!(o.differences[0].what.contains("document only in candidate"));
    // And a missing one.
    let o = diff(&extra, &good);
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert!(
        o.differences[0]
            .what
            .contains("document missing in candidate")
    );
}

#[test]
fn identifiers_inside_strings_and_key_names() {
    let a = oid_at(START + 10, 1);
    let b = oid_at(START + 20, 2);
    let mk = |id: &str| {
        raw(
            vec![http(
                200,
                json!({"links": {"self": format!("http://127.0.0.1:41234/items/{id}")}}),
            )],
            vec![],
            vec![
                entry(&format!("lock:{id}:owner"), &format!("worker-{id}"), -1),
                RawEntry {
                    key: b"index".to_vec(),
                    kind: "hash".into(),
                    value: RawValue::Hash(vec![(format!("user:{id}").into_bytes(), b"1".to_vec())]),
                    pttl: -1,
                    pttl_at: START + 3000,
                },
            ],
        )
    };
    assert_match(&diff(&mk(&a), &mk(&b)));
    // The key refers to a different id than the response.
    let mut bad = mk(&b);
    bad.dragonfly[0].key = format!("lock:{}:owner", oid_at(START + 30, 3)).into_bytes();
    let o = diff(&mk(&a), &bad);
    assert!(!o.differences.is_empty());
    // UUIDs too.
    let u1 = "0b6f2a4c-1d2e-4f3a-8b9c-0123456789ab";
    let u2 = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
    let mk = |u: &str| {
        raw(
            vec![http(200, json!({"id": u}))],
            vec![],
            vec![entry(&format!("job:{u}"), u, -1)],
        )
    };
    assert_match(&diff(&mk(u1), &mk(u2)));
}

#[test]
fn seeded_identifiers_compare_exactly() {
    let seeded = oid_at(START + 10, 1);
    let mut known = Known::default();
    known.ids.insert(seeded.clone());
    let other = oid_at(START + 20, 2);
    let mk = |id: &str| raw(vec![http(200, json!({"owner": id}))], vec![], vec![]);
    let p = Allowances::default();
    let ca = norm_w(&mk(&seeded), window(), &known, &p);
    let cb = norm_w(&mk(&other), window(), &known, &p);
    let o = compare::compare(&ca, &cb, &p, compare::Tolerances::default());
    assert_one(&o, "steps[0].body.owner", "text differs");
}

#[test]
fn times_inside_and_outside_the_window() {
    let mk = |created: i64, lease: f64, old: i64| {
        raw(
            vec![],
            vec![(
                "t",
                coll(vec![
                    doc! {"_id": "a", "createdAt": date(created), "leaseUntil": lease, "old": date(old)},
                ]),
            )],
            vec![],
        )
    };
    let base = mk(START + 100, (START + 100 + MIN) as f64, 978_307_200_000);
    // Within the 2 s tolerance.
    assert_match(&diff(
        &base,
        &mk(START + 600, (START + 600 + MIN) as f64, 978_307_200_000),
    ));
    // Beyond it.
    assert_one(
        &diff(
            &base,
            &mk(START + 2900, (START + 100 + MIN) as f64, 978_307_200_000),
        ),
        "mongo.t[0].createdAt",
        "run-relative times differ",
    );
    // A lease of 30 s instead of 60 s.
    assert_one(
        &diff(
            &base,
            &mk(START + 100, (START + 100 + MIN / 2) as f64, 978_307_200_000),
        ),
        "mongo.t[0].leaseUntil",
        "run-relative times differ",
    );
    // A far date is exact to the millisecond.
    assert_one(
        &diff(
            &base,
            &mk(START + 100, (START + 100 + MIN) as f64, 978_307_200_001),
        ),
        "mongo.t[0].old",
        "times differ",
    );
    // A per-path tolerance.
    let al = allow(&[("mongo.t[*].createdAt", AllowKind::Tolerance(5000))]);
    let o = diff_w(
        &base,
        window(),
        &mk(START + 4000, (START + 100 + MIN) as f64, 978_307_200_000),
        window(),
        &al,
    );
    assert_match(&o);
    assert_eq!(al.unused().count(), 0);
    // Relative to each side's own start: a candidate run five minutes later still matches.
    let later = 5 * MIN;
    assert_match(&diff_w(
        &base,
        window(),
        &mk(
            START + later + 100,
            (START + later + 100 + MIN) as f64,
            978_307_200_000,
        ),
        shifted(later),
        &Allowances::default(),
    ));
}

#[test]
fn constant_dates_near_the_run_need_an_exact_allowance() {
    // A fixed date ten days ahead (from configuration, not from "now"), recorded today and
    // verified five days later. A time near the run is compared relative to each side's run
    // start, never by absolute equality, so this is a difference ...
    let fixed = START + 10 * DAY;
    let mk = || {
        raw(
            vec![http(
                200,
                json!({"launch": crate::timefmt::format_iso_ms(fixed).unwrap()}),
            )],
            vec![],
            vec![],
        )
    };
    assert_one(
        &diff_w(
            &mk(),
            window(),
            &mk(),
            shifted(5 * DAY),
            &Allowances::default(),
        ),
        "steps[0].body.launch",
        "run-relative times differ",
    );
    // ... until the path is declared not a time.
    let al = allow(&[("steps[*].body.launch", AllowKind::Exact)]);
    assert_match(&diff_w(&mk(), window(), &mk(), shifted(5 * DAY), &al));
    assert_eq!(al.unused().count(), 0);
}

#[test]
fn a_replayed_absolute_time_is_not_a_match() {
    // The candidate runs five minutes later and writes the reference's absolute lease deadline.
    let d = |created: i64, lease: i64| {
        raw(
            vec![],
            vec![(
                "t",
                coll(vec![
                    doc! {"_id": "a", "createdAt": date(created), "leaseUntil": lease as f64},
                ]),
            )],
            vec![],
        )
    };
    let later = shifted(5 * MIN);
    let o = diff_w(
        &d(START + 100, START + 100 + MIN),
        window(),
        &d(later.start + 100, START + 100 + MIN),
        later,
        &Allowances::default(),
    );
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert_one(&o, "mongo.t[0].leaseUntil", "run-relative times differ");
    // Alone in its document too (no relation to fall back on).
    let alone = |lease: i64| {
        raw(
            vec![],
            vec![(
                "t",
                coll(vec![doc! {"_id": "a", "leaseUntil": lease as f64}]),
            )],
            vec![],
        )
    };
    assert_one(
        &diff_w(
            &alone(START + MIN),
            window(),
            &alone(START + MIN),
            later,
            &Allowances::default(),
        ),
        "mongo.t[0].leaseUntil",
        "run-relative times differ",
    );
}

/// A document with created, updated and lease times (offsets from the run start, ms).
fn timed_doc(created: i64, updated: i64, lease: i64) -> RawCapture {
    raw(
        vec![],
        vec![(
            "t",
            coll(vec![doc! {
                "_id": "a",
                "createdAt": date(START + created),
                "updatedAt": date(START + updated),
                "leaseUntil": (START + lease) as f64,
            }]),
        )],
        vec![],
    )
}

#[test]
fn relations_between_times_of_one_document() {
    let ok = |a: &RawCapture, b: &RawCapture| assert_match(&diff(a, b));
    // Reference: created, updated 150 ms later by a second operation, lease = updated + 60 s.
    let reference = timed_doc(100, 250, 250 + MIN);
    ok(&reference, &timed_doc(110, 280, 280 + MIN));
    // updatedAt not bumped by the second operation: within the window tolerance, caught by the
    // relation, reported once at updatedAt.
    let o = diff(&reference, &timed_doc(100, 100, 250 + MIN));
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert_one(
        &o,
        "mongo.t[0].updatedAt",
        "time relation to mongo.t[0].createdAt differs",
    );
    // A lease one second too long: within the window tolerance, caught as a fixed duration.
    let o = diff(&reference, &timed_doc(100, 250, 250 + MIN + 1000));
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert_one(&o, "mongo.t[0].leaseUntil", "a fixed duration");
    // Within the relation tolerance (50 ms) it matches.
    ok(&reference, &timed_doc(100, 250, 250 + MIN + 30));
    // One clock reading used twice must stay one.
    let same = timed_doc(100, 100, 100 + MIN);
    ok(&same, &timed_doc(300, 300, 300 + MIN));
    assert_one(
        &diff(&same, &timed_doc(100, 104, 104 + MIN)),
        "mongo.t[0].updatedAt",
        "one clock reading",
    );
    // Order reversed.
    assert_one(
        &diff(
            &timed_doc(100, 700, 700 + MIN),
            &timed_doc(700, 100, 100 + MIN),
        ),
        "mongo.t[0].updatedAt",
        "time relation",
    );
    // Two readings a few milliseconds apart may become one reading on a faster candidate.
    ok(
        &timed_doc(100, 103, 103 + MIN),
        &timed_doc(100, 100, 100 + MIN),
    );
    // A larger relation tolerance (per path) loosens the duration check.
    let al = allow(&[("mongo.t[*].leaseUntil", AllowKind::Tolerance(1500))]);
    assert_match(&diff_w(
        &reference,
        window(),
        &timed_doc(100, 250, 250 + MIN + 1000),
        window(),
        &al,
    ));
}

#[test]
fn relations_inside_a_response_and_with_coarse_times() {
    let iso = |ms: i64| crate::timefmt::format_iso_ms(START + ms).unwrap();
    let body = |c: i64, e: i64| {
        raw(
            vec![http(200, json!({"createdAt": iso(c), "expiresAt": iso(e)}))],
            vec![],
            vec![],
        )
    };
    assert_match(&diff(&body(100, 100 + DAY), &body(400, 400 + DAY)));
    assert_one(
        &diff(&body(100, 100 + DAY), &body(100, 100 + DAY - 1000)),
        "steps[0].body.expiresAt",
        "a fixed duration",
    );
    // Epoch seconds (declared): second precision, only the order counts.
    let secs = |a: i64, b: i64| {
        raw(
            vec![http(
                200,
                json!({"iat": (START + a) / 1000, "exp": (START + b) / 1000}),
            )],
            vec![],
            vec![],
        )
    };
    let al = allow(&[
        ("steps[*].body.iat", AllowKind::Time { seconds: true }),
        ("steps[*].body.exp", AllowKind::Time { seconds: true }),
    ]);
    assert_match(&diff_w(
        &secs(0, 3_600_000),
        window(),
        &secs(900, 3_600_900),
        window(),
        &al,
    ));
    assert_one(
        &diff_w(
            &secs(0, 3_600_000),
            window(),
            &secs(3_600_000, 0),
            window(),
            &al,
        ),
        "steps[0].body.exp",
        "run-relative times differ",
    );
}

#[test]
fn time_and_exact_allowances() {
    let n = |v: i64| raw(vec![http(200, json!({"v": v}))], vec![], vec![]);
    // An epoch-ms number near the run is a time by magnitude ...
    assert_match(&diff(&n(START + 100), &n(START + 900)));
    // ... unless the path is declared not a time.
    let exact = allow(&[("steps[*].body.v", AllowKind::Exact)]);
    assert_one(
        &diff_w(&n(START + 100), window(), &n(START + 900), window(), &exact),
        "steps[0].body.v",
        "number differs",
    );
    // Epoch seconds are not detected by magnitude ...
    let s = |v: i64| raw(vec![http(200, json!({"v": v}))], vec![], vec![]);
    assert_one(
        &diff(&s(START / 1000), &s(START / 1000 + 1)),
        "steps[0].body.v",
        "number differs",
    );
    // ... unless declared.
    let secs = allow(&[("steps[*].body.v", AllowKind::Time { seconds: true })]);
    assert_match(&diff_w(
        &s(START / 1000),
        window(),
        &s(START / 1000 + 1),
        window(),
        &secs,
    ));
    // A declared time keeps its representation: epoch seconds against epoch milliseconds differ.
    let ms = allow(&[("steps[*].body.v", AllowKind::Time { seconds: false })]);
    let ca = norm_w(&s(START / 1000), window(), &Known::default(), &secs);
    let cb = norm_w(&s(START), window(), &Known::default(), &ms);
    assert!(
        !compare::compare(&ca, &cb, &secs, compare::Tolerances::default())
            .differences
            .is_empty()
    );
    // A BSON date declared exact compares by its absolute value.
    let d = |ms: i64| {
        raw(
            vec![],
            vec![("c", coll(vec![doc! {"_id": "a", "at": date(ms)}]))],
            vec![],
        )
    };
    let exact = allow(&[("mongo.c[*].at", AllowKind::Exact)]);
    assert_one(
        &diff_w(&d(START + 100), window(), &d(START + 200), window(), &exact),
        "mongo.c[0].at",
        "times differ",
    );
}

#[test]
fn time_representation_and_format_are_contract() {
    let a = raw(
        vec![],
        vec![("t", coll(vec![doc! {"_id": "a", "at": date(START + 100)}]))],
        vec![],
    );
    let b = raw(
        vec![],
        vec![(
            "t",
            coll(vec![doc! {"_id": "a", "at": (START + 100) as f64}]),
        )],
        vec![],
    );
    assert_one(&diff(&a, &b), "mongo.t[0].at", "type differs");
    let iso = |s: &str| raw(vec![http(200, json!({"at": s}))], vec![], vec![]);
    let ms = crate::timefmt::format_iso_ms(START + 100).unwrap();
    let no_ms = ms.replace(".100Z", "Z").replace(".100", "");
    assert_one(
        &diff(&iso(&ms), &iso(&no_ms)),
        "steps[0].body.at",
        "different format",
    );
}

#[test]
fn ttl_classes() {
    let mk = |pttl: i64| raw(vec![], vec![], vec![entry("k", "v", pttl)]);
    assert_match(&diff(&mk(3_600_000), &mk(3_599_100)));
    assert_one(
        &diff(&mk(3_600_000), &mk(-1)),
        "dragonfly.k.ttl",
        "candidate has none",
    );
    assert_one(
        &diff(&mk(-1), &mk(60_000)),
        "dragonfly.k.ttl",
        "reference has none",
    );
    assert_one(
        &diff(&mk(3_600_000), &mk(60_000)),
        "dragonfly.k.ttl",
        "TTL differs",
    );
    assert_match(&diff(&mk(-1), &mk(-1)));
}

#[test]
fn never_forgiven() {
    let d = |doc: Document| raw(vec![], vec![("c", coll(vec![doc]))], vec![]);
    // Missing versus null, both ways.
    assert_one(
        &diff(
            &d(doc! {"_id": "a", "note": Bson::Null}),
            &d(doc! {"_id": "a"}),
        ),
        "mongo.c[0].note",
        "null in reference, missing in candidate",
    );
    assert_one(
        &diff(
            &d(doc! {"_id": "a"}),
            &d(doc! {"_id": "a", "note": Bson::Null}),
        ),
        "mongo.c[0].note",
        "null in candidate",
    );
    // Empty string versus missing.
    assert_one(
        &diff(&d(doc! {"_id": "a", "s": ""}), &d(doc! {"_id": "a"})),
        "mongo.c[0].s",
        "missing in candidate",
    );
    // Empty string versus a value.
    assert_one(
        &diff(
            &d(doc! {"_id": "a", "s": ""}),
            &d(doc! {"_id": "a", "s": "x"}),
        ),
        "mongo.c[0].s",
        "one side is empty",
    );
    // BSON number types.
    assert_one(
        &diff(
            &d(doc! {"_id": "a", "n": 5_i32}),
            &d(doc! {"_id": "a", "n": 5_i64}),
        ),
        "mongo.c[0].n",
        "reference int32, candidate int64",
    );
    assert_one(
        &diff(
            &d(doc! {"_id": "a", "n": 5_i32}),
            &d(doc! {"_id": "a", "n": 5.0_f64}),
        ),
        "mongo.c[0].n",
        "reference int32, candidate double",
    );
    // String versus number, in a response.
    let j = |v: Value| raw(vec![http(200, v)], vec![], vec![]);
    assert_one(
        &diff(&j(json!({"n": "5"})), &j(json!({"n": 5}))),
        "steps[0].body.n",
        "reference string, candidate number",
    );
    // JSON numbers compare by value.
    assert_match(&diff(&j(json!({"n": 5})), &j(json!({"n": 5.0}))));
    assert_one(
        &diff(&j(json!({"n": 5})), &j(json!({"n": 6}))),
        "steps[0].body.n",
        "number differs",
    );
    // Status.
    assert_one(
        &diff(
            &raw(vec![http(201, json!({}))], vec![], vec![]),
            &raw(vec![http(200, json!({}))], vec![], vec![]),
        ),
        "steps[0].status",
        "HTTP status differs",
    );
    // Extra and missing keys.
    let k = |keys: &[&str]| {
        raw(
            vec![],
            vec![],
            keys.iter().map(|n| entry(n, "1", -1)).collect(),
        )
    };
    assert_one(
        &diff(&k(&["a"]), &k(&["a", "b"])),
        "dragonfly.b",
        "key only in candidate",
    );
    assert_one(
        &diff(&k(&["a", "b"]), &k(&["a"])),
        "dragonfly.b",
        "key missing in candidate",
    );
    // Extra and missing indexes; index key order.
    let ix = |specs: Vec<Document>| {
        let mut c = coll(vec![]);
        c.indexes.extend(specs);
        raw(vec![], vec![("c", c)], vec![])
    };
    let by_name =
        doc! {"v": 2, "key": {"name": 1, "at": -1}, "name": "name_1_at_-1", "unique": true};
    assert_one(
        &diff(&ix(vec![by_name.clone()]), &ix(vec![])),
        "mongo.c.indexes.name_1_at_-1",
        "index missing in candidate",
    );
    assert_one(
        &diff(&ix(vec![]), &ix(vec![by_name.clone()])),
        "mongo.c.indexes.name_1_at_-1",
        "index only in candidate",
    );
    let swapped =
        doc! {"v": 2, "key": {"at": -1, "name": 1}, "name": "name_1_at_-1", "unique": true};
    assert_one(
        &diff(&ix(vec![by_name.clone()]), &ix(vec![swapped])),
        "mongo.c.indexes.name_1_at_-1.key",
        "index key order differs",
    );
    let not_unique = doc! {"v": 2, "key": {"name": 1, "at": -1}, "name": "name_1_at_-1"};
    assert_one(
        &diff(&ix(vec![by_name]), &ix(vec![not_unique])),
        "mongo.c.indexes.name_1_at_-1.unique",
        "missing in candidate",
    );
    // A missing collection.
    assert_one(
        &diff(&d(doc! {"_id": "a"}), &raw(vec![], vec![], vec![])),
        "mongo.c",
        "collection missing in candidate",
    );
    // A header.
    let h = |ct: &str| {
        raw(
            vec![http_h(200, &[("content-type", ct)], b"{}")],
            vec![],
            vec![],
        )
    };
    assert_one(
        &diff(
            &h("application/json; charset=utf-8"),
            &h("application/json"),
        ),
        "steps[0].headers.content-type",
        "text differs",
    );
}

#[test]
fn key_order_is_a_note_not_a_difference() {
    let a = raw(
        vec![http_h(
            200,
            &[("content-type", "application/json")],
            br#"{"a":1,"b":2}"#,
        )],
        vec![],
        vec![],
    );
    let b = raw(
        vec![http_h(
            200,
            &[("content-type", "application/json")],
            br#"{"b":2,"a":1}"#,
        )],
        vec![],
        vec![],
    );
    let o = diff(&a, &b);
    assert_match(&o);
    assert_eq!(o.notes.len(), 1);
    assert_eq!(o.notes[0].path, "steps[0].body");
}

#[test]
fn arrays_are_ordered_unless_allowed_as_a_set() {
    let j = |v: Value| raw(vec![http(200, v)], vec![], vec![]);
    let (a, b) = (
        j(json!({"tags": ["x", "y", "z"]})),
        j(json!({"tags": ["z", "x", "y"]})),
    );
    assert!(!diff(&a, &b).differences.is_empty());
    let al = allow(&[("steps[*].body.tags", AllowKind::Set)]);
    assert_match(&diff_w(&a, window(), &b, window(), &al));
    // One inserted element is one difference.
    let o = diff(&j(json!(["a", "b", "c"])), &j(json!(["a", "x", "b", "c"])));
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert!(o.differences[0].what.contains("only in candidate"));
    // Dragonfly sets are unordered by nature.
    let s = |m: &[&str]| {
        raw(
            vec![],
            vec![],
            vec![RawEntry {
                key: b"s".to_vec(),
                kind: "set".into(),
                value: RawValue::Set(m.iter().map(|x| x.as_bytes().to_vec()).collect()),
                pttl: -1,
                pttl_at: START + 3000,
            }],
        )
    };
    assert_match(&diff(&s(&["1", "2", "3"]), &s(&["3", "1", "2"])));
    assert_one(
        &diff(&s(&["1", "2", "3"]), &s(&["1", "2"])),
        "dragonfly.s.value[2]",
        "missing in candidate",
    );
}

#[test]
fn unused_allowances_are_reported() {
    let al = allow(&[
        ("mongo.nothing[*].here", AllowKind::Ignore),
        ("steps[0].body.n", AllowKind::Ignore),
    ]);
    let j = |v: Value| raw(vec![http(200, v)], vec![], vec![]);
    let o = diff_w(
        &j(json!({"n": 1})),
        window(),
        &j(json!({"n": 2})),
        window(),
        &al,
    );
    assert_match(&o);
    let unused: Vec<&str> = al.unused().map(|a| a.path.source()).collect();
    assert_eq!(unused, vec!["mongo.nothing[*].here"]);
}

#[test]
fn ignore_covers_presence() {
    let d = |doc: Document| raw(vec![], vec![("c", coll(vec![doc]))], vec![]);
    let al = allow(&[("mongo.c[*].debug", AllowKind::Ignore)]);
    assert_match(&diff_w(
        &d(doc! {"_id": "a"}),
        window(),
        &d(doc! {"_id": "a", "debug": "x"}),
        window(),
        &al,
    ));
}

#[test]
fn generated_tokens_by_allowance() {
    let mk = |tok: &str| {
        raw(
            vec![http(200, json!({"token": tok}))],
            vec![],
            vec![entry(
                &format!("session:{tok}"),
                "{\"user\":\"u1\"}",
                86_400_000,
            )],
        )
    };
    let (a, b) = (mk("tok_AbCdEf123456"), mk("tok_ZyXwVu987654"));
    assert!(
        !diff(&a, &b).differences.is_empty(),
        "random tokens differ without an allowance"
    );
    // Whole value at one path; the same value inside a key name follows it.
    let al = allow(&[("steps[*].body.token", AllowKind::Generated(None))]);
    assert_match(&diff_w(&a, window(), &b, window(), &al));
    // By pattern, everywhere.
    let al = allow(&[(
        "**",
        AllowKind::Generated(Some(regex::Regex::new("tok_[A-Za-z0-9]+").unwrap())),
    )]);
    assert_match(&diff_w(&a, window(), &b, window(), &al));
    // The key names a different token than the response: caught.
    let mut bad = mk("tok_ZyXwVu987654");
    bad.dragonfly[0].key = b"session:tok_Other0000000".to_vec();
    let al = allow(&[(
        "**",
        AllowKind::Generated(Some(regex::Regex::new("tok_[A-Za-z0-9]+").unwrap())),
    )]);
    assert!(
        !diff_w(&a, window(), &bad, window(), &al)
            .differences
            .is_empty()
    );
}

#[test]
fn non_ascii_keys_values_and_paths() {
    let d = |v: &str| {
        raw(
            vec![],
            vec![("c", coll(vec![doc! {"_id": "a", "ключ": {"🍕 pizza": v}}]))],
            vec![],
        )
    };
    assert_match(&diff(&d("ñandú 😀"), &d("ñandú 😀")));
    let o = diff(&d("ñandú 😀"), &d("ñandu 😀"));
    assert_one(&o, "mongo.c[0].ключ[\"🍕 pizza\"]", "text differs");
    assert_eq!(o.differences[0].reference.as_deref(), Some("\"ñandú 😀\""));
    // Emoji in a Dragonfly key and hash field.
    let h = |v: &str| {
        raw(
            vec![],
            vec![],
            vec![RawEntry {
                key: "rank:🏆".as_bytes().to_vec(),
                kind: "hash".into(),
                value: RawValue::Hash(vec![("日本".as_bytes().to_vec(), v.as_bytes().to_vec())]),
                pttl: -1,
                pttl_at: START + 3000,
            }],
        )
    };
    assert_one(
        &diff(&h("1"), &h("2")),
        "dragonfly[\"rank:🏆\"].value.日本",
        "text differs",
    );
}

#[test]
fn stored_json_is_compared_as_json_with_notes() {
    let s = |v: &str| raw(vec![], vec![], vec![entry("cache", v, -1)]);
    let o = diff(&s(r#"{"a":1,"b":2}"#), &s(r#"{"b":2,"a":1}"#));
    assert_match(&o);
    assert_eq!(o.notes.len(), 1);
    let o = diff(&s(r#"{"n":5}"#), &s(r#"{"n":5.0}"#));
    assert_match(&o);
    assert!(
        o.notes
            .iter()
            .any(|n| n.what.contains("written differently"))
    );
    // JSON versus plain text is a difference; pretty-printed JSON is kept as text.
    assert!(
        !diff(&s(r#"{"a":1}"#), &s(r#"{ "a": 1 }"#))
            .differences
            .is_empty()
    );
}

#[test]
fn days_relative_to_the_run() {
    let today = crate::timefmt::format_day(START.div_euclid(DAY));
    let tomorrow_start = shifted(DAY);
    let tomorrow = crate::timefmt::format_day((START + DAY).div_euclid(DAY));
    let mk = |d: &str| raw(vec![], vec![], vec![entry(&format!("stats:{d}"), "1", -1)]);
    // Recorded today, verified tomorrow: the daily key is "today" on both.
    assert_match(&diff_w(
        &mk(&today),
        window(),
        &mk(&tomorrow),
        tomorrow_start,
        &Allowances::default(),
    ));
    assert!(!diff(&mk(&today), &mk(&tomorrow)).differences.is_empty());
}

#[test]
fn ports_and_database_names_are_masked() {
    let mk = |port: u16, db: &str| {
        raw(
            vec![http_h(
                302,
                &[
                    ("location", &format!("http://127.0.0.1:{port}/next")),
                    ("x-db", db),
                ],
                b"",
            )],
            vec![],
            vec![],
        )
    };
    let none = Allowances::default();
    let known = Known::default();
    let ra = run_of(&mk(41234, "rig_1_0_ref"), window(), 41234);
    let mut rb = run_of(&mk(50999, "rig_1_1_cand"), window(), 50999);
    rb.run.mongo_db = "rig_1_1_cand".into();
    let o = compare::compare(
        &norm_run(&ra, &known, &none),
        &norm_run(&rb, &known, &none),
        &none,
        compare::Tolerances::default(),
    );
    assert_match(&o);
}

#[test]
fn capture_files_round_trip() {
    let a = ids_a();
    let run = run_of(&scenario_capture(refs(&a), false, 50), window(), 41234);
    let f = file_of(&run);
    let text = capture::to_file_string(&f);
    let back = capture::from_file_json(&serde_json::from_str(&text).unwrap()).unwrap();
    assert_eq!(back, f);
    assert_eq!(capture::to_file_string(&back), text);
    // The stored capture is raw: the generated ids are there as observed.
    assert!(text.contains(&a[0]), "{text}");
    // Normalising the stored run gives what normalising the live run gives.
    let none = Allowances::default();
    assert_eq!(
        norm_run(&through_file(&run), &Known::default(), &none),
        norm_run(&run, &Known::default(), &none)
    );
}

fn hash_entry(key: &[u8], pairs: Vec<(Vec<u8>, Vec<u8>)>) -> RawEntry {
    RawEntry {
        key: key.to_vec(),
        kind: "hash".into(),
        value: RawValue::Hash(pairs),
        pttl: -1,
        pttl_at: START + 3000,
    }
}

#[test]
fn bytes_that_are_not_utf8_never_collide_with_text() {
    let h = |field: Vec<u8>, v: &str| {
        raw(
            vec![],
            vec![],
            vec![hash_entry(b"h", vec![(field, v.as_bytes().to_vec())])],
        )
    };
    // A field with invalid bytes against the field its lossy decoding would give.
    let o = diff(
        &h(vec![b'a', 0xff], "1"),
        &h("a\u{fffd}".as_bytes().to_vec(), "1"),
    );
    assert!(!o.differences.is_empty(), "lossy decoding collided");
    // Two different invalid fields.
    let o = diff(&h(vec![b'a', 0xff], "1"), &h(vec![b'a', 0xfe], "1"));
    assert!(!o.differences.is_empty());
    assert_match(&diff(&h(vec![b'a', 0xff], "1"), &h(vec![b'a', 0xff], "1")));
    // A key name with invalid bytes against a key literally named like its marker.
    let k = |key: &[u8]| raw(vec![], vec![], vec![entry_bytes(key)]);
    let o = diff(&k(&[b'k', 0xff]), &k(b"k<bytes:ff>"));
    assert!(!o.differences.is_empty(), "{:#?}", paths(&o));
    // Ids are still found in the UTF-8 parts of such a key.
    let (a, b) = (oid_at(START + 10, 1), oid_at(START + 20, 2));
    let mk = |id: &str| {
        let mut key = format!("lock:{id}:").into_bytes();
        key.push(0xff);
        raw(
            vec![http(200, json!({"id": id}))],
            vec![],
            vec![entry_bytes(&key)],
        )
    };
    assert_match(&diff(&mk(&a), &mk(&b)));
    // And non-UTF-8 values are bytes, not text.
    let v = |b: Vec<u8>| {
        raw(
            vec![],
            vec![],
            vec![RawEntry {
                key: b"v".to_vec(),
                kind: "string".into(),
                value: RawValue::Str(b),
                pttl: -1,
                pttl_at: START,
            }],
        )
    };
    assert_one(
        &diff(&v(vec![0xff]), &v("\u{fffd}".as_bytes().to_vec())),
        "dragonfly.v.value",
        "type differs",
    );
}

fn entry_bytes(key: &[u8]) -> RawEntry {
    RawEntry {
        key: key.to_vec(),
        kind: "string".into(),
        value: RawValue::Str(b"1".to_vec()),
        pttl: -1,
        pttl_at: START + 3000,
    }
}

#[test]
fn stream_fields_are_ordered_pairs() {
    let s = |fields: &[(&str, &str)]| {
        raw(
            vec![],
            vec![],
            vec![RawEntry {
                key: b"events".to_vec(),
                kind: "stream".into(),
                value: RawValue::Stream(vec![(
                    "1-0".into(),
                    fields
                        .iter()
                        .map(|(f, v)| (f.as_bytes().to_vec(), v.as_bytes().to_vec()))
                        .collect(),
                )]),
                pttl: -1,
                pttl_at: START + 3000,
            }],
        )
    };
    let both = s(&[("tag", "a"), ("tag", "b")]);
    assert_match(&diff(&both, &both));
    let o = diff(&both, &s(&[("tag", "a")]));
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert_one(
        &o,
        "dragonfly.events.value[0].fields[1]",
        "array element missing in candidate",
    );
    // Field order is part of the entry.
    assert!(
        !diff(&s(&[("a", "1"), ("b", "2")]), &s(&[("b", "2"), ("a", "1")]))
            .differences
            .is_empty()
    );
}

#[test]
fn each_ttl_is_relative_to_its_own_reading() {
    // The same expiry, read 5 s apart: equal. With one reading time for every key it would
    // look 5 s shorter.
    let e = |pttl: i64, at: i64| {
        raw(
            vec![],
            vec![],
            vec![RawEntry {
                key: b"k".to_vec(),
                kind: "string".into(),
                value: RawValue::Str(b"v".to_vec()),
                pttl,
                pttl_at: at,
            }],
        )
    };
    assert_match(&diff(&e(60_000, START + 3000), &e(55_000, START + 8000)));
    assert_one(
        &diff(&e(60_000, START + 3000), &e(55_000, START + 3000)),
        "dragonfly.k.ttl",
        "TTL differs",
    );
}

#[test]
fn byte_sensitive_values_compare_as_exact_text() {
    let l = |key: &str, items: &[&str]| {
        raw(
            vec![],
            vec![],
            vec![RawEntry {
                key: key.as_bytes().to_vec(),
                kind: "list".into(),
                value: RawValue::List(items.iter().map(|x| x.as_bytes().to_vec()).collect()),
                pttl: -1,
                pttl_at: START,
            }],
        )
    };
    // Same content, different key order: a difference under a byte-sensitive key ...
    let a = r#"{"id":"j1","job":"memory","n":1}"#;
    let b = r#"{"job":"memory","id":"j1","n":1}"#;
    assert_one(
        &diff(&l("q:jobs", &[a]), &l("q:jobs", &[b])),
        "dragonfly[\"q:jobs\"].value[0]",
        "text differs",
    );
    // ... and a note elsewhere.
    let o = diff(&l("other", &[a]), &l("other", &[b]));
    assert_match(&o);
    assert_eq!(o.notes.len(), 1, "{:#?}", o.notes);
    // Number text, escaping and whitespace count.
    for (x, y) in [
        (r#"{"n":1}"#, r#"{"n":1.0}"#),
        (r#"{"u":"a/b"}"#, r#"{"u":"a\/b"}"#),
        (r#"{"n":1}"#, r#"{"n": 1}"#),
    ] {
        assert!(
            !diff(&l("q:x", &[x]), &l("q:x", &[y]))
                .differences
                .is_empty(),
            "{x} vs {y}"
        );
    }
    // Generated ids and times inside the text are still normalised.
    let (i1, i2) = (oid_at(START + 10, 1), oid_at(START + 20, 2));
    let t = |ms: i64| crate::timefmt::format_iso_ms(ms).unwrap();
    assert_match(&diff(
        &l(
            "q:jobs",
            &[&format!(r#"{{"id":"{i1}","at":"{}"}}"#, t(START + 100))],
        ),
        &l(
            "q:jobs",
            &[&format!(r#"{{"id":"{i2}","at":"{}"}}"#, t(START + 300))],
        ),
    ));
    // A reply to a command on a byte-sensitive key is exact text too.
    let reply = |key: &str, v: &str| {
        raw(
            vec![RawStep::Reply(crate::capture::RawReplyStep {
                at: START + 10,
                command: vec![b"GET".to_vec(), key.as_bytes().to_vec()],
                reply: crate::capture::RawReply::Bulk(v.as_bytes().to_vec()),
            })],
            vec![],
            vec![],
        )
    };
    assert_one(
        &diff(&reply("cas:1", a), &reply("cas:1", b)),
        "steps[0].reply",
        "text differs",
    );
    assert_match(&diff(&reply("plain", a), &reply("plain", b)));
}

#[test]
fn every_header_but_the_noise_is_compared() {
    let h = |hs: &[(&str, &str)]| raw(vec![http_h(200, hs, b"ok")], vec![], vec![]);
    // Noise: date, connection, content-length, x-powered-by.
    assert_match(&diff(
        &h(&[
            ("date", "Wed, 11 Nov 2026 12:00:00 GMT"),
            ("x-powered-by", "Express"),
            ("content-length", "2"),
            ("connection", "keep-alive"),
        ]),
        &h(&[
            ("date", "Wed, 11 Nov 2026 12:00:05 GMT"),
            ("connection", "close"),
        ]),
    ));
    // Anything else, including headers nobody listed.
    assert_one(
        &diff(&h(&[("vary", "Origin")]), &h(&[])),
        "steps[0].headers.vary",
        "header missing in candidate",
    );
    assert_one(
        &diff(&h(&[]), &h(&[("x-request-id", "abc")])),
        "steps[0].headers.x-request-id",
        "header only in candidate",
    );
    assert_one(
        &diff(
            &h(&[("access-control-allow-origin", "*")]),
            &h(&[("access-control-allow-origin", "https://dima.example")]),
        ),
        "steps[0].headers.access-control-allow-origin",
        "text differs",
    );
    // A repeated header keeps its values in order.
    assert!(
        !diff(
            &h(&[("link", "a"), ("link", "b")]),
            &h(&[("link", "b"), ("link", "a")])
        )
        .differences
        .is_empty()
    );
    // ETag: presence and weak/strong form only.
    assert_match(&diff(
        &h(&[("etag", "W/\"1a-abc\"")]),
        &h(&[("etag", "W/\"1a-xyz\"")]),
    ));
    assert_one(
        &diff(
            &h(&[("etag", "W/\"1a-abc\"")]),
            &h(&[("etag", "\"1a-abc\"")]),
        ),
        "steps[0].headers.etag",
        "text differs",
    );
    assert_one(
        &diff(&h(&[("etag", "W/\"1a-abc\"")]), &h(&[])),
        "steps[0].headers.etag",
        "header missing",
    );
    // An HTTP date near the run is a time relative to the run.
    let at = |ms: i64| crate::timefmt::format_http_date(ms).unwrap();
    assert_match(&diff(
        &h(&[("last-modified", &at(START + 1000))]),
        &h(&[("last-modified", &at(START + 2000))]),
    ));
}

#[test]
fn set_cookie_is_compared_attribute_by_attribute() {
    let at = |ms: i64| crate::timefmt::format_http_date(ms).unwrap();
    let cookie = |sid: &str, extra: &str, expires: i64| {
        format!(
            "sid={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Expires={}{extra}",
            at(expires)
        )
    };
    let h = |cookies: &[String]| {
        let hs: Vec<(&str, &str)> = cookies.iter().map(|c| ("set-cookie", c.as_str())).collect();
        raw(vec![http_h(201, &hs, b"ok")], vec![], vec![])
    };
    let (u1, u2) = (
        "0b6f2a4c-1d2e-4f3a-8b9c-0123456789ab",
        "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
    );
    let r = h(&[cookie(u1, "", START + 3_600_000), "theme=dark".into()]);
    // Generated value and expiry relative to the run: a match.
    assert_match(&diff(
        &r,
        &h(&[cookie(u2, "", START + 3_601_000), "theme=dark".into()]),
    ));
    // Attribute order is a note, not a difference.
    let reordered = format!(
        "sid={u2}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600; Expires={}",
        at(START + 3_600_000)
    );
    assert_match(&diff(&r, &h(&[reordered, "theme=dark".into()])));
    // A changed attribute.
    let o = diff(
        &r,
        &h(&[
            cookie(u2, "", START + 3_600_000).replace("Lax", "Strict"),
            "theme=dark".into(),
        ]),
    );
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert_one(
        &o,
        "steps[0].headers.set-cookie.sid.samesite",
        "text differs",
    );
    // A missing flag, an extra attribute.
    let o = diff(
        &r,
        &h(&[
            cookie(u2, "; Secure", START + 3_600_000).replace("HttpOnly; ", ""),
            "theme=dark".into(),
        ]),
    );
    assert_one(
        &o,
        "steps[0].headers.set-cookie.sid.httponly",
        "missing in candidate",
    );
    assert_one(
        &o,
        "steps[0].headers.set-cookie.sid.secure",
        "only in candidate",
    );
    // A cookie that is not set, and no Set-Cookie at all.
    assert_one(
        &diff(&r, &h(&[cookie(u2, "", START + 3_600_000)])),
        "steps[0].headers.set-cookie.theme",
        "missing in candidate",
    );
    assert_one(
        &diff(&r, &h(&[])),
        "steps[0].headers.set-cookie",
        "header missing in candidate",
    );
    // A different lifetime.
    assert_one(
        &diff(
            &r,
            &h(&[cookie(u2, "", START + 60_000), "theme=dark".into()]),
        ),
        "steps[0].headers.set-cookie.sid.expires",
        "run-relative times differ",
    );
}

#[test]
fn seeded_times_compare_by_their_seed_offset() {
    // A `$rigNow: +60s` value written by the seed stays that value; the process start between
    // the seed and the first step (different on each side) does not move it.
    let d = |at: i64| {
        raw(
            vec![],
            vec![(
                "c",
                coll(vec![doc! {"_id": "a", "leaseUntil": (at + MIN) as f64}]),
            )],
            vec![],
        )
    };
    let w = window();
    let slow = Window {
        start: w.start + 1800,
        ..w
    };
    assert_match(&diff_w(
        &d(w.seeded_at),
        w,
        &d(slow.seeded_at),
        slow,
        &Allowances::default(),
    ));
    // Next to a run time, only the order counts: here the reference's gap is a whole number
    // of seconds by chance, the slower candidate's is not.
    let both = |w: Window| {
        raw(
            vec![],
            vec![(
                "c",
                coll(vec![
                    doc! {"_id": "a", "createdAt": date(w.start), "leaseUntil": (w.seeded_at + MIN) as f64},
                ]),
            )],
            vec![],
        )
    };
    assert_match(&diff_w(
        &both(w),
        w,
        &both(slow),
        slow,
        &Allowances::default(),
    ));
    // The candidate rewrote it with its own clock: a run time, not the seeded one.
    assert_one(
        &diff_w(
            &d(w.seeded_at),
            w,
            &d(slow.start),
            slow,
            &Allowances::default(),
        ),
        "mongo.c[0].leaseUntil",
        "seed",
    );
}

#[test]
fn generated_values_spread_only_as_whole_tokens_and_never_onto_inputs() {
    let al = allow(&[("steps[*].body.token", AllowKind::Generated(None))]);
    let mk = |tok: &str, other: &str| {
        raw(
            vec![http(200, json!({"token": tok, "other": other}))],
            vec![],
            vec![],
        )
    };
    // The same token elsewhere, whole or at clear boundaries: followed.
    assert_match(&diff_w(
        &mk("abc12345", "abc12345"),
        window(),
        &mk("zzz98765", "zzz98765"),
        window(),
        &al,
    ));
    assert_match(&diff_w(
        &mk("abc12345", "session:abc12345/x"),
        window(),
        &mk("zzz98765", "session:zzz98765/x"),
        window(),
        &al,
    ));
    // Glued to letters or digits it is not that token: compared as text.
    assert_one(
        &diff_w(
            &mk("abc12345", "Xabc12345"),
            window(),
            &mk("zzz98765", "Xzzz98765"),
            window(),
            &al,
        ),
        "steps[0].body.other",
        "text differs",
    );
    // A value known from the inputs is never generated, not even at the named path.
    let mut known = Known::default();
    known.texts.insert("seed-token-0001".into());
    let ca = norm_w(&mk("seed-token-0001", "-"), window(), &known, &al);
    let cb = norm_w(&mk("other-token-002", "-"), window(), &known, &al);
    assert_one(
        &compare::compare(&ca, &cb, &al, compare::Tolerances::default()),
        "steps[0].body.token",
        "text differs",
    );
    // By pattern too.
    let pat = allow(&[(
        "**",
        AllowKind::Generated(Some(regex::Regex::new("tok_[a-z0-9]+").unwrap())),
    )]);
    let ca = norm_w(&mk("tok_seed01", "-"), window(), &Known::default(), &pat);
    let mut known = Known::default();
    known.texts.insert("Bearer tok_seed01".into());
    let ca2 = norm_w(&mk("tok_seed01", "-"), window(), &known, &pat);
    let cb = norm_w(&mk("tok_other1", "-"), window(), &known, &pat);
    assert_match(&compare::compare(
        &ca,
        &cb,
        &pat,
        compare::Tolerances::default(),
    ));
    assert!(
        !compare::compare(&ca2, &cb, &pat, compare::Tolerances::default())
            .differences
            .is_empty()
    );
}

#[test]
fn generated_object_keys_bind_by_key_and_value() {
    let (a1, a2) = (oid_at(START + 10, 1), oid_at(START + 20, 2));
    let (b1, b2) = (oid_at(START + 30, 3), oid_at(START + 40, 4));
    let body = |pairs: &[(&str, &str)]| {
        let text = format!(
            "{{{}}}",
            pairs
                .iter()
                .map(|(k, v)| format!(r#""{k}":{{"name":"{v}"}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        raw(
            vec![http_h(
                200,
                &[("content-type", "application/json")],
                text.as_bytes(),
            )],
            vec![],
            vec![],
        )
    };
    // The same objects keyed by fresh ids, written in the other order: a match (order is a note).
    let o = diff(
        &body(&[(&a1, "pizza"), (&a2, "ñandú")]),
        &body(&[(&b2, "ñandú"), (&b1, "pizza")]),
    );
    assert_match(&o);
    // Not equivalent: one value differs. Reported once, at that value.
    let o = diff(
        &body(&[(&a1, "pizza"), (&a2, "ñandú")]),
        &body(&[(&b2, "ñandu"), (&b1, "pizza")]),
    );
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    assert!(o.differences[0].path.ends_with(".name"), "{:#?}", paths(&o));
}

// ---------------------------------------------------------------------------------------------
// Outbound calls.

fn call(provider: &str, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> RawCall {
    RawCall {
        at: START + 500,
        provider: provider.into(),
        host: "h".into(),
        method: method.into(),
        path: path.into(),
        query: String::new(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
            .collect(),
        body: body.as_bytes().to_vec(),
        answered: "test".into(),
    }
}

fn with_calls(calls: Vec<RawCall>) -> RawCapture {
    RawCapture {
        calls,
        ..raw(vec![], vec![], vec![])
    }
}

fn diff_calls(a: Vec<RawCall>, b: Vec<RawCall>, rules: &crate::detect::CallRules) -> Outcome {
    let known = Known::default();
    let al = Allowances::default();
    let ca = norm_run_with(
        &through_file(&run_of(&with_calls(a), window(), 41234)),
        &known,
        &al,
        rules,
    );
    let cb = norm_run_with(
        &run_of(&with_calls(b), shifted(MIN), 41234),
        &known,
        &al,
        rules,
    );
    compare::compare(&ca, &cb, &al, compare::Tolerances::default())
}

const JSON: (&str, &str) = ("content-type", "application/json");

#[test]
fn calls_match_when_only_generated_values_differ() {
    let chat = |id: &str, at: i64| {
        let iso = crate::timefmt::format_iso_ms(at).unwrap();
        call(
            "twitch",
            "POST",
            "/helix/chat/messages",
            &[
                JSON,
                ("authorization", "Bearer <redacted>"),
                ("client-id", "c"),
                ("user-agent", "node"),
            ],
            &format!(r#"{{"broadcaster_id":"1001","message":"hola 👋 {id}","sent":"{iso}"}}"#),
        )
    };
    let a = vec![chat(&oid_at(START + 100, 1), START + 100)];
    let mut b = vec![chat(&oid_at(START + MIN + 100, 9), START + MIN + 120)];
    b[0].headers[3].1 = b"undici".to_vec();
    assert_match(&diff_calls(a, b, &Default::default()));
}

#[test]
fn call_differences_are_found_at_their_paths() {
    let prompt = |text: &str| {
        call(
            "openrouter",
            "POST",
            "/api/v1/chat/completions",
            &[JSON, ("authorization", "Bearer <redacted>")],
            &format!(r#"{{"model":"m","messages":[{{"role":"system","content":"{text}"}}]}}"#),
        )
    };
    // The prompt text compares exactly.
    let o = diff_calls(
        vec![prompt("Eres un bot.")],
        vec![prompt("Eres un bot. ")],
        &Default::default(),
    );
    assert_one(
        &o,
        "calls.openrouter[0].body.messages[0].content",
        "text differs",
    );
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    // Key order counts for a provider that caches prompts ...
    let reordered = call(
        "openrouter",
        "POST",
        "/api/v1/chat/completions",
        &[JSON, ("authorization", "Bearer <redacted>")],
        r#"{"messages":[{"role":"system","content":"Eres un bot."}],"model":"m"}"#,
    );
    let o = diff_calls(
        vec![prompt("Eres un bot.")],
        vec![reordered],
        &Default::default(),
    );
    assert_one(&o, "calls.openrouter[0].body", "key order");
    // ... and is only a note elsewhere.
    let tw = |body: &str| call("twitch", "POST", "/helix/chat/messages", &[JSON], body);
    let o = diff_calls(
        vec![tw(r#"{"a":"1","b":"2"}"#)],
        vec![tw(r#"{"b":"2","a":"1"}"#)],
        &Default::default(),
    );
    assert_match(&o);
    assert!(!o.notes.is_empty());
    // The authorization scheme counts, never the value; an extra call is one difference.
    let o = diff_calls(
        vec![call(
            "twitch-id",
            "GET",
            "/oauth2/validate",
            &[("authorization", "OAuth <redacted>")],
            "",
        )],
        vec![
            call(
                "twitch-id",
                "GET",
                "/oauth2/validate",
                &[("authorization", "Bearer <redacted>")],
                "",
            ),
            call(
                "twitch-id",
                "GET",
                "/oauth2/validate",
                &[("authorization", "Bearer <redacted>")],
                "",
            ),
        ],
        &Default::default(),
    );
    assert!(
        o.differences
            .iter()
            .any(|d| d.what.contains("call only in candidate")),
        "{:#?}",
        paths(&o)
    );
    // A call to a provider the reference never called.
    let o = diff_calls(
        vec![],
        vec![call("resend", "POST", "/emails", &[JSON], "{}")],
        &Default::default(),
    );
    assert_one(&o, "calls.resend[0]", "call only in candidate");
}

#[test]
fn call_order_per_provider() {
    let ev = |name: &str| {
        call(
            "posthog",
            "POST",
            "/batch",
            &[JSON],
            &format!(r#"{{"event":"{name}"}}"#),
        )
    };
    let tw = |m: &str| {
        call(
            "twitch",
            "POST",
            "/helix/chat/messages",
            &[JSON],
            &format!(r#"{{"message":"{m}"}}"#),
        )
    };
    // PostHog flushes on its own timer: a multiset by default.
    assert_match(&diff_calls(
        vec![ev("a"), ev("b")],
        vec![ev("b"), ev("a")],
        &Default::default(),
    ));
    // Twitch chat is ordered: the same two messages swapped are two differences.
    let o = diff_calls(
        vec![tw("1"), tw("2")],
        vec![tw("2"), tw("1")],
        &Default::default(),
    );
    assert_eq!(o.differences.len(), 2, "{:#?}", paths(&o));
    // A scenario may compare one provider as a multiset, or not at all.
    let mut rules = crate::detect::CallRules::default();
    rules
        .order
        .insert("twitch".into(), crate::mock::providers::CallOrder::Multiset);
    assert_match(&diff_calls(
        vec![tw("1"), tw("2")],
        vec![tw("2"), tw("1")],
        &rules,
    ));
    rules
        .order
        .insert("twitch".into(), crate::mock::providers::CallOrder::Ignore);
    assert_match(&diff_calls(vec![tw("1")], vec![], &rules));
    // OTLP log records are recorded, not compared.
    assert_match(&diff_calls(
        vec![call(
            "otlp-logs",
            "POST",
            "/i/v1/logs",
            &[JSON],
            r#"{"x":1}"#,
        )],
        vec![],
        &Default::default(),
    ));
}

#[test]
fn call_bodies_by_content_type() {
    let gz = |s: &str| {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut e, s.as_bytes()).unwrap();
        e.finish().unwrap()
    };
    let mut a = call(
        "posthog",
        "POST",
        "/batch",
        &[JSON, ("content-encoding", "gzip")],
        "",
    );
    a.body = gz(r#"{"batch":[{"event":"x","properties":{"n":1}}]}"#);
    let mut b = a.clone();
    b.body = gz(r#"{"batch":[{"event":"x","properties":{"n":2}}]}"#);
    let o = diff_calls(vec![a], vec![b], &Default::default());
    assert_one(
        &o,
        "calls.posthog[0].body.batch[0].properties.n",
        "number differs",
    );
    let form = ("content-type", "application/x-www-form-urlencoded");
    let o = diff_calls(
        vec![call(
            "twitch-id",
            "POST",
            "/oauth2/token",
            &[form],
            "grant_type=client_credentials&client_id=a",
        )],
        vec![call(
            "twitch-id",
            "POST",
            "/oauth2/token",
            &[form],
            "client_id=a&grant_type=refresh_token",
        )],
        &Default::default(),
    );
    assert_one(&o, "calls.twitch-id[0].body.grant_type", "text differs");
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
    let o = diff_calls(
        vec![call(
            "piper",
            "POST",
            "/synthesize",
            &[("content-type", "text/plain")],
            "hola",
        )],
        vec![call(
            "piper",
            "POST",
            "/synthesize",
            &[("content-type", "text/plain")],
            "adiós",
        )],
        &Default::default(),
    );
    assert_one(&o, "calls.piper[0].text", "text differs");
}

// ---------------------------------------------------------------------------------------------
// From the first service port.

#[test]
fn ttl_fields_compare_as_the_moment_they_end() {
    let body = |ttl: i64, at: i64| {
        RawStep::Http(RawHttp {
            at,
            status: 200,
            headers: vec![("content-type".into(), b"application/json".to_vec())],
            body: format!(r#"{{"ttl":{ttl},"none":-1}}"#).into_bytes(),
        })
    };
    let al = allow(&[("steps[*].body.ttl", AllowKind::Ttl { seconds: true })]);
    // The reference read 59 s left at +1.0 s, the candidate 58 s left at +1.6 s: the same end.
    let a = raw(vec![body(59, START + 1000)], vec![], vec![]);
    let b = raw(vec![body(58, START + MIN + 1600)], vec![], vec![]);
    let o = diff_w(&a, window(), &b, shifted(MIN), &al);
    assert_match(&o);
    // An expiry an hour off is a difference; -1 (no TTL) stays a number.
    let c = raw(vec![body(3659, START + MIN + 1600)], vec![], vec![]);
    let o = diff_w(&a, window(), &c, shifted(MIN), &al);
    assert_one(&o, "steps[0].body.ttl", "run-relative times differ");
    assert_eq!(o.differences.len(), 1, "{:#?}", paths(&o));
}

#[test]
fn date_only_and_epoch_second_inputs_are_known() {
    let p = Patterns::new().unwrap();
    let mut known = Known::default();
    let day = crate::timefmt::format_day(START.div_euclid(DAY));
    p.collect_known(&format!("{{\"day\":\"{day}\"}}"), &mut known);
    crate::detect::collect_known_json(&p, &json!({"at": START / 1000}), &mut known);
    let midnight = START.div_euclid(DAY) * DAY;
    assert!(known.times.contains(&midnight), "the date's midnight");
    assert!(
        known.times.contains(&(START / 1000 * 1000)),
        "epoch seconds as ms"
    );
    // The application stores that date: a run a day later still matches, because the value
    // is known from the request (without it, it would read as a run time a day off).
    let d = raw(
        vec![],
        vec![("days", coll(vec![doc! {"_id": 1, "day": date(midnight)}]))],
        vec![],
    );
    let ca = norm_w(&d, window(), &known, &Allowances::default());
    let cb = norm_w(&d, shifted(DAY), &known, &Allowances::default());
    assert_match(&compare::compare(
        &ca,
        &cb,
        &Allowances::default(),
        compare::Tolerances::default(),
    ));
    let none = Known::default();
    let ca = norm_w(&d, window(), &none, &Allowances::default());
    let cb = norm_w(&d, shifted(DAY), &none, &Allowances::default());
    let o = compare::compare(
        &ca,
        &cb,
        &Allowances::default(),
        compare::Tolerances::default(),
    );
    assert_one(&o, "mongo.days[0].day", "run-relative times differ");
}

#[test]
fn binary_command_arguments() {
    let cmd =
        crate::scenario::tests_command(&[json!("SET"), json!("k"), json!({"$rigBytes": "/wA="})]);
    assert!(matches!(cmd.get(2), Some(crate::scenario::Arg::Bytes(b)) if b == &vec![0xff, 0x00]));
    assert!(
        crate::scenario::tests_command_err(&[
            json!("SET"),
            json!("k"),
            json!({"$rigBytes": "/wA=", "x": 1})
        ])
        .contains("$rigBytes")
    );
}

#[test]
fn minute_windows_compare_relative_to_the_run() {
    let minute = |at: i64| {
        RawStep::Http(RawHttp {
            at,
            status: 200,
            headers: vec![("content-type".into(), b"application/json".to_vec())],
            body: format!(r#"{{"window":{},"text":"{}"}}"#, at / 60_000, at / 60_000).into_bytes(),
        })
    };
    let al = allow(&[
        ("steps[*].body.window", AllowKind::Minutes),
        ("steps[*].body.text", AllowKind::Minutes),
    ]);
    // A day apart, and the candidate's minute rolled over during its run: still the same.
    let a = raw(vec![minute(START + 1000)], vec![], vec![]);
    let b = raw(vec![minute(START + DAY + 59_000)], vec![], vec![]);
    assert_match(&diff_w(&a, window(), &b, shifted(DAY), &al));
    // Ten minutes off is a difference.
    let c = raw(vec![minute(START + DAY + 600_000)], vec![], vec![]);
    let o = diff_w(&a, window(), &c, shifted(DAY), &al);
    assert_one(&o, "steps[0].body.window", "minute precision");
    assert_one(&o, "steps[0].body.text", "minute precision");
}

#[test]
fn times_written_during_start_up_compare_as_such() {
    // Own process: seeded, then the process starts, then the first step.
    let w = |boot: i64| Window {
        start: START,
        end: START + 3000,
        proc_start: START - boot,
        seeded_at: START - boot - 500,
    };
    let doc_at = |t: i64| {
        raw(
            vec![],
            vec![(
                "clients",
                coll(vec![
                    doc! {"_id": 1, "createdAt": date(t), "updatedAt": date(t)},
                ]),
            )],
            vec![RawEntry {
                key: b"app:token".to_vec(),
                kind: "string".into(),
                value: RawValue::Str(b"t".to_vec()),
                pttl: 5_000_000_000 - (START + 3000 - t),
                pttl_at: START + 3000,
            }],
        )
    };
    let with_startup = |mut r: RawCapture, t: i64| {
        r.startup_keys = vec![(b"app:token".to_vec(), t + 5_000_000_000)];
        r
    };
    // The reference took 7 s to start and wrote 6 s before the first step; the candidate
    // started in 100 ms and wrote 50 ms before it: both wrote during start-up, same TTL length.
    let a = with_startup(doc_at(START - 6000), START - 6000);
    let b = with_startup(doc_at(START - 50), START - 50);
    let known = Known::default();
    let al = Allowances::default();
    let ca = norm_run(
        &RawRun {
            raw: a.clone(),
            run: meta(w(7000), 41234),
        },
        &known,
        &al,
    );
    let cb = norm_run(
        &RawRun {
            raw: b,
            run: meta(w(100), 41234),
        },
        &known,
        &al,
    );
    assert_match(&compare::compare(
        &ca,
        &cb,
        &al,
        compare::Tolerances::default(),
    ));
    // A candidate that writes during the run instead, with a TTL a day shorter.
    let mut late = doc_at(START + 500);
    late.dragonfly[0].pttl -= 86_400_000;
    let cl = norm_run(
        &RawRun {
            raw: late,
            run: meta(w(100), 41234),
        },
        &known,
        &al,
    );
    let o = compare::compare(&ca, &cl, &al, compare::Tolerances::default());
    assert_one(&o, "mongo.clients[0].createdAt", "during start-up");
    assert_one(&o, r#"dragonfly["app:token"].ttl"#, "during start-up");
    // A start-up TTL of another length.
    let mut short = with_startup(doc_at(START - 50), START - 50);
    short.dragonfly[0].pttl -= 86_400_000;
    short.startup_keys[0].1 -= 86_400_000;
    let cs = norm_run(
        &RawRun {
            raw: short,
            run: meta(w(100), 41234),
        },
        &known,
        &al,
    );
    let o = compare::compare(&ca, &cs, &al, compare::Tolerances::default());
    assert_one(
        &o,
        r#"dragonfly["app:token"].ttl"#,
        "TTLs set during start-up differ",
    );
}
