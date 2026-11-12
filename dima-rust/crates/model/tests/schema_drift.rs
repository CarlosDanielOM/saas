//! Every hand-written collection module against what Mongoose itself reports for the same model
//! (`tests/mongoose/schemas.json`, written by `tests/mongoose/dump_schemas.mts`): collection and
//! model names, schema options, every field with its kind, type, default (computed defaults
//! evaluated at the dump's fixed instant), `trim` and `immutable`, the `select: false` paths, the
//! validators and the declared indexes. Offline: no database is needed.
//!
//! The snapshot is only as current as the TypeScript it was dumped from: it records the reference
//! commit and the SHA-256 of every source file (the schema files and what they import), and
//! [`snapshot_sources_are_current`] fails, naming the file, when this checkout's copy differs.

use anyhow::{Context, Result, bail};
use bson::Bson;
use dima_model::validation::Check;
use dima_model::{CollectionInfo, REGISTRY};
use dima_store::mongo::schema::{Field, IdField, Kind, MapOf, Schema, ValueType};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

fn dump() -> Result<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mongoose/schemas.json");
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {path}"))?;
    Ok(serde_json::from_str(&text)?)
}

fn type_name(ty: ValueType) -> &'static str {
    match ty {
        ValueType::String => "String",
        ValueType::Number => "Number",
        ValueType::Date => "Date",
        ValueType::Boolean => "Boolean",
        ValueType::ObjectId => "ObjectId",
    }
}

fn ejson(value: Bson) -> Value {
    value.into_canonical_extjson()
}

/// A Rust field in the dump's shape.
fn field_json(field: &Field, fixed_ms: i64) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), json!(field.name));
    let implicit_array = matches!(
        field.kind,
        Kind::Array(_) | Kind::MixedArray | Kind::DocumentArray(_)
    );
    match field.kind {
        Kind::Value(ty) => {
            out.insert("kind".into(), json!("value"));
            out.insert("type".into(), json!(type_name(ty)));
        }
        Kind::Mixed => {
            out.insert("kind".into(), json!("mixed"));
        }
        Kind::Nested(children) => {
            out.insert("kind".into(), json!("nested"));
            out.insert(
                "fields".into(),
                Value::Array(children.iter().map(|f| field_json(f, fixed_ms)).collect()),
            );
        }
        Kind::Array(ty) => {
            out.insert("kind".into(), json!("array"));
            out.insert("type".into(), json!(type_name(ty)));
        }
        Kind::MixedArray => {
            out.insert("kind".into(), json!("mixedArray"));
        }
        Kind::DocumentArray(schema) => {
            out.insert("kind".into(), json!("documentArray"));
            out.insert("schema".into(), schema_json(schema, false, fixed_ms));
        }
        Kind::Subdocument(schema) => {
            out.insert("kind".into(), json!("subdocument"));
            out.insert("schema".into(), schema_json(schema, false, fixed_ms));
        }
        Kind::Map(of) => {
            out.insert("kind".into(), json!("map"));
            let of = match of {
                MapOf::Values(ty) => json!({ "kind": "values", "type": type_name(ty) }),
                MapOf::Mixed => json!({ "kind": "mixed" }),
                MapOf::Subdocuments(schema) => {
                    json!({ "kind": "subdocuments", "schema": schema_json(schema, false, fixed_ms) })
                }
            };
            out.insert("of".into(), of);
        }
    }
    if let Some(default) = field.default {
        let value = ejson(default.value.build(fixed_ms));
        // Mongoose wraps every array default in a function; only the declared value is compared
        // for an implicit `[]` (see `normalize_dump_field`).
        let function = if implicit_array && value == json!([]) {
            Value::Null
        } else {
            json!(default.function)
        };
        out.insert(
            "default".into(),
            json!({ "function": function, "value": value }),
        );
    }
    if field.trim {
        out.insert("trim".into(), json!(true));
    }
    if field.immutable {
        out.insert("immutable".into(), json!(true));
    }
    Value::Object(out)
}

fn schema_json(schema: &Schema, top_level: bool, fixed_ms: i64) -> Value {
    let id = match schema.id {
        IdField::Auto => "auto",
        IdField::Declared => "declared",
        IdField::None => "none",
    };
    let timestamps = schema
        .timestamps
        .map(|t| json!({ "createdAt": t.created_at, "updatedAt": t.updated_at }));
    json!({
        "id": id,
        "timestamps": timestamps,
        "versionKey": if top_level { json!(schema.version_key) } else { Value::Null },
        "minimize": schema.minimize,
        "fields": schema.fields.iter().map(|f| field_json(f, fixed_ms)).collect::<Vec<_>>(),
    })
}

/// The dump's field with the parts the Rust side does not express made comparable: the
/// `implicit` marker dropped, and the function flag of an array's `[]` default cleared.
fn normalize_dump(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let array_kind = matches!(
                object.get("kind").and_then(Value::as_str),
                Some("array" | "mixedArray" | "documentArray")
            );
            if let Some(Value::Object(default)) = object.get_mut("default") {
                default.remove("implicit");
                if array_kind && default.get("value") == Some(&json!([])) {
                    default.insert("function".into(), Value::Null);
                }
            }
            object.values_mut().for_each(normalize_dump);
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_dump),
        _ => {}
    }
}

/// Every difference between two JSON values, as `path: expected != actual` lines.
fn diff(path: &str, mongoose: &Value, rust: &Value, out: &mut Vec<String>) {
    match (mongoose, rust) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                let null = Value::Null;
                diff(
                    &format!("{path}.{key}"),
                    a.get(key).unwrap_or(&null),
                    b.get(key).unwrap_or(&null),
                    out,
                );
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                let name = x
                    .get("name")
                    .and_then(Value::as_str)
                    .map_or_else(|| i.to_string(), str::to_owned);
                diff(&format!("{path}[{name}]"), x, y, out);
            }
        }
        (Value::Number(a), Value::Number(b)) if a.as_f64() == b.as_f64() => {}
        _ if mongoose == rust => {}
        _ => out.push(format!("{path}: mongoose {mongoose} != rust {rust}")),
    }
}

fn rules_json(info: &CollectionInfo) -> Value {
    Value::Array(
        info.rules
            .iter()
            .map(|rule| match rule.check {
                Check::Required => {
                    json!({ "path": rule.path, "type": "required", "conditional": false })
                }
                Check::RequiredWhen(_) => {
                    json!({ "path": rule.path, "type": "required", "conditional": true })
                }
                Check::Enum(values) => {
                    json!({ "path": rule.path, "type": "enum", "values": values })
                }
                Check::Min(min) => json!({ "path": rule.path, "type": "min", "min": min }),
                Check::Max(max) => json!({ "path": rule.path, "type": "max", "max": max }),
                Check::MaxLength(max) => {
                    json!({ "path": rule.path, "type": "maxlength", "maxlength": max })
                }
                Check::Custom { message, .. } => {
                    json!({ "path": rule.path, "type": "user defined", "message": message })
                }
            })
            .collect(),
    )
}

fn indexes_json(info: &CollectionInfo) -> Value {
    Value::Array(
        info.indexes
            .iter()
            .map(|spec| {
                let mut options = Map::new();
                if spec.unique {
                    options.insert("unique".into(), json!(true));
                }
                if spec.sparse {
                    options.insert("sparse".into(), json!(true));
                }
                if let Some(seconds) = spec.expire_after_seconds {
                    options.insert("expireAfterSeconds".into(), json!(seconds));
                }
                if let Some(filter) = spec.partial_filter {
                    options.insert(
                        "partialFilterExpression".into(),
                        Bson::Document(filter()).into_relaxed_extjson(),
                    );
                }
                json!({
                    "key": spec.keys.iter().map(|(k, d)| json!([k, d])).collect::<Vec<_>>(),
                    "options": options,
                })
            })
            .collect(),
    )
}

fn dump_indexes(model: &Value) -> Value {
    let mut indexes = model.get("indexes").cloned().unwrap_or(Value::Null);
    if let Value::Array(items) = &mut indexes {
        for item in items {
            if let Some(Value::Object(options)) = item.get_mut("options") {
                // Added by Mongoose to every index; ignored and not stored by the server.
                options.remove("background");
            }
        }
    }
    indexes
}

#[test]
fn every_schema_matches_mongoose() -> Result<()> {
    let dump = dump()?;
    let fixed_ms = dump
        .get("fixedMs")
        .and_then(Value::as_i64)
        .context("fixedMs")?;
    let models = dump
        .get("models")
        .and_then(Value::as_object)
        .context("models")?;
    let mut problems = Vec::new();
    let registered: BTreeSet<&str> = REGISTRY.iter().map(|info| info.name).collect();
    if registered.len() != REGISTRY.len() {
        problems.push("a collection is registered twice".to_owned());
    }
    for name in models.keys() {
        if !registered.contains(name.as_str()) {
            problems.push(format!("{name}: dumped but not in the registry"));
        }
    }
    for info in REGISTRY {
        let Some(model) = models.get(info.name) else {
            problems.push(format!(
                "{}: not in the Mongoose dump (add it to dump_schemas.mts)",
                info.name
            ));
            continue;
        };
        let at = info.name;
        if model.get("model") != Some(&json!(info.model)) {
            problems.push(format!(
                "{at}: model name {} != {}",
                info.model, model["model"]
            ));
        }
        let mut schema = model.get("schema").cloned().unwrap_or(Value::Null);
        normalize_dump(&mut schema);
        diff(
            at,
            &schema,
            &schema_json(info.schema, true, fixed_ms),
            &mut problems,
        );
        diff(
            &format!("{at}.hidden"),
            model.get("hidden").unwrap_or(&Value::Null),
            &json!(info.hidden),
            &mut problems,
        );
        diff(
            &format!("{at}.validators"),
            model.get("validators").unwrap_or(&Value::Null),
            &rules_json(info),
            &mut problems,
        );
        diff(
            &format!("{at}.indexes"),
            &dump_indexes(model),
            &indexes_json(info),
            &mut problems,
        );
    }
    if !problems.is_empty() {
        bail!("{} differences:\n{}", problems.len(), problems.join("\n"));
    }
    eprintln!("{} collections match Mongoose", REGISTRY.len());
    Ok(())
}

/// How to regenerate the snapshot (`src/lib.rs`, "Tests every collection gets").
const REGENERATE: &str = "cd \"$DIMABOT_DIR\" && TZ=UTC node_modules/.bin/tsx \
    \"$REPO/dima-rust/crates/model/tests/mongoose/dump_schemas.mts\" \
    \"$REPO/dima-rust/crates/model/tests/mongoose/schemas.json\"";

#[test]
fn snapshot_sources_are_current() -> Result<()> {
    use sha2::{Digest, Sha256};
    let dump = dump()?;
    let reference = dump
        .get("reference")
        .and_then(Value::as_str)
        .context("the snapshot records no reference commit")?;
    if reference.len() != 40 || !reference.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("the snapshot's reference commit is not a commit id: {reference}");
    }
    let sources = dump
        .get("sources")
        .and_then(Value::as_array)
        .context("the snapshot records no source hashes")?;
    let dimabot = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../dimabot");
    let mut recorded = BTreeSet::new();
    let mut problems = Vec::new();
    for source in sources {
        let path = source
            .get("path")
            .and_then(Value::as_str)
            .context("source path")?;
        let expected = source
            .get("sha256")
            .and_then(Value::as_str)
            .context("source hash")?;
        recorded.insert(path);
        let file = format!("{dimabot}/{path}");
        match std::fs::read(&file) {
            Ok(bytes) => {
                let actual: String = Sha256::digest(&bytes)
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if actual != expected {
                    problems.push(format!("dimabot/{path} changed since the snapshot"));
                }
            }
            Err(error) => problems.push(format!("dimabot/{path}: {error}")),
        }
    }
    let models = dump
        .get("models")
        .and_then(Value::as_object)
        .context("models")?;
    for (name, model) in models {
        match model.get("file").and_then(Value::as_str) {
            Some(file) if recorded.contains(file) => {}
            other => problems.push(format!(
                "{name}: schema file {other:?} has no recorded hash"
            )),
        }
    }
    if !problems.is_empty() {
        bail!(
            "the schema snapshot (reference {reference}) is stale:\n{}\n\
             dimabot/src is frozen: if the change is intended, regenerate the snapshot and \
             re-check every model against it:\n{REGENERATE}",
            problems.join("\n")
        );
    }
    eprintln!(
        "{} source files match the snapshot of reference {reference}",
        sources.len()
    );
    Ok(())
}
