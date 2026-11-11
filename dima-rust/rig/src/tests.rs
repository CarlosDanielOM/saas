//! Normalisation and comparison, end to end on hand-built captures (no stores, no processes).

use std::collections::BTreeMap;

use bson::{Bson, Document, doc, oid::ObjectId};
use serde_json::{Value, json};

use crate::allow::{AllowKind, Allowances};
use crate::capture::{
    self, Capture, CaptureMeta, RawCapture, RawColl, RawEntry, RawHttp, RawStep, RawValue,
};
use crate::compare::{self, Outcome};
use crate::detect::tests::{START, oid_at, window};
use crate::detect::{DEFAULT_HEADERS, Known, Patterns, Window};
use crate::path::Pattern;
use crate::run::{RawRun, normalise};

const MIN: i64 = 60_000;
const DAY: i64 = 86_400_000;

fn http(status: u16, body: Value) -> RawStep {
    RawStep::Http(RawHttp {
        status,
        headers: vec![
            (
                "content-type".into(),
                "application/json; charset=utf-8".into(),
            ),
            ("x-powered-by".into(), "whatever".into()),
        ],
        body: serde_json::to_vec(&body).unwrap(),
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
        steps,
        mongo: mongo
            .into_iter()
            .map(|(n, c)| (n.to_string(), c))
            .collect::<BTreeMap<_, _>>(),
        dragonfly,
        captured_at: START + 3000,
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

fn norm_w(r: &RawCapture, w: Window, known: &Known, a: &Allowances) -> Capture {
    let p = Patterns::new().unwrap();
    let headers: Vec<String> = DEFAULT_HEADERS.iter().map(|s| s.to_string()).collect();
    let run = RawRun {
        raw: r.clone(),
        window: w,
        names: vec![("127.0.0.1:41234".into(), "port.http".into())],
    };
    normalise(&run, known, &headers, &[], a, &p)
}

fn shifted(ms: i64) -> Window {
    let w = window();
    Window {
        start: w.start + ms,
        end: w.end + ms,
        proc_start: w.proc_start + ms,
    }
}

fn diff_w(a: &RawCapture, wa: Window, b: &RawCapture, wb: Window, al: &Allowances) -> Outcome {
    let known = Known::default();
    let ca = norm_w(a, wa, &known, al);
    let cb = norm_w(b, wb, &known, al);
    // Through the file format, as `verify` reads the reference.
    let meta = CaptureMeta {
        target: "t".into(),
        scenario: "s".into(),
        scenario_hash: "h".into(),
    };
    let ca = capture::from_file_json(&capture::to_file_json(&meta, &ca))
        .unwrap()
        .1;
    compare::compare(&ca, &cb, al, compare::DEFAULT_TOLERANCE_MS)
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
    let meta = CaptureMeta {
        target: "t".into(),
        scenario: "s".into(),
        scenario_hash: "h".into(),
    };
    let (fa, fb) = (
        capture::to_file_string(&meta, &ca),
        capture::to_file_string(&meta, &cb),
    );
    assert_eq!(fa, fb, "captures differ");
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
    let o = compare::compare(&ca, &cb, &p, 2000);
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
fn constant_dates_near_the_run_match_across_days() {
    // A fixed date ten days ahead (from configuration, not from "now"): recorded today, verified
    // five days later. The absolute value is kept for times outside the run window.
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
    assert_match(&diff_w(
        &mk(),
        window(),
        &mk(),
        shifted(5 * DAY),
        &Allowances::default(),
    ));
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
            vec![RawStep::Http(RawHttp {
                status: 200,
                headers: vec![("content-type".into(), ct.into())],
                body: b"{}".to_vec(),
            })],
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
        "header differs",
    );
}

#[test]
fn key_order_is_a_note_not_a_difference() {
    let a = raw(
        vec![RawStep::Http(RawHttp {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: br#"{"a":1,"b":2}"#.to_vec(),
        })],
        vec![],
        vec![],
    );
    let b = raw(
        vec![RawStep::Http(RawHttp {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: br#"{"b":2,"a":1}"#.to_vec(),
        })],
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
    let mut a = raw(
        vec![RawStep::Http(RawHttp {
            status: 302,
            headers: vec![("location".into(), "http://127.0.0.1:41234/next".into())],
            body: vec![],
        })],
        vec![],
        vec![],
    );
    let p = Patterns::new().unwrap();
    let headers: Vec<String> = DEFAULT_HEADERS.iter().map(|s| s.to_string()).collect();
    let none = Allowances::default();
    let ra = RawRun {
        raw: a.clone(),
        window: window(),
        names: vec![("127.0.0.1:41234".into(), "port.http".into())],
    };
    if let RawStep::Http(h) = &mut a.steps[0] {
        h.headers[0].1 = "http://127.0.0.1:50999/next".into();
    }
    let rb = RawRun {
        raw: a,
        window: window(),
        names: vec![("127.0.0.1:50999".into(), "port.http".into())],
    };
    let ca = normalise(&ra, &Known::default(), &headers, &[], &none, &p);
    let cb = normalise(&rb, &Known::default(), &headers, &[], &none, &p);
    assert_match(&compare::compare(&ca, &cb, &none, 2000));
}

#[test]
fn capture_files_round_trip() {
    let a = ids_a();
    let cap = norm_w(
        &scenario_capture(refs(&a), false, 50),
        window(),
        &Known::default(),
        &Allowances::default(),
    );
    let meta = CaptureMeta {
        target: "t".into(),
        scenario: "s".into(),
        scenario_hash: "h".into(),
    };
    let text = capture::to_file_string(&meta, &cap);
    let v: Value = serde_json::from_str(&text).unwrap();
    let (m2, c2) = capture::from_file_json(&v).unwrap();
    assert_eq!(m2, meta);
    assert_eq!(c2, cap);
    assert_eq!(capture::to_file_string(&m2, &c2), text);
    // Unknown versions are refused with a hint.
    let mut old = v.clone();
    old["rig_capture"] = json!(0);
    assert!(
        capture::from_file_json(&old)
            .unwrap_err()
            .contains("re-record")
    );
}
