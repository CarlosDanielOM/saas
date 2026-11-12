//! No private value reaches `Debug` output (logs, panics, error reports).
//!
//! For every registered collection: a stored document built from the recorded create cases, with
//! marker values written at every private path ([`CollectionInfo::private`]: strings, numbers,
//! dates and ids, recursively through objects and arrays), is decoded with the read type and
//! formatted with `{:?}` and `{:#?}`; no marker may appear. The declarations themselves are
//! checked too: every `select: false` path is private, and so is every path named like an
//! e-mail address, a secret or an OAuth token.

mod support;

use anyhow::{Context, Result, bail};
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocumentBuf, doc};
use dima_model::{CollectionInfo, REGISTRY};
use dima_store::mongo::WriteContext;
use dima_store::mongo::schema::{Field, Kind, MapOf, Schema, ValueType};

/// Makes marker values and remembers how each one is printed: `shown` is what the stored
/// document's canonical Extended JSON holds, `also` the other ways a read type may print it.
#[derive(Default)]
struct Markers {
    shown: Vec<String>,
    also: Vec<String>,
}

impl Markers {
    fn next(&mut self) -> usize {
        self.shown.len() + 1
    }

    fn value(&mut self, ty: ValueType) -> Bson {
        let n = self.next();
        match ty {
            ValueType::String => {
                let text = format!("private-marker-{n}-📧");
                self.shown.push(text.clone());
                Bson::String(text)
            }
            ValueType::Number => {
                let number = 987_650_000 + i32::try_from(n).unwrap_or(0);
                self.shown.push(number.to_string());
                Bson::Int32(number)
            }
            ValueType::Date => {
                let ms = 1_111_111_000_000 + i64::try_from(n).unwrap_or(0);
                let date = bson::DateTime::from_millis(ms);
                self.shown.push(ms.to_string());
                self.also.extend(date.try_to_rfc3339_string().ok());
                self.also.push(date.to_string());
                Bson::DateTime(date)
            }
            ValueType::ObjectId => {
                let mut bytes = *b"\xfe\xedprivate\x00\x00\x00";
                bytes[11] = u8::try_from(n % 256).unwrap_or(0);
                let id = ObjectId::from_bytes(bytes);
                self.shown.push(id.to_hex());
                Bson::ObjectId(id)
            }
            ValueType::Boolean => Bson::Boolean(true),
        }
    }

    fn free(&mut self) -> Bson {
        Bson::Document(doc! { "m": self.value(ValueType::String) })
    }

    fn fields(&mut self, fields: &[Field]) -> Document {
        fields
            .iter()
            .map(|field| (field.name.to_owned(), self.kind(field.kind)))
            .collect()
    }

    /// A value for a schema node, with markers wherever a value can carry one.
    fn kind(&mut self, kind: Kind) -> Bson {
        match kind {
            Kind::Value(ty) => self.value(ty),
            Kind::Mixed => self.free(),
            Kind::Nested(fields) => Bson::Document(self.fields(fields)),
            Kind::Subdocument(schema) => Bson::Document(self.fields(schema.fields)),
            Kind::Array(ty) => Bson::Array(vec![self.value(ty)]),
            Kind::MixedArray => Bson::Array(vec![self.free()]),
            Kind::DocumentArray(schema) => {
                Bson::Array(vec![Bson::Document(self.fields(schema.fields))])
            }
            Kind::Map(MapOf::Values(ty)) => Bson::Document(doc! { "k": self.value(ty) }),
            Kind::Map(MapOf::Mixed) => Bson::Document(doc! { "k": self.free() }),
            Kind::Map(MapOf::Subdocuments(schema)) => {
                Bson::Document(doc! { "k": self.fields(schema.fields) })
            }
        }
    }
}

/// The schema field at a private path (`$` for array elements).
fn field_at(schema: &'static Schema, path: &str) -> Option<&'static Field> {
    let mut fields = schema.fields;
    let mut found = None;
    for segment in path.split('.') {
        if segment == "$" {
            continue;
        }
        let field = fields.iter().find(|f| f.name == segment)?;
        fields = match field.kind {
            Kind::Nested(children) => children,
            Kind::Subdocument(schema) | Kind::DocumentArray(schema) => schema.fields,
            _ => &[],
        };
        found = Some(field);
    }
    found
}

/// Writes `value` at a private path of `document`, element `0` for `$`; `false` when the
/// element is missing.
fn put(document: &mut Document, path: &str, value: Bson) -> bool {
    put_at(document, &path.replace(".$.", ".0."), value)
}

fn put_at(document: &mut Document, path: &str, value: Bson) -> bool {
    let Some((head, rest)) = path.split_once('.') else {
        document.insert(path, value);
        return true;
    };
    if !document.contains_key(head) {
        document.insert(head, doc! {});
    }
    match document.get_mut(head) {
        Some(Bson::Document(inner)) => put_at(inner, rest, value),
        Some(Bson::Array(items)) => {
            let (index, deeper) = rest.split_once('.').unwrap_or((rest, ""));
            match index.parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                Some(Bson::Document(inner)) if !deeper.is_empty() => put_at(inner, deeper, value),
                Some(slot) if deeper.is_empty() => {
                    *slot = value;
                    true
                }
                _ => false,
            }
        }
        _ => false,
    }
}

/// Every schema path, in schema notation (`$` for array elements).
fn schema_paths(fields: &[Field], prefix: &str, out: &mut Vec<String>) {
    for field in fields {
        let path = format!("{prefix}{}", field.name);
        out.push(path.clone());
        match field.kind {
            Kind::Nested(children) => schema_paths(children, &format!("{path}."), out),
            Kind::Subdocument(schema) => schema_paths(schema.fields, &format!("{path}."), out),
            Kind::DocumentArray(schema) => schema_paths(schema.fields, &format!("{path}.$."), out),
            _ => {}
        }
    }
}

fn covered(info: &CollectionInfo, path: &str) -> bool {
    info.private
        .iter()
        .any(|p| path == *p || path.starts_with(&format!("{p}.")))
}

/// A name that says the value is personal or secret.
fn sensitive_name(path: &str) -> bool {
    let name = path.rsplit('.').next().unwrap_or(path).to_ascii_lowercase();
    name.contains("email")
        || name.contains("password")
        || name.contains("secret")
        || name.contains("apikey")
        || name.contains("api_key")
        || name == "access_token"
        || name == "refresh_token"
        || name == "accesstoken"
        || name == "refreshtoken"
}

#[test]
fn debug_never_prints_private_values() -> Result<()> {
    let cases = support::recorded_cases()?;
    let mut problems = Vec::new();
    let mut checked = 0;
    for info in REGISTRY {
        for hidden in info.hidden {
            if !covered(info, hidden) {
                problems.push(format!(
                    "{}: `select: false` path {hidden} is not private",
                    info.name
                ));
            }
        }
        let mut paths = Vec::new();
        schema_paths(info.schema.fields, "", &mut paths);
        for path in paths.iter().filter(|p| sensitive_name(p)) {
            if !covered(info, path) {
                problems.push(format!(
                    "{}: {path} looks private but is not declared",
                    info.name
                ));
            }
        }
        let given = support::base_given(&cases, info.name)?;
        let mut document = info
            .prepare_create(&given, &mut WriteContext::new(0))
            .with_context(|| format!("{}: base document", info.name))?
            .document;
        let mut markers = Markers::default();
        for path in info.private {
            let field = field_at(info.schema, path).with_context(|| {
                format!("{}: private path {path} is not in the schema", info.name)
            })?;
            let value = markers.kind(field.kind);
            if !put(&mut document, path, value) {
                bail!("{}: the base document has no element for {path}", info.name);
            }
        }
        let raw = RawDocumentBuf::try_from(&document)?;
        let decoded = (info.decode)(&raw).map_err(|e| anyhow::anyhow!("{}: {e}", info.name))?;
        let shown = format!("{decoded:?}\n{decoded:#?}");
        let stored = Bson::Document(document.clone())
            .into_canonical_extjson()
            .to_string();
        for marker in &markers.shown {
            if !stored.contains(marker.as_str()) {
                bail!("{}: marker {marker} was not written", info.name);
            }
        }
        for marker in markers.shown.iter().chain(&markers.also) {
            if shown.contains(marker.as_str()) {
                problems.push(format!(
                    "{}: Debug shows the private value {marker}",
                    info.name
                ));
            }
        }
        checked += markers.shown.len();
    }
    if !problems.is_empty() {
        bail!("{}", problems.join("\n"));
    }
    eprintln!(
        "{checked} private markers in {} collections, none printed",
        REGISTRY.len()
    );
    Ok(())
}
