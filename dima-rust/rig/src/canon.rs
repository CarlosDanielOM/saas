//! Canonicalisation: order documents, Dragonfly keys and set-like arrays by content, then number
//! generated identifiers per side (`<oid:1>`, `<oid:2>`, ...) in that order: step responses first,
//! then MongoDB (collections by name), then Dragonfly.
//!
//! Ordering masks generated values, so two runs that differ only in generated values order the
//! same way. When documents look identical apart from their generated ids, each id gets a label
//! derived from every place it appears (a few rounds of refinement), so "the job whose id the
//! response returned" and "the other job" still sort the same way in every run.

use std::collections::{BTreeSet, HashMap};

use crate::allow::Allowances;
use crate::capture::{Body, Capture, EntryCap, StepCap};
use crate::path::Path;
use crate::value::{Id, IdKind, Moment, Seg, Text, Val};

type Key = (IdKind, String);

const ROUNDS: usize = 3;
/// Items with more distinct ids than this use one rendering for all of them (cost bound).
const SELF_RENDER_LIMIT: usize = 64;

pub fn fnv1a64(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

struct Ctx<'a> {
    allow: &'a Allowances,
    labels: &'a HashMap<Key, String>,
    focus: Option<&'a Key>,
}

fn id_label(id: &Id, ctx: &Ctx<'_>) -> String {
    match id {
        Id::Lit(v) => format!("={v}"),
        Id::Gen(k, n) => format!("<{}#{n}>", k.tag()),
        Id::Raw(k, v) => {
            let key = (*k, v.clone());
            if ctx.focus == Some(&key) {
                "<SELF>".into()
            } else {
                format!(
                    "<{}:{}>",
                    k.tag(),
                    ctx.labels.get(&key).map_or("?", String::as_str)
                )
            }
        }
    }
}

fn render_text(t: &Text, ctx: &Ctx<'_>) -> String {
    let mut s = String::new();
    for seg in &t.0 {
        match seg {
            Seg::Lit(l) => s.push_str(l),
            Seg::Id(id) => s.push_str(&id_label(id, ctx)),
            Seg::Time {
                at: Moment::Abs(ms),
                shape,
            } => s.push_str(&format!("<T@{ms}|{shape}>")),
            Seg::Time {
                at: Moment::Seed { seed, .. },
                shape,
            } => s.push_str(&format!("<Tseed{seed}|{shape}>")),
            Seg::Time { shape, .. } => s.push_str(&format!("<T|{shape}>")),
            Seg::Day { .. } => s.push_str("<D>"),
            Seg::Name(n) => s.push_str(&format!("<run:{n}>")),
            Seg::Bytes(b) => s.push_str(&format!("<B:{}>", crate::value::hex(b))),
        }
    }
    serde_json::to_string(&s).unwrap_or(s)
}

fn num_key(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    match n.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => format!("{}", f as i64),
        Some(f) => format!("{f:?}"),
        None => n.to_string(),
    }
}

/// A sort key for a value: generated ids by label, run-relative times masked, object keys sorted,
/// set-like arrays sorted.
fn render(v: &Val, path: &mut Path, ctx: &Ctx<'_>, top_is_set: bool) -> String {
    match v {
        Val::Null => "null".into(),
        Val::Bool(b) => b.to_string(),
        Val::Num(n) => format!("N{}", num_key(n)),
        Val::Int32(i) => format!("i{i}"),
        Val::Int64(i) => format!("l{i}"),
        Val::Double(f) => format!("d{f:?}"),
        Val::Dec(s) => format!("m{s}"),
        Val::Time(r, Moment::Abs(ms)) => format!("T{r:?}@{ms}"),
        Val::Time(r, Moment::Seed { seed, .. }) => format!("T{r:?}seed{seed}"),
        Val::Time(r, _) => format!("T{r:?}~"),
        Val::Oid(id) => format!("O{}", id_label(id, ctx)),
        Val::Uuid(id) => format!("U{}", id_label(id, ctx)),
        Val::Str(t) => format!("S{}", render_text(t, ctx)),
        Val::Bytes(b) => format!(
            "B{}",
            b.iter().map(|x| format!("{x:02x}")).collect::<String>()
        ),
        Val::Json(inner) => format!("J{}", render(inner, path, ctx, false)),
        Val::Ext(e) => format!("X{e}"),
        Val::Unsupported(t) => format!("?{t}"),
        Val::Arr(items) => {
            let mut parts: Vec<String> = items
                .iter()
                .enumerate()
                .map(|(i, x)| {
                    path.push_index(i);
                    let r = render(x, path, ctx, false);
                    path.pop();
                    r
                })
                .collect();
            if top_is_set || ctx.allow.is_set(path, false) {
                parts.sort();
            }
            format!("[{}]", parts.join(","))
        }
        Val::Obj(kv) => {
            let mut parts: Vec<String> = kv
                .iter()
                .map(|(k, x)| {
                    path.push_key(k.display());
                    let r = format!("{}:{}", render_text(k, ctx), render(x, path, ctx, false));
                    path.pop();
                    r
                })
                .collect();
            parts.sort();
            format!("{{{}}}", parts.join(","))
        }
    }
}

fn collect_text_ids(t: &Text, out: &mut Vec<Key>) {
    for s in &t.0 {
        if let Seg::Id(Id::Raw(k, v)) = s {
            out.push((*k, v.clone()));
        }
    }
}

fn collect_ids(v: &Val, out: &mut Vec<Key>) {
    match v {
        Val::Oid(Id::Raw(k, x)) | Val::Uuid(Id::Raw(k, x)) => out.push((*k, x.clone())),
        Val::Str(t) => collect_text_ids(t, out),
        Val::Json(inner) => collect_ids(inner, out),
        Val::Arr(items) => items.iter().for_each(|x| collect_ids(x, out)),
        Val::Obj(kv) => {
            for (k, x) in kv {
                collect_text_ids(k, out);
                collect_ids(x, out);
            }
        }
        _ => {}
    }
}

/// One unit of content for ordering and labelling.
enum Item<'a> {
    Step(usize, &'a StepCap),
    Options(&'a str, &'a Val),
    Indexes(&'a str, &'a [(String, Val)]),
    Doc(&'a str, usize, &'a Val),
    Entry(&'a EntryCap),
}

impl Item<'_> {
    fn group(&self) -> String {
        match self {
            Item::Step(i, _) => format!("step{i}"),
            Item::Options(c, _) => format!("mongo:{c}:options"),
            Item::Indexes(c, _) => format!("mongo:{c}:indexes"),
            Item::Doc(c, _, _) => format!("mongo:{c}"),
            Item::Entry(_) => "dragonfly".into(),
        }
    }

    fn ids(&self) -> Vec<Key> {
        let mut out = Vec::new();
        match self {
            Item::Step(_, StepCap::Http { headers, body, .. }) => {
                for (_, v) in headers.iter() {
                    collect_ids(v, &mut out);
                }
                match body {
                    Body::Json(v) => collect_ids(v, &mut out),
                    Body::Text(t) => collect_text_ids(t, &mut out),
                    Body::Bytes(_) => {}
                }
            }
            Item::Step(_, StepCap::Reply(v)) => collect_ids(v, &mut out),
            Item::Step(_, StepCap::Done(_)) => {}
            Item::Options(_, v) | Item::Doc(_, _, v) => collect_ids(v, &mut out),
            Item::Indexes(_, specs) => specs.iter().for_each(|(_, v)| collect_ids(v, &mut out)),
            Item::Entry(e) => {
                collect_text_ids(&e.key, &mut out);
                collect_ids(&e.value, &mut out);
            }
        }
        out
    }

    fn render(&self, ctx: &Ctx<'_>) -> String {
        match self {
            Item::Step(
                i,
                StepCap::Http {
                    status,
                    headers,
                    body,
                },
            ) => {
                let mut p = Path::root("steps").with_index(*i);
                let h: Vec<String> = headers
                    .iter()
                    .map(|(n, v)| {
                        let mut hp = p.with_key("headers").with_key(n.clone());
                        format!("{n}={}", render(v, &mut hp, ctx, false))
                    })
                    .collect();
                let b = match body {
                    Body::Json(v) => {
                        p.push_key("body");
                        render(v, &mut p, ctx, false)
                    }
                    Body::Text(t) => render_text(t, ctx),
                    Body::Bytes(b) => format!("{}B", b.len()),
                };
                format!("{status}|{}|{b}", h.join(";"))
            }
            Item::Step(i, StepCap::Reply(v)) => render(
                v,
                &mut Path::root("steps").with_index(*i).with_key("reply"),
                ctx,
                false,
            ),
            Item::Step(_, StepCap::Done(k)) => k.clone(),
            Item::Options(c, v) => render(
                v,
                &mut Path::root("mongo").with_key(*c).with_key("options"),
                ctx,
                false,
            ),
            Item::Indexes(c, specs) => specs
                .iter()
                .map(|(n, v)| {
                    format!(
                        "{n}={}",
                        render(
                            v,
                            &mut Path::root("mongo")
                                .with_key(*c)
                                .with_key("indexes")
                                .with_key(n.clone()),
                            ctx,
                            false
                        )
                    )
                })
                .collect::<Vec<_>>()
                .join(";"),
            Item::Doc(c, i, v) => render(
                v,
                &mut Path::root("mongo").with_key(*c).with_index(*i),
                ctx,
                false,
            ),
            Item::Entry(e) => entry_render(e, ctx),
        }
    }
}

fn entry_is_set(e: &EntryCap) -> bool {
    e.kind == "set" || e.kind == "zset"
}

fn entry_render(e: &EntryCap, ctx: &Ctx<'_>) -> String {
    let mut p = Path::root("dragonfly")
        .with_key(e.key.display())
        .with_key("value");
    let ttl = if e.ttl.is_some() { "ttl" } else { "-" };
    format!(
        "{}|{}|{ttl}|{}",
        render_text(&e.key, ctx),
        e.kind,
        render(&e.value, &mut p, ctx, entry_is_set(e))
    )
}

fn items(cap: &Capture) -> Vec<Item<'_>> {
    let mut out: Vec<Item<'_>> = cap
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| Item::Step(i, s))
        .collect();
    for (name, c) in &cap.mongo {
        out.push(Item::Options(name, &c.options));
        out.push(Item::Indexes(name, &c.indexes));
        out.extend(
            c.docs
                .iter()
                .enumerate()
                .map(|(i, d)| Item::Doc(name, i, d)),
        );
    }
    out.extend(cap.dragonfly.iter().map(Item::Entry));
    out
}

fn compute_labels(cap: &Capture, allow: &Allowances) -> HashMap<Key, String> {
    let items = items(cap);
    let item_ids: Vec<Vec<Key>> = items
        .iter()
        .map(|it| {
            let mut ids = it.ids();
            let mut seen = BTreeSet::new();
            ids.retain(|k| seen.insert(k.clone()));
            ids
        })
        .collect();
    let mut labels: HashMap<Key, String> = HashMap::new();
    for ids in &item_ids {
        for k in ids {
            labels.insert(k.clone(), "?".into());
        }
    }
    if labels.is_empty() {
        return labels;
    }
    let mut classes = 1;
    for _ in 0..ROUNDS {
        let mut sigs: HashMap<Key, Vec<String>> = HashMap::new();
        for (it, ids) in items.iter().zip(&item_ids) {
            let group = it.group();
            if ids.len() > SELF_RENDER_LIMIT {
                let plain = it.render(&Ctx {
                    allow,
                    labels: &labels,
                    focus: None,
                });
                for (pos, k) in ids.iter().enumerate() {
                    sigs.entry(k.clone())
                        .or_default()
                        .push(format!("{group}|{plain}#{pos}"));
                }
                continue;
            }
            for k in ids {
                let r = it.render(&Ctx {
                    allow,
                    labels: &labels,
                    focus: Some(k),
                });
                sigs.entry(k.clone())
                    .or_default()
                    .push(format!("{group}|{r}"));
            }
        }
        let next: HashMap<Key, String> = sigs
            .into_iter()
            .map(|(k, mut v)| {
                v.sort();
                let h = fnv1a64(v.join("\n").as_bytes());
                (k, format!("{h:016x}"))
            })
            .collect();
        let next_classes = next.values().collect::<BTreeSet<_>>().len();
        labels = next;
        if next_classes == classes {
            break;
        }
        classes = next_classes;
    }
    labels
}

/// Sort set-like arrays in place (Dragonfly sets and sorted sets, `set` allowances).
fn sort_sets(v: &mut Val, path: &mut Path, ctx: &Ctx<'_>, top_is_set: bool) {
    match v {
        Val::Arr(items) => {
            for (i, x) in items.iter_mut().enumerate() {
                path.push_index(i);
                sort_sets(x, path, ctx, false);
                path.pop();
            }
            if top_is_set || ctx.allow.is_set(path, false) {
                let mut keyed: Vec<(String, Val)> = std::mem::take(items)
                    .into_iter()
                    .enumerate()
                    .map(|(i, x)| {
                        path.push_index(i);
                        let k = render(&x, path, ctx, false);
                        path.pop();
                        (k, x)
                    })
                    .collect();
                keyed.sort_by(|a, b| a.0.cmp(&b.0));
                *items = keyed.into_iter().map(|(_, x)| x).collect();
            }
        }
        Val::Obj(kv) => {
            for (k, x) in kv.iter_mut() {
                path.push_key(k.display());
                sort_sets(x, path, ctx, false);
                path.pop();
            }
        }
        Val::Json(inner) => sort_sets(inner, path, ctx, false),
        _ => {}
    }
}

struct Numbering {
    next: HashMap<IdKind, u32>,
    map: HashMap<Key, u32>,
}

impl Numbering {
    fn see(&mut self, k: &Key) {
        if !self.map.contains_key(k) {
            let n = self.next.entry(k.0).or_insert(0);
            *n += 1;
            self.map.insert(k.clone(), *n);
        }
    }

    fn text(&mut self, t: &Text) {
        let mut ids = Vec::new();
        collect_text_ids(t, &mut ids);
        ids.iter().for_each(|k| self.see(k));
    }

    fn val(&mut self, v: &Val, ctx: &Ctx<'_>) {
        match v {
            Val::Oid(Id::Raw(k, x)) | Val::Uuid(Id::Raw(k, x)) => self.see(&(*k, x.clone())),
            Val::Str(t) => self.text(t),
            Val::Json(inner) => self.val(inner, ctx),
            Val::Arr(items) => items.iter().for_each(|x| self.val(x, ctx)),
            Val::Obj(kv) => {
                // Key order does not matter for numbering: visit keys in sorted order.
                let mut order: Vec<(String, usize)> = kv
                    .iter()
                    .enumerate()
                    .map(|(i, (k, _))| (render_text(k, ctx), i))
                    .collect();
                order.sort();
                for (_, i) in order {
                    if let Some((k, x)) = kv.get(i) {
                        self.text(k);
                        self.val(x, ctx);
                    }
                }
            }
            _ => {}
        }
    }
}

fn apply_text(t: &mut Text, map: &HashMap<Key, u32>) {
    for s in &mut t.0 {
        if let Seg::Id(Id::Raw(k, v)) = s
            && let Some(n) = map.get(&(*k, v.clone()))
        {
            *s = Seg::Id(Id::Gen(*k, *n));
        }
    }
}

fn apply(v: &mut Val, map: &HashMap<Key, u32>) {
    match v {
        Val::Oid(id) | Val::Uuid(id) => {
            if let Id::Raw(k, x) = id
                && let Some(n) = map.get(&(*k, x.clone()))
            {
                *id = Id::Gen(*k, *n);
            }
        }
        Val::Str(t) => apply_text(t, map),
        Val::Json(inner) => apply(inner, map),
        Val::Arr(items) => items.iter_mut().for_each(|x| apply(x, map)),
        Val::Obj(kv) => {
            for (k, x) in kv.iter_mut() {
                apply_text(k, map);
                apply(x, map);
            }
        }
        _ => {}
    }
}

/// Order and number a detected capture in place.
pub fn canonicalise(cap: &mut Capture, allow: &Allowances) {
    let labels = compute_labels(cap, allow);
    let ctx = Ctx {
        allow,
        labels: &labels,
        focus: None,
    };

    // Set-like arrays first: document and key order depend on their sorted form.
    for (i, s) in cap.steps.iter_mut().enumerate() {
        let mut p = Path::root("steps").with_index(i);
        match s {
            StepCap::Http {
                body: Body::Json(v),
                ..
            } => sort_sets(v, &mut p.with_key("body"), &ctx, false),
            StepCap::Reply(v) => sort_sets(v, &mut p.with_key("reply"), &ctx, false),
            _ => {}
        }
        p.pop();
    }
    for (name, c) in cap.mongo.iter_mut() {
        for (i, d) in c.docs.iter_mut().enumerate() {
            sort_sets(
                d,
                &mut Path::root("mongo").with_key(name.clone()).with_index(i),
                &ctx,
                false,
            );
        }
    }
    for e in cap.dragonfly.iter_mut() {
        let set = entry_is_set(e);
        let mut p = Path::root("dragonfly")
            .with_key(e.key.display())
            .with_key("value");
        sort_sets(&mut e.value, &mut p, &ctx, set);
    }

    for (name, c) in cap.mongo.iter_mut() {
        let base = Path::root("mongo").with_key(name.clone());
        let mut keyed: Vec<(String, Val)> = std::mem::take(&mut c.docs)
            .into_iter()
            .map(|d| (render(&d, &mut base.with_index(0), &ctx, false), d))
            .collect();
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        c.docs = keyed.into_iter().map(|(_, d)| d).collect();
    }
    let mut keyed: Vec<(String, EntryCap)> = std::mem::take(&mut cap.dragonfly)
        .into_iter()
        .map(|e| (entry_render(&e, &ctx), e))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    cap.dragonfly = keyed.into_iter().map(|(_, e)| e).collect();

    let mut num = Numbering {
        next: HashMap::new(),
        map: HashMap::new(),
    };
    for s in &cap.steps {
        match s {
            StepCap::Http { headers, body, .. } => {
                for (_, v) in headers {
                    num.val(v, &ctx);
                }
                match body {
                    Body::Json(v) => num.val(v, &ctx),
                    Body::Text(t) => num.text(t),
                    Body::Bytes(_) => {}
                }
            }
            StepCap::Reply(v) => num.val(v, &ctx),
            StepCap::Done(_) => {}
        }
    }
    for c in cap.mongo.values() {
        c.docs.iter().for_each(|d| num.val(d, &ctx));
        c.indexes.iter().for_each(|(_, v)| num.val(v, &ctx));
        num.val(&c.options, &ctx);
    }
    for e in &cap.dragonfly {
        num.text(&e.key);
        num.val(&e.value, &ctx);
    }
    let map = num.map;

    for s in cap.steps.iter_mut() {
        match s {
            StepCap::Http { headers, body, .. } => {
                for (_, v) in headers.iter_mut() {
                    apply(v, &map);
                }
                match body {
                    Body::Json(v) => apply(v, &map),
                    Body::Text(t) => apply_text(t, &map),
                    Body::Bytes(_) => {}
                }
            }
            StepCap::Reply(v) => apply(v, &map),
            StepCap::Done(_) => {}
        }
    }
    for c in cap.mongo.values_mut() {
        c.docs.iter_mut().for_each(|d| apply(d, &map));
        c.indexes.iter_mut().for_each(|(_, v)| apply(v, &map));
        apply(&mut c.options, &map);
    }
    for e in cap.dragonfly.iter_mut() {
        apply_text(&mut e.key, &map);
        apply(&mut e.value, &map);
    }
}
