//! Comparison of two normalised captures.
//!
//! Generated identifiers are matched by binding: the first time reference `<oid:2>` meets
//! candidate `<oid:5>` they are bound, and every later meeting must agree (a broken cross-reference
//! is a difference). Documents and Dragonfly keys are paired by content, then by identity, then by
//! similarity, so one extra document does not misalign the rest.
//!
//! Forgiven by default: JSON object key order (reported as a note), JSON numbers that are equal
//! by value (`5` and `5.0`), run-relative times within the tolerance. Nothing else.
//!
//! Times are compared twice. Each run-relative time against its counterpart, relative to its own
//! side's run start, within the window tolerance (2 s): the coarse check. Then the relations
//! between the times of one unit (a document, a response, a Dragonfly entry, a reply) must match
//! the reference: where the reference shows one clock reading used twice (a difference of zero),
//! the candidate must too; where it shows a whole number of seconds of at least one second (a
//! lease or expiry computed as now plus a constant), the candidate's difference must be the same
//! within the relation tolerance (50 ms); otherwise the order must be the same (a difference
//! within the relation tolerance may become zero, never reversed). Times with one-second
//! precision (epoch seconds, HTTP dates, ISO without milliseconds, TTLs) take part only by order,
//! and only when more than a second apart.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;
use serde_json::Number;

use crate::allow::Allowances;
use crate::capture::{Body, Capture, CollCap, EntryCap, StepCap};
use crate::path::{Path, Seg as PSeg};
use crate::timefmt::human_duration;
use crate::value::{Id, IdKind, Moment, Seg, Text, Val};

/// Time tolerance when the scenario sets none.
pub const DEFAULT_TOLERANCE_MS: i64 = 2000;
/// Tolerance of a fixed duration between two times of one unit, when the scenario sets none.
pub const DEFAULT_RELATION_TOLERANCE_MS: i64 = 50;
/// Units with more times than this check the order of neighbours only (and each fixed
/// duration and equality between neighbours), not every pair.
const ALL_PAIRS_LIMIT: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tolerances {
    /// A run-relative time against its counterpart.
    pub window_ms: i64,
    /// A fixed duration between two times of one unit.
    pub relation_ms: i64,
}

impl Default for Tolerances {
    fn default() -> Self {
        Tolerances {
            window_ms: DEFAULT_TOLERANCE_MS,
            relation_ms: DEFAULT_RELATION_TOLERANCE_MS,
        }
    }
}

/// One time of a unit, on both sides: milliseconds relative to each side's run start.
#[derive(Debug, Clone)]
struct TimeObs {
    path: Path,
    /// Which time inside a string (strings may hold several).
    label: String,
    r: i64,
    c: i64,
    /// Millisecond precision on both sides.
    fine: bool,
    /// A value the seed wrote (`$rigNow`): anchored at the seed, not at the run start.
    seeded: bool,
}
const SHOW: usize = 240;
/// Above this many reference × candidate items, skip the quadratic matching passes.
const QUADRATIC_LIMIT: usize = 250_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Finding {
    pub path: String,
    pub what: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub differences: Vec<Finding>,
    pub notes: Vec<Finding>,
}

struct State {
    probe: bool,
    failed: bool,
    journal: usize,
}

pub struct Comparator<'a> {
    allow: &'a Allowances,
    tolerance: i64,
    relation: i64,
    /// Times of the current unit, in the reference's order.
    unit: Vec<TimeObs>,
    /// Paths with a difference in the current unit (their relations are not checked again).
    flagged: HashSet<String>,
    fwd: HashMap<(IdKind, u32), u32>,
    back: HashMap<(IdKind, u32), u32>,
    journal: Vec<(IdKind, u32, u32)>,
    probe: bool,
    failed: bool,
    in_json_text: bool,
    context: Option<String>,
    out: Outcome,
}

fn show(v: &Val) -> String {
    v.short(SHOW)
}

fn exact_int(n: &Number) -> Option<i128> {
    if let Some(i) = n.as_i64() {
        return Some(i128::from(i));
    }
    if let Some(u) = n.as_u64() {
        return Some(i128::from(u));
    }
    let f = n.as_f64()?;
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.2e18 {
        Some(f as i128)
    } else {
        None
    }
}

fn json_num_eq(a: &Number, b: &Number) -> bool {
    match (exact_int(a), exact_int(b)) {
        (Some(x), Some(y)) => x == y,
        (None, None) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}

fn f64_eq(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// Content with generated values masked, used to pair documents and keys.
pub fn mask(v: &Val) -> String {
    fn text(t: &Text) -> String {
        let mut s = String::new();
        for seg in &t.0 {
            match seg {
                Seg::Lit(l) => s.push_str(l),
                Seg::Id(Id::Lit(v)) => s.push_str(v),
                Seg::Id(_) => s.push_str("<id>"),
                Seg::Time { shape, .. } => s.push_str(&format!("<t|{shape}>")),
                Seg::Day { .. } => s.push_str("<day>"),
                Seg::Name(n) => s.push_str(&format!("<run:{n}>")),
                Seg::Bytes(b) => s.push_str(&format!("<B:{}>", crate::value::hex(b))),
            }
        }
        serde_json::to_string(&s).unwrap_or(s)
    }
    match v {
        Val::Oid(Id::Lit(x)) | Val::Uuid(Id::Lit(x)) => format!("I{x}"),
        Val::Oid(_) | Val::Uuid(_) => "I<id>".into(),
        Val::Time(r, Moment::Abs(ms)) => format!("T{r:?}{ms}"),
        Val::Time(r, Moment::Seed { seed, .. }) => format!("T{r:?}seed{seed}"),
        Val::Time(r, _) => format!("T{r:?}"),
        Val::Str(t) => format!("S{}", text(t)),
        Val::Json(inner) => format!("J{}", mask(inner)),
        Val::Arr(items) => format!("[{}]", items.iter().map(mask).collect::<Vec<_>>().join(",")),
        Val::Obj(kv) => {
            let mut parts: Vec<String> = kv
                .iter()
                .map(|(k, x)| format!("{}:{}", text(k), mask(x)))
                .collect();
            parts.sort();
            format!("{{{}}}", parts.join(","))
        }
        Val::Num(n) => format!(
            "N{}",
            n.as_f64()
                .map_or_else(|| n.to_string(), |f| format!("{f:?}"))
        ),
        other => serde_json::to_string(&crate::value::encode(other)).unwrap_or_default(),
    }
}

fn mask_text(t: &Text) -> String {
    mask(&Val::Str(t.clone()))
}

fn doc_id(v: &Val) -> Option<&Val> {
    match v {
        Val::Obj(kv) => kv
            .iter()
            .find(|(k, _)| k.as_plain() == Some("_id"))
            .map(|(_, x)| x),
        _ => None,
    }
}

/// `mongo.<collection>.indexes.<name>.key`: the order of fields in an index key is meaningful.
fn order_matters(path: &Path) -> bool {
    matches!(path.0.as_slice(), [PSeg::Key(m), PSeg::Key(_), PSeg::Key(i), PSeg::Key(_), PSeg::Key(k)]
        if m == "mongo" && i == "indexes" && k == "key")
}

impl<'a> Comparator<'a> {
    pub fn new(allow: &'a Allowances, tol: Tolerances) -> Comparator<'a> {
        Comparator {
            allow,
            tolerance: tol.window_ms,
            relation: tol.relation_ms,
            unit: Vec::new(),
            flagged: HashSet::new(),
            fwd: HashMap::new(),
            back: HashMap::new(),
            journal: Vec::new(),
            probe: false,
            failed: false,
            in_json_text: false,
            context: None,
            out: Outcome::default(),
        }
    }

    fn diff(&mut self, path: &Path, what: impl Into<String>, r: Option<String>, c: Option<String>) {
        if self.probe {
            self.failed = true;
            return;
        }
        self.flagged.insert(path.to_string());
        self.out.differences.push(Finding {
            path: path.to_string(),
            what: what.into(),
            reference: r,
            candidate: c,
            context: self.context.clone(),
        });
    }

    fn note(&mut self, path: &Path, what: impl Into<String>, r: Option<String>, c: Option<String>) {
        if !self.probe {
            self.out.notes.push(Finding {
                path: path.to_string(),
                what: what.into(),
                reference: r,
                candidate: c,
                context: self.context.clone(),
            });
        }
    }

    fn ignored(&self, path: &Path) -> bool {
        self.allow.ignored(path, !self.probe)
    }

    fn tol(&self, path: &Path) -> i64 {
        self.allow
            .tolerance(path, !self.probe)
            .unwrap_or(self.tolerance)
    }

    fn save(&mut self) -> State {
        State {
            probe: self.probe,
            failed: self.failed,
            journal: self.journal.len(),
        }
    }

    fn rollback(&mut self, to: usize) {
        while self.journal.len() > to {
            if let Some((k, a, b)) = self.journal.pop() {
                self.fwd.remove(&(k, a));
                self.back.remove(&(k, b));
            }
        }
    }

    /// Run `f` without recording findings; keep its bindings only when it found no difference
    /// and `commit` is set.
    fn probe_with(&mut self, commit: bool, f: impl FnOnce(&mut Self)) -> bool {
        let saved = self.save();
        self.probe = true;
        self.failed = false;
        f(self);
        let equal = !self.failed;
        if !equal || !commit {
            self.rollback(saved.journal);
        }
        self.probe = saved.probe;
        self.failed = saved.failed;
        equal
    }

    fn ids(&mut self, a: &Id, b: &Id) -> Result<(), String> {
        match (a, b) {
            (Id::Lit(x), Id::Lit(y)) if x == y => Ok(()),
            (Id::Lit(_), Id::Lit(_)) => Err("identifiers differ".into()),
            (Id::Gen(k1, n1), Id::Gen(k2, n2)) => {
                if k1 != k2 {
                    return Err("different kinds of generated identifier".into());
                }
                match (self.fwd.get(&(*k1, *n1)), self.back.get(&(*k2, *n2))) {
                    (Some(m), _) if m == n2 => Ok(()),
                    (Some(m), _) => Err(format!(
                        "cross-reference differs: reference <{0}:{n1}> is candidate <{0}:{m}> elsewhere, but here candidate has <{0}:{n2}>",
                        k1.tag()
                    )),
                    (None, Some(m)) => Err(format!(
                        "cross-reference differs: candidate <{0}:{n2}> is reference <{0}:{m}> elsewhere, but here reference has <{0}:{n1}>",
                        k1.tag()
                    )),
                    (None, None) => {
                        self.fwd.insert((*k1, *n1), *n2);
                        self.back.insert((*k2, *n2), *n1);
                        self.journal.push((*k1, *n1, *n2));
                        Ok(())
                    }
                }
            }
            (Id::Lit(_), Id::Gen(..)) => {
                Err("reference has a fixed identifier, candidate a generated one".into())
            }
            (Id::Gen(..), Id::Lit(_)) => {
                Err("reference has a generated identifier, candidate a fixed one".into())
            }
            _ => Err("internal: identifier was not numbered".into()),
        }
    }

    fn moments(&self, path: &Path, a: &Moment, b: &Moment) -> Result<(), String> {
        match (a, b) {
            (Moment::Abs(x), Moment::Abs(y)) => {
                if x == y {
                    Ok(())
                } else {
                    Err(format!("times differ by {}", human_duration(y - x)))
                }
            }
            // Relative to each side's own run start only: the same absolute time on both sides
            // (a candidate replaying the reference's timestamp) is not a match.
            (Moment::Rel { off: x, .. }, Moment::Rel { off: y, .. }) => {
                let tol = self.tol(path);
                if (x - y).abs() <= tol {
                    Ok(())
                } else {
                    Err(format!(
                        "run-relative times differ by {} (tolerance {})",
                        human_duration(y - x),
                        human_duration(tol)
                    ))
                }
            }
            (Moment::Abs(x), Moment::Rel { abs: Some(y), .. })
            | (Moment::Rel { abs: Some(y), .. }, Moment::Abs(x))
                if x == y =>
            {
                Ok(())
            }
            (Moment::Seed { seed: x, .. }, Moment::Seed { seed: y, .. }) => {
                if x == y {
                    Ok(())
                } else {
                    Err(format!(
                        "seeded times differ: reference seed{}, candidate seed{}",
                        crate::timefmt::format_offset(*x),
                        crate::timefmt::format_offset(*y)
                    ))
                }
            }
            (Moment::Seed { seed, .. }, _) => Err(format!(
                "reference keeps the seeded time seed{}, candidate has another time",
                crate::timefmt::format_offset(*seed)
            )),
            (_, Moment::Seed { seed, .. }) => Err(format!(
                "candidate has the seeded time seed{}, reference another time",
                crate::timefmt::format_offset(*seed)
            )),
            _ => Err("one side has a fixed time, the other a time relative to the run".into()),
        }
    }

    fn text(&mut self, path: &Path, a: &Text, b: &Text) -> Result<(), String> {
        if a.0.len() != b.0.len() {
            return Err("text differs".into());
        }
        for (x, y) in a.0.iter().zip(&b.0) {
            match (x, y) {
                (Seg::Lit(p), Seg::Lit(q)) if p == q => {}
                (Seg::Id(p), Seg::Id(q)) => self.ids(p, q)?,
                (Seg::Time { at: p, shape: sp }, Seg::Time { at: q, shape: sq }) => {
                    if sp != sq {
                        return Err(format!("time written in a different format ({sp} vs {sq})"));
                    }
                    self.moments(path, p, q)?;
                }
                (Seg::Day { off: p, .. }, Seg::Day { off: q, .. }) => {
                    if p != q {
                        return Err(format!("days differ by {}", q - p));
                    }
                }
                (Seg::Name(p), Seg::Name(q)) if p == q => {}
                (Seg::Bytes(p), Seg::Bytes(q)) if p == q => {}
                (Seg::Bytes(_), _) | (_, Seg::Bytes(_)) => {
                    return Err(
                        "text differs (bytes that are not UTF-8 on one side or both)".into(),
                    );
                }
                _ => return Err("text differs".into()),
            }
        }
        Ok(())
    }

    fn val(&mut self, path: &mut Path, a: &Val, b: &Val) {
        if self.probe && self.failed {
            return;
        }
        if self.ignored(path) {
            return;
        }
        let type_diff = |s: &mut Self, path: &Path| {
            s.diff(
                path,
                format!(
                    "type differs: reference {}, candidate {}",
                    a.type_name(),
                    b.type_name()
                ),
                Some(show(a)),
                Some(show(b)),
            )
        };
        match (a, b) {
            (Val::Null, Val::Null) => {}
            (Val::Bool(x), Val::Bool(y)) => {
                if x != y {
                    self.diff(path, "value differs", Some(show(a)), Some(show(b)));
                }
            }
            (Val::Num(x), Val::Num(y)) => {
                let tol = self.allow.tolerance(path, !self.probe);
                let equal = match (tol, x.as_f64(), y.as_f64()) {
                    (Some(t), Some(p), Some(q)) => (p - q).abs() <= t as f64,
                    _ => json_num_eq(x, y),
                };
                if !equal {
                    self.diff(
                        path,
                        "number differs",
                        Some(x.to_string()),
                        Some(y.to_string()),
                    );
                } else if self.in_json_text && x.is_f64() != y.is_f64() {
                    self.note(
                        path,
                        "same number written differently in stored JSON",
                        Some(x.to_string()),
                        Some(y.to_string()),
                    );
                }
            }
            (Val::Int32(x), Val::Int32(y)) => self.int(path, i64::from(*x), i64::from(*y), a, b),
            (Val::Int64(x), Val::Int64(y)) => self.int(path, *x, *y, a, b),
            (Val::Double(x), Val::Double(y)) => {
                let equal = match self.allow.tolerance(path, !self.probe) {
                    Some(t) => (x - y).abs() <= t as f64,
                    None => f64_eq(*x, *y),
                };
                if !equal {
                    self.diff(path, "number differs", Some(show(a)), Some(show(b)));
                }
            }
            (Val::Dec(x), Val::Dec(y)) => {
                if x != y {
                    self.diff(path, "number differs", Some(show(a)), Some(show(b)));
                }
            }
            (Val::Time(r1, m1), Val::Time(r2, m2)) => {
                if r1 != r2 {
                    type_diff(self, path);
                } else if let Err(why) = self.moments(path, m1, m2) {
                    self.diff(path, why, Some(show(a)), Some(show(b)));
                }
                self.observe(path, String::new(), m1, m2, r1.fine() && r2.fine());
            }
            (Val::Oid(x), Val::Oid(y)) | (Val::Uuid(x), Val::Uuid(y)) => {
                if let Err(why) = self.ids(x, y) {
                    self.diff(path, why, Some(show(a)), Some(show(b)));
                }
            }
            (Val::Str(x), Val::Str(y)) => {
                if let Err(why) = self.text(path, x, y) {
                    let what = if x.as_plain() == Some("") || y.as_plain() == Some("") {
                        format!("{why} (one side is empty)")
                    } else {
                        why
                    };
                    self.diff(path, what, Some(show(a)), Some(show(b)));
                } else {
                    let times = x.0.iter().zip(&y.0).filter_map(|p| match p {
                        (Seg::Time { at: m1, shape: s1 }, Seg::Time { at: m2, .. }) => {
                            Some((*m1, *m2, shape_is_fine(s1)))
                        }
                        _ => None,
                    });
                    let times: Vec<_> = times.collect();
                    let several = times.len() > 1;
                    for (k, (m1, m2, fine)) in times.into_iter().enumerate() {
                        let label = if several {
                            format!(" (time {} in the text)", k + 1)
                        } else {
                            String::new()
                        };
                        self.observe(path, label, &m1, &m2, fine);
                    }
                }
            }
            (Val::Bytes(x), Val::Bytes(y)) => {
                if x != y {
                    self.diff(path, "bytes differ", Some(show(a)), Some(show(b)));
                }
            }
            (Val::Json(x), Val::Json(y)) => {
                let was = self.in_json_text;
                self.in_json_text = true;
                self.val(path, x, y);
                self.in_json_text = was;
            }
            (Val::Arr(x), Val::Arr(y)) => {
                if self.allow.is_set(path, !self.probe) {
                    self.set(path, x, y);
                } else {
                    self.arr(path, x, y);
                }
            }
            (Val::Obj(x), Val::Obj(y)) => self.obj(path, x, y),
            (Val::Ext(x), Val::Ext(y)) => {
                if x != y {
                    self.diff(path, "value differs", Some(show(a)), Some(show(b)));
                }
            }
            (Val::Unsupported(x), Val::Unsupported(y)) if x == y => {}
            _ => type_diff(self, path),
        }
    }

    /// Note a time of the current unit (only while really comparing, not while probing).
    fn observe(&mut self, path: &Path, label: String, a: &Moment, b: &Moment, fine: bool) {
        if self.probe {
            return;
        }
        if let (Some(r), Some(c)) = (a.run_offset(), b.run_offset()) {
            self.unit.push(TimeObs {
                path: path.clone(),
                label,
                r,
                c,
                fine,
                seeded: matches!(a, Moment::Seed { .. }),
            });
        }
    }

    fn begin_unit(&mut self) {
        self.unit.clear();
        self.flagged.clear();
    }

    /// Check the relations between the times of the unit just compared.
    fn end_unit(&mut self) {
        let obs = std::mem::take(&mut self.unit);
        let n = obs.len();
        if n < 2 {
            self.flagged.clear();
            return;
        }
        let pairs: Vec<(usize, usize)> = if n <= ALL_PAIRS_LIMIT {
            (0..n)
                .flat_map(|i| (i + 1..n).map(move |j| (i, j)))
                .collect()
        } else {
            // Neighbours in the reference's time order: the order of all follows from them.
            let mut idx: Vec<usize> = (0..n).collect();
            idx.sort_by_key(|i| obs.get(*i).map_or(0, |o| o.r));
            idx.windows(2)
                .filter_map(|w| match w {
                    [a, b] => Some(((*a).min(*b), (*a).max(*b))),
                    _ => None,
                })
                .collect()
        };
        for (i, j) in pairs {
            let (Some(a), Some(b)) = (obs.get(i), obs.get(j)) else {
                continue;
            };
            let (ka, kb) = (a.path.to_string(), b.path.to_string());
            if self.flagged.contains(&ka) || self.flagged.contains(&kb) {
                continue;
            }
            let tol = self
                .allow
                .tolerance(&a.path, false)
                .into_iter()
                .chain(self.allow.tolerance(&b.path, false))
                .fold(self.relation, i64::max);
            // A seeded time and a run time have different anchors (the process start lies
            // between them, and varies): only their order means something.
            let fine = a.fine && b.fine && a.seeded == b.seeded;
            if let Some(why) = relation_problem(b.r - a.r, b.c - a.c, fine, tol) {
                let what = format!("time relation to {ka}{} differs: {why}", a.label);
                self.diff(
                    &b.path,
                    format!("{what}{}", b.label),
                    Some(format!("{} after it", human_signed(b.r - a.r))),
                    Some(format!("{} after it", human_signed(b.c - a.c))),
                );
            }
        }
        self.flagged.clear();
    }

    fn int(&mut self, path: &Path, x: i64, y: i64, a: &Val, b: &Val) {
        let equal = match self.allow.tolerance(path, !self.probe) {
            Some(t) => (x - y).abs() <= t,
            None => x == y,
        };
        if !equal {
            self.diff(path, "number differs", Some(show(a)), Some(show(b)));
        }
    }

    fn obj(&mut self, path: &mut Path, a: &[(Text, Val)], b: &[(Text, Val)]) {
        let mut b_used = vec![false; b.len()];
        let mut a_pair: Vec<Option<usize>> = vec![None; a.len()];
        let plain_b: HashMap<&str, usize> = b
            .iter()
            .enumerate()
            .filter_map(|(j, (k, _))| k.as_plain().map(|p| (p, j)))
            .collect();
        // 1. Plain keys by name.
        for (i, (ka, _)) in a.iter().enumerate() {
            if let Some(p) = ka.as_plain()
                && let Some(j) = plain_b.get(p).copied()
                && !b_used.get(j).copied().unwrap_or(true)
            {
                b_used[j] = true;
                a_pair[i] = Some(j);
            }
        }
        // 2. Keys holding generated values: bound by key and value together, so equivalent
        //    objects whose generated keys come in another order pair correctly ...
        // 3. ... then by key alone (the values' differences are reported).
        for whole in [true, false] {
            for (i, (ka, va)) in a.iter().enumerate() {
                if ka.as_plain().is_some() || a_pair.get(i).copied().flatten().is_some() {
                    continue;
                }
                for (j, (kb, vb)) in b.iter().enumerate() {
                    if b_used.get(j).copied().unwrap_or(true) || kb.as_plain().is_some() {
                        continue;
                    }
                    let p2 = path.clone();
                    let hit = self.probe_with(true, |s| {
                        if s.text(&p2, ka, kb).is_err() {
                            s.failed = true;
                        } else if whole {
                            s.val(&mut p2.with_key(ka.display()), va, vb);
                        }
                    });
                    if hit {
                        b_used[j] = true;
                        a_pair[i] = Some(j);
                        break;
                    }
                }
            }
        }
        let pairs: Vec<(usize, usize)> = a_pair
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.map(|j| (i, j)))
            .collect();
        let missing: Vec<usize> = a_pair
            .iter()
            .enumerate()
            .filter(|(_, p)| p.is_none())
            .map(|(i, _)| i)
            .collect();
        for (i, j) in &pairs {
            if let (Some((k, x)), Some((_, y))) = (a.get(*i), b.get(*j)) {
                path.push_key(k.display());
                self.val(path, x, y);
                path.pop();
            }
        }
        for i in missing {
            if let Some((k, x)) = a.get(i) {
                path.push_key(k.display());
                if !self.ignored(path) {
                    let what = if matches!(x, Val::Null) {
                        "field is null in reference, missing in candidate"
                    } else {
                        "field missing in candidate"
                    };
                    self.diff(path, what, Some(show(x)), None);
                }
                path.pop();
            }
        }
        for (j, (k, y)) in b.iter().enumerate() {
            if b_used.get(j).copied().unwrap_or(true) {
                continue;
            }
            path.push_key(k.display());
            if !self.ignored(path) {
                let what = if matches!(y, Val::Null) {
                    "field missing in reference, null in candidate"
                } else {
                    "field only in candidate"
                };
                self.diff(path, what, None, Some(show(y)));
            }
            path.pop();
        }
        let reordered = pairs.len() == a.len()
            && pairs.len() == b.len()
            && pairs
                .windows(2)
                .any(|w| matches!(w, [(_, j1), (_, j2)] if j1 > j2));
        if reordered {
            let ra: Vec<String> = a.iter().map(|(k, _)| k.display()).collect();
            let rb: Vec<String> = b.iter().map(|(k, _)| k.display()).collect();
            if order_matters(path) {
                self.diff(
                    path,
                    "index key order differs",
                    Some(ra.join(", ")),
                    Some(rb.join(", ")),
                );
            } else {
                self.note(
                    path,
                    "object key order differs",
                    Some(ra.join(", ")),
                    Some(rb.join(", ")),
                );
            }
        }
    }

    fn arr(&mut self, path: &mut Path, a: &[Val], b: &[Val]) {
        if a.len() == b.len() || a.len().saturating_mul(b.len()) > QUADRATIC_LIMIT {
            for i in 0..a.len().max(b.len()) {
                path.push_index(i);
                match (a.get(i), b.get(i)) {
                    (Some(x), Some(y)) => self.val(path, x, y),
                    (Some(x), None) => {
                        if !self.ignored(path) {
                            self.diff(
                                path,
                                "array element missing in candidate",
                                Some(show(x)),
                                None,
                            );
                        }
                    }
                    (None, Some(y)) => {
                        if !self.ignored(path) {
                            self.diff(path, "array element only in candidate", None, Some(show(y)));
                        }
                    }
                    (None, None) => {}
                }
                path.pop();
            }
            return;
        }
        if self.probe {
            self.failed = true;
            return;
        }
        // Different lengths: align by masked content (longest common subsequence) so that one
        // inserted element is reported once instead of shifting every later element.
        let ma: Vec<String> = a.iter().map(mask).collect();
        let mb: Vec<String> = b.iter().map(mask).collect();
        let (n, m) = (a.len(), b.len());
        let mut lcs = vec![vec![0u32; m + 1]; n + 1];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                let v = if ma.get(i) == mb.get(j) {
                    lcs.get(i + 1)
                        .and_then(|r| r.get(j + 1))
                        .copied()
                        .unwrap_or(0)
                        + 1
                } else {
                    let down = lcs.get(i + 1).and_then(|r| r.get(j)).copied().unwrap_or(0);
                    let right = lcs.get(i).and_then(|r| r.get(j + 1)).copied().unwrap_or(0);
                    down.max(right)
                };
                if let Some(cell) = lcs.get_mut(i).and_then(|r| r.get_mut(j)) {
                    *cell = v;
                }
            }
        }
        let at = |i: usize, j: usize| lcs.get(i).and_then(|r| r.get(j)).copied().unwrap_or(0);
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && ma.get(i) == mb.get(j) {
                if let (Some(x), Some(y)) = (a.get(i), b.get(j)) {
                    path.push_index(i);
                    self.val(path, x, y);
                    path.pop();
                }
                i += 1;
                j += 1;
            } else if j < m && (i >= n || at(i, j + 1) >= at(i + 1, j)) {
                path.push_index(j);
                if !self.ignored(path) {
                    let y = b.get(j).map(show);
                    self.diff(
                        path,
                        format!("array element only in candidate (candidate index {j})"),
                        None,
                        y,
                    );
                }
                path.pop();
                j += 1;
            } else {
                path.push_index(i);
                if !self.ignored(path) {
                    let x = a.get(i).map(show);
                    self.diff(path, "array element missing in candidate", x, None);
                }
                path.pop();
                i += 1;
            }
        }
    }

    /// Multiset comparison.
    fn set(&mut self, path: &mut Path, a: &[Val], b: &[Val]) {
        let mut b_used = vec![false; b.len()];
        let mut left: Vec<usize> = Vec::new();
        for (i, x) in a.iter().enumerate() {
            let mut hit = None;
            for (j, y) in b.iter().enumerate() {
                if b_used.get(j).copied().unwrap_or(true) {
                    continue;
                }
                let p2 = path.with_index(i);
                if self.probe_with(true, |s| s.val(&mut p2.clone(), x, y)) {
                    hit = Some(j);
                    break;
                }
            }
            match hit {
                Some(j) => {
                    if let Some(u) = b_used.get_mut(j) {
                        *u = true;
                    }
                    if !self.probe {
                        path.push_index(i);
                        if let Some(y) = b.get(j) {
                            self.val(path, x, y);
                        }
                        path.pop();
                    }
                }
                None => left.push(i),
            }
        }
        if self.probe && (!left.is_empty() || b_used.iter().any(|u| !u)) {
            self.failed = true;
            return;
        }
        // Pair leftovers by masked content to show a precise difference.
        for i in left {
            let Some(x) = a.get(i) else { continue };
            let mx = mask(x);
            let partner = (0..b.len()).find(|j| {
                !b_used.get(*j).copied().unwrap_or(true)
                    && b.get(*j).map(mask).as_deref() == Some(mx.as_str())
            });
            path.push_index(i);
            match partner.and_then(|j| b.get(j).map(|y| (j, y))) {
                Some((j, y)) => {
                    if let Some(u) = b_used.get_mut(j) {
                        *u = true;
                    }
                    self.val(path, x, y);
                }
                None => {
                    if !self.ignored(path) {
                        self.diff(
                            path,
                            "set element missing in candidate",
                            Some(show(x)),
                            None,
                        );
                    }
                }
            }
            path.pop();
        }
        for (j, y) in b.iter().enumerate() {
            if !b_used.get(j).copied().unwrap_or(true) {
                path.push_index(j);
                if !self.ignored(path) {
                    self.diff(
                        path,
                        format!("set element only in candidate (candidate index {j})"),
                        None,
                        Some(show(y)),
                    );
                }
                path.pop();
            }
        }
    }

    fn steps(&mut self, a: &[StepCap], b: &[StepCap]) {
        for i in 0..a.len().max(b.len()) {
            self.begin_unit();
            self.step(i, a.get(i), b.get(i));
            self.end_unit();
        }
    }

    fn step(&mut self, i: usize, a: Option<&StepCap>, b: Option<&StepCap>) {
        {
            let base = Path::root("steps").with_index(i);
            match (a, b) {
                (
                    Some(StepCap::Http {
                        status: s1,
                        headers: h1,
                        body: b1,
                    }),
                    Some(StepCap::Http {
                        status: s2,
                        headers: h2,
                        body: b2,
                    }),
                ) => {
                    let sp = base.with_key("status");
                    if s1 != s2 && !self.ignored(&sp) {
                        self.diff(
                            &sp,
                            "HTTP status differs",
                            Some(s1.to_string()),
                            Some(s2.to_string()),
                        );
                    }
                    let names: BTreeSet<&String> =
                        h1.iter().chain(h2.iter()).map(|(n, _)| n).collect();
                    for name in names {
                        let mut hp = base.with_key("headers").with_key(name.clone());
                        if self.ignored(&hp) {
                            continue;
                        }
                        let x = h1.iter().find(|(n, _)| n == name).map(|(_, v)| v);
                        let y = h2.iter().find(|(n, _)| n == name).map(|(_, v)| v);
                        match (x, y) {
                            (Some(x), None) => {
                                self.diff(&hp, "header missing in candidate", Some(show(x)), None)
                            }
                            (None, Some(y)) => {
                                self.diff(&hp, "header only in candidate", None, Some(show(y)))
                            }
                            (Some(x), Some(y)) => self.val(&mut hp, x, y),
                            (None, None) => {}
                        }
                    }
                    let mut bp = base.with_key("body");
                    if self.ignored(&bp) {
                        return;
                    }
                    match (b1, b2) {
                        (Body::Json(x), Body::Json(y)) => self.val(&mut bp, x, y),
                        (Body::Text(x), Body::Text(y)) => {
                            if let Err(why) = self.text(&bp, x, y) {
                                self.diff(
                                    &bp,
                                    format!("body {why}"),
                                    Some(Val::Str(x.clone()).short(SHOW)),
                                    Some(Val::Str(y.clone()).short(SHOW)),
                                );
                            }
                        }
                        (Body::Bytes(x), Body::Bytes(y)) => {
                            if x != y {
                                self.diff(
                                    &bp,
                                    "body bytes differ",
                                    Some(format!("{} bytes", x.len())),
                                    Some(format!("{} bytes", y.len())),
                                );
                            }
                        }
                        (x, y) => {
                            let kind = |b: &Body| match b {
                                Body::Json(_) => "JSON",
                                Body::Text(_) => "text",
                                Body::Bytes(_) => "binary",
                            };
                            self.diff(
                                &bp,
                                format!(
                                    "body is {} in reference, {} in candidate",
                                    kind(x),
                                    kind(y)
                                ),
                                None,
                                None,
                            );
                        }
                    }
                }
                (Some(StepCap::Reply(x)), Some(StepCap::Reply(y))) => {
                    self.val(&mut base.with_key("reply"), x, y)
                }
                (Some(StepCap::Done(_)), Some(StepCap::Done(_))) => {}
                (x, y) => self.diff(
                    &base,
                    "step results do not line up (was the scenario changed after recording?)",
                    x.map(|_| "present".to_string()),
                    y.map(|_| "present".to_string()),
                ),
            }
        }
    }

    /// Pair two lists of items: exact matches first, then by identity, then by similarity.
    /// Returns (pairs, unpaired reference, unpaired candidate).
    fn pair<T>(
        &mut self,
        a: &[T],
        b: &[T],
        masked: impl Fn(&T) -> String,
        exact: impl Fn(&mut Self, &T, &T),
        same_identity: impl Fn(&mut Self, &T, &T) -> bool,
        similarity: impl Fn(&mut Self, &T, &T) -> f64,
    ) -> (Vec<(usize, usize)>, Vec<usize>, Vec<usize>) {
        let ma: Vec<String> = a.iter().map(&masked).collect();
        let mb: Vec<String> = b.iter().map(&masked).collect();
        let mut b_used = vec![false; b.len()];
        let mut a_pair: Vec<Option<usize>> = vec![None; a.len()];
        let quadratic = a.len().saturating_mul(b.len()) <= QUADRATIC_LIMIT;
        // 1. Exactly equal (under the bindings so far), same masked content first.
        for pass in 0..2 {
            if pass == 1 && !quadratic {
                break;
            }
            for i in 0..a.len() {
                if a_pair.get(i).copied().flatten().is_some() {
                    continue;
                }
                let Some(x) = a.get(i) else { continue };
                for j in 0..b.len() {
                    if b_used.get(j).copied().unwrap_or(true)
                        || (pass == 0 && ma.get(i) != mb.get(j))
                    {
                        continue;
                    }
                    let Some(y) = b.get(j) else { continue };
                    if self.probe_with(true, |s| exact(s, x, y)) {
                        a_pair[i] = Some(j);
                        b_used[j] = true;
                        break;
                    }
                }
            }
        }
        // 2. Same identity (literal _id or key, or ids already bound to each other).
        for i in 0..a.len() {
            if a_pair.get(i).copied().flatten().is_some() {
                continue;
            }
            let Some(x) = a.get(i) else { continue };
            for j in 0..b.len() {
                if b_used.get(j).copied().unwrap_or(true) {
                    continue;
                }
                let Some(y) = b.get(j) else { continue };
                if same_identity(self, x, y) {
                    a_pair[i] = Some(j);
                    b_used[j] = true;
                    break;
                }
            }
        }
        // 3. Most similar, when at least half alike.
        if quadratic {
            for i in 0..a.len() {
                if a_pair.get(i).copied().flatten().is_some() {
                    continue;
                }
                let Some(x) = a.get(i) else { continue };
                let mut best: Option<(usize, f64)> = None;
                for j in 0..b.len() {
                    if b_used.get(j).copied().unwrap_or(true) {
                        continue;
                    }
                    let Some(y) = b.get(j) else { continue };
                    let score = similarity(self, x, y);
                    if score >= 0.5 && best.is_none_or(|(_, s)| score > s) {
                        best = Some((j, score));
                    }
                }
                if let Some((j, _)) = best {
                    a_pair[i] = Some(j);
                    b_used[j] = true;
                }
            }
        }
        let pairs = a_pair
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.map(|j| (i, j)))
            .collect();
        let lone_a = a_pair
            .iter()
            .enumerate()
            .filter(|(_, p)| p.is_none())
            .map(|(i, _)| i)
            .collect();
        let lone_b = b_used
            .iter()
            .enumerate()
            .filter(|(_, u)| !**u)
            .map(|(j, _)| j)
            .collect();
        (pairs, lone_a, lone_b)
    }

    fn top_level_similarity(&mut self, x: &Val, y: &Val) -> f64 {
        let (Val::Obj(p), Val::Obj(q)) = (x, y) else {
            return if mask(x) == mask(y) { 1.0 } else { 0.0 };
        };
        let keys: BTreeSet<String> = p.iter().chain(q.iter()).map(|(k, _)| k.display()).collect();
        if keys.is_empty() {
            return 1.0;
        }
        let mut same = 0usize;
        for (k, v) in p {
            if let Some((_, w)) = q.iter().find(|(kk, _)| kk.display() == k.display())
                && self.probe_with(false, |s| s.val(&mut Path::root("similarity"), v, w))
            {
                same += 1;
            }
        }
        same as f64 / keys.len() as f64
    }

    fn collection(&mut self, name: &str, a: &CollCap, b: &CollCap) {
        let base = Path::root("mongo").with_key(name);
        if a.kind != b.kind {
            self.diff(
                &base.with_key("type"),
                "collection type differs",
                Some(a.kind.clone()),
                Some(b.kind.clone()),
            );
        }
        self.val(&mut base.with_key("options"), &a.options, &b.options);
        let names: BTreeSet<&String> = a
            .indexes
            .iter()
            .chain(b.indexes.iter())
            .map(|(n, _)| n)
            .collect();
        for n in names {
            let ip = base.with_key("indexes").with_key(n.clone());
            let x = a.indexes.iter().find(|(m, _)| m == n).map(|(_, v)| v);
            let y = b.indexes.iter().find(|(m, _)| m == n).map(|(_, v)| v);
            match (x, y) {
                (Some(x), Some(y)) => self.val(&mut ip.clone(), x, y),
                (Some(x), None) => {
                    if !self.ignored(&ip) {
                        self.diff(&ip, "index missing in candidate", Some(show(x)), None);
                    }
                }
                (None, Some(y)) => {
                    if !self.ignored(&ip) {
                        self.diff(&ip, "index only in candidate", None, Some(show(y)));
                    }
                }
                (None, None) => {}
            }
        }
        let (pairs, lone_a, lone_b) = self.pair(
            &a.docs,
            &b.docs,
            mask,
            |s, x, y| s.val(&mut base.with_index(0), x, y),
            |s, x, y| match (doc_id(x), doc_id(y)) {
                (Some(p), Some(q)) => match (p, q) {
                    (Val::Oid(Id::Gen(k1, n1)), Val::Oid(Id::Gen(k2, n2)))
                    | (Val::Uuid(Id::Gen(k1, n1)), Val::Uuid(Id::Gen(k2, n2))) => {
                        k1 == k2 && s.fwd.get(&(*k1, *n1)) == Some(n2)
                    }
                    (Val::Oid(Id::Gen(..)), _) | (_, Val::Oid(Id::Gen(..))) => false,
                    _ => mask(p) == mask(q),
                },
                _ => false,
            },
            |s, x, y| s.top_level_similarity(x, y),
        );
        let doc_context = |v: &Val| doc_id(v).map(|id| format!("document _id {}", id.short(80)));
        let mut sorted = pairs;
        sorted.sort();
        for (i, j) in sorted {
            if let (Some(x), Some(y)) = (a.docs.get(i), b.docs.get(j)) {
                self.context = doc_context(x);
                self.begin_unit();
                self.val(&mut base.with_index(i), x, y);
                self.end_unit();
            }
        }
        for i in lone_a {
            if let Some(x) = a.docs.get(i) {
                self.context = doc_context(x);
                let p = base.with_index(i);
                if !self.ignored(&p) {
                    self.diff(&p, "document missing in candidate", Some(show(x)), None);
                }
            }
        }
        for j in lone_b {
            if let Some(y) = b.docs.get(j) {
                self.context = doc_context(y);
                let p = base.with_index(j);
                if !self.ignored(&p) {
                    self.diff(
                        &p,
                        format!("document only in candidate (candidate index {j})"),
                        None,
                        Some(show(y)),
                    );
                }
            }
        }
        self.context = None;
    }

    fn entry_path(e: &EntryCap) -> Path {
        Path::root("dragonfly").with_key(e.key.display())
    }

    fn entry(&mut self, x: &EntryCap, y: &EntryCap) {
        let base = Self::entry_path(x);
        if self.ignored(&base) {
            return;
        }
        if let Err(why) = self.text(&base, &x.key, &y.key) {
            self.diff(
                &base,
                format!("key name differs: {why}"),
                Some(x.key.display()),
                Some(y.key.display()),
            );
        }
        if x.kind != y.kind {
            self.diff(
                &base.with_key("type"),
                "Dragonfly type differs",
                Some(x.kind.clone()),
                Some(y.kind.clone()),
            );
            return;
        }
        let tp = base.with_key("ttl");
        if !self.ignored(&tp) {
            let fmt = |t: &Option<Moment>| crate::capture::encode_ttl(t).to_string();
            match (&x.ttl, &y.ttl) {
                (None, None) => {}
                (Some(_), None) => self.diff(
                    &tp,
                    "TTL: reference has one, candidate has none",
                    Some(fmt(&x.ttl)),
                    Some("no TTL".into()),
                ),
                (None, Some(_)) => self.diff(
                    &tp,
                    "TTL: reference has none, candidate has one",
                    Some("no TTL".into()),
                    Some(fmt(&y.ttl)),
                ),
                (Some(p), Some(q)) => {
                    if let Err(why) = self.moments(&tp, p, q) {
                        self.diff(
                            &tp,
                            format!("TTL differs: {why}"),
                            Some(fmt(&x.ttl)),
                            Some(fmt(&y.ttl)),
                        );
                    }
                    // Measured, not written: one-second precision for relations.
                    self.observe(&tp, String::new(), p, q, false);
                }
            }
        }
        let mut vp = base.with_key("value");
        if self.ignored(&vp) {
            return;
        }
        match (&x.value, &y.value) {
            (Val::Arr(p), Val::Arr(q)) if x.kind == "set" || x.kind == "zset" => {
                self.set(&mut vp, p, q)
            }
            (p, q) => self.val(&mut vp, p, q),
        }
    }

    fn dragonfly(&mut self, a: &[EntryCap], b: &[EntryCap]) {
        let (pairs, lone_a, lone_b) = self.pair(
            a,
            b,
            |e| {
                format!(
                    "{}|{}|{}|{}",
                    mask_text(&e.key),
                    e.kind,
                    e.ttl.is_some(),
                    mask(&e.value)
                )
            },
            |s, x, y| s.entry(x, y),
            |s, x, y| {
                s.probe_with(true, |s2| {
                    if s2.text(&Path::root("dragonfly"), &x.key, &y.key).is_err() {
                        s2.failed = true;
                    }
                })
            },
            // Keys alike, then the more alike values: entries named after the wrong id still
            // pair with the entry that holds the same content.
            |s, x, y| {
                if mask_text(&x.key) != mask_text(&y.key) || x.kind != y.kind {
                    return 0.0;
                }
                let unwrap = |v: &Val| match v {
                    Val::Json(inner) => (**inner).clone(),
                    other => other.clone(),
                };
                0.5 + 0.5 * s.top_level_similarity(&unwrap(&x.value), &unwrap(&y.value))
            },
        );
        let mut sorted = pairs;
        sorted.sort();
        for (i, j) in sorted {
            if let (Some(x), Some(y)) = (a.get(i), b.get(j)) {
                self.begin_unit();
                self.entry(x, y);
                self.end_unit();
            }
        }
        for i in lone_a {
            if let Some(x) = a.get(i) {
                let p = Self::entry_path(x);
                if !self.ignored(&p) {
                    self.diff(
                        &p,
                        "key missing in candidate",
                        Some(format!("{} {}", x.kind, x.value.short(SHOW))),
                        None,
                    );
                }
            }
        }
        for j in lone_b {
            if let Some(y) = b.get(j) {
                let p = Self::entry_path(y);
                if !self.ignored(&p) {
                    self.diff(
                        &p,
                        "key only in candidate",
                        None,
                        Some(format!("{} {}", y.kind, y.value.short(SHOW))),
                    );
                }
            }
        }
    }

    /// Compare a reference capture with a candidate capture.
    pub fn compare(mut self, a: &Capture, b: &Capture) -> Outcome {
        self.steps(&a.steps, &b.steps);
        let names: BTreeSet<&String> = a.mongo.keys().chain(b.mongo.keys()).collect();
        for name in names {
            let p = Path::root("mongo").with_key(name.clone());
            match (a.mongo.get(name), b.mongo.get(name)) {
                (Some(x), Some(y)) => self.collection(name, x, y),
                (Some(x), None) => {
                    if !self.ignored(&p) {
                        self.diff(
                            &p,
                            "collection missing in candidate",
                            Some(format!("{} documents", x.docs.len())),
                            None,
                        );
                    }
                }
                (None, Some(y)) => {
                    if !self.ignored(&p) {
                        self.diff(
                            &p,
                            "collection only in candidate",
                            None,
                            Some(format!("{} documents", y.docs.len())),
                        );
                    }
                }
                (None, None) => {}
            }
        }
        self.dragonfly(&a.dragonfly, &b.dragonfly);
        self.out
    }
}

/// A time written with milliseconds (ISO with `.ddd`, a 13-digit epoch-ms run).
fn shape_is_fine(shape: &str) -> bool {
    shape == "ms" || shape.contains(".ddd")
}

fn human_signed(ms: i64) -> String {
    if ms > 0 {
        format!("+{}", human_duration(ms))
    } else {
        human_duration(ms)
    }
}

/// Why the candidate's difference `dc` between two times breaks the reference's relation `dr`.
fn relation_problem(dr: i64, dc: i64, fine: bool, tol: i64) -> Option<String> {
    if !fine {
        // One-second precision: only an order more than a second apart is meaningful.
        return (dr.abs() > 1000 && dc.signum() != dr.signum()).then(|| {
            format!(
                "reference {} after it, candidate {} (order reversed)",
                human_signed(dr),
                human_signed(dc)
            )
        });
    }
    if dr == 0 {
        return (dc != 0).then(|| {
            format!(
                "reference has the same time (one clock reading), candidate {} after it",
                human_signed(dc)
            )
        });
    }
    if dr.abs() >= 1000 && dr % 1000 == 0 {
        return ((dc - dr).abs() > tol).then(|| {
            format!(
                "reference exactly {} after it (a fixed duration), candidate {} (tolerance {})",
                human_signed(dr),
                human_signed(dc),
                human_duration(tol)
            )
        });
    }
    let reversed = dc.signum() == -dr.signum();
    let collapsed = dc == 0 && dr.abs() > tol;
    (reversed || collapsed).then(|| {
        format!(
            "reference {} after it, candidate {}",
            human_signed(dr),
            if dc == 0 {
                "the same time".to_string()
            } else {
                format!("{} after it", human_signed(dc))
            }
        )
    })
}

/// Compare two captures with the given allowances and tolerances.
pub fn compare(a: &Capture, b: &Capture, allow: &Allowances, tol: Tolerances) -> Outcome {
    Comparator::new(allow, tol).compare(a, b)
}
